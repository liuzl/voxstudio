import type { GatewayEvent, MediaPlaybackCodec } from "@voxstudio/realtime-gateway/protocol";
import { monotonicEpochMs, type AudioFrameDelivery } from "./client";
import type { WebRtcStatsSample } from "./webrtc-stats";

export type MediaTransportFallbackReason = "livekit_service_unavailable" | "livekit_room_connection_failed";

export type BrowserMediaTelemetryEvent =
  | { stage: "browser.receive"; atMs: number; frameId?: number; bytes: number; decodedAtMs: number }
  | { stage: "browser.enqueue"; atMs: number; frameId?: number; bufferBeforeMs: number; bufferAfterMs: number; targetBufferMs: number }
  | { stage: "browser.render"; atMs: number; frameId?: number; scheduledAtMs: number; latenessMs: number; bufferDepthMs: number; estimated: boolean }
  | { stage: "browser.underrun"; atMs: number; frameId?: number; durationMs: number }
  | { stage: "browser.playback"; atMs: number; state: "playing" }
  | { stage: "browser.stop"; atMs: number; reason: "interrupted" | "closed"; sourceCount: number; operationMs: number }
  | { stage: "browser.context"; atMs: number; state: AudioContextState; sampleRate: number; outputLatencyMs?: number }
  | { stage: "browser.route"; atMs: number; deviceId?: string; label?: string; trackState?: MediaStreamTrackState; recoveries: number }
  | { stage: "browser.mute"; atMs: number; muted: boolean }
  | { stage: "browser.transport"; atMs: number; transport: "websocket" | "webrtc"; fallbackReason?: MediaTransportFallbackReason }
  | { stage: "browser.webrtc.aggregate"; atMs: number; direction: "downlink"; rtpBitrateKbps: number; streamCount: number }
  | ({ stage: "browser.webrtc" } & WebRtcStatsSample)
  | {
      stage: "browser.clock_sync";
      atMs: number;
      clientSentAtMs: number;
      serverReceivedAtMs: number;
      serverSentAtMs: number;
      rttMs: number;
      serverClockOffsetMs: number;
    };

export interface MediaDiagnostics {
  transport: "websocket" | "webrtc" | undefined;
  transportFallbackReason: MediaTransportFallbackReason | undefined;
  codec: MediaPlaybackCodec | undefined;
  sampleRate: number | undefined;
  mediaFormatChanges: number;
  frames: number;
  bytes: number;
  audioMs: number;
  bufferDepthMs: number;
  targetBufferMs: number;
  underruns: number;
  underrunMs: number;
  rttMs: number | undefined;
  serverClockOffsetMs: number | undefined;
  firstAudibleMs: number | undefined;
  highWaterBytes: number;
  maxQueuedAudioMs: number;
  droppedFrames: number;
  backpressureEvents: number;
  bufferDepthP95Ms: number | undefined;
  interruptionStops: number;
  interruptionStopP95Ms: number | undefined;
  closedStops: number;
  renderObservations: number;
  playbackObservations: number;
  estimatedRenders: number;
  rttSamples: number;
  rttP50Ms: number | undefined;
  rttP95Ms: number | undefined;
  rttJitterP95Ms: number | undefined;
  contextState: AudioContextState | undefined;
  contextSampleRate: number | undefined;
  webrtcSamples: number;
  uplinkBitrateKbps: number | undefined;
  uplinkBitrateP95Kbps: number | undefined;
  downlinkBitrateKbps: number | undefined;
  downlinkBitrateP95Kbps: number | undefined;
  downlinkRtpBitrateKbps: number | undefined;
  downlinkRtpBitrateP95Kbps: number | undefined;
  downlinkRtpBytes: number;
  uplinkPacketLossPct: number | undefined;
  uplinkPacketLossP95Pct: number | undefined;
  downlinkPacketLossPct: number | undefined;
  downlinkPacketLossP95Pct: number | undefined;
  webrtcRttMs: number | undefined;
  webrtcRttP95Ms: number | undefined;
  downlinkJitterMs: number | undefined;
  downlinkJitterP95Ms: number | undefined;
  downlinkJitterBufferMs: number | undefined;
  downlinkJitterBufferP95Ms: number | undefined;
  downlinkJitterBufferTargetMs: number | undefined;
  downlinkJitterBufferTargetP95Ms: number | undefined;
  downlinkJitterBufferMinimumMs: number | undefined;
  downlinkJitterBufferMinimumP95Ms: number | undefined;
  concealedSamples: number;
  concealmentEvents: number;
}

