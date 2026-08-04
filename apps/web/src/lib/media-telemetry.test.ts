import { describe, expect, test } from "bun:test";
import { attributeMediaDelay, type MediaAttributionSample, type MediaDelayLayer } from "./media-telemetry";

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
});
