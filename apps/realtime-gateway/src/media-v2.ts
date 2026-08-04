/** Fixed, allocation-safe binary framing for VoxStudio WebSocket Media v2. */
export const mediaV2Version = 2;
export const mediaV2HeaderBytes = 56;
export const mediaV2MaxPayloadBytes = 1024 * 1024;

export const mediaV2FlagStart = 1 << 0;
export const mediaV2FlagEnd = 1 << 1;
export const mediaV2FlagDiscontinuity = 1 << 2;
const knownFlags = mediaV2FlagStart | mediaV2FlagEnd | mediaV2FlagDiscontinuity;

export type MediaV2Kind = "playback" | "capture";
export type MediaV2Codec = "pcm_s16le" | "opus" | "pcm_f32le";

export interface MediaV2Frame {
  kind: MediaV2Kind;
  codec: MediaV2Codec;
  flags: number;
  streamId: string;
  sequence: number;
  timestampSamples: bigint;
  durationSamples: number;
  sampleRate: number;
  channels: number;
  payload: Uint8Array;
}

const magic = Uint8Array.of(0x56, 0x4f, 0x58, 0x32); // "VOX2"
const kindIds: Record<MediaV2Kind, number> = { playback: 1, capture: 2 };
const codecIds: Record<MediaV2Codec, number> = { pcm_s16le: 1, opus: 2, pcm_f32le: 3 };
const kinds = new Map<number, MediaV2Kind>(Object.entries(kindIds).map(([name, id]) => [id, name as MediaV2Kind]));
const codecs = new Map<number, MediaV2Codec>(Object.entries(codecIds).map(([name, id]) => [id, name as MediaV2Codec]));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function integer(name: string, value: number, maximum = 0xffff_ffff): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function uuidBytes(value: string): Uint8Array {
  if (!uuidPattern.test(value)) throw new TypeError("streamId must be a canonical UUID");
  const hex = value.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function uuidString(bytes: Uint8Array): string {
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validatePayload(codec: MediaV2Codec, flags: number, durationSamples: number, channels: number, bytes: number): void {
  if ((flags & mediaV2FlagEnd) !== 0 && durationSamples === 0 && bytes === 0) return;
  const width = codec === "pcm_s16le" ? 2 : codec === "pcm_f32le" ? 4 : undefined;
  if (width !== undefined && bytes !== durationSamples * channels * width) {
    throw new TypeError(`${codec} payload length does not match durationSamples and channels`);
  }
  if (durationSamples === 0 || bytes === 0) throw new TypeError("non-terminal media frames must contain audio");
}

export function isMediaV2Frame(input: ArrayBuffer | Uint8Array): boolean {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return bytes.byteLength >= 4 && magic.every((value, index) => bytes[index] === value);
}

export function encodeMediaV2Frame(frame: MediaV2Frame): Uint8Array {
  const sequence = integer("sequence", frame.sequence);
  const durationSamples = integer("durationSamples", frame.durationSamples);
  const sampleRate = integer("sampleRate", frame.sampleRate);
  const channels = integer("channels", frame.channels, 255);
  const flags = integer("flags", frame.flags, 255);
  if (sampleRate === 0 || channels === 0) throw new TypeError("sampleRate and channels must be positive");
  if ((flags & ~knownFlags) !== 0) throw new TypeError("media flags contain unsupported bits");
  if (frame.timestampSamples < 0n || frame.timestampSamples > 0xffff_ffff_ffff_ffffn) {
    throw new TypeError("timestampSamples must fit an unsigned 64-bit integer");
  }
  if (frame.payload.byteLength > mediaV2MaxPayloadBytes) throw new TypeError("media payload exceeds the 1 MiB limit");
  validatePayload(frame.codec, flags, durationSamples, channels, frame.payload.byteLength);

  const output = new Uint8Array(mediaV2HeaderBytes + frame.payload.byteLength);
  output.set(magic, 0);
  const view = new DataView(output.buffer);
  view.setUint8(4, mediaV2Version);
  view.setUint8(5, kindIds[frame.kind]);
  view.setUint8(6, codecIds[frame.codec]);
  view.setUint8(7, flags);
  view.setUint16(8, mediaV2HeaderBytes, true);
  view.setUint8(10, channels);
  view.setUint8(11, 0);
  view.setUint32(12, sampleRate, true);
  view.setUint32(16, sequence, true);
  view.setUint32(20, durationSamples, true);
  view.setBigUint64(24, frame.timestampSamples, true);
  view.setUint32(32, frame.payload.byteLength, true);
  view.setUint32(36, 0, true);
  output.set(uuidBytes(frame.streamId), 40);
  output.set(frame.payload, mediaV2HeaderBytes);
  return output;
}

export function parseMediaV2Frame(input: ArrayBuffer | Uint8Array): MediaV2Frame {
  const bytes = input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  if (!isMediaV2Frame(bytes)) throw new TypeError("not a VoxStudio Media v2 frame");
  if (bytes.byteLength < mediaV2HeaderBytes) throw new TypeError("truncated Media v2 header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== mediaV2Version) throw new TypeError(`unsupported media version ${view.getUint8(4)}`);
  const kind = kinds.get(view.getUint8(5));
  const codec = codecs.get(view.getUint8(6));
  if (kind === undefined) throw new TypeError(`unsupported media kind ${view.getUint8(5)}`);
  if (codec === undefined) throw new TypeError(`unsupported media codec ${view.getUint8(6)}`);
  const flags = view.getUint8(7);
  if ((flags & ~knownFlags) !== 0) throw new TypeError("media flags contain unsupported bits");
  if (view.getUint16(8, true) !== mediaV2HeaderBytes) throw new TypeError("unsupported Media v2 header size");
  if (view.getUint8(11) !== 0 || view.getUint32(36, true) !== 0) throw new TypeError("reserved Media v2 fields must be zero");
  const channels = view.getUint8(10);
  const sampleRate = view.getUint32(12, true);
  const durationSamples = view.getUint32(20, true);
  const payloadBytes = view.getUint32(32, true);
  if (channels === 0 || sampleRate === 0) throw new TypeError("sampleRate and channels must be positive");
  if (payloadBytes > mediaV2MaxPayloadBytes) throw new TypeError("media payload exceeds the 1 MiB limit");
  if (bytes.byteLength !== mediaV2HeaderBytes + payloadBytes) throw new TypeError("Media v2 payload length mismatch");
  validatePayload(codec, flags, durationSamples, channels, payloadBytes);
  return {
    kind,
    codec,
    flags,
    streamId: uuidString(bytes.subarray(40, 56)),
    sequence: view.getUint32(16, true),
    timestampSamples: view.getBigUint64(24, true),
    durationSamples,
    sampleRate,
    channels,
    payload: bytes.subarray(mediaV2HeaderBytes),
  };
}