/** Compact, shared summary for the conversation footer and Agent preview panel. */
export function formatWebRtcDiagnostics(diagnostics: MediaDiagnostics): string {
  const details = formatMediaTransportDetails(diagnostics);
  return details === "" ? "WebRTC" : `WebRTC · ${details}`;
}

export function formatMediaTransportDetails(diagnostics: MediaDiagnostics): string {
  const parts: string[] = [];
  if (diagnostics.codec === "opus") {
    parts.push(`Opus${diagnostics.sampleRate === undefined ? "" : ` ${Math.round(diagnostics.sampleRate / 1_000)}kHz`}`);
  } else if (diagnostics.transport === "websocket") {
    parts.push(diagnostics.codec === "pcm_s16le"
      ? `PCM16${diagnostics.sampleRate === undefined ? "" : ` ${Math.round(diagnostics.sampleRate / 1_000)}kHz`}`
      : diagnostics.codec === "pcm_f32le"
        ? `PCM f32${diagnostics.sampleRate === undefined ? "" : ` ${Math.round(diagnostics.sampleRate / 1_000)}kHz`}`
        : "PCM");
  }
  if (diagnostics.transport === "webrtc") {
    if (diagnostics.uplinkBitrateKbps !== undefined) parts.push(`↑ ${Math.round(diagnostics.uplinkBitrateKbps)} kbps`);
    const downlinkBitrate = diagnostics.downlinkRtpBitrateKbps ?? diagnostics.downlinkBitrateKbps;
    if (downlinkBitrate !== undefined) parts.push(`↓ ${Math.round(downlinkBitrate)} kbps`);
    if (diagnostics.uplinkPacketLossPct !== undefined) parts.push(`↑loss ${diagnostics.uplinkPacketLossPct.toFixed(1)}%`);
    if (diagnostics.downlinkPacketLossPct !== undefined) parts.push(`↓loss ${diagnostics.downlinkPacketLossPct.toFixed(1)}%`);
    if (diagnostics.downlinkJitterMs !== undefined) parts.push(`jitter ${Math.round(diagnostics.downlinkJitterMs)}ms`);
    if (diagnostics.webrtcRttMs !== undefined) parts.push(`RTT ${Math.round(diagnostics.webrtcRttMs)}ms`);
  } else if (diagnostics.transport === "websocket" && diagnostics.frames > 0) {
    parts.push(`${Math.round(diagnostics.bufferDepthMs)}ms buffer`, `underrun ${diagnostics.underruns}`);
    if (diagnostics.rttMs !== undefined) parts.push(`RTT ${Math.round(diagnostics.rttMs)}ms`);
  }
  return parts.join(" · ");
}

export function mediaTransportFallbackMessage(reason: MediaTransportFallbackReason | undefined):
  | "LiveKit 服务不可用，已回退到 WebSocket"
  | "LiveKit 房间连接失败，已回退到 WebSocket"
  | undefined {
  if (reason === "livekit_service_unavailable") return "LiveKit 服务不可用，已回退到 WebSocket";
  if (reason === "livekit_room_connection_failed") return "LiveKit 房间连接失败，已回退到 WebSocket";
  return undefined;
}

export interface MediaAttributionSample {
  previousProducedAtMs: number;
  previousAudioMs: number;
  producedAtMs: number;
  enqueuedAtMs: number;
  submittedAtMs: number;
  receivedAtMs: number;
  decodedAtMs: number;
  browserEnqueuedAtMs: number;
  scheduledRenderAtMs: number;
  renderedAtMs: number;
}

export type MediaDelayLayer = "production" | "server_send" | "network" | "decode" | "browser_enqueue" | "render";

