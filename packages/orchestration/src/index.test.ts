import { describe, expect, test } from "bun:test";
import { readWav, writeWav } from "@voxstudio/audio";
import type {
  ChunkConfig,
  SpeechInput,
  TtsDefaults,
} from "@voxstudio/contracts";
import fixture from "../../../fixtures/orchestration/stream.json" with { type: "json" };
import {
  type SpeechEngine,
  type SynthesisOptions,
  streamLong,
  streamReply,
  synthesizeLong,
} from "./index";

const chunking: ChunkConfig = {
  maxSeconds: 0.4,
  firstMaxSeconds: 0.4,
  growth: 2,
  sentenceEnders: "。！？；!?;.;।॥؟۔។៕။",
  joinPauseMs: 250,
  trimFloorDb: 25,
  edgePadMs: 0,
};
const ttsDefaults: TtsDefaults = {
  voice: "clone",
  cfgValue: 2,
  timesteps: 10,
  responseFormat: "wav",
};
const options: SynthesisOptions = { chunking, ttsDefaults };

function response(sampleRate = fixture.sampleRate, silent = false): Uint8Array {
  const body = new Float32Array(Math.floor(sampleRate * 0.4));
  if (!silent) {
    for (let index = 0; index < body.length; index += 1) {
      body[index] = 0.5 * Math.sin(2 * Math.PI * 220 * index / sampleRate);
    }
  }
  const pad = new Float32Array(Math.floor(sampleRate * 0.2));
  const samples = new Float32Array(pad.length + body.length + pad.length);
  samples.set(body, pad.length);
  return writeWav(samples, sampleRate);
}

class FakeTts implements SpeechEngine {
  readonly calls: SpeechInput[] = [];

  async speech(input: SpeechInput): Promise<Uint8Array> {
    this.calls.push(input);
    return response();
  }
}

async function collect(
  tts: SpeechEngine,
  text = fixture.text,
  synthesis: SynthesisOptions = options,
): Promise<Float32Array[]> {
  const pieces: Float32Array[] = [];
  for await (const piece of streamLong(tts, text, synthesis)) pieces.push(piece.samples);
  return pieces;
}

describe("streaming reply orchestration", () => {
  // Conversation-scale chunking: the shared fixture's 0.4s caps exist to force splits in
  // the long-text tests, and would shred single sentences here.
  const replyChunking: ChunkConfig = { ...chunking, maxSeconds: 15, firstMaxSeconds: 8 };

  async function* deltas(parts: string[]): AsyncGenerator<string> {
    for (const part of parts) yield part;
  }

  async function drainReply(
    tts: SpeechEngine,
    parts: string[],
    extra: Partial<import("./index").StreamReplyOptions> = {},
  ) {
    const pieces: Float32Array[] = [];
    for await (const piece of streamReply(tts, deltas(parts), { ...options, chunking: replyChunking, ...extra })) {
      pieces.push(piece.samples);
    }
    return pieces;
  }

  test("synthesizes the first sentence as its own immediate chunk", async () => {
    const tts = new FakeTts();
    // Deltas split mid-sentence, the way a model streams tokens.
    await drainReply(tts, ["你好", "。今天天气", "很好。"]);
    expect(tts.calls.length).toBe(2);
    expect(tts.calls[0]?.input).toBe("你好。");
    expect(tts.calls[1]?.input).toBe("今天天气很好。");
  });

  test("marks only the final chunk as the continuation end", async () => {
    const tts = new FakeTts();
    await drainReply(tts, ["第一句。", "第二句。"], { continuationId: "reply-1" });
    expect(tts.calls.map(call => call.continuation_end)).toEqual([false, true]);
    expect(tts.calls.every(call => call.continuation_id === "reply-1")).toBe(true);
  });

  test("speaks an unpunctuated tail after the stream ends", async () => {
    const tts = new FakeTts();
    await drainReply(tts, ["好的。", "马上就来"], { continuationId: "reply-2" });
    expect(tts.calls.map(call => call.input)).toEqual(["好的。", "马上就来"]);
    expect(tts.calls[1]?.continuation_end).toBe(true);
  });

  test("a single-sentence reply is one chunk marked as the end", async () => {
    const tts = new FakeTts();
    await drainReply(tts, ["只有", "一句话。"], { continuationId: "reply-3" });
    expect(tts.calls.map(call => call.input)).toEqual(["只有一句话。"]);
    expect(tts.calls[0]?.continuation_end).toBe(true);
  });

  test("applies the chunk transform before synthesis and drops chunks it empties", async () => {
    const tts = new FakeTts();
    const pieces = await drainReply(tts, ["**你好。**", "正文继续。"], {
      transformChunk: (text: string) => text.replaceAll("*", ""),
    });
    expect(tts.calls.map(call => call.input)).toEqual(["你好。", "正文继续。"]);
    expect(pieces.length).toBeGreaterThan(0);
  });

  test("yields nothing for a stream with no speakable text", async () => {
    const tts = new FakeTts();
    const pieces = await drainReply(tts, ["   ", ""]);
    expect(tts.calls).toEqual([]);
    expect(pieces).toEqual([]);
  });
});

