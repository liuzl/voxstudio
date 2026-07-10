export interface PcmAudio {
  samples: Float32Array;
  sampleRate: number;
}

const frameMs = 10;

function ascii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function readWav(input: ArrayBuffer | Uint8Array): PcmAudio {
  const bytes = input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") {
    throw new TypeError("not a RIFF/WAVE file");
  }

  let format: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bits: number | undefined;
  let blockAlign: number | undefined;
  let dataOffset: number | undefined;
  let dataLength: number | undefined;

  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const id = ascii(view, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + length > bytes.byteLength) throw new TypeError(`truncated WAV ${id} chunk`);
    if (id === "fmt ") {
      if (length < 16) throw new TypeError("WAV fmt chunk is too short");
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && length >= 40) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = length;
    }
    offset = body + length + (length & 1);
  }

  if (format === undefined || channels === undefined || sampleRate === undefined
      || bits === undefined || blockAlign === undefined || dataOffset === undefined
      || dataLength === undefined) {
    throw new TypeError("WAV is missing fmt or data metadata");
  }
  if (channels < 1 || sampleRate < 1 || blockAlign < 1) throw new TypeError("invalid WAV format");
  if (format !== 1 && format !== 3) throw new TypeError(`unsupported WAV format ${format}`);
  const bytesPerSample = bits / 8;
  if (!Number.isInteger(bytesPerSample) || blockAlign < bytesPerSample * channels) {
    throw new TypeError("invalid WAV sample width");
  }
  const frames = Math.floor(dataLength / blockAlign);
  const samples = new Float32Array(frames);

  const decode = (offset: number): number => {
    if (format === 3 && bits === 32) return view.getFloat32(offset, true);
    if (format === 3 && bits === 64) return view.getFloat64(offset, true);
    if (format !== 1) throw new TypeError(`unsupported float WAV width ${bits}`);
    if (bits === 8) return (view.getUint8(offset) - 128) / 128;
    if (bits === 16) return view.getInt16(offset, true) / 32768;
    if (bits === 24) {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8)
        | (view.getUint8(offset + 2) << 16);
      if (value & 0x800000) value |= 0xff000000;
      return value / 8388608;
    }
    if (bits === 32) return view.getInt32(offset, true) / 2147483648;
    throw new TypeError(`unsupported PCM WAV width ${bits}`);
  };

  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const base = dataOffset + frame * blockAlign;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += decode(base + channel * bytesPerSample);
    }
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate };
}

export function writeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new TypeError("invalid sample rate");
  const output = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(output.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, output.length - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(32767 / 32768, samples[index] as number));
    view.setInt16(44 + index * 2, Math.round(sample * 32768), true);
  }
  return output;
}

function frameDb(samples: Float32Array, sampleRate: number): number[] {
  const frame = Math.max(1, Math.floor(sampleRate * frameMs / 1000));
  const count = Math.floor(samples.length / frame);
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    let squares = 0;
    const start = index * frame;
    for (let offset = 0; offset < frame; offset += 1) {
      const value = samples[start + offset] as number;
      squares += value * value;
    }
    result.push(20 * Math.log10(Math.sqrt(squares / frame) + 1e-12));
  }
  return result;
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return -120;
  const position = (sorted.length - 1) * quantile;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const weight = position - low;
  return (sorted[low] as number) * (1 - weight) + (sorted[high] as number) * weight;
}

export function speechLevelDb(samples: Float32Array, sampleRate: number): number {
  const levels = frameDb(samples, sampleRate);
  if (levels.length === 0) return -120;
  const peak = Math.max(...levels);
  if (peak <= -119) return -120;
  const voiced = levels.filter((level) => level > peak - 40);
  return voiced.length ? percentile(voiced, 0.6) : -120;
}

export function trimEdgeSilence(
  samples: Float32Array,
  sampleRate: number,
  floorBelowSpeechDb = 25,
  padMs = 40,
): Float32Array {
  const levels = frameDb(samples, sampleRate);
  if (levels.length === 0) return samples.slice(0, 0);
  const level = speechLevelDb(samples, sampleRate);
  if (level <= -119) return samples.slice(0, 0);
  const threshold = level - floorBelowSpeechDb;
  const voiced: number[] = [];
  for (let index = 0; index < levels.length; index += 1) {
    if ((levels[index] as number) > threshold) voiced.push(index);
  }
  if (voiced.length === 0) return samples.slice(0, 0);
  const frame = Math.max(1, Math.floor(sampleRate * frameMs / 1000));
  const pad = Math.floor(sampleRate * padMs / 1000);
  const start = Math.max(0, (voiced[0] as number) * frame - pad);
  const end = Math.min(
    samples.length,
    ((voiced[voiced.length - 1] as number) + 1) * frame + pad,
  );
  return samples.slice(start, end);
}

export function matchLoudness(
  samples: Float32Array,
  sampleRate: number,
  targetDb: number,
): Float32Array {
  const level = speechLevelDb(samples, sampleRate);
  if (level <= -119) return samples;
  const gain = 10 ** ((targetDb - level) / 20);
  return Float32Array.from(samples, (sample) => sample * gain);
}

function concatenate(parts: Float32Array[]): Float32Array {
  const output = new Float32Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function joinChunks(
  wavs: ReadonlyArray<ArrayBuffer | Uint8Array>,
  pauseMs = 210,
  floorBelowSpeechDb = 25,
  padMs = 40,
): Uint8Array {
  if (wavs.length === 0) throw new TypeError("nothing to join");
  const decoded = wavs.map(readWav);
  const sampleRate = decoded[0]?.sampleRate as number;
  const rates = [...new Set(decoded.map((audio) => audio.sampleRate))];
  if (rates.length !== 1) throw new TypeError(`chunks disagree on sample rate: ${rates.join(", ")}`);
  const trimmed = decoded
    .map((audio) => trimEdgeSilence(audio.samples, sampleRate, floorBelowSpeechDb, padMs))
    .filter((samples) => samples.length > 0);
  if (trimmed.length === 0) return writeWav(new Float32Array(), sampleRate);

  const target = speechLevelDb(trimmed[0] as Float32Array, sampleRate);
  const leveled = [
    trimmed[0] as Float32Array,
    ...trimmed.slice(1).map((samples) => matchLoudness(samples, sampleRate, target)),
  ];
  const gapMs = Math.max(0, pauseMs - 2 * padMs);
  const pause = new Float32Array(Math.floor(sampleRate * gapMs / 1000));
  const pieces: Float32Array[] = [leveled[0] as Float32Array];
  for (const chunk of leveled.slice(1)) pieces.push(pause, chunk);
  return writeWav(concatenate(pieces), sampleRate);
}
