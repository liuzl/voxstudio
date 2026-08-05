import { describe, expect, test } from "bun:test";
import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import {
  attributeMediaDelay,
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
});