/** Pure phase-0 attribution rule; timestamps must already share the client clock. */
export function attributeMediaDelay(
  sample: MediaAttributionSample,
  thresholdMs = 100,
): { layer: MediaDelayLayer | "none"; delayMs: number; gaps: Record<MediaDelayLayer, number> } {
  const gaps: Record<MediaDelayLayer, number> = {
    production: Math.max(0, sample.producedAtMs - sample.previousProducedAtMs - sample.previousAudioMs),
    server_send: Math.max(0, sample.submittedAtMs - sample.enqueuedAtMs),
    network: Math.max(0, sample.receivedAtMs - sample.submittedAtMs),
    decode: Math.max(0, sample.decodedAtMs - sample.receivedAtMs),
    browser_enqueue: Math.max(0, sample.browserEnqueuedAtMs - sample.decodedAtMs),
    render: Math.max(0, sample.renderedAtMs - sample.scheduledRenderAtMs),
  };
  const [layer, delayMs] = (Object.entries(gaps) as [MediaDelayLayer, number][])
    .reduce((largest, entry) => entry[1] > largest[1] ? entry : largest, ["production", gaps.production]);
  return delayMs >= thresholdMs ? { layer, delayMs, gaps } : { layer: "none", delayMs, gaps };
}

const maxEvents = 5_000;

/** Fixed-memory histogram used by long device runs whose raw trace is intentionally capped. */
class FixedHistogram {
  private readonly counts: Uint32Array;
  private total = 0;

  constructor(private readonly step: number, private readonly maximum: number) {
    this.counts = new Uint32Array(Math.ceil(maximum / step) + 2);
  }

  observe(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const bucket = Math.min(this.counts.length - 1, Math.ceil(value / this.step));
    this.counts[bucket] = (this.counts[bucket] ?? 0) + 1;
    this.total += 1;
  }

  percentile(quantile: number): number | undefined {
    if (this.total === 0) return undefined;
    const target = Math.max(1, Math.ceil(this.total * quantile));
    let seen = 0;
    for (let index = 0; index < this.counts.length; index += 1) {
      seen += this.counts[index] ?? 0;
      if (seen >= target) return Math.min(this.maximum + this.step, index * this.step);
    }
    return this.maximum + this.step;
  }

  reset(): void {
    this.counts.fill(0);
    this.total = 0;
  }
}

type MediaTraceEntry =
  | { clock: "server"; event: GatewayEvent }
  | { clock: "client"; event: BrowserMediaTelemetryEvent };

interface ClockSync {
  clientAtMs: number;
  serverAtMs: number;
  offsetMs: number;
}

interface FrameTrace {
  frame?: Extract<GatewayEvent, { type: "media.frame" }>;
  socket?: Extract<GatewayEvent, { type: "media.socket" }>;
  receive?: Extract<BrowserMediaTelemetryEvent, { stage: "browser.receive" }>;
  enqueue?: Extract<BrowserMediaTelemetryEvent, { stage: "browser.enqueue" }>;
  render?: Extract<BrowserMediaTelemetryEvent, { stage: "browser.render" }>;
}

function isCompleteFrameTrace(trace: FrameTrace): trace is Required<FrameTrace> {
  return trace.frame !== undefined
    && trace.socket !== undefined
    && trace.receive !== undefined
    && trace.enqueue !== undefined
    && trace.render !== undefined;
}

function frameIdOf(event: GatewayEvent | BrowserMediaTelemetryEvent): number | undefined {
  return "frameId" in event && typeof event.frameId === "number" ? event.frameId : undefined;
}

/** Bounded metadata-only trace assembled in the browser; it never contains audio bytes. */
export class MediaTraceRecorder {
  private startedAtMs: number;
  private readonly entries: MediaTraceEntry[] = [];
  private diagnostics: MediaDiagnostics = emptyMediaDiagnostics();
  private sessionId: string | undefined;
  private readonly bufferDepths = new FixedHistogram(5, 2_000);
  private readonly interruptionStops = new FixedHistogram(1, 1_000);
  private readonly rtts = new FixedHistogram(1, 2_000);
  private readonly rttJitters = new FixedHistogram(1, 2_000);
  private readonly uplinkBitrates = new FixedHistogram(1, 1_000);
  private readonly downlinkBitrates = new FixedHistogram(1, 1_000);
  private readonly downlinkRtpBitrates = new FixedHistogram(1, 1_000);
  private readonly uplinkLoss = new FixedHistogram(0.1, 100);
  private readonly downlinkLoss = new FixedHistogram(0.1, 100);
  private readonly webRtcRtts = new FixedHistogram(1, 2_000);
  private readonly downlinkJitters = new FixedHistogram(1, 1_000);
  private readonly downlinkJitterBuffers = new FixedHistogram(1, 2_000);
  private readonly downlinkJitterBufferTargets = new FixedHistogram(1, 2_000);
  private readonly downlinkJitterBufferMinimums = new FixedHistogram(1, 2_000);
  private previousRttMs: number | undefined;

