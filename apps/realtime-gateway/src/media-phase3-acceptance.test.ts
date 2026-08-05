import { describe, expect, test } from "bun:test";
import {
  evaluatePhase3Acceptance,
  parsePhase3BillingEvidence,
  parsePhase3Manifest,
  parsePhase3NetworkEvidence,
  type Phase3Manifest,
  type Phase3NetworkEvidence,
  type Phase3RunDefinition,
  type Phase3TraceDocument,
} from "./media-phase3-acceptance";

const observations = {
  staleAudioHeard: false,
  audioDropoutsHeard: false,
  controlsResponsive: true,
  voiceQualityPassed: true,
  microphoneReleasedAfterEnd: true,
  interruptionToSilenceP95Ms: 90,
  interruptionSamples: 12,
  routeChangeRecovered: true,
  reconnectRecovered: true,
  muteUnmutePassed: true,
};

const runs: Phase3RunDefinition[] = [
  {
    id: "healthy-macos-chrome", trace: "traces/healthy.json", networkEvidence: "evidence/healthy.json",
    device: "macos_chrome", route: "same_wifi",
    network: { downlinkKbps: "unshaped", rttMs: 20, jitterMs: 0, packetLossPct: 0, packetLossDirection: "bidirectional" },
    interactions: ["uninterrupted", "barge_in"], healthyNetwork: true, observations,
  },
  {
    id: "iphone-cellular", trace: "traces/iphone.json", networkEvidence: "evidence/iphone.json",
    device: "iphone_safari", route: "cellular_overlay",
    network: { downlinkKbps: 256, rttMs: 100, jitterMs: 20, packetLossPct: 1, packetLossDirection: "downlink" },
    interactions: ["rapid_revision", "reconnect"], observations,
  },
  {
    id: "android-relayed", trace: "traces/android.json", networkEvidence: "evidence/android.json",
    device: "android_chrome", route: "relayed_derp",
    network: { downlinkKbps: 512, rttMs: 300, jitterMs: 50, packetLossPct: 3, packetLossDirection: "downlink" },
    interactions: ["mute_unmute"], observations,
  },
  {
    id: "macos-safari-route", trace: "traces/safari.json", networkEvidence: "evidence/safari.json",
    device: "macos_safari", route: "same_wifi",
    network: { downlinkKbps: 1_024, rttMs: 20, jitterMs: 100, packetLossPct: 0, packetLossDirection: "downlink" },
    interactions: ["route_change"], observations,
  },
  {
    id: "macos-2048", trace: "traces/2048.json", networkEvidence: "evidence/2048.json",
    device: "macos_chrome", route: "same_wifi",
    network: { downlinkKbps: 2_048, rttMs: 20, jitterMs: 0, packetLossPct: 0, packetLossDirection: "downlink" },
    interactions: ["uninterrupted"], observations,
  },
];

const manifest: Phase3Manifest = {
  schema: "voxstudio.media-phase3-manifest.v1",
  deployment: "self_hosted",
  runs,
};
const startedAtMs = Date.parse("2026-08-05T00:00:00.000Z");

