import { describe, expect, test } from "bun:test";
import {
  encodeMediaV2Frame,
  mediaV2FlagEnd,
  mediaV2FlagStart,
  mediaV2HeaderBytes,
  parseMediaV2Frame,
} from "./media-v2";
import { parseCommand, protocolVersion } from "./protocol";

const streamId = "00112233-4455-6677-8899-aabbccddeeff";

describe("WebSocket Media v2 binary envelope", () => {
  test("is frozen by a little-endian golden vector", () => {
    const encoded = encodeMediaV2Frame({
      kind: "playback",
      codec: "pcm_s16le",
      flags: mediaV2FlagStart,
      streamId,
      sequence: 0x01020304,
      timestampSamples: 0x0102030405060708n,
      durationSamples: 2,
      sampleRate: 24_000,
      channels: 1,
      payload: Uint8Array.of(0x34, 0x12, 0xcc, 0xed),
    });
    expect(Buffer.from(encoded).toString("hex")).toBe(
      "564f58320201010138000100c05d0000040302010200000008070605040302010400000000000000"
      + "00112233445566778899aabbccddeeff3412cced",
    );
    expect(parseMediaV2Frame(encoded)).toEqual({
      kind: "playback",
      codec: "pcm_s16le",
      flags: mediaV2FlagStart,
      streamId,
      sequence: 0x01020304,
      timestampSamples: 0x0102030405060708n,
      durationSamples: 2,
      sampleRate: 24_000,
      channels: 1,
      payload: Uint8Array.of(0x34, 0x12, 0xcc, 0xed),
    });
  });

  test("accepts an empty terminal marker and rejects malformed allocation claims", () => {
    const terminal = encodeMediaV2Frame({
      kind: "playback",
      codec: "pcm_s16le",
      flags: mediaV2FlagEnd,
      streamId,
      sequence: 7,
      timestampSamples: 960n,
      durationSamples: 0,
      sampleRate: 24_000,
      channels: 1,
      payload: new Uint8Array(0),
    });
    expect(terminal).toHaveLength(mediaV2HeaderBytes);
    const malformed = terminal.slice();
    new DataView(malformed.buffer).setUint32(32, 1_048_577, true);
    expect(() => parseMediaV2Frame(malformed)).toThrow("1 MiB");
    expect(() => parseMediaV2Frame(terminal.subarray(0, 20))).toThrow("truncated");
  });

  test("rejects PCM payloads that disagree with their declared sample duration", () => {
    expect(() => encodeMediaV2Frame({
      kind: "playback",
      codec: "pcm_s16le",
      flags: 0,
      streamId,
      sequence: 0,
      timestampSamples: 0n,
      durationSamples: 20,
      sampleRate: 24_000,
      channels: 1,
      payload: new Uint8Array(20),
    })).toThrow("payload length");
  });
});

describe("Media v2 capability offer", () => {
  test("parses a bounded exact configuration without changing control protocol v1", () => {
    expect(parseCommand(JSON.stringify({
      v: protocolVersion,
      type: "session.start",
      idempotencyKey: "media-offer",
      options: {
        media: {
          version: 2,
          playback: [{ codec: "pcm_s16le", sampleRate: 24_000, channels: 1, packetDurationMs: 20 }],
        },
      },
    }))).toMatchObject({
      v: 1,
      options: {
        media: {
          version: 2,
          playback: [{ codec: "pcm_s16le", sampleRate: 24_000, channels: 1, packetDurationMs: 20 }],
        },
      },
    });
  });

  test("rejects malformed and oversized capability lists", () => {
    const command = (media: unknown) => JSON.stringify({
      v: protocolVersion,
      type: "session.start",
      idempotencyKey: "bad-media",
      options: { media },
    });
    expect(() => parseCommand(command({ version: 3, playback: [] }))).toThrow("unsupported media version");
    expect(() => parseCommand(command({ version: 2, playback: [] }))).toThrow("between 1 and 8");
    expect(() => parseCommand(command({
      version: 2,
      playback: Array.from({ length: 9 }, () => ({
        codec: "pcm_s16le", sampleRate: 24_000, channels: 1, packetDurationMs: 20,
      })),
    }))).toThrow("between 1 and 8");
  });
});