  constructor(private readonly now: () => number = monotonicEpochMs) {
    this.startedAtMs = this.now();
  }

  reset(): void {
    this.entries.length = 0;
    this.diagnostics = emptyMediaDiagnostics();
    this.sessionId = undefined;
    this.bufferDepths.reset();
    this.interruptionStops.reset();
    this.rtts.reset();
    this.rttJitters.reset();
    this.uplinkBitrates.reset();
    this.downlinkBitrates.reset();
    this.downlinkRtpBitrates.reset();
    this.uplinkLoss.reset();
    this.downlinkLoss.reset();
    this.webRtcRtts.reset();
    this.downlinkJitters.reset();
    this.downlinkJitterBuffers.reset();
    this.downlinkJitterBufferTargets.reset();
    this.downlinkJitterBufferMinimums.reset();
    this.previousRttMs = undefined;
    this.startedAtMs = this.now();
  }

  observeGateway(event: GatewayEvent): void {
    this.sessionId ||= event.sessionId || undefined;
    if (!event.type.startsWith("media.")) return;
    this.push({ clock: "server", event });
    if (event.type === "media.frame") {
      const browserDecodesFrame = this.diagnostics.transport !== "webrtc";
      this.diagnostics = {
        ...this.diagnostics,
        mediaFormatChanges: this.diagnostics.mediaFormatChanges
          + (browserDecodesFrame && this.diagnostics.frames > 0
            && (this.diagnostics.codec !== event.codec || this.diagnostics.sampleRate !== event.sampleRate) ? 1 : 0),
        ...(browserDecodesFrame ? { codec: event.codec, sampleRate: event.sampleRate } : {}),
        frames: this.diagnostics.frames + 1,
        bytes: this.diagnostics.bytes + event.bytes,
        audioMs: this.diagnostics.audioMs + event.audioMs,
      };
    } else if (event.type === "media.socket") {
      this.diagnostics = {
        ...this.diagnostics,
        highWaterBytes: Math.max(this.diagnostics.highWaterBytes, event.highWaterBytes),
        maxQueuedAudioMs: Math.max(this.diagnostics.maxQueuedAudioMs, event.queuedAudioMs),
        droppedFrames: this.diagnostics.droppedFrames + (event.dropped ? 1 : 0),
      };
    } else if (event.type === "media.socket.drain") {
      this.diagnostics = {
        ...this.diagnostics,
        backpressureEvents: this.diagnostics.backpressureEvents + 1,
      };
    } else if (event.type === "media.pong") {
      const clientReceivedAtMs = this.now();
      const rttMs = Math.max(0, clientReceivedAtMs - event.clientSentAtMs - (event.serverSentAtMs - event.serverReceivedAtMs));
      const serverClockOffsetMs = ((event.serverReceivedAtMs - event.clientSentAtMs)
        + (event.serverSentAtMs - clientReceivedAtMs)) / 2;
      this.rtts.observe(rttMs);
      if (this.previousRttMs !== undefined) this.rttJitters.observe(Math.abs(rttMs - this.previousRttMs));
      this.previousRttMs = rttMs;
      this.diagnostics = {
        ...this.diagnostics,
        rttMs,
        serverClockOffsetMs,
        rttSamples: this.diagnostics.rttSamples + 1,
        rttP50Ms: this.rtts.percentile(0.5),
        rttP95Ms: this.rtts.percentile(0.95),
        rttJitterP95Ms: this.rttJitters.percentile(0.95),
      };
      this.push({
        clock: "client",
        event: {
          stage: "browser.clock_sync",
          atMs: clientReceivedAtMs,
          clientSentAtMs: event.clientSentAtMs,
          serverReceivedAtMs: event.serverReceivedAtMs,
          serverSentAtMs: event.serverSentAtMs,
          rttMs,
          serverClockOffsetMs,
        },
      });
    }
  }