function trace(run: Phase3RunDefinition): Record<string, unknown> {
  const durationMs = run.healthyNetwork ? 600_000 : 60_000;
  const audioMs = durationMs;
  const loss = run.network.packetLossPct === 0 ? 0.1 : run.network.packetLossPct;
  const rtcEvents = Array.from({ length: 12 }, (_, index) => ({
    clock: "client",
    event: {
      stage: "browser.webrtc",
      atMs: startedAtMs + index * 2_000,
      direction: index % 2 === 0 ? "uplink" : "downlink",
      streamId: index % 2 === 0 ? "microphone-rtp" : "agent-rtp",
      bytes: 10_000 + index * 8_000,
      bytesDelta: 8_000,
      headerBytes: 1_000 + index * 200,
      headerBytesDelta: 200,
      rtpBytesDelta: 8_200,
      packets: 100 + index * 20,
      packetLossPct: loss,
      bitrateKbps: index % 2 === 0 ? 36 : 58,
      roundTripTimeMs: run.network.rttMs,
      ...(index % 2 === 0 ? {} : {
        jitterMs: run.network.jitterMs === 0 ? 5 : run.network.jitterMs,
        jitterBufferMs: 80,
        jitterBufferTargetMs: 100,
        concealedSamplesDelta: 0,
        concealmentEventsDelta: 0,
      }),
      codec: "audio/opus",
      sampleRate: 48_000,
    },
  }));
  const events = run.interactions.includes("mute_unmute") ? [
    ...rtcEvents,
    { clock: "client", event: { stage: "browser.mute", atMs: startedAtMs + 24_000, muted: true } },
    { clock: "client", event: { stage: "browser.mute", atMs: startedAtMs + 26_000, muted: false } },
  ] : rtcEvents;
  return {
    schema: "voxstudio.media-trace.v2",
    privacy: "metadata_only",
    sessionId: `session-${run.id}`,
    startedAtMs,
    exportedAtMs: startedAtMs + durationMs,
    diagnostics: {
      transport: "webrtc",
      codec: "opus",
      sampleRate: 48_000,
      frames: Math.ceil(audioMs / 240),
      audioMs,
      webrtcSamples: run.healthyNetwork ? 600 : 30,
      uplinkBitrateP95Kbps: 40,
      downlinkBitrateP95Kbps: 60,
      downlinkRtpBitrateP95Kbps: 64,
      downlinkRtpBytes: 49_200,
      uplinkPacketLossP95Pct: loss,
      downlinkPacketLossP95Pct: loss,
      webrtcRttP95Ms: run.network.rttMs,
      downlinkJitterP95Ms: run.network.jitterMs === 0 ? 5 : run.network.jitterMs,
      downlinkJitterBufferP95Ms: 100,
      downlinkJitterBufferTargetP95Ms: 120,
      concealedSamples: 0,
      concealmentEvents: 0,
      underruns: 0,
      maxQueuedAudioMs: 240,
      highWaterBytes: 48_000,
      droppedFrames: 0,
      playbackObservations: 1,
    },
    events,
  };
}

function traceDocument(run: Phase3RunDefinition, index: number): Phase3TraceDocument {
  return { value: trace(run), digestSha256: (index + 101).toString(16).padStart(64, "0") };
}

function evidence(run: Phase3RunDefinition, index: number): Phase3NetworkEvidence {
  return parsePhase3NetworkEvidence({
    schema: "voxstudio.media-network-evidence.v2",
    runId: run.id,
    source: "test shaper",
    capturedAt: "2026-08-05T00:00:00.000Z",
    device: run.device,
    route: run.route,
    profile: run.network,
  }, (index + 1).toString(16).padStart(64, "0"));
}

function inputs() {
  return {
    traces: new Map(runs.map((run, index) => [run.id, traceDocument(run, index)])),
    evidence: new Map(runs.map((run, index) => [run.id, evidence(run, index)])),
  };
}

