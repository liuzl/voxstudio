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

async function collect(tts: SpeechEngine, text = fixture.text): Promise<Float32Array[]> {
  const pieces: Float32Array[] = [];
  for await (const piece of streamLong(tts, text, options)) pieces.push(piece.samples);
  return pieces;
}

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
});