  observeDelivery(samples: Float32Array, delivery: AudioFrameDelivery): void {
    this.observeBrowser({
      stage: "browser.receive",
      atMs: delivery.receivedAtMs,
      ...(delivery.frame === undefined ? {} : { frameId: delivery.frame.frameId }),
      bytes: samples.byteLength,
      decodedAtMs: delivery.decodedAtMs,
    });
  }

  observeBrowser(event: BrowserMediaTelemetryEvent): void {
    this.push({ clock: "client", event });
    if (event.stage === "browser.enqueue") {
      this.diagnostics = {
        ...this.diagnostics,
        bufferDepthMs: event.bufferAfterMs,
        targetBufferMs: event.targetBufferMs,
      };
    } else if (event.stage === "browser.underrun") {
      this.diagnostics = {
        ...this.diagnostics,
        underruns: this.diagnostics.underruns + 1,
        underrunMs: this.diagnostics.underrunMs + event.durationMs,
      };
    } else if (event.stage === "browser.playback") {
      this.diagnostics = {
        ...this.diagnostics,
        playbackObservations: this.diagnostics.playbackObservations + 1,
      };
    } else if (event.stage === "browser.render") {
      this.bufferDepths.observe(event.bufferDepthMs);
      this.diagnostics = {
        ...this.diagnostics,
        bufferDepthMs: event.bufferDepthMs,
        bufferDepthP95Ms: this.bufferDepths.percentile(0.95),
        renderObservations: this.diagnostics.renderObservations + 1,
        estimatedRenders: this.diagnostics.estimatedRenders + (event.estimated ? 1 : 0),
        ...(this.diagnostics.firstAudibleMs === undefined
          ? { firstAudibleMs: Math.max(0, event.atMs - this.startedAtMs) }
          : {}),
      };
    } else if (event.stage === "browser.stop") {
      if (event.reason === "interrupted") {
        this.interruptionStops.observe(event.operationMs);
        this.diagnostics = {
          ...this.diagnostics,
          interruptionStops: this.diagnostics.interruptionStops + 1,
          interruptionStopP95Ms: this.interruptionStops.percentile(0.95),
        };
      } else {
        this.diagnostics = { ...this.diagnostics, closedStops: this.diagnostics.closedStops + 1 };
      }
    } else if (event.stage === "browser.context") {
      this.diagnostics = {
        ...this.diagnostics,
        contextState: event.state,
        contextSampleRate: event.sampleRate,
      };
    } else if (event.stage === "browser.transport") {
      this.diagnostics = {
        ...this.diagnostics,
        transport: event.transport,
        transportFallbackReason: event.fallbackReason,
      };
    } else if (event.stage === "browser.webrtc.aggregate") {
      this.downlinkRtpBitrates.observe(event.rtpBitrateKbps);
      this.diagnostics = {
        ...this.diagnostics,
        downlinkRtpBitrateKbps: event.rtpBitrateKbps,
        downlinkRtpBitrateP95Kbps: this.downlinkRtpBitrates.percentile(0.95),
      };
    } else if (event.stage === "browser.webrtc") {
      const uplink = event.direction === "uplink";
      if (event.bitrateKbps !== undefined) (uplink ? this.uplinkBitrates : this.downlinkBitrates).observe(event.bitrateKbps);
      if (event.packetLossPct !== undefined) (uplink ? this.uplinkLoss : this.downlinkLoss).observe(event.packetLossPct);
      if (event.roundTripTimeMs !== undefined) this.webRtcRtts.observe(event.roundTripTimeMs);
      if (!uplink && event.jitterMs !== undefined) this.downlinkJitters.observe(event.jitterMs);
      if (!uplink && event.jitterBufferMs !== undefined) this.downlinkJitterBuffers.observe(event.jitterBufferMs);
      if (!uplink && event.jitterBufferTargetMs !== undefined) this.downlinkJitterBufferTargets.observe(event.jitterBufferTargetMs);
      if (!uplink && event.jitterBufferMinimumMs !== undefined) this.downlinkJitterBufferMinimums.observe(event.jitterBufferMinimumMs);
      const opus = event.codec?.toLowerCase().includes("opus");
      this.diagnostics = {
        ...this.diagnostics,
        transport: "webrtc",
        webrtcSamples: this.diagnostics.webrtcSamples + 1,
        ...(opus ? { codec: "opus" as const } : {}),
        ...(event.sampleRate !== undefined ? { sampleRate: event.sampleRate } : {}),
        ...(uplink && event.bitrateKbps !== undefined ? {
          uplinkBitrateKbps: event.bitrateKbps,
          uplinkBitrateP95Kbps: this.uplinkBitrates.percentile(0.95),
        } : {}),
        ...(!uplink && event.bitrateKbps !== undefined ? {
          downlinkBitrateKbps: event.bitrateKbps,
          downlinkBitrateP95Kbps: this.downlinkBitrates.percentile(0.95),
        } : {}),
        ...(!uplink && event.rtpBytesDelta !== undefined ? {
          downlinkRtpBytes: this.diagnostics.downlinkRtpBytes + event.rtpBytesDelta,
        } : {}),
        ...(uplink && event.packetLossPct !== undefined ? {
          uplinkPacketLossPct: event.packetLossPct,
          uplinkPacketLossP95Pct: this.uplinkLoss.percentile(0.95),
        } : {}),
        ...(!uplink && event.packetLossPct !== undefined ? {
          downlinkPacketLossPct: event.packetLossPct,
          downlinkPacketLossP95Pct: this.downlinkLoss.percentile(0.95),
        } : {}),
        ...(event.roundTripTimeMs === undefined ? {} : {
          webrtcRttMs: event.roundTripTimeMs,
          webrtcRttP95Ms: this.webRtcRtts.percentile(0.95),
        }),
        ...(uplink || event.jitterMs === undefined ? {} : {
          downlinkJitterMs: event.jitterMs,
          downlinkJitterP95Ms: this.downlinkJitters.percentile(0.95),
        }),
        ...(uplink || event.jitterBufferMs === undefined ? {} : {
          downlinkJitterBufferMs: event.jitterBufferMs,
          downlinkJitterBufferP95Ms: this.downlinkJitterBuffers.percentile(0.95),
        }),
        ...(uplink || event.jitterBufferTargetMs === undefined ? {} : {
          downlinkJitterBufferTargetMs: event.jitterBufferTargetMs,
          downlinkJitterBufferTargetP95Ms: this.downlinkJitterBufferTargets.percentile(0.95),
        }),
        ...(uplink || event.jitterBufferMinimumMs === undefined ? {} : {
          downlinkJitterBufferMinimumMs: event.jitterBufferMinimumMs,
          downlinkJitterBufferMinimumP95Ms: this.downlinkJitterBufferMinimums.percentile(0.95),
        }),
        concealedSamples: this.diagnostics.concealedSamples + (event.concealedSamplesDelta ?? 0),
        concealmentEvents: this.diagnostics.concealmentEvents + (event.concealmentEventsDelta ?? 0),
      };
    }
  }