describe("streaming synthesis", () => {
  class StreamingTts extends FakeTts {
    readonly streamed: string[] = [];

    async *speechStream(input: SpeechInput): AsyncGenerator<{ samples: Float32Array; sampleRate: number }> {
      this.streamed.push(input.input);
      yield { samples: new Float32Array(100).fill(0.1), sampleRate: 48_000 };
      yield { samples: new Float32Array(100).fill(0.2), sampleRate: 48_000 };
    }
  }

  async function* one(text: string): AsyncGenerator<string> {
    yield text;
  }

  test("streams pieces through the engine's streaming endpoint when opted in", async () => {
    const tts = new StreamingTts();
    const pieces = [];
    for await (const piece of streamReply(tts, one("第一句。"), {
      ...options, chunking: { ...chunking, maxSeconds: 15, firstMaxSeconds: 8 }, streaming: true,
    })) pieces.push(piece);
    expect(tts.streamed).toEqual(["第一句。"]);
    expect(tts.calls).toEqual([]); // the batch endpoint was never touched
    expect(pieces).toHaveLength(2);
  });

  test("without the opt-in a streaming-capable engine still takes the batch path", async () => {
    const tts = new StreamingTts();
    const pieces = [];
    for await (const piece of streamReply(tts, one("第一句。"), {
      ...options, chunking: { ...chunking, maxSeconds: 15, firstMaxSeconds: 8 },
    })) pieces.push(piece);
    expect(tts.streamed).toEqual([]);
    expect(tts.calls.length).toBe(1);
  });
});

