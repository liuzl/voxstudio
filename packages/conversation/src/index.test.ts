import { describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { DuplexSession, EnergyVadSegmenter } from "@voxstudio/duplex-session";
import { runConversation, type ChatEngine, type ConversationFrame, type ConversationTool } from "./index";

const chunking = {
  maxSeconds: 15, firstMaxSeconds: 8, growth: 2, sentenceEnders: "。！？.!?",
  joinPauseMs: 210, trimFloorDb: 25, edgePadMs: 40,
};
const ttsDefaults = { voice: "demo", cfgValue: 2, timesteps: 10, responseFormat: "wav" as const };

function frames(): AsyncIterable<ConversationFrame> {
  return (async function* () {
    yield { samples: new Float32Array(320).fill(0.2), timestampMs: 0 };
    yield { samples: new Float32Array(320).fill(0.2), timestampMs: 20 };
    yield { samples: new Float32Array(320), timestampMs: 40 };
  })();
}

describe("runConversation", () => {
  test("runs one VAD-delimited turn through ASR, streaming LLM deltas, TTS, and callbacks", async () => {
    const session = new DuplexSession();
    const events: string[] = [];
    const deltas: string[] = [];
    const played: number[] = [];
    const utterances: { bytes: number; transcript: string }[] = [];
    let playerClosed = false;
    session.start();

    await runConversation({
      session,
      vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 40, silenceMs: 20 }),
      frames: frames(),
      createPlayer: () => ({
        write: async audio => { played.push(audio.samples.length); },
        close: async () => { playerClosed = true; },
      }),
      asr: { transcribe: async () => ({ text: "你好" }) },
      llm: {
        chatStream: async function* () {
          yield "回答";
          yield "完毕。";
        },
      },
      tts: { speech: async () => new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000)) },
    }, {
      language: "zh", chunking, ttsDefaults, voice: "demo",
      allowBargeIn: true, turnTaking: "conservative", reopenMs: 7_000,
    }, {
      onTranscript: text => events.push(`transcript:${text}`),
      onReplyDelta: delta => deltas.push(delta),
      onReply: text => events.push(`reply:${text}`),
      onUtterance: (wav, transcript) => { utterances.push({ bytes: wav.length, transcript }); },
    });

    expect(events).toEqual(["transcript:你好", "reply:回答完毕。"]);
    expect(deltas).toEqual(["回答", "完毕。"]);
    expect(played).toEqual([48_000]);
    expect(playerClosed).toBe(true);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]?.transcript).toBe("你好");
    expect(utterances[0]?.bytes).toBeGreaterThan(44);
    expect(session.state).toBe("listening");
  });

  test("closing the session mid-reply aborts the turn and stops the player", async () => {
    const session = new DuplexSession();
    let aborted = false;
    let releaseWrite = () => {};
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    session.start();

    await runConversation({
      session,
      vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 40, silenceMs: 20 }),
      frames: (async function* () {
        yield* [
          { samples: new Float32Array(320).fill(0.2), timestampMs: 0 },
          { samples: new Float32Array(320).fill(0.2), timestampMs: 20 },
          { samples: new Float32Array(320), timestampMs: 40 },
        ];
        // The reply is audibly playing; shutting down now must abort it, not wait it out.
        await writeGate;
        session.close();
      })(),
      createPlayer: () => ({
        write: async () => { releaseWrite(); },
        close: async () => {},
        abort: async () => { aborted = true; },
      }),
      asr: { transcribe: async () => ({ text: "你好" }) },
      llm: { chatStream: async function* () { yield "回答。"; } },
      tts: {
        speech: async () => {
          await Bun.sleep(1);
          return new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000));
        },
      },
    }, {
      language: "zh", chunking, ttsDefaults, voice: "demo",
      allowBargeIn: true, turnTaking: "conservative", reopenMs: 7_000,
    });

    expect(aborted).toBe(true);
    expect(session.state).toBe("closed");
  });
});