  summary(): MediaDiagnostics {
    return { ...this.diagnostics };
  }

  export(): Record<string, unknown> {
    const clockSyncs = this.clockSyncs();
    return {
      schema: "voxstudio.media-trace.v2",
      sessionId: this.sessionId,
      startedAtMs: this.startedAtMs,
      exportedAtMs: this.now(),
      privacy: "metadata_only",
      diagnostics: this.summary(),
      events: [...this.entries],
      timeline: this.alignedTimeline(clockSyncs),
      frameAttributions: this.frameAttributions(clockSyncs),
    };
  }

  private clockSyncs(): ClockSync[] {
    return this.entries.flatMap(entry => {
      if (entry.clock !== "client" || entry.event.stage !== "browser.clock_sync") return [];
      return [{
        clientAtMs: entry.event.atMs,
        serverAtMs: (entry.event.serverReceivedAtMs + entry.event.serverSentAtMs) / 2,
        offsetMs: entry.event.serverClockOffsetMs,
      }];
    });
  }

  private offsetAt(serverAtMs: number, syncs: ClockSync[]): number | undefined {
    let nearest: ClockSync | undefined;
    let distance = Number.POSITIVE_INFINITY;
    for (const sync of syncs) {
      const candidate = Math.abs(sync.serverAtMs - serverAtMs);
      if (candidate < distance) {
        nearest = sync;
        distance = candidate;
      }
    }
    return nearest?.offsetMs;
  }

