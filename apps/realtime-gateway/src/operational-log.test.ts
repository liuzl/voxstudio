import { describe, expect, test } from "bun:test";
import type { GatewayEvent } from "./protocol";
import { formatOperationalEventLog } from "./session";

const envelope = {
  v: 1 as const,
  sequence: 42,
  sessionId: "12345678-aaaa-bbbb-cccc-1234567890ab",
  timestampMs: 100,
};

describe("realtime operational log", () => {
  test("silences per-frame telemetry and pong detail while retaining a low-rate ping heartbeat", () => {
    const events: GatewayEvent[] = [
      {
        ...envelope,
        type: "media.frame",
        frameId: 1,
        turnId: "turn-12345678",
        revision: 0,
        codec: "pcm_s16le",
        sampleRate: 24_000,
        channels: 1,
        bytes: 1_016,
        audioMs: 20,
        producedAtMs: 90,
        enqueuedAtMs: 91,
        streamId: "00112233-4455-6677-8899-aabbccddeeff",
        mediaSequence: 0,
        timestampSamples: 0,
      },
      {
        ...envelope,
        type: "media.socket",
        frameId: 1,
        submittedAtMs: 92,
        sendResult: 1_016,
        bufferedBytes: 0,
        highWaterBytes: 0,
        queuedBytes: 0,
        queuedAudioMs: 0,
        backpressured: false,
        dropped: false,
      },
      {
        ...envelope,
        type: "media.pong",
        clientSentAtMs: 80,
        serverReceivedAtMs: 90,
        serverSentAtMs: 91,
      },
      {
        ...envelope,
        type: "command.accepted",
        commandType: "media.ping",
        idempotencyKey: "ping-1",
      },
    ];
    expect(events.map(event => formatOperationalEventLog(envelope.sessionId, event))).toEqual([
      undefined,
      undefined,
      undefined,
      "session 12345678 #42 command.accepted media.ping",
    ]);
  });

  test("keeps one useful rendition summary and exceptional pressure", () => {
    const rendition: GatewayEvent = {
      ...envelope,
      type: "media.rendition",
      turnId: "abcdef12-3456",
      revision: 0,
      status: "completed",
      frames: 137,
      audioMs: 2_731.6,
      staleFramesDiscarded: 0,
      endedAtMs: 100,
    };
    const drain: GatewayEvent = {
      ...envelope,
      type: "media.socket.drain",
      startedAtMs: 80,
      drainedAtMs: 99.6,
      durationMs: 19.6,
      highWaterBytes: 4_096,
    };
    expect(formatOperationalEventLog(envelope.sessionId, rendition))
      .toBe("session 12345678 #42 media.rendition turn abcdef12 completed frames=137 audio=2732ms stale=0");
    expect(formatOperationalEventLog(envelope.sessionId, drain))
      .toBe("session 12345678 #42 media.socket.drain duration=20ms high_water=4096B");
  });

  test("preserves errors and ordinary lifecycle milestones without transcript contents", () => {
    const error: GatewayEvent = {
      ...envelope,
      type: "error",
      code: "network_congested",
      message: "media socket blocked",
      recoverable: true,
    };
    const state: GatewayEvent = {
      ...envelope,
      type: "session.state",
      previous: "idle",
      state: "listening",
    };
    expect(formatOperationalEventLog(envelope.sessionId, error))
      .toBe("session 12345678 #42 error: media socket blocked");
    expect(formatOperationalEventLog(envelope.sessionId, state))
      .toBe("session 12345678 #42 session.state listening");
  });
});
