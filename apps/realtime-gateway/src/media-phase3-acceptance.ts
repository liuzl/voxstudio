/** Machine-readable acceptance policy for docs/realtime-media-transport.md Phase 3. */

export const phase3Deployments = ["livekit_cloud", "self_hosted"] as const;
export const phase3Devices = ["iphone_safari", "android_chrome", "macos_chrome", "macos_safari"] as const;
export const phase3Routes = ["same_wifi", "cellular_overlay", "relayed_derp"] as const;
export const phase3Interactions = [
  "uninterrupted", "barge_in", "rapid_revision", "mute_unmute", "route_change", "reconnect",
] as const;
export const phase3Downlinks = [256, 512, 1_024, 2_048, "unshaped"] as const;
export const phase3Rtts = [20, 100, 300] as const;
export const phase3Jitters = [0, 20, 50, 100] as const;
export const phase3PacketLoss = [0, 1, 3] as const;
export const phase3LossDirections = ["downlink", "uplink", "bidirectional"] as const;

export type Phase3Deployment = typeof phase3Deployments[number];
export type Phase3Device = typeof phase3Devices[number];
export type Phase3Route = typeof phase3Routes[number];
export type Phase3Interaction = typeof phase3Interactions[number];
export type Phase3Downlink = typeof phase3Downlinks[number];
export type Phase3Rtt = typeof phase3Rtts[number];
export type Phase3Jitter = typeof phase3Jitters[number];
export type Phase3PacketLoss = typeof phase3PacketLoss[number];
export type Phase3LossDirection = typeof phase3LossDirections[number];

export interface Phase3NetworkProfile {
  downlinkKbps: Phase3Downlink;
  rttMs: Phase3Rtt;
  jitterMs: Phase3Jitter;
  packetLossPct: Phase3PacketLoss;
  packetLossDirection: Phase3LossDirection;
}

export interface Phase3RunDefinition {
  id: string;
  trace: string;
  networkEvidence: string;
  device: Phase3Device;
  route: Phase3Route;
  network: Phase3NetworkProfile;
  interactions: Phase3Interaction[];
  /** Marks the ten-minute, unshaped/direct WebRTC baseline. */
  healthyNetwork?: boolean;
  observations: {
    staleAudioHeard: boolean;
    audioDropoutsHeard: boolean;
    controlsResponsive: boolean;
    voiceQualityPassed: boolean;
    microphoneReleasedAfterEnd: boolean;
    interruptionToSilenceP95Ms?: number;
    interruptionSamples?: number;
    routeChangeRecovered?: boolean;
    reconnectRecovered?: boolean;
    muteUnmutePassed?: boolean;
  };
}

export interface Phase3Manifest {
  schema: "voxstudio.media-phase3-manifest.v1";
  deployment: Phase3Deployment;
  /** Required for livekit_cloud; resolved relative to the manifest. */
  billingEvidence?: string;
  runs: Phase3RunDefinition[];
}

export interface Phase3NetworkEvidence {
  schema: "voxstudio.media-network-evidence.v2";
  runId: string;
  source: string;
  capturedAt: string;
  device: Phase3Device;
  route: Phase3Route;
  profile: Phase3NetworkProfile;
  digestSha256: string;
}

export interface Phase3BillingEvidence {
  schema: "voxstudio.livekit-billing-evidence.v1";
  source: string;
  periodStart: string;
  periodEnd: string;
  participantMinutes: number;
  downstreamBytes: number;
  digestSha256: string;
}

export interface Phase3TraceDocument {
  value: unknown;
  digestSha256: string;
}