  private alignedTimeline(syncs: ClockSync[]): Record<string, unknown>[] {
    const timeline: Record<string, unknown>[] = [];
    const pushServer = (stage: string, sourceAtMs: number, eventIndex: number, frameId?: number): void => {
      const offsetMs = this.offsetAt(sourceAtMs, syncs);
      timeline.push({
        atMs: offsetMs === undefined ? sourceAtMs : sourceAtMs - offsetMs,
        sourceAtMs,
        sourceClock: "server",
        aligned: offsetMs !== undefined,
        ...(offsetMs === undefined ? {} : { offsetAppliedMs: offsetMs }),
        stage,
        ...(frameId === undefined ? {} : { frameId }),
        eventIndex,
      });
    };
    this.entries.forEach((entry, eventIndex) => {
      if (entry.clock === "client") {
        timeline.push({
          atMs: entry.event.atMs,
          sourceAtMs: entry.event.atMs,
          sourceClock: "client",
          aligned: true,
          stage: entry.event.stage,
          ...(frameIdOf(entry.event) === undefined ? {} : { frameId: frameIdOf(entry.event) }),
          eventIndex,
        });
        return;
      }
      switch (entry.event.type) {
        case "media.frame":
          pushServer("server.production", entry.event.producedAtMs, eventIndex, entry.event.frameId);
          pushServer("server.enqueue", entry.event.enqueuedAtMs, eventIndex, entry.event.frameId);
          break;
        case "media.socket":
          pushServer("server.socket_submit", entry.event.submittedAtMs, eventIndex, entry.event.frameId);
          break;
        case "media.socket.drain":
          pushServer("server.backpressure_start", entry.event.startedAtMs, eventIndex);
          pushServer("server.socket_drain", entry.event.drainedAtMs, eventIndex);
          break;
        case "media.rendition":
          pushServer("server.rendition_end", entry.event.endedAtMs, eventIndex);
          break;
        case "media.pong":
          pushServer("server.pong_send", entry.event.serverSentAtMs, eventIndex);
          break;
        default:
          break;
      }
    });
    return timeline.sort((left, right) => Number(left.atMs) - Number(right.atMs));
  }

