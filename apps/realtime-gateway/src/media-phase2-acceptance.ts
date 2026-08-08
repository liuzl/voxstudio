/** Machine-readable acceptance policy for docs/realtime-media-transport.md Phase 2. */

export const phase2Devices = ["iphone_safari", "android_chrome", "macos_chrome", "macos_safari"] as const;
export const phase2Routes = ["same_wifi", "cellular_overlay", "relayed_derp"] as const;
export const phase2Interactions = ["uninterrupted", "barge_in", "rapid_revision", "mute_unmute", "route_change"] as const;
export const phase2Downlinks = [256, 512, 1_024, 2_048, "unshaped"] as const;
export const phase2Rtts = [20, 100, 300] as const;
export const phase2Jitters = [0, 20, 50, 100] as const;

export type Phase2Device = typeof phase2Devices[number];
export type Phase2Route = typeof phase2Routes[number];
export type Phase2Interaction = typeof phase2Interactions[number];
export type Phase2Downlink = typeof phase2Downlinks[number];
export type Phase2Rtt = typeof phase2Rtts[number];
export type Phase2Jitter = typeof phase2Jitters[number];

export interface Phase2RunDefinition {
  id: string;
  trace: string;
  /** External network-shaper/controller record, resolved relative to the manifest. */
  networkEvidence: string;
  device: Phase2Device;
  route: Phase2Route;
  network: {
    downlinkKbps: Phase2Downlink;
    rttMs: Phase2Rtt;
    jitterMs: Phase2Jitter;
  };
  interactions: Phase2Interaction[];
  /** Marks the one ten-minute, unshaped/direct profile that must have zero underruns. */
  healthyNetwork?: boolean;
  observations: {
    staleAudioHeard: boolean;
    controlsResponsive: boolean;
    voiceQualityPassed: boolean;
    /** External/audio-loopback measurement; browser stop-call cost alone is not audible silence. */
    interruptionToSilenceP95Ms?: number;
    interruptionSamples?: number;
  };
}

export interface Phase2NetworkEvidence {
  schema: "voxstudio.media-network-evidence.v1";
  runId: string;
  source: string;
  capturedAt: string;
  device: Phase2Device;
  route: Phase2Route;
  profile: Phase2RunDefinition["network"];
  /** SHA-256 of the evidence file, added by the gate loader for an auditable report. */
  digestSha256: string;
}

export interface Phase2TraceDocument {
  /** Parsed Studio media-trace export. */
  value: unknown;
  /** SHA-256 of the exact trace file read by the gate. */
  digestSha256: string;
}

export interface Phase2Manifest {
  schema: "voxstudio.media-phase2-manifest.v1";
  runs: Phase2RunDefinition[];
}

