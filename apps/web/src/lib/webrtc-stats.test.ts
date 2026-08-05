import { describe, expect, test } from "bun:test";
import { WebRtcStatsSampler } from "./webrtc-stats";

const report = (...records: Record<string, unknown>[]): Map<string, Record<string, unknown>> =>
  new Map(records.map((entry, index) => [String(entry.id ?? index), entry]));

describe("WebRTC stats normalization", () => {
  test("derives uplink bitrate, remote loss, jitter, and RTT from counter deltas", () => {
    const sampler = new WebRtcStatsSampler();
    const first = report(
      { id: "out", type: "outbound-rtp", kind: "audio", timestamp: 1_000, bytesSent: 10_000, headerBytesSent: 1_000, packetsSent: 100, remoteId: "remote", codecId: "codec" },
      { id: "remote", type: "remote-inbound-rtp", kind: "audio", localId: "out", packetsLost: 2, jitter: 0.012, roundTripTime: 0.08 },
      { id: "codec", type: "codec", mimeType: "audio/opus", clockRate: 48_000 },
    );
    const second = report(
      { id: "out", type: "outbound-rtp", kind: "audio", timestamp: 3_000, bytesSent: 22_000, headerBytesSent: 2_200, packetsSent: 220, remoteId: "remote", codecId: "codec" },
      { id: "remote", type: "remote-inbound-rtp", kind: "audio", localId: "out", packetsLost: 5, jitter: 0.02, roundTripTime: 0.1 },
      { id: "codec", type: "codec", mimeType: "audio/opus", clockRate: 48_000 },
    );
    expect(sampler.sample(first, "uplink", 10)).toMatchObject({
      direction: "uplink", streamId: "out", bytes: 10_000, bytesDelta: 10_000,
      headerBytes: 1_000, headerBytesDelta: 1_000, rtpBytesDelta: 11_000, packets: 100, packetsLost: 2,
      jitterMs: 12, roundTripTimeMs: 80, codec: "audio/opus", sampleRate: 48_000,
    });
    expect(sampler.sample(second, "uplink", 20)).toMatchObject({
      bitrateKbps: 48,
      rtpBitrateKbps: 52.8,
      packetLossPct: 3 * 100 / 120,
      jitterMs: 20,
      roundTripTimeMs: 100,
    });
  });

  test("derives downlink jitter-buffer and concealment deltas without leaking cumulative math", () => {
    const sampler = new WebRtcStatsSampler();
    sampler.sample(report({
      id: "in", type: "inbound-rtp", kind: "audio", timestamp: 1_000,
      bytesReceived: 8_000, headerBytesReceived: 800, packetsReceived: 80, packetsLost: 1, jitter: 0.01,
      jitterBufferDelay: 1.2, jitterBufferEmittedCount: 60,
      jitterBufferTargetDelay: 1.8, jitterBufferMinimumDelay: 0.6,
      concealedSamples: 200, concealmentEvents: 2,
    }), "downlink", 10);
    const sample = sampler.sample(report({
      id: "in", type: "inbound-rtp", kind: "audio", timestamp: 3_000,
      bytesReceived: 24_000, headerBytesReceived: 2_400, packetsReceived: 240, packetsLost: 3, jitter: 0.015,
      jitterBufferDelay: 3.6, jitterBufferEmittedCount: 180,
      jitterBufferTargetDelay: 5.4, jitterBufferMinimumDelay: 1.8,
      concealedSamples: 260, concealmentEvents: 3,
    }), "downlink", 20);
    expect(sample).toMatchObject({
      direction: "downlink",
      bitrateKbps: 64,
      rtpBitrateKbps: 70.4,
      rtpBytesDelta: 17_600,
      packetLossPct: 2 * 100 / 162,
      jitterMs: 15,
      concealedSamplesDelta: 60,
      concealmentEventsDelta: 1,
    });
    expect(sample?.jitterBufferMs).toBeCloseTo(20);
    expect(sample?.jitterBufferTargetMs).toBeCloseTo(30);
    expect(sample?.jitterBufferMinimumMs).toBeCloseTo(10);
  });

  test("ignores reports without an audio RTP stream and resets discontinuous counters", () => {
    const sampler = new WebRtcStatsSampler();
    expect(sampler.sample(report({ type: "candidate-pair", state: "succeeded" }), "uplink", 1)).toBeUndefined();
    sampler.sample(report({ type: "outbound-rtp", kind: "audio", timestamp: 2_000, bytesSent: 10_000, packetsSent: 100 }), "uplink", 2);
    expect(sampler.sample(report({ type: "outbound-rtp", kind: "audio", timestamp: 3_000, bytesSent: 100, packetsSent: 1 }), "uplink", 3)?.bitrateKbps).toBeUndefined();
    sampler.reset();
    expect(sampler.sample(report({ type: "outbound-rtp", kind: "audio", timestamp: 4_000, bytesSent: 200, packetsSent: 2 }), "uplink", 4)?.bitrateKbps).toBeUndefined();
  });

  test("keeps unavailable uplink loss missing until two remote reports establish a baseline", () => {
    const sampler = new WebRtcStatsSampler();
    const first = sampler.sample(report({
      id: "out", type: "outbound-rtp", kind: "audio", timestamp: 1_000,
      bytesSent: 10_000, packetsSent: 100, remoteId: "remote",
    }), "uplink", 1);
    expect(first?.packetsLost).toBeUndefined();
    expect(first?.packetLossPct).toBeUndefined();

    const firstRemote = sampler.sample(report(
      { id: "out", type: "outbound-rtp", kind: "audio", timestamp: 3_000, bytesSent: 20_000, packetsSent: 200, remoteId: "remote" },
      { id: "remote", type: "remote-inbound-rtp", localId: "out", packetsLost: 12 },
    ), "uplink", 2);
    expect(firstRemote?.packetsLost).toBe(12);
    expect(firstRemote?.packetLossPct).toBeUndefined();

    expect(sampler.sample(report(
      { id: "out", type: "outbound-rtp", kind: "audio", timestamp: 5_000, bytesSent: 30_000, packetsSent: 300, remoteId: "remote" },
      { id: "remote", type: "remote-inbound-rtp", localId: "out", packetsLost: 14 },
    ), "uplink", 3)?.packetLossPct).toBe(2);
  });

  test("starts a new baseline when the selected RTP stream changes", () => {
    const sampler = new WebRtcStatsSampler();
    sampler.sample(report({
      id: "old", type: "outbound-rtp", kind: "audio", active: true,
      timestamp: 1_000, bytesSent: 10_000, packetsSent: 100,
    }), "uplink", 1);

    const switched = sampler.sample(report(
      { id: "old", type: "outbound-rtp", kind: "audio", active: false, timestamp: 3_000, bytesSent: 50_000, packetsSent: 500 },
      { id: "new", type: "outbound-rtp", kind: "audio", active: true, timestamp: 3_000, bytesSent: 20_000, packetsSent: 200 },
    ), "uplink", 2);
    expect(switched).toMatchObject({ bytes: 20_000, packets: 200 });
    expect(switched?.bytesDelta).toBe(20_000);
    expect(switched?.bitrateKbps).toBeUndefined();
    expect(switched?.packetLossPct).toBeUndefined();

    expect(sampler.sample(report({
      id: "new", type: "outbound-rtp", kind: "audio", active: true,
      timestamp: 5_000, bytesSent: 32_000, packetsSent: 320,
    }), "uplink", 3)?.bitrateKbps).toBe(48);
  });

  test("retains first-epoch and reset bytes while keeping bitrate baselines isolated", () => {
    const sampler = new WebRtcStatsSampler();
    const first = sampler.sample(report({
      id: "in", type: "inbound-rtp", kind: "audio", timestamp: 1_000,
      bytesReceived: 5_000, headerBytesReceived: 500, packetsReceived: 50,
    }), "downlink", 1);
    expect(first).toMatchObject({ streamId: "in", bytesDelta: 5_000, headerBytesDelta: 500, rtpBytesDelta: 5_500 });
    expect(first?.rtpBitrateKbps).toBeUndefined();

    const reset = sampler.sample(report({
      id: "in", type: "inbound-rtp", kind: "audio", timestamp: 3_000,
      bytesReceived: 200, headerBytesReceived: 20, packetsReceived: 2,
    }), "downlink", 2);
    expect(reset).toMatchObject({ bytesDelta: 200, headerBytesDelta: 20, rtpBytesDelta: 220 });
    expect(reset?.rtpBitrateKbps).toBeUndefined();
  });

  test("does not turn a late browser header counter into a bitrate spike", () => {
    const sampler = new WebRtcStatsSampler();
    sampler.sample(report({
      id: "in", type: "inbound-rtp", kind: "audio", timestamp: 1_000,
      bytesReceived: 5_000, packetsReceived: 50,
    }), "downlink", 1);
    const baseline = sampler.sample(report({
      id: "in", type: "inbound-rtp", kind: "audio", timestamp: 3_000,
      bytesReceived: 15_000, headerBytesReceived: 1_500, packetsReceived: 150,
    }), "downlink", 2);
    expect(baseline).toMatchObject({ bytesDelta: 10_000, headerBytesDelta: 1_500, rtpBytesDelta: 11_500 });
    expect(baseline?.rtpBitrateKbps).toBeUndefined();
    expect(sampler.sample(report({
      id: "in", type: "inbound-rtp", kind: "audio", timestamp: 5_000,
      bytesReceived: 25_000, headerBytesReceived: 2_500, packetsReceived: 250,
    }), "downlink", 3)?.rtpBitrateKbps).toBe(44);
  });
});
