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
});