  private frameAttributions(syncs: ClockSync[]): Record<string, unknown>[] {
    const byFrame = new Map<number, FrameTrace>();
    for (const entry of this.entries) {
      const frameId = frameIdOf(entry.event);
      if (frameId === undefined) continue;
      const trace = byFrame.get(frameId) ?? {};
      if (entry.clock === "server") {
        if (entry.event.type === "media.frame") trace.frame = entry.event;
        else if (entry.event.type === "media.socket") trace.socket = entry.event;
      } else {
        if (entry.event.stage === "browser.receive") trace.receive = entry.event;
        else if (entry.event.stage === "browser.enqueue") trace.enqueue = entry.event;
        else if (entry.event.stage === "browser.render") trace.render = entry.event;
      }
      byFrame.set(frameId, trace);
    }

    const allFrames = [...byFrame.entries()]
      .filter((entry): entry is [number, FrameTrace & { frame: NonNullable<FrameTrace["frame"]> }] => entry[1].frame !== undefined)
      .sort((left, right) => left[0] - right[0]);
    const previousFrame = new Map<number, Extract<GatewayEvent, { type: "media.frame" }> | undefined>();
    const previousByRendition = new Map<string, Extract<GatewayEvent, { type: "media.frame" }>>();
    for (const [frameId, trace] of allFrames) {
      const rendition = `${trace.frame.turnId}:${trace.frame.revision}`;
      previousFrame.set(frameId, previousByRendition.get(rendition));
      previousByRendition.set(rendition, trace.frame);
    }
    const output: Record<string, unknown>[] = [];
    for (const [frameId, candidate] of allFrames) {
      if (!isCompleteFrameTrace(candidate)) continue;
      const trace = candidate;
      const offsetMs = this.offsetAt(trace.frame.producedAtMs, syncs);
      if (offsetMs === undefined) continue;
      const previous = previousFrame.get(frameId);
      const previousOffsetMs = previous === undefined ? offsetMs : this.offsetAt(previous.producedAtMs, syncs) ?? offsetMs;
      const sample: MediaAttributionSample = {
        previousProducedAtMs: previous === undefined
          ? trace.frame.producedAtMs - offsetMs - trace.frame.audioMs
          : previous.producedAtMs - previousOffsetMs,
        previousAudioMs: previous?.audioMs ?? trace.frame.audioMs,
        producedAtMs: trace.frame.producedAtMs - offsetMs,
        enqueuedAtMs: trace.frame.enqueuedAtMs - offsetMs,
        submittedAtMs: trace.socket.submittedAtMs - offsetMs,
        receivedAtMs: trace.receive.atMs,
        decodedAtMs: trace.receive.decodedAtMs,
        browserEnqueuedAtMs: trace.enqueue.atMs,
        scheduledRenderAtMs: trace.render.scheduledAtMs,
        renderedAtMs: trace.render.atMs,
      };
      output.push({
        frameId,
        turnId: trace.frame.turnId,
        revision: trace.frame.revision,
        offsetAppliedMs: offsetMs,
        sample,
        attribution: attributeMediaDelay(sample),
      });
    }
    return output;
  }

  private push(entry: MediaTraceEntry): void {
    this.entries.push(entry);
    if (this.entries.length > maxEvents) this.entries.splice(0, this.entries.length - maxEvents);
  }
}

export function emptyMediaDiagnostics(): MediaDiagnostics {
  return {
    transport: undefined,
    transportFallbackReason: undefined,
    codec: undefined,
    sampleRate: undefined,
    mediaFormatChanges: 0,
    frames: 0,
    bytes: 0,
    audioMs: 0,
    bufferDepthMs: 0,
    targetBufferMs: 700,
    underruns: 0,
    underrunMs: 0,
    rttMs: undefined,
    serverClockOffsetMs: undefined,
    firstAudibleMs: undefined,
    highWaterBytes: 0,
    maxQueuedAudioMs: 0,
    droppedFrames: 0,
    backpressureEvents: 0,
    bufferDepthP95Ms: undefined,
    interruptionStops: 0,
    interruptionStopP95Ms: undefined,
    closedStops: 0,
    renderObservations: 0,
    playbackObservations: 0,
    estimatedRenders: 0,
    rttSamples: 0,
    rttP50Ms: undefined,
    rttP95Ms: undefined,
    rttJitterP95Ms: undefined,
    contextState: undefined,
    contextSampleRate: undefined,
    webrtcSamples: 0,
    uplinkBitrateKbps: undefined,
    uplinkBitrateP95Kbps: undefined,
    downlinkBitrateKbps: undefined,
    downlinkBitrateP95Kbps: undefined,
    downlinkRtpBitrateKbps: undefined,
    downlinkRtpBitrateP95Kbps: undefined,
    downlinkRtpBytes: 0,
    uplinkPacketLossPct: undefined,
    uplinkPacketLossP95Pct: undefined,
    downlinkPacketLossPct: undefined,
    downlinkPacketLossP95Pct: undefined,
    webrtcRttMs: undefined,
    webrtcRttP95Ms: undefined,
    downlinkJitterMs: undefined,
    downlinkJitterP95Ms: undefined,
    downlinkJitterBufferMs: undefined,
    downlinkJitterBufferP95Ms: undefined,
    downlinkJitterBufferTargetMs: undefined,
    downlinkJitterBufferTargetP95Ms: undefined,
    downlinkJitterBufferMinimumMs: undefined,
    downlinkJitterBufferMinimumP95Ms: undefined,
    concealedSamples: 0,
    concealmentEvents: 0,
  };
}
