import { describe, expect, test } from "bun:test";
import { LinearResampler, PlaybackTimeline } from "./audio";

describe("LinearResampler", () => {
  test("passes input through unchanged when rates match", () => {
    const resampler = new LinearResampler(16_000, 16_000);
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampler.push(input)).toBe(input);
  });

  test("halves the sample count for a 2:1 downsample, independent of chunking", () => {
    const long = new LinearResampler(48_000, 24_000);
    const ramp = Float32Array.from({ length: 480 }, (_, index) => index / 480);
    const whole = long.push(ramp);

    const chunked = new LinearResampler(48_000, 24_000);
    const pieces: number[] = [];
    for (let offset = 0; offset < ramp.length; offset += 96) {
      pieces.push(...chunked.push(ramp.slice(offset, offset + 96)));
    }
    // Chunk boundaries must not change the output stream.
    expect(pieces.length).toBe(whole.length);
    for (let index = 0; index < whole.length; index += 1) {
      expect(Math.abs((pieces[index] as number) - (whole[index] as number))).toBeLessThan(1e-6);
    }
    expect(whole.length).toBeGreaterThanOrEqual(239);
    expect(whole.length).toBeLessThanOrEqual(240);
  });

  test("interpolates a linear ramp exactly", () => {
    const resampler = new LinearResampler(32_000, 16_000);
    const ramp = Float32Array.from({ length: 100 }, (_, index) => index);
    const output = resampler.push(ramp);
    for (let index = 1; index < output.length; index += 1) {
      expect((output[index] as number) - (output[index - 1] as number)).toBeCloseTo(2, 5);
    }
  });

  test("48k to 16k keeps a 20ms cadence over time", () => {
    const resampler = new LinearResampler(48_000, 16_000);
    let total = 0;
    for (let chunk = 0; chunk < 100; chunk += 1) {
      total += resampler.push(new Float32Array(128)).length;
    }
    // 12800 input samples → ~4266 output samples; drift beyond one sample means the
    // stream is stretching or compressing.
    expect(Math.abs(total - 12_800 / 3)).toBeLessThanOrEqual(1);
  });
});

describe("PlaybackTimeline", () => {
  test("schedules gaplessly and reports the audible remainder", () => {
    const timeline = new PlaybackTimeline(0.05);
    const first = timeline.schedule(1, 0);
    expect(first).toBeCloseTo(0.05);
    const second = timeline.schedule(0.5, 0.2);
    // The second chunk starts where the first ends, not at now+lead.
    expect(second).toBeCloseTo(1.05);
    expect(timeline.remainingSec(0.2)).toBeCloseTo(1.35);
    expect(timeline.remainingSec(2)).toBeCloseTo(0);
  });

  test("a drained queue restarts from now plus the lead", () => {
    const timeline = new PlaybackTimeline(0.05);
    timeline.schedule(0.1, 0);
    const late = timeline.schedule(0.1, 5);
    expect(late).toBeCloseTo(5.05);
  });

  test("reset clears the playhead after an interruption", () => {
    const timeline = new PlaybackTimeline(0.05);
    timeline.schedule(10, 0);
    timeline.reset();
    expect(timeline.remainingSec(0)).toBe(0);
    expect(timeline.schedule(1, 0)).toBeCloseTo(0.05);
  });
});