describe("runConversation tool cycle", () => {
  const base = {
    language: "zh", chunking, ttsDefaults, voice: "demo",
    allowBargeIn: true, turnTaking: "conservative" as const, reopenMs: 7_000,
  };

  function scriptedLlm(rounds: (
    | { text: string[] }
    | { calls: { id: string; name: string; args: string }[]; text?: string[] }
  )[]): ChatEngine & { seen: { toolsOffered: number; messages: number }[] } {
    let round = 0;
    const seen: { toolsOffered: number; messages: number }[] = [];
    return {
      seen,
      chatStream: async function* () {
        yield "unused";
      },
      chatToolStream: async function* (messages, tools) {
        seen.push({ toolsOffered: tools.length, messages: messages.length });
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

  async function run(llm: ChatEngine, tools: ConversationTool[], callbacks: Parameters<typeof runConversation>[2] = {}) {
    const session = new DuplexSession();
    session.start();
    await runConversation({
      session,
      vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 40, silenceMs: 20 }),
      frames: frames(),
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
      asr: { transcribe: async () => ({ text: "把声音换成 zliu" }) },
      llm,
      tts: { speech: async () => new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000)) },
    }, { ...base, tools }, callbacks);
  }

  test("executes a call, feeds the result back, and speaks the follow-up round", async () => {
    const invoked: Record<string, unknown>[] = [];
    const toolEvents: string[] = [];
    const llm = scriptedLlm([
      { calls: [{ id: "c1", name: "set_voice", args: '{"voice":"zliu"}' }] },
      { text: ["已切换到 zliu。"] },
    ]);
    await run(llm, [{
      name: "set_voice", description: "切换音色", effect: "session",
      parameters: { type: "object", properties: { voice: { type: "string" } } },
      handler: async args => { invoked.push(args); return { ok: true, voice: args.voice }; },
    }], {
      onToolCall: (name, args) => toolEvents.push(`call:${name}:${JSON.stringify(args)}`),
      onToolResult: (name, ok) => toolEvents.push(`result:${name}:${ok}`),
      onReply: text => toolEvents.push(`reply:${text}`),
    });
    expect(invoked).toEqual([{ voice: "zliu" }]);
    expect(toolEvents).toEqual([
      'call:set_voice:{"voice":"zliu"}',
      "result:set_voice:true",
      "reply:已切换到 zliu。",
    ]);
    // Round 2 saw the assistant tool_calls message and the tool result appended.
    expect(llm.seen[1]!.messages).toBe(llm.seen[0]!.messages + 2);
  });

  test("a looping model is bounded: the final round offers no tools", async () => {
    const call = { id: "c", name: "noop", args: "{}" };
    const llm = scriptedLlm([
      { calls: [call] }, { calls: [call] }, { calls: [call] }, { text: ["好了。"] },
    ]);
    let ran = 0;
    await run(llm, [{
      name: "noop", description: "无操作", effect: "read", parameters: { type: "object", properties: {} },
      handler: async () => { ran += 1; return { ok: true }; },
    }]);
    expect(ran).toBe(3);
    expect(llm.seen.map(entry => entry.toolsOffered)).toEqual([1, 1, 1, 0]);
  });

  test("unknown tools and handler failures return structured errors, not crashes", async () => {
    const llm = scriptedLlm([
      { calls: [
        { id: "a", name: "invented_tool", args: "{}" },
        { id: "b", name: "flaky", args: "not-json" },
      ] },
      { text: ["出了点问题。"] },
    ]);
    const results: { name: string; ok: boolean }[] = [];
    let replies = "";
    await run(llm, [{
      name: "flaky", description: "会失败", effect: "read", parameters: { type: "object", properties: {} },
      handler: async () => { throw new Error("boom"); },
    }], {
      onToolResult: (name, ok) => results.push({ name, ok }),
      onReply: text => { replies = text; },
    });
    expect(results).toEqual([
      { name: "invented_tool", ok: false },
      { name: "flaky", ok: false },
    ]);
    expect(replies).toBe("出了点问题。");
  });

  test("a wordless tool-only turn completes instead of raising llm_empty", async () => {
    const llm = scriptedLlm([
      { calls: [{ id: "c1", name: "end_call", args: "{}" }] },
      { text: [] },
    ]);
    const errors: string[] = [];
    let ended = false;
    await run(llm, [{
      name: "end_call", description: "结束对话", effect: "session", parameters: { type: "object", properties: {} },
      handler: async () => { ended = true; return { ok: true }; },
    }], {
      onError: code => errors.push(code),
    });
    expect(ended).toBe(true);
    expect(errors).toEqual([]);
  });
});
