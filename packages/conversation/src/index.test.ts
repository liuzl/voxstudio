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

describe("runConversation external confirmation flow", () => {
  const base = {
    language: "zh", chunking, ttsDefaults, voice: "demo",
    allowBargeIn: true, turnTaking: "conservative" as const, reopenMs: 7_000,
  };

  function scriptedLlm(rounds: (
    | { text: string[] }
    | { calls: { id: string; name: string; args: string }[]; text?: string[] }
  )[]): ChatEngine & { seen: { toolsOffered: number }[] } {
    let round = 0;
    const seen: { toolsOffered: number }[] = [];
    return {
      seen,
      chatStream: async function* () { yield "unused"; },
      chatToolStream: async function* (_messages, tools) {
        seen.push({ toolsOffered: tools.length });
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

  /** One speech burst per utterance, the next paced to start only after the turn settles. */
  function pacedFrames(session: DuplexSession, utterances: number): AsyncIterable<ConversationFrame> {
    const settle = async (): Promise<void> => {
      const wait = (predicate: () => boolean): Promise<void> => new Promise(resolve => {
        const poll = (): void => { predicate() ? resolve() : setTimeout(poll, 5); };
        poll();
      });
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
    })();
  }

  async function runTurns(
    llm: ChatEngine,
    tools: ConversationTool[],
    transcripts: string[],
    callbacks: Parameters<typeof runConversation>[2] = {},
  ): Promise<void> {
    const session = new DuplexSession();
    session.start();
    let turn = 0;
    await runConversation({
      session,
      vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 40, silenceMs: 20 }),
      frames: pacedFrames(session, transcripts.length),
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
      asr: { transcribe: async () => ({ text: transcripts[Math.min(turn++, transcripts.length - 1)] as string }) },
      llm,
      tts: { speech: async () => new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000)) },
    }, { ...base, tools }, callbacks);
  }

  function memoTool(invoked: Record<string, unknown>[]): ConversationTool {
    return {
      name: "add_memo", description: "记一条备忘", effect: "external",
      parameters: { type: "object", properties: { content: { type: "string" } } },
      handler: async args => { invoked.push(args); return { ok: true }; },
    };
  }

  test("an external call is held, asked about, and executed only on spoken confirmation", async () => {
    const invoked: Record<string, unknown>[] = [];
    const events: string[] = [];
    const llm = scriptedLlm([
      { calls: [{ id: "c1", name: "add_memo", args: '{"content":"买牛奶"}' }] },
      { text: ["要我记下“买牛奶”这条备忘吗？"] },
      { calls: [{ id: "c2", name: "confirm_action", args: "{}" }] },
      { text: ["已经记下了。"] },
    ]);
    await runTurns(llm, [memoTool(invoked)], ["帮我记一条备忘，买牛奶", "确认"], {
      onToolPending: (name, args) => events.push(`pending:${name}:${JSON.stringify(args)}`),
      onToolCall: (name, args) => events.push(`call:${name}:${JSON.stringify(args)}`),
      onToolResult: (name, ok) => events.push(`result:${name}:${ok}`),
      onReply: text => events.push(`reply:${text}`),
    });
    // Turn 1 parks the action — the handler must not run; turn 2's confirm runs it with
    // the original arguments and reports under the real tool's name.
    expect(invoked).toEqual([{ content: "买牛奶" }]);
    expect(events).toEqual([
      'pending:add_memo:{"content":"买牛奶"}',
      "result:add_memo:true",
      "reply:要我记下“买牛奶”这条备忘吗？",
      'call:add_memo:{"content":"买牛奶"}',
      "result:add_memo:true",
      "reply:已经记下了。",
    ]);
    // The confirmation tools exist exactly in the pending turn's declarations.
    expect(llm.seen.map(entry => entry.toolsOffered)).toEqual([1, 1, 3, 3]);
  });

  test("a spoken cancel discards the pending action without executing it", async () => {
    const invoked: Record<string, unknown>[] = [];
    const events: string[] = [];
    const llm = scriptedLlm([
      { calls: [{ id: "c1", name: "add_memo", args: '{"content":"买牛奶"}' }] },
      { text: ["要我记下这条备忘吗？"] },
      { calls: [{ id: "c2", name: "cancel_action", args: "{}" }] },
      { text: ["好的，不记了。"] },
    ]);
    await runTurns(llm, [memoTool(invoked)], ["记条备忘", "算了"], {
      onToolResult: (name, ok) => events.push(`result:${name}:${ok}`),
    });
    expect(invoked).toEqual([]);
    expect(events).toContain("result:cancel_action:true");
  });

  test("an unrelated turn consumes the window: a later confirm lands on nothing", async () => {
    const invoked: Record<string, unknown>[] = [];
    const results: { name: string; ok: boolean }[] = [];
    const llm = scriptedLlm([
      { calls: [{ id: "c1", name: "add_memo", args: '{"content":"买牛奶"}' }] },
      { text: ["要我记下这条备忘吗？"] },
      { text: ["今天天气不错。"] },
      { calls: [{ id: "c2", name: "confirm_action", args: "{}" }] },
      { text: ["现在没有等待确认的操作。"] },
    ]);
    await runTurns(llm, [memoTool(invoked)], ["记条备忘", "今天天气怎么样", "确认"], {
      onToolResult: (name, ok) => results.push({ name, ok }),
    });
    expect(invoked).toEqual([]);
    expect(results.at(-1)).toEqual({ name: "confirm_action", ok: false });
    // Turn 2 still offered the confirm tools; turn 3, after the drop, did not.
    expect(llm.seen.map(entry => entry.toolsOffered)).toEqual([1, 1, 3, 1, 1]);
  });

  test("a second external call while one is pending is refused, not queued", async () => {
    const invoked: Record<string, unknown>[] = [];
    const events: string[] = [];
    const llm = scriptedLlm([
      { calls: [
        { id: "a", name: "add_memo", args: '{"content":"买牛奶"}' },
        { id: "b", name: "add_memo", args: '{"content":"倒垃圾"}' },
      ] },
      { text: ["要我记下“买牛奶”吗？另一条现在加不了。"] },
    ]);
    await runTurns(llm, [memoTool(invoked)], ["记两条备忘"], {
      onToolPending: (name, args) => events.push(`pending:${name}:${JSON.stringify(args)}`),
      onToolResult: (name, ok) => events.push(`result:${name}:${ok}`),
    });
    expect(invoked).toEqual([]);
    expect(events).toEqual([
      'pending:add_memo:{"content":"买牛奶"}',
      "result:add_memo:true",
      "result:add_memo:false",
    ]);
  });
});