describe("long-text orchestration", () => {
  test("requests chunks serially in order with stable wire fields", async () => {
    const tts = new FakeTts();
    await collect(tts);
    expect(tts.calls.map((call) => call.input)).toEqual(fixture.expectedChunks);
    expect(tts.calls[0]).toMatchObject({
      voice: "clone",
      response_format: "wav",
      cfg_value: 2,
      timesteps: 10,
    });
  });

  test("yields the first chunk before requesting the rest", async () => {
    const tts = new FakeTts();
    const stream = streamLong(tts, fixture.text, options);
    await stream.next();
    expect(tts.calls.map((call) => call.input)).toEqual([fixture.expectedChunks[0] as string]);
    await stream.return(undefined);
  });

  test("marks one continuation session from its first through final chunk", async () => {
    const tts = new FakeTts();
    await collect(tts, "甲。乙。");
    // Re-run with a session so the final marker can be asserted independently.
    const calls: SpeechInput[] = [];
    const session: SpeechEngine = { speech: async (input) => { calls.push(input); return response(); } };
    for await (const _piece of streamLong(session, "甲。乙。", {
      ...options,
      continuationId: "session-1",
    })) { /* consume */ }
    expect(calls).toEqual([
      expect.objectContaining({ continuation_id: "session-1", continuation_end: false }),
      expect.objectContaining({ continuation_id: "session-1", continuation_end: true }),
    ]);
  });

  test("puts one pause between chunks and not around them", async () => {
    const pieces = await collect(new FakeTts());
    expect(pieces.length).toBe(fixture.expectedPieces);
    const silent = pieces.flatMap((piece, index) =>
      piece.every((sample) => Math.abs(sample) < 1e-6) ? [index] : []);
    expect(silent).toEqual(fixture.silentPieceIndexes);
    for (const index of silent) expect(pieces[index]?.length).toBe(fixture.pauseSamples);
  });

  test("collects the stream into one WAV", async () => {
    const decoded = readWav(await synthesizeLong(new FakeTts(), fixture.text, options));
    expect(decoded.sampleRate).toBe(fixture.sampleRate);
    expect(Math.abs(decoded.samples.length - fixture.outputSamples)).toBeLessThanOrEqual(400);
  });

  test("rejects empty text and an all-silent engine", async () => {
    await expect(collect(new FakeTts(), "   ")).rejects.toThrow("nothing to synthesize");
    const silent: SpeechEngine = { speech: async () => response(fixture.sampleRate, true) };
    await expect(synthesizeLong(silent, "甲。", options)).rejects.toThrow("no audio");
  });

  test("rejects a sample-rate change within one stream", async () => {
    let call = 0;
    const changing: SpeechEngine = {
      speech: async () => response(call++ === 0 ? 8_000 : 16_000),
    };
    await expect(collect(changing, "甲。乙。")).rejects.toThrow("sample rate");
  });

  test("does not request another TTS chunk after cancellation", async () => {
    const controller = new AbortController();
    const calls: SpeechInput[] = [];
    const engine: SpeechEngine = {
      speech: async input => {
        calls.push(input);
        controller.abort("barge_in");
        return response();
      },
    };
    await expect(collect(engine, "甲。乙。", { ...options, signal: controller.signal }))
      .rejects.toThrow("barge_in");
    expect(calls).toHaveLength(1);
  });
});

describe("first-chunk clause fast path", () => {
  const replyChunking: ChunkConfig = {
    ...chunking, maxSeconds: 15, firstMaxSeconds: 8, firstClauseSeconds: 1.2,
  };

  async function* deltas(parts: string[]): AsyncGenerator<string> {
    for (const part of parts) yield part;
  }

  async function drainReply(tts: SpeechEngine, parts: string[], chunkingOverride: ChunkConfig) {
    const pieces: Float32Array[] = [];
    for await (const piece of streamReply(tts, deltas(parts), { ...options, chunking: chunkingOverride })) {
      pieces.push(piece.samples);
    }
    return pieces;
  }

  test("the first chunk may end at a clause boundary; later chunks keep the sentence rule", async () => {
    const tts = new FakeTts();
    await drainReply(tts, ["今天的天气非常不错，", "适合出去走走，", "或者去公园。"], replyChunking);
    expect(tts.calls[0]?.input).toBe("今天的天气非常不错，");
    // The rest waits for its sentence ender: the fast path is first-chunk-only.
    expect(tts.calls.slice(1).map(call => call.input).join("")).toBe("适合出去走走，或者去公园。");
  });

  test("a clause still too short keeps waiting for the sentence", async () => {
    const tts = new FakeTts();
    await drainReply(tts, ["好的，", "我来帮你查一下今天的天气。"], replyChunking);
    expect(tts.calls[0]?.input).toBe("好的，我来帮你查一下今天的天气。");
  });

  test("without firstClauseSeconds the sentence rule stands", async () => {
    const tts = new FakeTts();
    const { firstClauseSeconds: _unused, ...sentenceOnly } = replyChunking;
    await drainReply(tts, ["今天的天气非常不错，", "适合出去走走。"], sentenceOnly);
    expect(tts.calls[0]?.input).toBe("今天的天气非常不错，适合出去走走。");
  });
});
