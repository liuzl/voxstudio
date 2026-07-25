import { describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { DuplexSession, EnergyVadSegmenter } from "@voxstudio/duplex-session";
import {
  createStudioReferents,
  createStudioTools,
  runConversation,
  type ChatEngine,
  type ConversationControls,
  type ConversationFrame,
  type ConversationTool,
} from "./index";

const chunking = {
  maxSeconds: 15, firstMaxSeconds: 8, growth: 2, sentenceEnders: "。！？.!?",
  joinPauseMs: 210, trimFloorDb: 25, edgePadMs: 40,
};
const ttsDefaults = { voice: "demo", cfgValue: 2, timesteps: 10, responseFormat: "wav" as const };

function scriptedLlm(rounds: (
  | { text: string[] }
  | { calls: { id: string; name: string; args: string }[]; text?: string[] }
)[]): ChatEngine {
  let round = 0;
  return {
    chatStream: async function* () { yield "unused"; },
    chatToolStream: async function* () {
      const script = rounds[round];
      round += 1;
      if (!script) return;
      for (const text of script.text ?? []) yield { type: "text" as const, text };
      if ("calls" in script && script.calls.length > 0) {
        yield {
          type: "tool_calls" as const,
          calls: script.calls.map(call => ({
            id: call.id, type: "function" as const,
            function: { name: call.name, arguments: call.args },
          })),
        };
      }
    },
  };
}

/** One speech burst per utterance; after the last, silence flows until `until` (or timeout). */
function pacedFrames(
  session: DuplexSession,
  utterances: number,
  until?: () => boolean,
): AsyncIterable<ConversationFrame> {
  const wait = (predicate: () => boolean): Promise<void> => new Promise(resolve => {
    const poll = (): void => { predicate() ? resolve() : setTimeout(poll, 5); };
    poll();
  });
  const settle = async (): Promise<void> => {
    await wait(() => session.snapshot().state !== "listening");
    await wait(() => session.snapshot().state === "listening");
  };
  return (async function* () {
    for (let index = 0; index < utterances; index += 1) {
      const t = index * 1_000;
      yield { samples: new Float32Array(320).fill(0.2), timestampMs: t };
      yield { samples: new Float32Array(320).fill(0.2), timestampMs: t + 20 };
      yield { samples: new Float32Array(320), timestampMs: t + 40 };
      if (index < utterances - 1) await settle();
    }
    if (until) {
      const deadline = Date.now() + 5_000;
      let t = utterances * 1_000;
      while (!until() && Date.now() < deadline) {
        yield { samples: new Float32Array(320), timestampMs: t };
        t += 20;
        await Bun.sleep(5);
      }
    }
  })();
}

interface Synthesized { input: string; voice: string; speed: number | undefined }

async function runStudio(config: {
  llm: ChatEngine;
  transcripts: string[];
  deps?: Partial<Parameters<typeof createStudioTools>[0]>;
  pronunciations?: Record<string, string>;
  untilSynth?: number;
  callbacks?: Parameters<typeof runConversation>[2];
}): Promise<{ synthesized: Synthesized[]; referents: ReturnType<typeof createStudioReferents> }> {
  const session = new DuplexSession();
  session.start();
  const synthesized: Synthesized[] = [];
  const referents = createStudioReferents();
  let controls: ConversationControls | undefined;
  const pronunciations = config.pronunciations ?? {};
  const tools: ConversationTool[] = createStudioTools({
    lastUtterance: referents.lastUtterance,
    lastReply: referents.lastReply,
    queueAgentSpeech: (text, overrides) => controls?.queueAgentSpeech(text, overrides),
    setPronunciation: (term, reading) => { pronunciations[term] = reading; },
    ...config.deps,
  });
  let turn = 0;
  await runConversation({
    session,
    vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 40, silenceMs: 20 }),
    frames: pacedFrames(session, config.transcripts.length,
      config.untilSynth === undefined ? undefined : () => synthesized.length >= (config.untilSynth as number)),
    createPlayer: () => ({ write: async () => {}, close: async () => {} }),
    asr: { transcribe: async () => ({ text: config.transcripts[Math.min(turn++, config.transcripts.length - 1)] as string }) },
    llm: config.llm,
    tts: {
      speech: async input => {
        synthesized.push({ input: input.input, voice: input.voice, speed: input.speed });
        return new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000));
      },
    },
  }, {
    language: "zh", chunking, ttsDefaults, voice: "demo",
    allowBargeIn: true, turnTaking: "conservative", reopenMs: 7_000,
    tools, pronunciations,
    onControls: handle => { controls = handle; },
  }, {
    ...config.callbacks,
    onUtterance: async (wav, transcript) => {
      referents.recordUtterance(wav, transcript);
      await config.callbacks?.onUtterance?.(wav, transcript);
    },
    onReply: (text, turnHandle) => {
      referents.recordReply(text);
      config.callbacks?.onReply?.(text, turnHandle);
    },
    onToolPending: (name, args, turnHandle) => {
      referents.onToolPending(name);
      config.callbacks?.onToolPending?.(name, args, turnHandle);
    },
  });
  return { synthesized, referents };
}