describe("runConversation keyterm correction", () => {
  test("corrects the transcript for LLM and captions but never the utterance sample", async () => {
    const session = new DuplexSession();
    session.start();
    const seen: Record<string, string> = {};
    let llmSaw = "";
    await runConversation({
      session,
      vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 40, silenceMs: 20 }),
      frames: frames(),
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
      asr: { transcribe: async () => ({ text: "帮我换成ZF001的声音" }) },
      llm: {
        chatStream: async function* (messages) {
          llmSaw = messages[messages.length - 1]!.content;
          yield "好的。";
        },
      },
      tts: { speech: async () => new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000)) },
    }, {
      language: "zh", chunking, ttsDefaults, voice: "demo",
      allowBargeIn: true, turnTaking: "conservative", reopenMs: 7_000,
      keyterms: async () => ["zf_001", "zliu"],
    }, {
      onUtterance: (_wav, transcript) => { seen.utterance = transcript; },
      onTranscript: text => { seen.transcript = text; },
      onKeytermCorrection: (from, to) => { seen.correction = `${from}->${to}`; },
    });
    expect(seen.utterance).toBe("帮我换成ZF001的声音");   // raw: the ASR test set stays honest
    expect(seen.transcript).toBe("帮我换成zf_001的声音"); // corrected: what the model and captions see
    expect(seen.correction).toBe("ZF001->zf_001");
    expect(llmSaw).toBe("帮我换成zf_001的声音");
  });
});

