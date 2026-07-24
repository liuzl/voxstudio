import { describe, expect, test } from "bun:test";
import cases from "../../../fixtures/audio/cases.json" with { type: "json" };
import {
  decodePcm16,
  encodePcm16,
  LinearResampler,
  matchLoudness,
  readWav,
  speechLevelDb,
  trimEdgeSilence,
  writeWav,
  wavHeader,
} from "./index";

function tone(
  sampleRate: number,
  seconds: number,
  lead = 0,
  tail = 0,
  gain = 1,
): Float32Array {
  const body = new Float32Array(Math.floor(sampleRate * seconds));
  for (let index = 0; index < body.length; index += 1) {
    body[index] = gain * 0.5 * Math.sin(2 * Math.PI * 220 * index / sampleRate);
  }
  const output = new Float32Array(
    Math.floor(sampleRate * lead) + body.length + Math.floor(sampleRate * tail),
  );
  output.set(body, Math.floor(sampleRate * lead));
  return output;
}

function wavFixture(format: 1 | 3, bits: 16 | 24 | 32, frames: number[][]): Uint8Array {
  const channels = frames[0]?.length ?? 1;
  const width = bits / 8;
  const output = new Uint8Array(44 + frames.length * channels * width);
  const view = new DataView(output.buffer);
  const label = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  label(0, "RIFF");
  view.setUint32(4, output.length - 8, true);
  label(8, "WAVE");
  label(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 16_000 * channels * width, true);
  view.setUint16(32, channels * width, true);
  view.setUint16(34, bits, true);
  label(36, "data");
  view.setUint32(40, output.length - 44, true);
  let offset = 44;
  for (const frame of frames) {
    for (const sample of frame) {
      if (format === 3) {
        view.setFloat32(offset, sample, true);
      } else if (bits === 16) {
        view.setInt16(offset, Math.round(sample * 32768), true);
      } else {
        const value = Math.round(sample * 8388608);
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setUint8(offset + 2, (value >> 16) & 0xff);
      }
      offset += width;
    }
  }
  return output;
}

describe("WAV codec", () => {
  test("PCM16 round trips mono samples", () => {
    const source = Float32Array.from([-1, -0.5, 0, 0.5, 0.999]);
    const decoded = readWav(writeWav(source, 16_000));
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.samples.length).toBe(source.length);
    for (let index = 0; index < source.length; index += 1) {
      expect(decoded.samples[index] as number).toBeCloseTo(source[index] as number, 4);
    }
  });

  test("invalid input and sample rates are rejected", () => {
    expect(() => readWav(new Uint8Array([1, 2, 3]))).toThrow("RIFF/WAVE");
    expect(() => writeWav(new Float32Array(), 0)).toThrow("sample rate");
    expect(() => wavHeader(48_000, 0x8000_0000)).toThrow("RIFF size limit");
  });

  test("stereo float32 is downmixed to mono", () => {
    const decoded = readWav(wavFixture(3, 32, [[0.5, -0.5], [1, 0]]));
    expect(decoded.samples).toEqual(Float32Array.from([0, 0.5]));
  });

  test("signed PCM24 is decoded", () => {
    const decoded = readWav(wavFixture(1, 24, [[-0.5], [0.5]]));
    expect(decoded.samples[0] as number).toBeCloseTo(-0.5, 6);
    expect(decoded.samples[1] as number).toBeCloseTo(0.5, 6);
  });

  test("unknown compressed WAV formats are rejected", () => {
    const wav = writeWav(Float32Array.from([0]), 8_000);
    new DataView(wav.buffer).setUint16(20, 6, true);
    expect(() => readWav(wav)).toThrow("unsupported WAV format 6");
  });
});

describe("shared audio fixtures", () => {
  for (const fixture of cases.trim) {
    test(`trim: ${fixture.name}`, () => {
      const samples = tone(
        fixture.rate,
        fixture.toneSeconds,
        fixture.leadSeconds,
        fixture.tailSeconds,
      );
      const trimmed = trimEdgeSilence(samples, fixture.rate, 25, fixture.padMs);
      expect(Math.abs(trimmed.length - fixture.expectedLength)).toBeLessThanOrEqual(fixture.tolerance);
    });
  }

});

describe("level handling", () => {
  test("matches speech level to a target", () => {
    const loud = tone(8_000, 0.4, 0, 0, 1);
    const quiet = tone(8_000, 0.4, 0, 0, 0.1);
    const matched = matchLoudness(quiet, 8_000, speechLevelDb(loud, 8_000));
    expect(speechLevelDb(matched, 8_000)).toBeCloseTo(speechLevelDb(loud, 8_000), 4);
  });

});

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

describe("decodePcm16", () => {
  test("round-trips through encodePcm16 within quantization error", () => {
    const input = Float32Array.from({ length: 200 }, (_, index) => Math.sin(index / 10) * 0.8);
    const decoded = decodePcm16(encodePcm16(input));
    expect(decoded.length).toBe(input.length);
    for (let index = 0; index < input.length; index += 1) {
      expect(Math.abs((decoded[index] as number) - (input[index] as number))).toBeLessThan(1 / 32768);
    }
  });

  test("ignores a trailing odd byte", () => {
    expect(decodePcm16(new Uint8Array([0, 0, 255])).length).toBe(1);
  });
});
