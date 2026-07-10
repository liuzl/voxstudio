import { describe, expect, test } from "bun:test";
import cases from "../../../fixtures/audio/cases.json" with { type: "json" };
import {
  joinChunks,
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

  for (const fixture of cases.join) {
    test(`join: ${fixture.name}`, () => {
      const chunks = fixture.chunks.map((chunk) => writeWav(tone(
        fixture.rate,
        chunk.toneSeconds,
        chunk.leadSeconds,
        chunk.tailSeconds,
        chunk.gain,
      ), fixture.rate));
      const decoded = readWav(joinChunks(chunks, fixture.pauseMs, 25, fixture.padMs));
      expect(decoded.sampleRate).toBe(fixture.rate);
      expect(Math.abs(decoded.samples.length - fixture.expectedLength))
        .toBeLessThanOrEqual(fixture.tolerance);
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

  test("all-silent chunks join to an empty WAV", () => {
    const decoded = readWav(joinChunks([writeWav(new Float32Array(800), 8_000)]));
    expect(decoded.samples.length).toBe(0);
  });

  test("mixed sample rates are rejected", () => {
    expect(() => joinChunks([
      writeWav(new Float32Array(100), 8_000),
      writeWav(new Float32Array(100), 16_000),
    ])).toThrow("sample rate");
  });
});