export interface Phase3AcceptanceCheck {
  id: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface Phase3RunReport {
  id: string;
  trace: string;
  traceSessionId: string | null;
  traceDigestSha256: string | null;
  networkEvidenceDigest: string | null;
  passed: boolean;
  checks: Phase3AcceptanceCheck[];
  metrics: Record<string, unknown>;
}

export interface Phase3AcceptanceReport {
  schema: "voxstudio.media-phase3-report.v1";
  generatedAt: string;
  deployment: Phase3Deployment;
  passed: boolean;
  summary: { runs: number; passedRuns: number; failedRuns: number; failedChecks: number };
  matrix: Phase3AcceptanceCheck[];
  runs: Phase3RunReport[];
  billing: {
    evidenceDigest: string | null;
    measuredParticipantMinutes: number;
    measuredDownstreamBytes: number;
    checks: Phase3AcceptanceCheck[];
  };
}

interface TraceDiagnostics {
  transport?: unknown;
  transportFallbackReason?: unknown;
  codec?: unknown;
  sampleRate?: unknown;
  frames?: unknown;
  audioMs?: unknown;
  webrtcSamples?: unknown;
  uplinkBitrateP95Kbps?: unknown;
  downlinkBitrateP95Kbps?: unknown;
  downlinkRtpBitrateP95Kbps?: unknown;
  downlinkRtpBytes?: unknown;
  uplinkPacketLossP95Pct?: unknown;
  downlinkPacketLossP95Pct?: unknown;
  webrtcRttP95Ms?: unknown;
  downlinkJitterP95Ms?: unknown;
  downlinkJitterBufferP95Ms?: unknown;
  downlinkJitterBufferTargetP95Ms?: unknown;
  underruns?: unknown;
  maxQueuedAudioMs?: unknown;
  highWaterBytes?: unknown;
  droppedFrames?: unknown;
  staleDroppedFrames?: unknown;
  unexpectedDroppedFrames?: unknown;
  playbackObservations?: unknown;
  concealedSamples?: unknown;
  concealmentEvents?: unknown;
}

interface TraceExport {
  schema?: unknown;
  privacy?: unknown;
  sessionId?: unknown;
  startedAtMs?: unknown;
  exportedAtMs?: unknown;
  diagnostics?: TraceDiagnostics;
  events?: unknown;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);

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
  // Old v2 traces can be classified only while their bounded raw event window still
  // contains every drop. Otherwise fail closed by treating the legacy total as loss.
  if (total !== undefined && raw.length === total) {
    const stale = raw.filter(event => event.discardReason === "stale_rendition").length;
    return { total, stale, unexpected: total - stale };
  }
  return { total, stale: total === undefined ? undefined : 0, unexpected: total };
}

function member<T extends readonly unknown[]>(name: string, value: unknown, values: T): T[number] {
  if (!values.includes(value as T[number])) throw new TypeError(`${name} must be one of ${values.join(", ")}`);
  return value as T[number];
}

function boolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function nonNegative(name: string, value: unknown): number {
  if (!finite(value) || value < 0) throw new TypeError(`${name} must be a non-negative number`);
  return value;
}

