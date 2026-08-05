import { describe, expect, test } from "bun:test";
import {
  evaluatePhase2Acceptance,
  parsePhase2Manifest,
  parsePhase2NetworkEvidence,
  type Phase2Manifest,
  type Phase2NetworkEvidence,
  type Phase2RunDefinition,
  type Phase2TraceDocument,
} from "./media-phase2-acceptance";

const observations = {
  staleAudioHeard: false,
  controlsResponsive: true,
  voiceQualityPassed: true,
  interruptionToSilenceP95Ms: 80,
  interruptionSamples: 12,
};

const definitions: Phase2RunDefinition[] = [
  {
    id: "healthy-macos-chrome",
    trace: "traces/healthy.json",
    networkEvidence: "evidence/healthy.json",
    device: "macos_chrome",
    route: "same_wifi",
    network: { downlinkKbps: "unshaped", rttMs: 20, jitterMs: 0 },
    interactions: ["uninterrupted", "barge_in"],
    healthyNetwork: true,
    observations,
  },
  {
    id: "iphone-constrained",
    trace: "traces/iphone.json",
    networkEvidence: "evidence/iphone.json",
    device: "iphone_safari",
    route: "cellular_overlay",
    network: { downlinkKbps: 256, rttMs: 100, jitterMs: 20 },
    interactions: ["rapid_revision"],
    observations,
  },
  {
    id: "android-relayed",
    trace: "traces/android.json",
    networkEvidence: "evidence/android.json",
    device: "android_chrome",
    route: "relayed_derp",
    network: { downlinkKbps: 512, rttMs: 300, jitterMs: 50 },
    interactions: ["mute_unmute"],
    observations,
  },
  {
    id: "macos-safari-route-change",
    trace: "traces/safari.json",
    networkEvidence: "evidence/safari.json",
    device: "macos_safari",
    route: "same_wifi",
    network: { downlinkKbps: 1_024, rttMs: 20, jitterMs: 100 },
    interactions: ["route_change"],
    observations,
  },
  {
    id: "remaining-downlink",
    trace: "traces/2048.json",
    networkEvidence: "evidence/2048.json",
    device: "macos_chrome",
    route: "same_wifi",
    network: { downlinkKbps: 2_048, rttMs: 20, jitterMs: 0 },
    interactions: ["uninterrupted"],
    observations,
  },
];

const manifest: Phase2Manifest = { schema: "voxstudio.media-phase2-manifest.v1", runs: definitions };
const traceStartMs = Date.parse("2026-08-05T00:00:00.000Z");

function trace(run: Phase2RunDefinition, durationMs = 60_000): Record<string, unknown> {
  const audioMs = run.healthyNetwork ? 600_000 : 60_000;
  const frames = audioMs / 20;
  return {
    schema: "voxstudio.media-trace.v2",
    sessionId: `session-${run.id}`,
    privacy: "metadata_only",
    startedAtMs: traceStartMs,
    exportedAtMs: traceStartMs + durationMs,
    diagnostics: {
      codec: "pcm_s16le",
      sampleRate: 24_000,
      mediaFormatChanges: 0,
      frames,
      audioMs,
      underruns: 0,
      droppedFrames: 0,
      maxQueuedAudioMs: 320,
      bufferDepthP95Ms: 280,
      interruptionStops: 12,
      interruptionStopP95Ms: 24,
      renderObservations: frames,
      estimatedRenders: 0,
      rttSamples: run.healthyNetwork ? 120 : 12,
      rttP50Ms: run.network.rttMs,
      rttP95Ms: run.network.rttMs + run.network.jitterMs,
      rttJitterP95Ms: run.network.jitterMs === 0 ? 5 : run.network.jitterMs,
    },
  };
}

function traceDocument(run: Phase2RunDefinition, index: number, durationMs?: number): Phase2TraceDocument {
  return {
    value: trace(run, durationMs),
    digestSha256: (index + 101).toString(16).padStart(64, "0"),
  };
}

function evidence(run: Phase2RunDefinition, index: number): Phase2NetworkEvidence {
  return parsePhase2NetworkEvidence({
    schema: "voxstudio.media-network-evidence.v1",
    runId: run.id,
    source: "test shaper",
    capturedAt: "2026-08-05T00:00:00.000Z",
    device: run.device,
    route: run.route,
    profile: run.network,
  }, String(index + 1).padStart(64, "0"));
}