describe("Phase 3 WebRTC acceptance gate", () => {
  test("passes a complete self-hosted device, network, loss, and interaction matrix", () => {
    const values = inputs();
    const report = evaluatePhase3Acceptance(manifest, values.traces, values.evidence, undefined, "2026-08-05T01:00:00.000Z");
    expect(report.passed).toBe(true);
    expect(report.summary).toEqual({ runs: 5, passedRuns: 5, failedRuns: 0, failedChecks: 0 });
    expect(report.matrix.every(candidate => candidate.passed)).toBe(true);
    expect(report.billing.checks).toEqual([expect.objectContaining({ id: "billing.not_required", passed: true })]);
  });

  test("fails closed on fallback, excessive bitrate, retained microphone, and missing matrix coverage", () => {
    const oneRun = { ...runs[0] as Phase3RunDefinition, observations: { ...observations, microphoneReleasedAfterEnd: false } };
    const broken = traceDocument(oneRun, 0);
    const diagnostics = (broken.value as Record<string, unknown>).diagnostics as Record<string, unknown>;
    diagnostics.transport = "websocket";
    diagnostics.transportFallbackReason = "livekit_room_connection_failed";
    diagnostics.downlinkBitrateP95Kbps = 120;
    diagnostics.downlinkRtpBitrateP95Kbps = 120;
    const report = evaluatePhase3Acceptance(
      { schema: "voxstudio.media-phase3-manifest.v1", deployment: "self_hosted", runs: [oneRun] },
      new Map([[oneRun.id, broken]]),
      new Map([[oneRun.id, evidence(oneRun, 0)]]),
    );
    expect(report.passed).toBe(false);
    expect(report.runs[0]?.checks.find(candidate => candidate.id === "transport.webrtc")?.passed).toBe(false);
    expect(report.runs[0]?.checks.find(candidate => candidate.id === "webrtc.downlink_rtp_bitrate_p95_max")?.passed).toBe(false);
    expect(report.runs[0]?.checks.find(candidate => candidate.id === "observation.microphone_released")?.passed).toBe(false);
    expect(report.matrix.find(candidate => candidate.id === "matrix.devices")?.passed).toBe(false);
  });

  test("requires distinct trace/evidence paths and validates the packet-loss profile", () => {
    expect(parsePhase3Manifest(manifest)).toEqual(manifest);
    expect(() => parsePhase3Manifest({
      ...manifest,
      runs: [runs[0], { ...runs[1], trace: runs[0]?.trace }],
    })).toThrow("duplicate trace path");
    expect(() => parsePhase3Manifest({
      ...manifest,
      runs: [{ ...runs[0], network: { ...runs[0]?.network, packetLossPct: 2 } }],
    })).toThrow("packetLossPct must be one of");
    expect(() => parsePhase3Manifest({
      ...manifest,
      runs: [{ ...runs[0], network: { ...runs[0]?.network, packetLossDirection: undefined } }],
    })).toThrow("packetLossDirection must be one of");
    expect(() => parsePhase3Manifest({ ...manifest, deployment: "livekit_cloud" })).toThrow("requires billingEvidence");
  });

  test("requires route-change, reconnect, and audible interruption evidence", () => {
    const values = inputs();
    const modifiedRuns = runs.map(run => ({
      ...run,
      observations: {
        ...run.observations,
        ...(run.interactions.includes("route_change") ? { routeChangeRecovered: false } : {}),
        ...(run.interactions.includes("reconnect") ? { reconnectRecovered: false } : {}),
        ...(run.interactions.includes("barge_in") ? { interruptionSamples: 1 } : {}),
      },
    }));
    const report = evaluatePhase3Acceptance({ ...manifest, runs: modifiedRuns }, values.traces, values.evidence);
    expect(report.passed).toBe(false);
    expect(report.runs.flatMap(run => run.checks).find(candidate => candidate.id === "observation.route_change_recovered")?.passed).toBe(false);
    expect(report.runs.flatMap(run => run.checks).find(candidate => candidate.id === "observation.reconnect_recovered")?.passed).toBe(false);
    expect(report.runs[0]?.checks.find(candidate => candidate.id === "observation.interruption_samples")?.passed).toBe(false);
  });

  test("requires direction-specific loss, RTP-overhead bitrate, and a recorded mute cycle", () => {
    const values = inputs();
    const android = values.traces.get("android-relayed") as Phase3TraceDocument;
    const androidTrace = android.value as Record<string, unknown>;
    const androidDiagnostics = androidTrace.diagnostics as Record<string, unknown>;
    androidDiagnostics.downlinkPacketLossP95Pct = 0;
    androidDiagnostics.uplinkPacketLossP95Pct = 3;
    androidDiagnostics.downlinkRtpBitrateP95Kbps = 90;
    androidTrace.events = (androidTrace.events as Record<string, unknown>[]).filter(entry => {
      const event = entry.event as Record<string, unknown>;
      if (event.direction === "downlink") delete event.rtpBytesDelta;
      return event.stage !== "browser.mute";
    });

    const report = evaluatePhase3Acceptance(manifest, values.traces, values.evidence);
    const checks = report.runs.find(run => run.id === "android-relayed")?.checks ?? [];
    expect(checks.find(candidate => candidate.id === "network.downlink_loss_p95_matches_profile")?.passed).toBe(false);
    expect(checks.find(candidate => candidate.id === "webrtc.downlink_rtp_bitrate_p95_max")?.passed).toBe(false);
    expect(checks.find(candidate => candidate.id === "webrtc.auditable_downlink_samples")?.passed).toBe(false);
    expect(checks.find(candidate => candidate.id === "telemetry.mute_unmute")?.passed).toBe(false);
  });

  test("rejects an unobserved or unhealthy native playback soak", () => {
    const values = inputs();
    const healthy = values.traces.get("healthy-macos-chrome") as Phase3TraceDocument;
    const diagnostics = (healthy.value as Record<string, unknown>).diagnostics as Record<string, unknown>;
    diagnostics.playbackObservations = 0;
    diagnostics.underruns = 1;
    diagnostics.maxQueuedAudioMs = 1_200;
    diagnostics.highWaterBytes = 200_000;
    diagnostics.droppedFrames = 1;
    const report = evaluatePhase3Acceptance(manifest, values.traces, values.evidence);
    const checks = report.runs[0]?.checks ?? [];
    expect(checks.find(candidate => candidate.id === "webrtc.playback_observations")?.passed).toBe(false);
    expect(checks.find(candidate => candidate.id === "healthy.underruns")?.passed).toBe(false);
    expect(checks.find(candidate => candidate.id === "media.max_queued_audio")?.passed).toBe(false);
    expect(checks.find(candidate => candidate.id === "media.high_water_bytes")?.passed).toBe(false);
    expect(checks.find(candidate => candidate.id === "media.dropped_frames")?.passed).toBe(false);
  });

  test("sums explicit per-stream RTP deltas across a replacement without cumulative cross-talk", () => {
    const values = inputs();
    const iphone = values.traces.get("iphone-cellular") as Phase3TraceDocument;
    const value = iphone.value as Record<string, unknown>;
    (value.diagnostics as Record<string, unknown>).downlinkRtpBytes = 117_700;
    value.events = [
      { event: { stage: "browser.webrtc", direction: "downlink", streamId: "old", bytes: 100_000, bytesDelta: 100_000, headerBytes: 2_000, headerBytesDelta: 2_000, rtpBytesDelta: 102_000 } },
      { event: { stage: "browser.webrtc", direction: "downlink", streamId: "new", bytes: 1_000, bytesDelta: 1_000, headerBytes: 100, headerBytesDelta: 100, rtpBytesDelta: 1_100 } },
      { event: { stage: "browser.webrtc", direction: "downlink", streamId: "old", bytes: 110_000, bytesDelta: 10_000, headerBytes: 2_200, headerBytesDelta: 200, rtpBytesDelta: 10_200 } },
      { event: { stage: "browser.webrtc", direction: "downlink", streamId: "new", bytes: 3_000, bytesDelta: 2_000, headerBytes: 300, headerBytesDelta: 200, rtpBytesDelta: 2_200 } },
      { event: { stage: "browser.webrtc", direction: "downlink", streamId: "new", bytes: 5_000, bytesDelta: 2_000, headerBytes: 500, headerBytesDelta: 200, rtpBytesDelta: 2_200 } },
    ];
    const report = evaluatePhase3Acceptance(manifest, values.traces, values.evidence);
    expect(report.runs.find(run => run.id === "iphone-cellular")?.metrics.measuredDownstreamBytes).toBe(117_700);
  });

  test("reconciles an isolated LiveKit Cloud billing export with trace measurements", () => {
    const values = inputs();
    const cloudManifest: Phase3Manifest = {
      ...manifest,
      deployment: "livekit_cloud",
      billingEvidence: "evidence/livekit-billing.json",
    };
    const baseline = evaluatePhase3Acceptance(manifest, values.traces, values.evidence);
    const billing = parsePhase3BillingEvidence({
      schema: "voxstudio.livekit-billing-evidence.v1",
      source: "isolated LiveKit Cloud project export",
      periodStart: "2026-08-04T23:59:00.000Z",
      periodEnd: "2026-08-05T00:11:00.000Z",
      participantMinutes: baseline.billing.measuredParticipantMinutes,
      downstreamBytes: baseline.billing.measuredDownstreamBytes + 10_000,
    }, "f".repeat(64));
    const report = evaluatePhase3Acceptance(cloudManifest, values.traces, values.evidence, billing);
    expect(report.passed).toBe(true);
    expect(report.billing.checks.every(candidate => candidate.passed)).toBe(true);

    billing.participantMinutes += 10;
    billing.downstreamBytes = 0;
    const failed = evaluatePhase3Acceptance(cloudManifest, values.traces, values.evidence, billing);
    expect(failed.matrix.find(candidate => candidate.id === "billing.participant_minutes")?.passed).toBe(false);
    expect(failed.matrix.find(candidate => candidate.id === "billing.downstream_bytes")?.passed).toBe(false);
  });

  test("rejects stale or mismatched external network evidence and reused digests", () => {
    const values = inputs();
    const iphone = values.evidence.get("iphone-cellular") as Phase3NetworkEvidence;
    iphone.capturedAt = "2026-08-04T00:00:00.000Z";
    iphone.route = "same_wifi";
    for (const item of values.evidence.values()) item.digestSha256 = "e".repeat(64);
    const report = evaluatePhase3Acceptance(manifest, values.traces, values.evidence);
    expect(report.runs[1]?.checks.find(candidate => candidate.id === "evidence.environment")?.passed).toBe(false);
    expect(report.runs[1]?.checks.find(candidate => candidate.id === "evidence.capture_window")?.passed).toBe(false);
    expect(report.matrix.find(candidate => candidate.id === "matrix.unique_network_evidence")?.passed).toBe(false);
  });
});