function positiveInteger(name: string, value: unknown): number {
  if (!finite(value) || !Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(name: string, value: unknown): number {
  if (!finite(value) || !Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function text(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty`);
  return value;
}

function timestamp(name: string, value: unknown): string {
  const result = text(name, value);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${name} must be an ISO timestamp`);
  return result;
}

function profile(value: unknown, prefix: string): Phase3NetworkProfile {
  if (!record(value)) throw new TypeError(`${prefix} must be an object`);
  return {
    downlinkKbps: member(`${prefix}.downlinkKbps`, value.downlinkKbps, phase3Downlinks),
    rttMs: member(`${prefix}.rttMs`, value.rttMs, phase3Rtts),
    jitterMs: member(`${prefix}.jitterMs`, value.jitterMs, phase3Jitters),
    packetLossPct: member(`${prefix}.packetLossPct`, value.packetLossPct, phase3PacketLoss),
    packetLossDirection: member(`${prefix}.packetLossDirection`, value.packetLossDirection, phase3LossDirections),
  };
}

export function parsePhase3Manifest(value: unknown): Phase3Manifest {
  if (!record(value) || value.schema !== "voxstudio.media-phase3-manifest.v1" || !Array.isArray(value.runs)) {
    throw new TypeError("manifest must use schema voxstudio.media-phase3-manifest.v1 and contain runs[]");
  }
  const deployment = member("deployment", value.deployment, phase3Deployments);
  const billingEvidence = value.billingEvidence === undefined ? undefined : text("billingEvidence", value.billingEvidence);
  if (deployment === "livekit_cloud" && billingEvidence === undefined) {
    throw new TypeError("livekit_cloud manifest requires billingEvidence");
  }
  const ids = new Set<string>();
  const tracePaths = new Set<string>();
  const evidencePaths = new Set<string>();
  const runs = value.runs.map((candidate, index): Phase3RunDefinition => {
    if (!record(candidate)) throw new TypeError(`runs[${index}] must be an object`);
    const id = text(`runs[${index}].id`, candidate.id);
    const trace = text(`runs[${index}].trace`, candidate.trace);
    const networkEvidence = text(`runs[${index}].networkEvidence`, candidate.networkEvidence);
    if (ids.has(id)) throw new TypeError(`duplicate run id ${id}`);
    if (tracePaths.has(trace)) throw new TypeError(`duplicate trace path ${trace}`);
    if (evidencePaths.has(networkEvidence)) throw new TypeError(`duplicate network evidence path ${networkEvidence}`);
    ids.add(id);
    tracePaths.add(trace);
    evidencePaths.add(networkEvidence);
    if (!Array.isArray(candidate.interactions) || candidate.interactions.length === 0) {
      throw new TypeError(`runs[${index}].interactions must be non-empty`);
    }
    if (!record(candidate.observations)) throw new TypeError(`runs[${index}].observations must be an object`);
    const interruptionToSilenceP95Ms = candidate.observations.interruptionToSilenceP95Ms;
    const interruptionSamples = candidate.observations.interruptionSamples;
    return {
      id,
      trace,
      networkEvidence,
      device: member("device", candidate.device, phase3Devices),
      route: member("route", candidate.route, phase3Routes),
      network: profile(candidate.network, `runs[${index}].network`),
      interactions: [...new Set(candidate.interactions.map(interaction => member("interaction", interaction, phase3Interactions)))],
      ...(candidate.healthyNetwork === undefined ? {} : { healthyNetwork: boolean("healthyNetwork", candidate.healthyNetwork) }),
      observations: {
        staleAudioHeard: boolean("staleAudioHeard", candidate.observations.staleAudioHeard),
        audioDropoutsHeard: boolean("audioDropoutsHeard", candidate.observations.audioDropoutsHeard),
        controlsResponsive: boolean("controlsResponsive", candidate.observations.controlsResponsive),
        voiceQualityPassed: boolean("voiceQualityPassed", candidate.observations.voiceQualityPassed),
        microphoneReleasedAfterEnd: boolean("microphoneReleasedAfterEnd", candidate.observations.microphoneReleasedAfterEnd),
        ...(interruptionToSilenceP95Ms === undefined ? {} : {
          interruptionToSilenceP95Ms: nonNegative("interruptionToSilenceP95Ms", interruptionToSilenceP95Ms),
        }),
        ...(interruptionSamples === undefined ? {} : { interruptionSamples: positiveInteger("interruptionSamples", interruptionSamples) }),
        ...(candidate.observations.routeChangeRecovered === undefined ? {} : {
          routeChangeRecovered: boolean("routeChangeRecovered", candidate.observations.routeChangeRecovered),
        }),
        ...(candidate.observations.reconnectRecovered === undefined ? {} : {
          reconnectRecovered: boolean("reconnectRecovered", candidate.observations.reconnectRecovered),
        }),
        ...(candidate.observations.muteUnmutePassed === undefined ? {} : {
          muteUnmutePassed: boolean("muteUnmutePassed", candidate.observations.muteUnmutePassed),
        }),
      },
    };
  });
  if (runs.length === 0) throw new TypeError("manifest must contain at least one run");
  return {
    schema: "voxstudio.media-phase3-manifest.v1",
    deployment,
    ...(billingEvidence === undefined ? {} : { billingEvidence }),
    runs,
  };
}

export function parsePhase3NetworkEvidence(value: unknown, digestSha256: string): Phase3NetworkEvidence {
  if (!record(value) || value.schema !== "voxstudio.media-network-evidence.v2") {
    throw new TypeError("network evidence must use schema voxstudio.media-network-evidence.v2");
  }
  if (!sha256(digestSha256)) throw new TypeError("network evidence digest must be SHA-256 hex");
  return {
    schema: "voxstudio.media-network-evidence.v2",
    runId: text("network evidence runId", value.runId),
    source: text("network evidence source", value.source),
    capturedAt: timestamp("network evidence capturedAt", value.capturedAt),
    device: member("evidence device", value.device, phase3Devices),
    route: member("evidence route", value.route, phase3Routes),
    profile: profile(value.profile, "network evidence profile"),
    digestSha256: digestSha256.toLowerCase(),
  };
}

export function parsePhase3BillingEvidence(value: unknown, digestSha256: string): Phase3BillingEvidence {
  if (!record(value) || value.schema !== "voxstudio.livekit-billing-evidence.v1") {
    throw new TypeError("billing evidence must use schema voxstudio.livekit-billing-evidence.v1");
  }
  if (!sha256(digestSha256)) throw new TypeError("billing evidence digest must be SHA-256 hex");
  const periodStart = timestamp("billing periodStart", value.periodStart);
  const periodEnd = timestamp("billing periodEnd", value.periodEnd);
  if (Date.parse(periodEnd) <= Date.parse(periodStart)) throw new TypeError("billing periodEnd must follow periodStart");
  return {
    schema: "voxstudio.livekit-billing-evidence.v1",
    source: text("billing source", value.source),
    periodStart,
    periodEnd,
    participantMinutes: nonNegative("billing participantMinutes", value.participantMinutes),
    downstreamBytes: nonNegativeInteger("billing downstreamBytes", value.downstreamBytes),
    digestSha256: digestSha256.toLowerCase(),
  };
}

function check(id: string, passed: boolean, expected: unknown, actual: unknown): Phase3AcceptanceCheck {
  return { id, passed, expected, actual };
}

function atLeast(id: string, value: unknown, minimum: number): Phase3AcceptanceCheck {
  return check(id, finite(value) && value >= minimum, `>= ${minimum}`, value ?? null);
}

function atMost(id: string, value: unknown, maximum: number): Phase3AcceptanceCheck {
  return check(id, finite(value) && value >= 0 && value <= maximum, `0..${maximum}`, value ?? null);
}

function coverage<T>(id: string, actual: Set<T>, required: readonly T[]): Phase3AcceptanceCheck {
  const missing = required.filter(value => !actual.has(value));
  return check(id, missing.length === 0, [...required], { covered: [...actual], missing });
}

function browserEvents(trace: TraceExport): Record<string, unknown>[] {
  if (!Array.isArray(trace.events)) return [];
  return trace.events.flatMap(entry => {
    if (!record(entry) || !record(entry.event)) return [];
    return [entry.event];
  });
}

function webRtcEvents(trace: TraceExport): Record<string, unknown>[] {
  return browserEvents(trace).filter(event => event.stage === "browser.webrtc");
}

function hasMuteCycle(events: Record<string, unknown>[]): boolean {
  let muted = false;
  for (const event of events) {
    if (event.stage !== "browser.mute" || typeof event.muted !== "boolean") continue;
    if (event.muted) muted = true;
    else if (muted) return true;
  }
  return false;
}

function sameProfile(left: Phase3NetworkProfile | undefined, right: Phase3NetworkProfile): boolean {
  return left !== undefined
    && left.downlinkKbps === right.downlinkKbps
    && left.rttMs === right.rttMs
    && left.jitterMs === right.jitterMs
    && left.packetLossPct === right.packetLossPct
    && left.packetLossDirection === right.packetLossDirection;
}

function profileMatch(value: unknown, target: number, zeroMaximum: number): boolean {
  if (!finite(value)) return false;
  return target === 0
    ? value >= 0 && value <= zeroMaximum
    : value >= target * 0.2 && value <= target * 3 + zeroMaximum;
}

function evaluateRun(
  run: Phase3RunDefinition,
  document: Phase3TraceDocument | undefined,
  evidence: Phase3NetworkEvidence | undefined,
): Phase3RunReport {
  const trace = record(document?.value) ? document.value as TraceExport : {};
  const diagnostics = record(trace.diagnostics) ? trace.diagnostics : {};
  const dropped = droppedFrameCounts(trace, diagnostics);
  const durationMs = finite(trace.startedAtMs) && finite(trace.exportedAtMs)
    ? Math.max(0, trace.exportedAtMs - trace.startedAtMs)
    : undefined;
  const events = webRtcEvents(trace);
  const muteCycleObserved = hasMuteCycle(browserEvents(trace));
  const concealmentAvailable = events.some(event => finite(event.concealmentEventsDelta));
  const uplinkSamples = events.filter(event => event.direction === "uplink").length;
  const downlinkSamples = events.filter(event => event.direction === "downlink").length;
  const auditableDownlinkSamples = events.filter(event => event.direction === "downlink"
    && typeof event.streamId === "string" && event.streamId.length > 0
    && finite(event.rtpBytesDelta) && event.rtpBytesDelta >= 0).length;
  // This aggregate survives the recorder's bounded raw-event rollover during a long soak.
  const measuredDownstreamBytes = finite(diagnostics.downlinkRtpBytes) ? diagnostics.downlinkRtpBytes : undefined;
  const evidenceAt = evidence === undefined ? undefined : Date.parse(evidence.capturedAt);
  const evidenceToleranceMs = 15 * 60_000;
  const checks: Phase3AcceptanceCheck[] = [
    check("trace.schema", trace.schema === "voxstudio.media-trace.v2", "voxstudio.media-trace.v2", trace.schema ?? null),
    check("trace.privacy", trace.privacy === "metadata_only", "metadata_only", trace.privacy ?? null),
    check("trace.digest", sha256(document?.digestSha256), "SHA-256", document?.digestSha256 ?? null),
    check("trace.session_id", typeof trace.sessionId === "string" && trace.sessionId.length > 0, "non-empty", trace.sessionId ?? null),
    atLeast("trace.duration", durationMs, 30_000),
    check("transport.webrtc", diagnostics.transport === "webrtc", "webrtc", diagnostics.transport ?? null),
    check("transport.no_fallback", diagnostics.transportFallbackReason === undefined, null, diagnostics.transportFallbackReason ?? null),
    check("media.codec", diagnostics.codec === "opus", "opus", diagnostics.codec ?? null),
    check("media.sample_rate", diagnostics.sampleRate === 48_000, 48_000, diagnostics.sampleRate ?? null),
    atLeast("media.audio_duration", diagnostics.audioMs, 30_000),
    // Gateway production telemetry is coalesced to at most 240 ms even though the
    // rtc-node endpoint packetizes the published Opus track into 20 ms frames.
    atLeast("media.frames", diagnostics.frames, 125),
    atLeast("webrtc.samples", diagnostics.webrtcSamples, 10),
    atLeast("webrtc.uplink_samples", uplinkSamples, 5),
    atLeast("webrtc.downlink_samples", downlinkSamples, 5),
    atLeast("webrtc.auditable_downlink_samples", auditableDownlinkSamples, 5),
    atLeast("webrtc.playback_observations", diagnostics.playbackObservations, 1),
    atLeast("webrtc.downlink_bytes", measuredDownstreamBytes, 1),
    atLeast("webrtc.downlink_bitrate_p95_min", diagnostics.downlinkBitrateP95Kbps, 1),
    atLeast("webrtc.downlink_rtp_bitrate_p95_min", diagnostics.downlinkRtpBitrateP95Kbps, 1),
    atMost("webrtc.downlink_rtp_bitrate_p95_max", diagnostics.downlinkRtpBitrateP95Kbps, 80),
    check(
      "network.rtt_p95_matches_profile",
      finite(diagnostics.webrtcRttP95Ms)
        && diagnostics.webrtcRttP95Ms >= (run.network.rttMs <= 20 ? 0 : run.network.rttMs * 0.5)
        && diagnostics.webrtcRttP95Ms <= run.network.rttMs * 2 + 20,
      run.network.rttMs <= 20 ? "0..60ms" : `${run.network.rttMs * 0.5}..${run.network.rttMs * 2 + 20}ms`,
      diagnostics.webrtcRttP95Ms ?? null,
    ),
    check(
      "network.jitter_p95_matches_profile",
      profileMatch(diagnostics.downlinkJitterP95Ms, run.network.jitterMs, 15),
      run.network.jitterMs === 0 ? "<= 15ms" : `${run.network.jitterMs * 0.2}..${run.network.jitterMs * 3 + 15}ms`,
      diagnostics.downlinkJitterP95Ms ?? null,
    ),
    ...(run.network.packetLossDirection === "downlink" || run.network.packetLossDirection === "bidirectional" ? [check(
      "network.downlink_loss_p95_matches_profile",
      profileMatch(diagnostics.downlinkPacketLossP95Pct, run.network.packetLossPct, 0.5),
      run.network.packetLossPct === 0 ? "<= 0.5%" : `${run.network.packetLossPct * 0.2}..${run.network.packetLossPct * 3 + 0.5}%`,
      diagnostics.downlinkPacketLossP95Pct ?? null,
    )] : []),
    ...(run.network.packetLossDirection === "uplink" || run.network.packetLossDirection === "bidirectional" ? [check(
      "network.uplink_loss_p95_matches_profile",
      profileMatch(diagnostics.uplinkPacketLossP95Pct, run.network.packetLossPct, 0.5),
      run.network.packetLossPct === 0 ? "<= 0.5%" : `${run.network.packetLossPct * 0.2}..${run.network.packetLossPct * 3 + 0.5}%`,
      diagnostics.uplinkPacketLossP95Pct ?? null,
    )] : []),
    atMost("webrtc.jitter_buffer_p95", diagnostics.downlinkJitterBufferP95Ms, 600),
    atMost("media.max_queued_audio", diagnostics.maxQueuedAudioMs, 1_000),
    atMost("media.high_water_bytes", diagnostics.highWaterBytes, 192_000),
    check("media.dropped_frame_accounting", finite(dropped.total) && finite(dropped.stale) && finite(dropped.unexpected)
      && dropped.total === dropped.stale + dropped.unexpected,
    "total = stale + unexpected", dropped),
    atMost("media.unexpected_dropped_frames", dropped.unexpected, 0),
    check("evidence.present", evidence !== undefined, "loaded", evidence?.source ?? null),
    check("evidence.run_id", evidence?.runId === run.id, run.id, evidence?.runId ?? null),
    check("evidence.environment", evidence?.device === run.device && evidence?.route === run.route,
      { device: run.device, route: run.route }, evidence === undefined ? null : { device: evidence.device, route: evidence.route }),
    check("evidence.profile", sameProfile(evidence?.profile, run.network), run.network, evidence?.profile ?? null),
    check("evidence.capture_window", finite(trace.startedAtMs) && finite(trace.exportedAtMs) && finite(evidenceAt)
      && evidenceAt >= trace.startedAtMs - evidenceToleranceMs && evidenceAt <= trace.exportedAtMs + evidenceToleranceMs,
    "within 15 minutes of trace window", evidence?.capturedAt ?? null),
    check("evidence.digest", evidence !== undefined && sha256(evidence.digestSha256), "SHA-256", evidence?.digestSha256 ?? null),
    check("observation.no_stale_audio", run.observations.staleAudioHeard === false, false, run.observations.staleAudioHeard),
    check("observation.no_audio_dropouts", run.observations.audioDropoutsHeard === false, false, run.observations.audioDropoutsHeard),
    check("observation.controls_responsive", run.observations.controlsResponsive === true, true, run.observations.controlsResponsive),
    check("observation.voice_quality", run.observations.voiceQualityPassed === true, true, run.observations.voiceQualityPassed),
    check("observation.microphone_released", run.observations.microphoneReleasedAfterEnd === true, true, run.observations.microphoneReleasedAfterEnd),
  ];
  if (run.interactions.includes("barge_in") || run.interactions.includes("rapid_revision")) {
    checks.push(
      atLeast("observation.interruption_samples", run.observations.interruptionSamples, 10),
      atMost("observation.interruption_to_silence_p95", run.observations.interruptionToSilenceP95Ms, 150),
    );
  }
  if (run.interactions.includes("route_change")) {
    checks.push(check("observation.route_change_recovered", run.observations.routeChangeRecovered === true, true, run.observations.routeChangeRecovered ?? null));
  }
  if (run.interactions.includes("reconnect")) {
    checks.push(check("observation.reconnect_recovered", run.observations.reconnectRecovered === true, true, run.observations.reconnectRecovered ?? null));
  }
  if (run.interactions.includes("mute_unmute")) {
    checks.push(
      check("observation.mute_unmute", run.observations.muteUnmutePassed === true, true, run.observations.muteUnmutePassed ?? null),
      check("telemetry.mute_unmute", muteCycleObserved, "successful mute followed by unmute", muteCycleObserved),
    );
  }
  if (run.healthyNetwork === true) {
    checks.push(
      atLeast("healthy.duration", durationMs, 600_000),
      atLeast("healthy.audio_duration", diagnostics.audioMs, 600_000),
      atLeast("healthy.frames", diagnostics.frames, 2_500),
      atLeast("healthy.webrtc_samples", diagnostics.webrtcSamples, 500),
      check("healthy.underruns", diagnostics.underruns === 0, 0, diagnostics.underruns ?? null),
      check("healthy.profile", run.route === "same_wifi" && run.network.downlinkKbps === "unshaped"
        && run.network.rttMs === 20 && run.network.jitterMs === 0 && run.network.packetLossPct === 0
        && run.network.packetLossDirection === "bidirectional",
      { route: "same_wifi", downlinkKbps: "unshaped", rttMs: 20, jitterMs: 0, packetLossPct: 0, packetLossDirection: "bidirectional" },
      { route: run.route, ...run.network }),
      check("healthy.no_concealment_when_available",
        !concealmentAvailable || diagnostics.concealmentEvents === 0,
        "0 when the browser exposes concealmentEvents",
        { available: concealmentAvailable, events: diagnostics.concealmentEvents ?? null }),
    );
  }
  return {
    id: run.id,
    trace: run.trace,
    traceSessionId: typeof trace.sessionId === "string" ? trace.sessionId : null,
    traceDigestSha256: sha256(document?.digestSha256) ? document.digestSha256.toLowerCase() : null,
    networkEvidenceDigest: evidence?.digestSha256 ?? null,
    passed: checks.every(candidate => candidate.passed),
    checks,
    metrics: {
      durationMs: durationMs ?? null,
      audioMs: diagnostics.audioMs ?? null,
      frames: diagnostics.frames ?? null,
      webrtcSamples: diagnostics.webrtcSamples ?? null,
      uplinkSamples,
      downlinkSamples,
      auditableDownlinkSamples,
      measuredDownstreamBytes: measuredDownstreamBytes ?? null,
      uplinkBitrateP95Kbps: diagnostics.uplinkBitrateP95Kbps ?? null,
      downlinkBitrateP95Kbps: diagnostics.downlinkBitrateP95Kbps ?? null,
      downlinkRtpBitrateP95Kbps: diagnostics.downlinkRtpBitrateP95Kbps ?? null,
      uplinkPacketLossP95Pct: diagnostics.uplinkPacketLossP95Pct ?? null,
      downlinkPacketLossP95Pct: diagnostics.downlinkPacketLossP95Pct ?? null,
      webrtcRttP95Ms: diagnostics.webrtcRttP95Ms ?? null,
      downlinkJitterP95Ms: diagnostics.downlinkJitterP95Ms ?? null,
      downlinkJitterBufferP95Ms: diagnostics.downlinkJitterBufferP95Ms ?? null,
      downlinkJitterBufferTargetP95Ms: diagnostics.downlinkJitterBufferTargetP95Ms ?? null,
      underruns: diagnostics.underruns ?? null,
      maxQueuedAudioMs: diagnostics.maxQueuedAudioMs ?? null,
      highWaterBytes: diagnostics.highWaterBytes ?? null,
      droppedFrames: diagnostics.droppedFrames ?? null,
      staleDroppedFrames: dropped.stale ?? null,
      unexpectedDroppedFrames: dropped.unexpected ?? null,
      playbackObservations: diagnostics.playbackObservations ?? null,
      concealedSamples: diagnostics.concealedSamples ?? null,
      concealmentEvents: diagnostics.concealmentEvents ?? null,
    },
  };
}

export function evaluatePhase3Acceptance(
  manifest: Phase3Manifest,
  traces: ReadonlyMap<string, Phase3TraceDocument>,
  evidence: ReadonlyMap<string, Phase3NetworkEvidence>,
  billingEvidence?: Phase3BillingEvidence,
  generatedAt = new Date().toISOString(),
): Phase3AcceptanceReport {
  const runs = manifest.runs.map(run => evaluateRun(run, traces.get(run.id), evidence.get(run.id)));
  const measuredParticipantMinutes = runs.reduce((total, run) => total + (finite(run.metrics.durationMs) ? run.metrics.durationMs : 0), 0) * 2 / 60_000;
  const measuredDownstreamBytes = runs.reduce((total, run) => total + (finite(run.metrics.measuredDownstreamBytes) ? run.metrics.measuredDownstreamBytes : 0), 0);
  const billingChecks: Phase3AcceptanceCheck[] = manifest.deployment === "livekit_cloud" ? [
    check("billing.present", billingEvidence !== undefined, "loaded", billingEvidence?.source ?? null),
    check("billing.digest", billingEvidence !== undefined && sha256(billingEvidence.digestSha256), "SHA-256", billingEvidence?.digestSha256 ?? null),
    check("billing.period_covers_runs", billingEvidence !== undefined && manifest.runs.every(run => {
      const trace = traces.get(run.id)?.value;
      return record(trace) && finite(trace.startedAtMs) && finite(trace.exportedAtMs)
        && Date.parse(billingEvidence.periodStart) <= trace.startedAtMs
        && Date.parse(billingEvidence.periodEnd) >= trace.exportedAtMs;
    }), "billing window covers every trace", billingEvidence === undefined ? null : {
      periodStart: billingEvidence.periodStart, periodEnd: billingEvidence.periodEnd,
    }),
    check("billing.participant_minutes", billingEvidence !== undefined
      && Math.abs(billingEvidence.participantMinutes - measuredParticipantMinutes) <= Math.max(1, measuredParticipantMinutes * 0.15),
    `within max(1 minute, 15%) of ${measuredParticipantMinutes}`, billingEvidence?.participantMinutes ?? null),
    check("billing.downstream_bytes", billingEvidence !== undefined
      && billingEvidence.downstreamBytes >= measuredDownstreamBytes
      && billingEvidence.downstreamBytes <= Math.max(measuredDownstreamBytes * 2, measuredDownstreamBytes + 1_000_000),
    `between ${measuredDownstreamBytes} and transport-overhead ceiling`, billingEvidence?.downstreamBytes ?? null),
  ] : [
    check("billing.not_required", billingEvidence === undefined, "not supplied for self_hosted", billingEvidence?.source ?? null),
  ];
  const matrix: Phase3AcceptanceCheck[] = [
    coverage("matrix.devices", new Set(manifest.runs.map(run => run.device)), phase3Devices),
    coverage("matrix.routes", new Set(manifest.runs.map(run => run.route)), phase3Routes),
    coverage("matrix.downlinks", new Set(manifest.runs.map(run => run.network.downlinkKbps)), phase3Downlinks),
    coverage("matrix.rtts", new Set(manifest.runs.map(run => run.network.rttMs)), phase3Rtts),
    coverage("matrix.jitters", new Set(manifest.runs.map(run => run.network.jitterMs)), phase3Jitters),
    coverage("matrix.packet_loss", new Set(manifest.runs.map(run => run.network.packetLossPct)), phase3PacketLoss),
    coverage("matrix.interactions", new Set(manifest.runs.flatMap(run => run.interactions)), phase3Interactions),
    check("matrix.unique_sessions", new Set(runs.map(run => run.traceSessionId).filter((value): value is string => value !== null)).size === runs.length,
      `${runs.length} unique non-empty session ids`, runs.map(run => run.traceSessionId)),
    check("matrix.unique_traces", new Set(runs.map(run => run.traceDigestSha256).filter((value): value is string => value !== null)).size === runs.length,
      `${runs.length} unique trace digests`, runs.map(run => run.traceDigestSha256)),
    check("matrix.unique_network_evidence", new Set(runs.map(run => run.networkEvidenceDigest).filter((value): value is string => value !== null)).size === runs.length,
      `${runs.length} unique evidence digests`, runs.map(run => run.networkEvidenceDigest)),
    check("matrix.healthy_soak", manifest.runs.some((run, index) => run.healthyNetwork === true && runs[index]?.passed === true),
      "one passing healthyNetwork run", manifest.runs.filter(run => run.healthyNetwork === true).map(run => run.id)),
    ...billingChecks,
  ];
  const failedChecks = [...matrix, ...runs.flatMap(run => run.checks)].filter(candidate => !candidate.passed).length;
  const passedRuns = runs.filter(run => run.passed).length;
  return {
    schema: "voxstudio.media-phase3-report.v1",
    generatedAt,
    deployment: manifest.deployment,
    passed: failedChecks === 0,
    summary: { runs: runs.length, passedRuns, failedRuns: runs.length - passedRuns, failedChecks },
    matrix,
    runs,
    billing: {
      evidenceDigest: billingEvidence?.digestSha256 ?? null,
      measuredParticipantMinutes,
      measuredDownstreamBytes,
      checks: billingChecks,
    },
  };
}