describe("Phase 2 media acceptance gate", () => {
  test("passes only a complete device/network/interaction matrix with a healthy soak", () => {
    const traces = new Map(definitions.map((run, index) => [
      run.id,
      traceDocument(run, index, run.healthyNetwork ? 600_000 : 60_000),
    ]));
    const evidenceByRun = new Map(definitions.map((run, index) => [run.id, evidence(run, index)]));
    const report = evaluatePhase2Acceptance(manifest, traces, evidenceByRun, "2026-08-04T00:00:00.000Z");
    expect(report.passed).toBe(true);
    expect(report.summary).toEqual({ runs: 5, passedRuns: 5, failedRuns: 0, failedChecks: 0 });
    expect(report.matrix.every(candidate => candidate.passed)).toBe(true);
  });

  test("fails closed on old traces, underruns, missing observations, and incomplete coverage", () => {
    const incomplete: Phase2Manifest = {
      schema: "voxstudio.media-phase2-manifest.v1",
      runs: [{
        ...definitions[0] as Phase2RunDefinition,
        observations: { ...observations, staleAudioHeard: true },
      }],
    };
    const oldTrace = traceDocument(incomplete.runs[0] as Phase2RunDefinition, 0, 600_000);
    const diagnostics = (oldTrace.value as Record<string, unknown>).diagnostics as Record<string, unknown>;
    diagnostics.underruns = 2;
    delete diagnostics.bufferDepthP95Ms;
    const run = incomplete.runs[0] as Phase2RunDefinition;
    const report = evaluatePhase2Acceptance(
      incomplete,
      new Map([[run.id, oldTrace]]),
      new Map([[run.id, evidence(run, 0)]]),
    );
    expect(report.passed).toBe(false);
    expect(report.runs[0]?.checks.find(candidate => candidate.id === "healthy.underruns")?.passed).toBe(false);
    expect(report.runs[0]?.checks.find(candidate => candidate.id === "browser.buffer_depth_p95")?.passed).toBe(false);
    expect(report.runs[0]?.checks.find(candidate => candidate.id === "observation.no_stale_audio")?.passed).toBe(false);
    expect(report.matrix.find(candidate => candidate.id === "matrix.devices")?.passed).toBe(false);
  });

  test("validates manifest enums, booleans, and unique run ids before reading traces", () => {
    expect(parsePhase2Manifest(manifest)).toEqual(manifest);
    expect(() => parsePhase2Manifest({
      schema: "voxstudio.media-phase2-manifest.v1",
      runs: [{ ...definitions[0], device: "desktop" }],
    })).toThrow("device must be one of");
    expect(() => parsePhase2Manifest({
      schema: "voxstudio.media-phase2-manifest.v1",
      runs: [definitions[0], definitions[0]],
    })).toThrow("duplicate run id");
  });

  test("rejects duplicate trace/evidence paths and a constrained healthy profile", () => {
    expect(() => parsePhase2Manifest({
      schema: "voxstudio.media-phase2-manifest.v1",
      runs: [definitions[0], { ...definitions[1], trace: definitions[0]?.trace }],
    })).toThrow("duplicate trace path");
    expect(() => parsePhase2Manifest({
      schema: "voxstudio.media-phase2-manifest.v1",
      runs: [definitions[0], { ...definitions[1], networkEvidence: definitions[0]?.networkEvidence }],
    })).toThrow("duplicate network evidence path");

    const constrained: Phase2Manifest = {
      schema: "voxstudio.media-phase2-manifest.v1",
      runs: [{
        ...definitions[0] as Phase2RunDefinition,
        route: "relayed_derp",
        network: { downlinkKbps: 256, rttMs: 300, jitterMs: 100 },
      }],
    };
    const run = constrained.runs[0] as Phase2RunDefinition;
    const report = evaluatePhase2Acceptance(
      constrained,
      new Map([[run.id, traceDocument(run, 0, 600_000)]]),
      new Map([[run.id, evidence(run, 0)]]),
    );
    expect(report.runs[0]?.checks.find(candidate => candidate.id === "healthy.profile")?.passed).toBe(false);
  });

  test("does not let idle wall time, one render, or reused sessions satisfy the gate", () => {
    const traces = new Map(definitions.map((run, index) => [
      run.id,
      traceDocument(run, index, run.healthyNetwork ? 600_000 : 60_000),
    ]));
    const idle = traces.get(definitions[0]?.id as string)?.value as Record<string, unknown>;
    const diagnostics = idle.diagnostics as Record<string, unknown>;
    diagnostics.audioMs = 20;
    diagnostics.frames = 1;
    diagnostics.renderObservations = 1;
    for (const document of traces.values()) {
      (document.value as Record<string, unknown>).sessionId = "reused-session";
      document.digestSha256 = "a".repeat(64);
    }
    const evidenceByRun = new Map(definitions.map((run, index) => [run.id, evidence(run, index)]));
    const report = evaluatePhase2Acceptance(manifest, traces, evidenceByRun);
    expect(report.passed).toBe(false);
    expect(report.runs[0]?.checks.find(candidate => candidate.id === "healthy.audio_duration")?.passed).toBe(false);
    expect(report.matrix.find(candidate => candidate.id === "matrix.unique_sessions")?.passed).toBe(false);
    expect(report.matrix.find(candidate => candidate.id === "matrix.unique_traces")?.passed).toBe(false);
  });

  test("rejects reused network evidence and manifest profiles that disagree with telemetry", () => {
    const traces = new Map(definitions.map((run, index) => [run.id, traceDocument(run, index, run.healthyNetwork ? 600_000 : 60_000)]));
    const iphone = traces.get("iphone-constrained")?.value as Record<string, unknown>;
    const diagnostics = iphone.diagnostics as Record<string, unknown>;
    diagnostics.rttP50Ms = 20;
    diagnostics.rttJitterP95Ms = 0;

    const evidenceByRun = new Map(definitions.map((run, index) => [run.id, evidence(run, index)]));
    for (const value of evidenceByRun.values()) value.digestSha256 = "b".repeat(64);
    const iphoneEvidence = evidenceByRun.get("iphone-constrained") as Phase2NetworkEvidence;
    iphoneEvidence.route = "same_wifi";
    iphoneEvidence.capturedAt = "2026-08-04T00:00:00.000Z";
    const report = evaluatePhase2Acceptance(manifest, traces, evidenceByRun);

    expect(report.passed).toBe(false);
    expect(report.runs[1]?.checks.find(candidate => candidate.id === "network.rtt_p50_matches_profile")?.passed).toBe(false);
    expect(report.runs[1]?.checks.find(candidate => candidate.id === "network.jitter_p95_matches_profile")?.passed).toBe(false);
    expect(report.runs[1]?.checks.find(candidate => candidate.id === "evidence.environment")?.passed).toBe(false);
    expect(report.runs[1]?.checks.find(candidate => candidate.id === "evidence.capture_window")?.passed).toBe(false);
    expect(report.matrix.find(candidate => candidate.id === "matrix.unique_network_evidence")?.passed).toBe(false);
  });
});
