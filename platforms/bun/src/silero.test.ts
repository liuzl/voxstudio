import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EnergyVadSegmenter, SileroVadSegmenter, type VadSegmenter } from "@voxstudio/duplex-session";
import { clickTrain, frameSamples, hum, sampleRate, steadyNoise } from "../tools/vad-corpus";
import { loadSileroVadModel } from "./silero";

// These tests exercise the real ONNX model from the verified local cache. On a
// machine that has never run the VAD (fresh CI), they skip rather than reach for
// the network — the compiled-binary gate and the AEC gate cover the live paths.
const cached = process.env.VOXSTUDIO_SILERO_VAD
  ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "voxstudio", "silero-vad-v5.1.2.onnx");
const haveModel = existsSync(cached);

/** A deterministic speech-ish chirp, distinct per seed. */
function frame(seed: number, index: number): Float32Array {
  const out = new Float32Array(512);
  for (let sample = 0; sample < out.length; sample += 1) {
    const t = (index * 512 + sample) / 16_000;
    out[sample] = 0.3 * Math.sin(2 * Math.PI * (150 + 60 * seed + 40 * Math.sin(t * 3)) * t);
  }
  return out;
}

describe.skipIf(!haveModel)("silero VAD shared backend", () => {
  test("two streams on the shared session keep independent recurrent state", async () => {
    // The reference: each signal scored alone on a fresh model.
    const aloneA = await loadSileroVadModel();
    const soloA: number[] = [];
    for (let i = 0; i < 6; i += 1) soloA.push(await aloneA.process(frame(1, i)));
    const aloneB = await loadSileroVadModel();
    const soloB: number[] = [];
    for (let i = 0; i < 6; i += 1) soloB.push(await aloneB.process(frame(4, i)));

    // The race: both signals interleaved through two models sharing one session,
    // every window fired without awaiting the other stream.
    const modelA = await loadSileroVadModel();
    const modelB = await loadSileroVadModel();
    const mixedA: number[] = [];
    const mixedB: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const [a, b] = await Promise.all([modelA.process(frame(1, i)), modelB.process(frame(4, i))]);
      mixedA.push(a);
      mixedB.push(b);
    }
    // Interleaving must not bleed state between streams: identical to the solo runs.
    expect(mixedA).toEqual(soloA);
    expect(mixedB).toEqual(soloB);
    // And the two signals are genuinely different work, not one stream twice.
    expect(mixedA).not.toEqual(mixedB);
  });

  test("reset returns a stream to its from-scratch outputs", async () => {
    const model = await loadSileroVadModel();
    const first: number[] = [];
    for (let i = 0; i < 4; i += 1) first.push(await model.process(frame(2, i)));
    model.reset();
    const again: number[] = [];
    for (let i = 0; i < 4; i += 1) again.push(await model.process(frame(2, i)));
    expect(again).toEqual(first);
  });

  test("silero rejects the non-speech negatives the energy detector confirms", async () => {
    // The 2026-07-22 A/B, kept as a regression: over the deterministic negative
    // corpus — all above the shared 0.01 RMS level floor — the energy detector
    // confirms "speech" repeatedly (its indifference to speech-likeness is why it
    // is only the fallback) while silero confirms nothing. If silero ever starts
    // confirming these, the default detector got worse than its fallback.
    const negatives = [clickTrain(30, 0.3), steadyNoise(30, 0.05), hum(30, 0.05)];
    const confirmsOf = async (segmenter: VadSegmenter, samples: Float32Array): Promise<number> => {
      segmenter.reset();
      let confirmed = 0;
      for (let offset = 0; offset < samples.length; offset += frameSamples) {
        const events = await segmenter.push(samples.subarray(offset, Math.min(offset + frameSamples, samples.length)), 1_000 * offset / sampleRate);
        for (const event of events) if (event.type === "speech.confirmed") confirmed += 1;
      }
      return confirmed;
    };
    const energy = new EnergyVadSegmenter({ sampleRate });
    const silero = new SileroVadSegmenter({ model: await loadSileroVadModel() });
    let energyTotal = 0;
    let sileroTotal = 0;
    for (const clip of negatives) {
      energyTotal += await confirmsOf(energy, clip);
      sileroTotal += await confirmsOf(silero, clip);
    }
    expect(sileroTotal).toBe(0);
    // The corpus is loud enough to fool a level threshold — that being true is
    // part of what the test asserts (otherwise "silero confirms nothing" is vacuous).
    expect(energyTotal).toBeGreaterThan(0);
  });

  test("session churn allocates per-stream state only — a hundred loads stay cheap", async () => {
    // The leak shape the adversarial review called out: connect, converse,
    // disconnect, repeat. With the shared session, each load is a 320-float view;
    // a hundred of them must be quick and must all still work.
    const started = performance.now();
    for (let churn = 0; churn < 100; churn += 1) {
      const model = await loadSileroVadModel();
      const probability = await model.process(frame(3, churn));
      expect(Number.isFinite(probability)).toBe(true);
    }
    // Well under one backend construction each; generous bound to stay unflaky.
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