describe("studio tools", () => {
  test("remember_pronunciation takes effect at the TTS boundary from the next synthesis", async () => {
    const replies: string[] = [];
    const { synthesized } = await runStudio({
      llm: scriptedLlm([
        { calls: [{ id: "c1", name: "remember_pronunciation", args: '{"term":"VoxCPM","reading":"vox-c-p-m"}' }] },
        { text: ["记住了。"] },
        { text: ["VoxCPM 很棒。"] },
      ]),
      transcripts: ["记住 VoxCPM 读 vox-c-p-m", "介绍一下 VoxCPM"],
      callbacks: { onReply: text => replies.push(text) },
    });
    // The caption keeps the spelling; the engine hears the reading.
    expect(replies).toEqual(["记住了。", "VoxCPM 很棒。"]);
    expect(synthesized.map(piece => piece.input)).toEqual(["记住了。", "vox-c-p-m 很棒。"]);
  });

  test("redo_last_reply re-speaks the previous reply as an agent turn with one-shot overrides", async () => {
    const replies: string[] = [];
    const { synthesized } = await runStudio({
      llm: scriptedLlm([
        { text: ["第一句回复。"] },
        { calls: [{ id: "c1", name: "redo_last_reply", args: '{"voice":"zf_001","rate":3}' }] },
        { text: ["好。"] },
      ]),
      transcripts: ["随便说一句", "用 zf_001 再念一遍"],
      untilSynth: 3,
      callbacks: { onReply: text => replies.push(text) },
    });
    expect(replies).toEqual(["第一句回复。", "好。", "第一句回复。"]);
    expect(synthesized).toEqual([
      { input: "第一句回复。", voice: "demo", speed: undefined },
      { input: "好。", voice: "demo", speed: undefined },
      // The redo: overridden voice, rate clamped into [0.5, 2], session voice untouched.
      { input: "第一句回复。", voice: "zf_001", speed: 2 },
    ]);
  });

  test("save_last_utterance_as_voice registers the park-time utterance only on spoken confirmation", async () => {
    const registered: { id: string; transcript: string; bytes: number }[] = [];
    const utteranceBytes: number[] = [];
    const { synthesized } = await runStudio({
      llm: scriptedLlm([
        { text: ["这句话我听到了。"] },
        { calls: [{ id: "c1", name: "save_last_utterance_as_voice", args: '{"voice":"myvoice"}' }] },
        { text: ["要把刚才那句注册成音色 myvoice，确认吗？"] },
        { calls: [{ id: "c2", name: "confirm_action", args: "{}" }] },
        { text: ["已经注册好了。"] },
      ]),
      transcripts: ["这是我要克隆的声音样本", "把我刚才那句存成音色 myvoice", "确认"],
      deps: {
        registerVoice: async (id, wav, transcript) => {
          registered.push({ id, transcript, bytes: wav.length });
        },
      },
      callbacks: { onUtterance: wav => { utteranceBytes.push(wav.length); } },
    });
    // Held at the ask, executed at the confirm — and the audio is the SAMPLE utterance
    // (pinned when the action parked), not the command or the confirmation.
    expect(registered).toEqual([{
      id: "myvoice",
      transcript: "这是我要克隆的声音样本",
      bytes: utteranceBytes[0] as number,
    }]);
    // The clause fast path may split a piece; the spoken content is what matters.
    expect(synthesized.map(piece => piece.input).join("")).toBe(
      "这句话我听到了。要把刚才那句注册成音色 myvoice，确认吗？已经注册好了。",
    );
  });

  test("the pin survives a failed registration and clears on cancel or success", () => {
    const referents = createStudioReferents();
    referents.recordUtterance(new Uint8Array([1]), "样本");
    referents.recordUtterance(new Uint8Array([2]), "保存命令");
    referents.onToolPending("save_last_utterance_as_voice");
    referents.recordUtterance(new Uint8Array([3]), "确认");
    // Non-consuming: a transient registration failure must not lose the confirmed sample.
    expect(referents.lastUtterance()?.transcript).toBe("样本");
    expect(referents.lastUtterance()?.transcript).toBe("样本");
    referents.clearPin();
    // Unpinned, the referent falls back to the utterance before the current one.
    expect(referents.lastUtterance()?.transcript).toBe("保存命令");
  });

  test("save rejects a voice id the engine facade would refuse", async () => {
    const tools = createStudioTools({
      lastUtterance: () => ({ wav: new Uint8Array([1]), transcript: "样本" }),
      registerVoice: async () => { throw new Error("must not be called"); },
      setPronunciation: () => {},
    });
    const save = tools.find(tool => tool.name === "save_last_utterance_as_voice");
    const signal = new AbortController().signal;
    const rejected = await save?.handler({ voice: "坏 id\n" }, signal) as Record<string, unknown>;
    expect(rejected.error).toBeDefined();
  });

  test("persist saves exactly the session-added overlay, once", async () => {
    const persisted: Record<string, string>[] = [];
    const live: Record<string, string> = { existing: "旧读法" };
    const tools = createStudioTools({
      setPronunciation: (term, reading) => { live[term] = reading; },
      persistPronunciations: async entries => { persisted.push(entries); },
    });
    const signal = new AbortController().signal;
    const remember = tools.find(tool => tool.name === "remember_pronunciation");
    const persist = tools.find(tool => tool.name === "persist_pronunciations");
    // Nothing session-added yet: refuse rather than rewrite the config with nothing.
    expect(((await persist?.handler({}, signal)) as Record<string, unknown>).error).toBeDefined();
    await remember?.handler({ term: "VoxCPM", reading: "vox-c-p-m" }, signal);
    const saved = await persist?.handler({}, signal) as Record<string, unknown>;
    expect(saved.ok).toBe(true);
    // The delta only — the config-sourced entry is not re-written.
    expect(persisted).toEqual([{ VoxCPM: "vox-c-p-m" }]);
    // A second persist with nothing new refuses again.
    expect(((await persist?.handler({}, signal)) as Record<string, unknown>).error).toBeDefined();
  });

  test("generate_take validates and forwards; audit_profile forwards the verdict", async () => {
    const takes: { text: string; voice: string | undefined }[] = [];
    const tools = createStudioTools({
      setPronunciation: () => {},
      generateTake: async (text, voice) => { takes.push({ text, voice }); return { location: "takes" }; },
      auditProfile: async id => ({ status: "drift", model: "m2", detail: `${id} drifted` }),
    });
    const signal = new AbortController().signal;
    const generate = tools.find(tool => tool.name === "generate_take");
    const audit = tools.find(tool => tool.name === "audit_profile");
    expect(((await generate?.handler({ text: "  " }, signal)) as Record<string, unknown>).error).toBeDefined();
    expect(((await generate?.handler({ text: "长".repeat(501) }, signal)) as Record<string, unknown>).error).toBeDefined();
    const produced = await generate?.handler({ text: "欢迎光临", voice: "calm" }, signal) as Record<string, unknown>;
    expect(produced).toMatchObject({ ok: true, location: "takes" });
    expect(takes).toEqual([{ text: "欢迎光临", voice: "calm" }]);
    expect(await audit?.handler({ profile: "design-x" }, signal)).toMatchObject({ status: "drift", model: "m2" });
    // Deps omitted → structured refusals, not crashes.
    const bare = createStudioTools({ setPronunciation: () => {} });
    expect(((await bare.find(tool => tool.name === "generate_take")?.handler({ text: "x" }, signal)) as Record<string, unknown>).error).toBeDefined();
    expect(((await bare.find(tool => tool.name === "audit_profile")?.handler({ profile: "x" }, signal)) as Record<string, unknown>).error).toBeDefined();
    expect(((await bare.find(tool => tool.name === "persist_pronunciations")?.handler({}, signal)) as Record<string, unknown>).error).toBeDefined();
  });

  test("save refuses when nothing has been said and redo refuses without a prior reply", async () => {
    const tools = createStudioTools({
      lastUtterance: () => undefined,
      registerVoice: async () => {},
      lastReply: () => undefined,
      queueAgentSpeech: () => { throw new Error("must not queue"); },
      setPronunciation: () => {},
    });
    const signal = new AbortController().signal;
    const save = tools.find(tool => tool.name === "save_last_utterance_as_voice");
    const redo = tools.find(tool => tool.name === "redo_last_reply");
    expect(((await save?.handler({ voice: "x" }, signal)) as Record<string, unknown>).error).toBeDefined();
    expect(((await redo?.handler({}, signal)) as Record<string, unknown>).error).toBeDefined();
  });
});