describe("runConversation etiquette", () => {
  const base = {
    language: "zh", chunking, ttsDefaults, voice: "demo",
    allowBargeIn: true, turnTaking: "conservative" as const, reopenMs: 7_000,
  };

  function capturingTts(): { inputs: string[]; speech: (input: { input: string }) => Promise<Uint8Array> } {
    const inputs: string[] = [];
    return {
      inputs,
      speech: async ({ input }) => {
        inputs.push(input);
        return new Uint8Array(writeWav(new Float32Array(4_800).fill(0.1), 24_000));
      },
    };
  }

  function fixedLlm(reply: string): ChatEngine {
    return { chatStream: async function* () { yield reply; } };
  }

  /** Wall-clock frames: a settle-gated burst per utterance, then silence until stopped. */
  function etiquetteFrames(
    session: DuplexSession,
    utterances: number,
    stopped: () => boolean,
    trailingSilence: boolean,
  ): AsyncIterable<ConversationFrame> {
    const wait = (predicate: () => boolean): Promise<void> => new Promise(resolve => {
      const poll = (): void => { predicate() ? resolve() : setTimeout(poll, 5); };
      poll();
    });
    return (async function* () {
      for (let index = 0; index < utterances; index += 1) {
        // Speak only into an idle session: never race the welcome or a reply.
        await wait(() => session.snapshot().state === "listening" && !stopped());
        if (stopped()) return;
        yield { samples: new Float32Array(320).fill(0.2), timestampMs: Date.now() };
        yield { samples: new Float32Array(320).fill(0.2), timestampMs: Date.now() };
        yield { samples: new Float32Array(320), timestampMs: Date.now() };
        await wait(() => session.snapshot().state !== "listening" || stopped());
        await wait(() => session.snapshot().state === "listening" || stopped());
      }
      while (trailingSilence && !stopped()) {
        await new Promise(resolve => setTimeout(resolve, 10));
        yield { samples: new Float32Array(320), timestampMs: Date.now() };
      }
    })();
  }

  async function runEtiquette(options: {
    llm: ChatEngine;
    extra: Record<string, unknown>;
    utterances: number;
    trailingSilence?: boolean;
    until?: (replies: string[]) => boolean;
  }): Promise<{ replies: string[]; ttsInputs: string[] }> {
    const session = new DuplexSession();
    session.start();
    const tts = capturingTts();
    const replies: string[] = [];
    let finished = false;
    const timer = setTimeout(() => { finished = true; session.close(); }, 3_000);
    await runConversation({
      session,
      vad: new EnergyVadSegmenter({ sampleRate: 16_000, threshold: 0.1, minSpeechMs: 40, silenceMs: 20 }),
      frames: etiquetteFrames(session, options.utterances, () => finished, options.trailingSilence ?? false),
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
      asr: { transcribe: async () => ({ text: "讲个笑话" }) },
      llm: options.llm,
      tts,
    }, { ...base, ...options.extra } as Parameters<typeof runConversation>[1], {
      onReply: text => {
        replies.push(text);
        if (options.until?.(replies)) {
          finished = true;
          session.close();
        }
      },
    });
    clearTimeout(timer);
    return { replies, ttsInputs: tts.inputs };
  }

  test("the welcome speaks first, enters history, and the reply follows", async () => {
    const llm = fixedLlm("哈哈，好的。");
    const seen: number[] = [];
    const counting: ChatEngine = {
      chatStream: async function* (messages) {
        seen.push(messages.length);
        yield* llm.chatStream([], undefined, undefined);
      },
    };
    const { replies, ttsInputs } = await runEtiquette({
      llm: counting,
      extra: { welcome: "你好，我在。" },
      utterances: 1,
      until: replies => replies.length >= 2,
    });
    expect(replies[0]).toBe("你好，我在。");
    expect(ttsInputs[0]).toBe("你好，我在。");
    // The model sees the welcome as history: assistant welcome + user (no system configured).
    expect(seen[0]).toBe(2);
    expect(replies[1]).toBe("哈哈，好的。");
  });

  test("the nudge fires once into silence and never repeats", async () => {
    const { replies, ttsInputs } = await runEtiquette({
      llm: fixedLlm("好的。"),
      extra: { nudgeAfterSeconds: 0.08, nudgeText: "还在吗？" },
      utterances: 1,
      trailingSilence: true,
      until: replies => replies.length >= 2 && Date.now() > 0,
    });
    // Give the silence window time to prove there is no second nudge.
    expect(replies).toEqual(["好的。", "还在吗？"]);
    expect(ttsInputs.filter(input => input === "还在吗？").length).toBe(1);
  });

  test("pronunciations change what the engine speaks and nothing the captions see", async () => {
    const { replies, ttsInputs } = await runEtiquette({
      llm: fixedLlm("欢迎使用 VoxStudio。"),
      extra: { pronunciations: { VoxStudio: "沃克斯" } },
      utterances: 1,
      until: replies => replies.length >= 1,
    });
    expect(replies[0]).toBe("欢迎使用 VoxStudio。");
    expect(ttsInputs.some(input => input.includes("沃克斯"))).toBe(true);
    expect(ttsInputs.some(input => input.includes("VoxStudio"))).toBe(false);
  });
});