export interface AcceptanceCheck {
  id: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface Phase2RunReport {
  id: string;
  trace: string;
  environment: Omit<Phase2RunDefinition, "id" | "trace" | "observations">;
  observations: Phase2RunDefinition["observations"];
  traceSessionId: string | null;
  traceDigestSha256: string | null;
  networkEvidenceDigest: string | null;
  passed: boolean;
  checks: AcceptanceCheck[];
  metrics: Record<string, unknown>;
}

export interface Phase2AcceptanceReport {
  schema: "voxstudio.media-phase2-report.v1";
  generatedAt: string;
  passed: boolean;
  summary: { runs: number; passedRuns: number; failedRuns: number; failedChecks: number };
  matrix: AcceptanceCheck[];
  runs: Phase2RunReport[];
}

interface TraceDiagnostics {
  codec?: unknown;
  sampleRate?: unknown;
  mediaFormatChanges?: unknown;
  underruns?: unknown;
  droppedFrames?: unknown;
  staleDroppedFrames?: unknown;
  unexpectedDroppedFrames?: unknown;
  maxQueuedAudioMs?: unknown;
  bufferDepthP95Ms?: unknown;
  interruptionStops?: unknown;
  interruptionStopP95Ms?: unknown;
  renderObservations?: unknown;
  estimatedRenders?: unknown;
  frames?: unknown;
  audioMs?: unknown;
  rttSamples?: unknown;
  rttP50Ms?: unknown;
  rttP95Ms?: unknown;
  rttJitterP95Ms?: unknown;
}

interface TraceExport {
  schema?: unknown;
  privacy?: unknown;
  startedAtMs?: unknown;
  exportedAtMs?: unknown;
  sessionId?: unknown;
  diagnostics?: TraceDiagnostics;
  events?: unknown;
}

function droppedFrameCounts(trace: TraceExport, diagnostics: TraceDiagnostics): {
  total: number | undefined;
  stale: number | undefined;
  unexpected: number | undefined;
} {
  const total = finite(diagnostics.droppedFrames) ? diagnostics.droppedFrames : undefined;
  if (finite(diagnostics.staleDroppedFrames) && finite(diagnostics.unexpectedDroppedFrames)) {
    return { total, stale: diagnostics.staleDroppedFrames, unexpected: diagnostics.unexpectedDroppedFrames };
  }
  const raw = Array.isArray(trace.events) ? trace.events.flatMap(entry => {
    if (!record(entry) || !record(entry.event)) return [];
    const event = entry.event;
    return event.type === "media.socket" && event.dropped === true ? [event] : [];
  }) : [];
  if (total !== undefined && raw.length === total) {
    const stale = raw.filter(event => event.discardReason === "stale_rendition").length;
    return { total, stale, unexpected: total - stale };
  }
  return { total, stale: total === undefined ? undefined : 0, unexpected: total };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function member<T extends readonly unknown[]>(name: string, value: unknown, values: T): T[number] {
  if (!values.includes(value as T[number])) throw new TypeError(`${name} must be one of ${values.join(", ")}`);
  return value as T[number];
}

function boolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function positiveInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

const sha256 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);

export function parsePhase2NetworkEvidence(value: unknown, digestSha256: string): Phase2NetworkEvidence {
  if (!record(value) || value.schema !== "voxstudio.media-network-evidence.v1") {
    throw new TypeError("network evidence must use schema voxstudio.media-network-evidence.v1");
  }
  if (typeof value.runId !== "string" || value.runId.trim() === "") throw new TypeError("network evidence runId must be non-empty");
  if (typeof value.source !== "string" || value.source.trim() === "") throw new TypeError("network evidence source must be non-empty");
  if (typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) {
    throw new TypeError("network evidence capturedAt must be an ISO timestamp");
  }
  if (!record(value.profile)) throw new TypeError("network evidence profile must be an object");
  if (!sha256(digestSha256)) throw new TypeError("network evidence digest must be SHA-256 hex");
  return {
    schema: "voxstudio.media-network-evidence.v1",
    runId: value.runId,
    source: value.source,
    capturedAt: value.capturedAt,
    device: member("evidence device", value.device, phase2Devices),
    route: member("evidence route", value.route, phase2Routes),
    profile: {
      downlinkKbps: member("evidence downlinkKbps", value.profile.downlinkKbps, phase2Downlinks),
      rttMs: member("evidence rttMs", value.profile.rttMs, phase2Rtts),
      jitterMs: member("evidence jitterMs", value.profile.jitterMs, phase2Jitters),
    },
    digestSha256: digestSha256.toLowerCase(),
  };
}

export function parsePhase2Manifest(value: unknown): Phase2Manifest {
  if (!record(value) || value.schema !== "voxstudio.media-phase2-manifest.v1" || !Array.isArray(value.runs)) {
    throw new TypeError("manifest must use schema voxstudio.media-phase2-manifest.v1 and contain runs[]");
  }
  const ids = new Set<string>();
  const tracePaths = new Set<string>();
  const evidencePaths = new Set<string>();
  const runs = value.runs.map((candidate, index): Phase2RunDefinition => {
    if (!record(candidate)) throw new TypeError(`runs[${index}] must be an object`);
    const id = candidate.id;
    const trace = candidate.trace;
    const networkEvidence = candidate.networkEvidence;
    if (typeof id !== "string" || id.trim() === "") throw new TypeError(`runs[${index}].id must be non-empty`);
    if (ids.has(id)) throw new TypeError(`duplicate run id ${id}`);
    ids.add(id);
    if (typeof trace !== "string" || trace.trim() === "") throw new TypeError(`runs[${index}].trace must be non-empty`);
    if (tracePaths.has(trace)) throw new TypeError(`duplicate trace path ${trace}`);
    tracePaths.add(trace);
    if (typeof networkEvidence !== "string" || networkEvidence.trim() === "") {
      throw new TypeError(`runs[${index}].networkEvidence must be non-empty`);
    }
    if (evidencePaths.has(networkEvidence)) throw new TypeError(`duplicate network evidence path ${networkEvidence}`);
    evidencePaths.add(networkEvidence);
    if (!record(candidate.network)) throw new TypeError(`runs[${index}].network must be an object`);
    if (!Array.isArray(candidate.interactions) || candidate.interactions.length === 0) {
      throw new TypeError(`runs[${index}].interactions must be non-empty`);
    }
    if (!record(candidate.observations)) throw new TypeError(`runs[${index}].observations must be an object`);
    const interruptionToSilenceP95Ms = candidate.observations.interruptionToSilenceP95Ms;
    const interruptionSamples = candidate.observations.interruptionSamples;
    if (interruptionToSilenceP95Ms !== undefined
        && (!finite(interruptionToSilenceP95Ms) || interruptionToSilenceP95Ms < 0)) {
      throw new TypeError("interruptionToSilenceP95Ms must be a non-negative number");
    }
    return {
      id,
      trace,
      networkEvidence,
      device: member("device", candidate.device, phase2Devices),
      route: member("route", candidate.route, phase2Routes),
      network: {
        downlinkKbps: member("downlinkKbps", candidate.network.downlinkKbps, phase2Downlinks),
        rttMs: member("rttMs", candidate.network.rttMs, phase2Rtts),
        jitterMs: member("jitterMs", candidate.network.jitterMs, phase2Jitters),
      },
      interactions: [...new Set(candidate.interactions.map(interaction => member("interaction", interaction, phase2Interactions)))],
      ...(candidate.healthyNetwork === undefined ? {} : { healthyNetwork: boolean("healthyNetwork", candidate.healthyNetwork) }),
      observations: {
        staleAudioHeard: boolean("staleAudioHeard", candidate.observations.staleAudioHeard),
        controlsResponsive: boolean("controlsResponsive", candidate.observations.controlsResponsive),
        voiceQualityPassed: boolean("voiceQualityPassed", candidate.observations.voiceQualityPassed),
        ...(interruptionToSilenceP95Ms === undefined ? {} : { interruptionToSilenceP95Ms }),
        ...(interruptionSamples === undefined ? {} : { interruptionSamples: positiveInteger("interruptionSamples", interruptionSamples) }),
      },
    };
  });
  if (runs.length === 0) throw new TypeError("manifest must contain at least one run");
  return { schema: "voxstudio.media-phase2-manifest.v1", runs };
}

function check(id: string, passed: boolean, expected: unknown, actual: unknown): AcceptanceCheck {
  return { id, passed, expected, actual };
}

function numberAtMost(id: string, value: unknown, maximum: number): AcceptanceCheck {
  return check(id, finite(value) && value <= maximum, `<= ${maximum}`, value ?? null);
}

function numberEquals(id: string, value: unknown, expected: number): AcceptanceCheck {
  return check(id, finite(value) && value === expected, expected, value ?? null);
}

function numberAtLeast(id: string, value: unknown, minimum: number): AcceptanceCheck {
  return check(id, finite(value) && value >= minimum, `>= ${minimum}`, value ?? null);
}

function coverage<T>(id: string, actual: Set<T>, required: readonly T[]): AcceptanceCheck {
  const missing = required.filter(value => !actual.has(value));
  return check(id, missing.length === 0, [...required], { covered: [...actual], missing });
}

function evaluateRun(
  run: Phase2RunDefinition,
  document: Phase2TraceDocument | undefined,
  evidence: Phase2NetworkEvidence | undefined,
): Phase2RunReport {
  const input = document?.value;
  const trace = record(input) ? input as TraceExport : {};
  const diagnostics = record(trace.diagnostics) ? trace.diagnostics : {};
  const dropped = droppedFrameCounts(trace, diagnostics);
  const durationMs = finite(trace.startedAtMs) && finite(trace.exportedAtMs)
    ? Math.max(0, trace.exportedAtMs - trace.startedAtMs)
    : undefined;
  const evidenceCapturedAtMs = evidence === undefined ? undefined : Date.parse(evidence.capturedAt);
  const evidenceWindowToleranceMs = 15 * 60_000;
  const checks: AcceptanceCheck[] = [
    check("trace.schema", trace.schema === "voxstudio.media-trace.v2", "voxstudio.media-trace.v2", trace.schema ?? null),
    check("trace.privacy", trace.privacy === "metadata_only", "metadata_only", trace.privacy ?? null),
    check("trace.digest", sha256(document?.digestSha256), "SHA-256", document?.digestSha256 ?? null),
    check("trace.session_id", typeof trace.sessionId === "string" && trace.sessionId.length > 0, "non-empty", trace.sessionId ?? null),
    check("trace.duration", finite(durationMs) && durationMs >= 30_000, ">= 30000ms", durationMs ?? null),
    check("media.codec", diagnostics.codec === "pcm_s16le", "pcm_s16le", diagnostics.codec ?? null),
    numberEquals("media.sample_rate", diagnostics.sampleRate, 24_000),
    numberEquals("media.format_changes", diagnostics.mediaFormatChanges, 0),
    numberAtLeast("media.audio_duration", diagnostics.audioMs, 30_000),
    numberAtLeast("media.frames", diagnostics.frames, 1_500),
    check("media.dropped_frame_accounting", finite(dropped.total) && finite(dropped.stale) && finite(dropped.unexpected)
      && dropped.total === dropped.stale + dropped.unexpected,
    "total = stale + unexpected", dropped),
    numberEquals("media.unexpected_dropped_frames", dropped.unexpected, 0),
    numberAtMost("media.max_queued_audio", diagnostics.maxQueuedAudioMs, 1_000),
    numberAtMost("browser.buffer_depth_p95", diagnostics.bufferDepthP95Ms, 600),
    numberAtLeast("browser.render_observed", diagnostics.renderObservations, 1_350),
    check(
      "browser.render_coverage",
      finite(diagnostics.renderObservations) && finite(diagnostics.frames)
        && diagnostics.renderObservations >= diagnostics.frames * 0.9,
      ">= 90% of media frames",
      finite(diagnostics.renderObservations) && finite(diagnostics.frames)
        ? diagnostics.renderObservations / Math.max(1, diagnostics.frames)
        : null,
    ),
    numberEquals("browser.estimated_renders", diagnostics.estimatedRenders, 0),
    numberAtLeast("network.rtt_samples", diagnostics.rttSamples, 5),
    check(
      "network.rtt_p50_matches_profile",
      finite(diagnostics.rttP50Ms)
        && diagnostics.rttP50Ms >= (run.network.rttMs <= 20 ? 0 : run.network.rttMs * 0.5)
        && diagnostics.rttP50Ms <= run.network.rttMs * 2 + 20,
      run.network.rttMs <= 20 ? "0..60ms" : `${run.network.rttMs * 0.5}..${run.network.rttMs * 2 + 20}ms`,
      diagnostics.rttP50Ms ?? null,
    ),
    check(
      "network.jitter_p95_matches_profile",
      finite(diagnostics.rttJitterP95Ms)
        && (run.network.jitterMs === 0
          ? diagnostics.rttJitterP95Ms <= 15
          : diagnostics.rttJitterP95Ms >= run.network.jitterMs * 0.2
            && diagnostics.rttJitterP95Ms <= run.network.jitterMs * 3 + 10),
      run.network.jitterMs === 0
        ? "<= 15ms"
        : `${run.network.jitterMs * 0.2}..${run.network.jitterMs * 3 + 10}ms`,
      diagnostics.rttJitterP95Ms ?? null,
    ),
    check("evidence.present", evidence !== undefined, "loaded", evidence === undefined ? null : evidence.source),
    check("evidence.run_id", evidence?.runId === run.id, run.id, evidence?.runId ?? null),
    check("evidence.environment", evidence?.device === run.device && evidence?.route === run.route,
      { device: run.device, route: run.route },
      evidence === undefined ? null : { device: evidence.device, route: evidence.route }),
    check("evidence.profile", evidence !== undefined
      && evidence.profile.downlinkKbps === run.network.downlinkKbps
      && evidence.profile.rttMs === run.network.rttMs
      && evidence.profile.jitterMs === run.network.jitterMs, run.network, evidence?.profile ?? null),
    check(
      "evidence.capture_window",
      finite(trace.startedAtMs) && finite(trace.exportedAtMs) && finite(evidenceCapturedAtMs)
        && evidenceCapturedAtMs >= trace.startedAtMs - evidenceWindowToleranceMs
        && evidenceCapturedAtMs <= trace.exportedAtMs + evidenceWindowToleranceMs,
      "within 15 minutes of trace window",
      evidence?.capturedAt ?? null,
    ),
    check("evidence.digest", evidence !== undefined && sha256(evidence.digestSha256), "SHA-256", evidence?.digestSha256 ?? null),
    check("observation.no_stale_audio", run.observations.staleAudioHeard === false, false, run.observations.staleAudioHeard),
    check("observation.controls_responsive", run.observations.controlsResponsive === true, true, run.observations.controlsResponsive),
    check("observation.voice_quality", run.observations.voiceQualityPassed === true, true, run.observations.voiceQualityPassed),
  ];
  if (run.interactions.includes("barge_in") || run.interactions.includes("rapid_revision")) {
    checks.push(
      check("browser.interruption_observed", finite(diagnostics.interruptionStops) && diagnostics.interruptionStops > 0, "> 0", diagnostics.interruptionStops ?? null),
      numberAtLeast("browser.interruption_samples", diagnostics.interruptionStops, 10),
      numberAtMost("browser.interruption_stop_p95", diagnostics.interruptionStopP95Ms, 150),
      numberAtLeast("observation.interruption_samples", run.observations.interruptionSamples, 10),
      numberAtMost("observation.interruption_to_silence_p95", run.observations.interruptionToSilenceP95Ms, 150),
    );
  }
  if (run.healthyNetwork === true) {
    checks.push(
      check("healthy.duration", finite(durationMs) && durationMs >= 600_000, ">= 600000ms", durationMs ?? null),
      numberAtLeast("healthy.audio_duration", diagnostics.audioMs, 600_000),
      numberAtLeast("healthy.frames", diagnostics.frames, 30_000),
      numberAtLeast("healthy.render_observations", diagnostics.renderObservations, 27_000),
      numberAtLeast("healthy.rtt_samples", diagnostics.rttSamples, 100),
      check("healthy.profile", run.route === "same_wifi"
        && run.network.downlinkKbps === "unshaped"
        && run.network.rttMs === 20
        && run.network.jitterMs === 0,
      { route: "same_wifi", downlinkKbps: "unshaped", rttMs: 20, jitterMs: 0 },
      { route: run.route, ...run.network }),
      numberEquals("healthy.underruns", diagnostics.underruns, 0),
    );
  }
  return {
    id: run.id,
    trace: run.trace,
    environment: {
      device: run.device,
      route: run.route,
      network: run.network,
      interactions: run.interactions,
      networkEvidence: run.networkEvidence,
      ...(run.healthyNetwork === undefined ? {} : { healthyNetwork: run.healthyNetwork }),
    },
    observations: run.observations,
    traceSessionId: typeof trace.sessionId === "string" ? trace.sessionId : null,
    traceDigestSha256: sha256(document?.digestSha256) ? document.digestSha256.toLowerCase() : null,
    networkEvidenceDigest: evidence?.digestSha256 ?? null,
    passed: checks.every(candidate => candidate.passed),
    checks,
    metrics: {
      durationMs: durationMs ?? null,
      codec: diagnostics.codec ?? null,
      sampleRate: diagnostics.sampleRate ?? null,
      mediaFormatChanges: diagnostics.mediaFormatChanges ?? null,
      frames: diagnostics.frames ?? null,
      audioMs: diagnostics.audioMs ?? null,
      underruns: diagnostics.underruns ?? null,
      droppedFrames: diagnostics.droppedFrames ?? null,
      staleDroppedFrames: dropped.stale ?? null,
      unexpectedDroppedFrames: dropped.unexpected ?? null,
      maxQueuedAudioMs: diagnostics.maxQueuedAudioMs ?? null,
      bufferDepthP95Ms: diagnostics.bufferDepthP95Ms ?? null,
      interruptionStops: diagnostics.interruptionStops ?? null,
      interruptionStopP95Ms: diagnostics.interruptionStopP95Ms ?? null,
      rttSamples: diagnostics.rttSamples ?? null,
      rttP50Ms: diagnostics.rttP50Ms ?? null,
      rttP95Ms: diagnostics.rttP95Ms ?? null,
      rttJitterP95Ms: diagnostics.rttJitterP95Ms ?? null,
    },
  };
}

export function evaluatePhase2Acceptance(
  manifest: Phase2Manifest,
  traces: ReadonlyMap<string, Phase2TraceDocument>,
  evidence: ReadonlyMap<string, Phase2NetworkEvidence>,
  generatedAt = new Date().toISOString(),
): Phase2AcceptanceReport {
  const runs = manifest.runs.map(run => evaluateRun(run, traces.get(run.id), evidence.get(run.id)));
  const matrix: AcceptanceCheck[] = [
    coverage("matrix.devices", new Set(manifest.runs.map(run => run.device)), phase2Devices),
    coverage("matrix.routes", new Set(manifest.runs.map(run => run.route)), phase2Routes),
    coverage("matrix.downlinks", new Set(manifest.runs.map(run => run.network.downlinkKbps)), phase2Downlinks),
    coverage("matrix.rtts", new Set(manifest.runs.map(run => run.network.rttMs)), phase2Rtts),
    coverage("matrix.jitters", new Set(manifest.runs.map(run => run.network.jitterMs)), phase2Jitters),
    coverage("matrix.interactions", new Set(manifest.runs.flatMap(run => run.interactions)), phase2Interactions),
    check(
      "matrix.unique_sessions",
      new Set(runs.map(run => run.traceSessionId).filter((value): value is string => value !== null)).size === runs.length,
      `${runs.length} unique non-empty session ids`,
      runs.map(run => run.traceSessionId),
    ),
    check(
      "matrix.unique_traces",
      new Set(runs.map(run => run.traceDigestSha256).filter((value): value is string => value !== null)).size === runs.length,
      `${runs.length} unique trace digests`,
      runs.map(run => run.traceDigestSha256),
    ),
    check(
      "matrix.unique_network_evidence",
      new Set(runs.map(run => run.networkEvidenceDigest).filter((value): value is string => value !== null)).size === runs.length,
      `${runs.length} unique evidence digests`,
      runs.map(run => run.networkEvidenceDigest),
    ),
    check(
      "matrix.healthy_soak",
      manifest.runs.some((run, index) => run.healthyNetwork === true && runs[index]?.passed === true),
      "one passing healthyNetwork run",
      manifest.runs.filter(run => run.healthyNetwork === true).map(run => run.id),
    ),
  ];
  const failedChecks = [...matrix, ...runs.flatMap(run => run.checks)].filter(candidate => !candidate.passed).length;
  const passedRuns = runs.filter(run => run.passed).length;
  return {
    schema: "voxstudio.media-phase2-report.v1",
    generatedAt,
    passed: failedChecks === 0,
    summary: { runs: runs.length, passedRuns, failedRuns: runs.length - passedRuns, failedChecks },
    matrix,
    runs,
  };
}
