import { describe, expect, test } from "bun:test";
import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import {
  attributeMediaDelay,
  formatMediaTransportDetails,
  formatWebRtcDiagnostics,
  mediaTransportFallbackMessage,
  MediaTraceRecorder,
  type MediaAttributionSample,
  type MediaDelayLayer,
} from "./media-telemetry";

const baseline: MediaAttributionSample = {
  previousProducedAtMs: 0,
  previousAudioMs: 100,
  producedAtMs: 100,
  enqueuedAtMs: 101,
  submittedAtMs: 102,
  receivedAtMs: 103,
  decodedAtMs: 104,
  browserEnqueuedAtMs: 105,
  scheduledRenderAtMs: 200,
  renderedAtMs: 201,
};

describe("media delay attribution", () => {
  const injections: [MediaDelayLayer, Partial<MediaAttributionSample>][] = [
    ["production", { producedAtMs: 250, enqueuedAtMs: 251, submittedAtMs: 252, receivedAtMs: 253, decodedAtMs: 254, browserEnqueuedAtMs: 255 }],
    ["server_send", { submittedAtMs: 251, receivedAtMs: 252, decodedAtMs: 253, browserEnqueuedAtMs: 254 }],
    ["network", { receivedAtMs: 253, decodedAtMs: 254, browserEnqueuedAtMs: 255 }],
    ["decode", { decodedAtMs: 254, browserEnqueuedAtMs: 255 }],
    ["browser_enqueue", { browserEnqueuedAtMs: 255 }],
    ["render", { renderedAtMs: 351 }],
  ];

  for (const [layer, injection] of injections) {
    test(`attributes a synthetic ${layer} pause to ${layer}`, () => {
      expect(attributeMediaDelay({ ...baseline, ...injection }).layer).toBe(layer);
    });
  }

  test("does not invent a layer below the diagnostic threshold", () => {
    expect(attributeMediaDelay(baseline).layer).toBe("none");
  });

  test("exports a clock-aligned real frame and attributes its network pause", () => {
    let now = 0;
    const recorder = new MediaTraceRecorder(() => now);
    const gateway = <T extends GatewayEvent["type"]>(event: Extract<GatewayEvent, { type: T }>): void => {
      recorder.observeGateway(event);
    };
    const envelope = { v: 1 as const, sessionId: "s-1", timestampMs: 0 };

    // Server clock is exactly 1000ms ahead of the browser clock.
    now = 22;
    gateway({
      ...envelope,
      sequence: 1,
      type: "media.pong",
      clientSentAtMs: 0,
      serverReceivedAtMs: 1_010,
      serverSentAtMs: 1_012,
    });
    gateway({
      ...envelope,
      sequence: 2,
      type: "media.frame",
      frameId: 7,
      turnId: "t-1",
      revision: 0,
      codec: "pcm_f32le",
      sampleRate: 24_000,
      channels: 1,
      bytes: 9_600,
      audioMs: 100,
      producedAtMs: 1_100,
      enqueuedAtMs: 1_101,
    });
    gateway({
      ...envelope,
      sequence: 3,
      type: "media.socket",
      frameId: 7,
      submittedAtMs: 1_102,
      sendResult: 9_600,
      bufferedBytes: 0,
      highWaterBytes: 0,
      queuedBytes: 0,
      queuedAudioMs: 0,
      backpressured: false,
      dropped: false,
    });
    recorder.observeDelivery(new Float32Array(2_400), {
      frame: {
        ...envelope,
        sequence: 2,
        type: "media.frame",
        frameId: 7,
        turnId: "t-1",
        revision: 0,
        codec: "pcm_f32le",
        sampleRate: 24_000,
        channels: 1,
        bytes: 9_600,
        audioMs: 100,
        producedAtMs: 1_100,
        enqueuedAtMs: 1_101,
      },
      receivedAtMs: 253,
      decodedAtMs: 254,
    });
    recorder.observeBrowser({
      stage: "browser.enqueue",
      atMs: 255,
      frameId: 7,
      bufferBeforeMs: 0,
      bufferAfterMs: 700,
      targetBufferMs: 700,
    });
    recorder.observeBrowser({
      stage: "browser.render",
      atMs: 351,
      frameId: 7,
      scheduledAtMs: 350,
      latenessMs: 1,
      bufferDepthMs: 500,
      estimated: true,
    });

    const exported = recorder.export() as {
      schema: string;
      timeline: { stage: string; atMs: number; aligned: boolean }[];
      frameAttributions: { frameId: number; attribution: { layer: MediaDelayLayer } }[];
    };
    expect(exported.schema).toBe("voxstudio.media-trace.v2");
    expect(exported.timeline.find(event => event.stage === "server.production")).toMatchObject({ atMs: 100, aligned: true });
    expect(exported.timeline.find(event => event.stage === "server.enqueue")).toMatchObject({ atMs: 101, aligned: true });
    expect(exported.frameAttributions).toEqual([
      expect.objectContaining({ frameId: 7, attribution: expect.objectContaining({ layer: "network" }) }),
    ]);
  });

  test("keeps an incomplete frame on the timeline without inventing an attribution", () => {
    const recorder = new MediaTraceRecorder(() => 20);
    recorder.observeGateway({
      v: 1,
      sequence: 1,
      sessionId: "s-1",
      timestampMs: 20,
      type: "media.frame",
      frameId: 1,
      turnId: "t-1",
      revision: 0,
      codec: "pcm_f32le",
      sampleRate: 24_000,
      channels: 1,
      bytes: 9_600,
      audioMs: 100,
      producedAtMs: 10,
      enqueuedAtMs: 11,
    });

    const exported = recorder.export() as { timeline: unknown[]; frameAttributions: unknown[] };
    expect(exported.timeline).toHaveLength(2);
    expect(exported.frameAttributions).toHaveLength(0);
  });

  test("keeps bounded long-run acceptance aggregates after raw events roll over", () => {
    const recorder = new MediaTraceRecorder(() => 10_000);
    const envelope = { v: 1 as const, sessionId: "s-1", timestampMs: 0 };
    recorder.observeGateway({
      ...envelope,
      sequence: 1,
      type: "media.socket",
      frameId: 1,
      submittedAtMs: 1,
      sendResult: 1_016,
      bufferedBytes: 2_048,
      highWaterBytes: 2_048,
      queuedBytes: 10_160,
      queuedAudioMs: 200,
      backpressured: false,
      dropped: false,
    });
    recorder.observeGateway({
      ...envelope,
      sequence: 2,
      type: "media.socket.drain",
      startedAtMs: 2,
      drainedAtMs: 12,
      durationMs: 10,
      highWaterBytes: 2_048,
    });
    for (let index = 0; index < 6_000; index += 1) {
      recorder.observeBrowser({
        stage: "browser.render",
        atMs: index,
        frameId: index,
        scheduledAtMs: index,
        latenessMs: 0,
        bufferDepthMs: index % 20 === 0 ? 500 : 200,
        estimated: false,
      });
    }
    recorder.observeBrowser({
      stage: "browser.stop",
      atMs: 7_000,
      reason: "interrupted",
      sourceCount: 1,
      operationMs: 12.4,
    });
    recorder.observeBrowser({
      stage: "browser.stop",
      atMs: 7_100,
      reason: "closed",
      sourceCount: 1,
      operationMs: 1,
    });

    expect(recorder.summary()).toMatchObject({
      highWaterBytes: 2_048,
      maxQueuedAudioMs: 200,
      backpressureEvents: 1,
      bufferDepthP95Ms: 200,
      interruptionStops: 1,
      interruptionStopP95Ms: 13,
      closedStops: 1,
      renderObservations: 6_000,
      estimatedRenders: 0,
    });
    const exported = recorder.export() as { events: unknown[] };
    expect(exported.events).toHaveLength(5_000);

    recorder.reset();
    expect(recorder.summary()).toMatchObject({
      maxQueuedAudioMs: 0,
      backpressureEvents: 0,
      bufferDepthP95Ms: undefined,
      interruptionStops: 0,
      interruptionStopP95Ms: undefined,
      closedStops: 0,
      renderObservations: 0,
    });
  });

  test("keeps RTT and RTT-jitter distributions instead of only the last ping", () => {
    let now = 20;
    const recorder = new MediaTraceRecorder(() => now);
    const pong = (sequence: number, clientSentAtMs: number): void => recorder.observeGateway({
      v: 1,
      sequence,
      sessionId: "s-1",
      timestampMs: now,
      type: "media.pong",
      clientSentAtMs,
      serverReceivedAtMs: 1_000 + clientSentAtMs,
      serverSentAtMs: 1_000 + clientSentAtMs,
    });
    pong(1, 0); // 20ms
    now = 40;
    pong(2, 10); // 30ms, jitter 10ms
    now = 90;
    pong(3, 20); // 70ms, jitter 40ms

    expect(recorder.summary()).toMatchObject({
      rttSamples: 3,
      rttP50Ms: 30,
      rttP95Ms: 70,
      rttJitterP95Ms: 40,
    });
  });

  test("aggregates WebRTC transport health and retains it in the metadata-only trace", () => {
    const recorder = new MediaTraceRecorder(() => 5_000);
    recorder.observeBrowser({
      stage: "browser.transport", atMs: 900, transport: "webrtc",
    });
    recorder.observeBrowser({
      stage: "browser.webrtc", atMs: 1_000, direction: "uplink",
      bytes: 10_000, packets: 100, packetsLost: 1,
      bitrateKbps: 36.2, packetLossPct: 0.7, roundTripTimeMs: 48.4,
      codec: "audio/opus", sampleRate: 48_000,
    });
    recorder.observeBrowser({
      stage: "browser.webrtc", atMs: 1_000, direction: "downlink",
      bytes: 12_000, packets: 120, packetsLost: 2,
      bitrateKbps: 42.6, packetLossPct: 1.2, jitterMs: 14.3,
      roundTripTimeMs: 49.1, jitterBufferMs: 38.2,
      jitterBufferTargetMs: 52.3, jitterBufferMinimumMs: 20.1,
      concealedSamplesDelta: 120, concealmentEventsDelta: 2,
      codec: "audio/opus", sampleRate: 48_000,
    });

    const summary = recorder.summary();
    expect(summary).toMatchObject({
      transport: "webrtc",
      codec: "opus",
      sampleRate: 48_000,
      webrtcSamples: 2,
      uplinkBitrateKbps: 36.2,
      uplinkBitrateP95Kbps: 37,
      downlinkBitrateKbps: 42.6,
      downlinkBitrateP95Kbps: 43,
      webrtcRttP95Ms: 50,
      downlinkJitterP95Ms: 15,
      downlinkJitterBufferP95Ms: 39,
      downlinkJitterBufferTargetP95Ms: 53,
      downlinkJitterBufferMinimumP95Ms: 21,
      concealedSamples: 120,
      concealmentEvents: 2,
    });
    expect(summary.uplinkPacketLossP95Pct).toBeCloseTo(0.7);
    expect(summary.downlinkPacketLossP95Pct).toBeCloseTo(1.2);
    expect(formatWebRtcDiagnostics(summary)).toBe("WebRTC · Opus 48kHz · ↑ 36 kbps · ↓ 43 kbps · ↑loss 0.7% · ↓loss 1.2% · jitter 14ms · RTT 49ms");
    const exported = recorder.export() as {
      privacy: string;
      events: { event: { stage: string } }[];
      timeline: { stage: string }[];
    };
    expect(exported.privacy).toBe("metadata_only");
    expect(exported.events.filter(entry => entry.event.stage === "browser.webrtc")).toHaveLength(2);
    expect(exported.timeline.filter(entry => entry.stage === "browser.webrtc")).toHaveLength(2);

    // media.frame describes production timing on both transports. LiveKit forwards the
    // same metadata over its data channel, so it must not relabel WebRTC as WebSocket.
    recorder.observeGateway({
      v: 1,
      sequence: 1,
      sessionId: "s-1",
      timestampMs: 1_100,
      type: "media.frame",
      frameId: 1,
      streamId: "stream-1",
      mediaSequence: 0,
      timestampSamples: 0,
      turnId: "t-1",
      revision: 0,
      codec: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
      bytes: 960,
      audioMs: 20,
      producedAtMs: 1_090,
      enqueuedAtMs: 1_095,
    });
    expect(recorder.summary()).toMatchObject({ transport: "webrtc", codec: "opus", sampleRate: 48_000 });

    recorder.reset();
    expect(recorder.summary()).toMatchObject({ transport: undefined, webrtcSamples: 0, concealedSamples: 0 });
  });

  test("makes an explicit WebSocket fallback and its safe reason visible before audio arrives", () => {
    const recorder = new MediaTraceRecorder(() => 2_000);
    recorder.observeBrowser({
      stage: "browser.transport",
      atMs: 1_000,
      transport: "websocket",
      fallbackReason: "livekit_room_connection_failed",
    });
    expect(recorder.summary()).toMatchObject({
      transport: "websocket",
      transportFallbackReason: "livekit_room_connection_failed",
      frames: 0,
    });
    expect(formatMediaTransportDetails(recorder.summary())).toBe("PCM");
    expect(mediaTransportFallbackMessage(recorder.summary().transportFallbackReason))
      .toBe("LiveKit 房间连接失败，已回退到 WebSocket");

    recorder.observeGateway({
      v: 1,
      sequence: 1,
      sessionId: "s-1",
      timestampMs: 1_100,
      type: "media.frame",
      frameId: 1,
      streamId: "stream-1",
      mediaSequence: 0,
      timestampSamples: 0,
      turnId: "t-1",
      revision: 0,
      codec: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
      bytes: 960,
      audioMs: 20,
      producedAtMs: 1_090,
      enqueuedAtMs: 1_095,
    });
    expect(formatMediaTransportDetails(recorder.summary())).toBe("PCM16 24kHz · 0ms buffer · underrun 0");
    expect(recorder.summary().transportFallbackReason).toBe("livekit_room_connection_failed");
  });
});
