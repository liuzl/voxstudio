import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import { monotonicEpochMs, type AudioFrameDelivery } from "./client";

export type BrowserMediaTelemetryEvent =
  | { stage: "browser.receive"; atMs: number; frameId?: number; bytes: number; decodedAtMs: number }
  | { stage: "browser.enqueue"; atMs: number; frameId?: number; bufferBeforeMs: number; bufferAfterMs: number; targetBufferMs: number }
  | { stage: "browser.render"; atMs: number; frameId?: number; scheduledAtMs: number; latenessMs: number; bufferDepthMs: number; estimated: true }
  | { stage: "browser.underrun"; atMs: number; frameId?: number; durationMs: number }
  | { stage: "browser.stop"; atMs: number; reason: "interrupted" | "closed"; sourceCount: number; operationMs: number }
  | { stage: "browser.context"; atMs: number; state: AudioContextState; sampleRate: number; outputLatencyMs?: number }
  | { stage: "browser.route"; atMs: number; deviceId?: string; label?: string; trackState?: MediaStreamTrackState; recoveries: number };

export interface MediaDiagnostics {
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
  droppedFrames: number;
  contextState: AudioContextState | undefined;
  contextSampleRate: number | undefined;
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

/** Bounded metadata-only trace assembled in the browser; it never contains audio bytes. */
export class MediaTraceRecorder {
  private readonly startedAtMs = monotonicEpochMs();
  private readonly entries: ({ clock: "server" | "client"; event: GatewayEvent | BrowserMediaTelemetryEvent })[] = [];
  private diagnostics: MediaDiagnostics = emptyMediaDiagnostics();
  private sessionId: string | undefined;

  reset(): void {
    this.entries.length = 0;
    this.diagnostics = emptyMediaDiagnostics();
    this.sessionId = undefined;
  }

  observeGateway(event: GatewayEvent): void {
    this.sessionId ||= event.sessionId || undefined;
    if (!event.type.startsWith("media.")) return;
    this.push({ clock: "server", event });
    if (event.type === "media.frame") {
      this.diagnostics = {
        ...this.diagnostics,
        frames: this.diagnostics.frames + 1,
        bytes: this.diagnostics.bytes + event.bytes,
        audioMs: this.diagnostics.audioMs + event.audioMs,
      };
    } else if (event.type === "media.socket") {
      this.diagnostics = {
        ...this.diagnostics,
        highWaterBytes: Math.max(this.diagnostics.highWaterBytes, event.highWaterBytes),
        droppedFrames: this.diagnostics.droppedFrames + (event.dropped ? 1 : 0),
      };
    } else if (event.type === "media.pong") {
      const clientReceivedAtMs = monotonicEpochMs();
      const rttMs = Math.max(0, clientReceivedAtMs - event.clientSentAtMs - (event.serverSentAtMs - event.serverReceivedAtMs));
      const serverClockOffsetMs = ((event.serverReceivedAtMs - event.clientSentAtMs)
        + (event.serverSentAtMs - clientReceivedAtMs)) / 2;
      this.diagnostics = { ...this.diagnostics, rttMs, serverClockOffsetMs };
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
    } else if (event.stage === "browser.render") {
      this.diagnostics = {
        ...this.diagnostics,
        bufferDepthMs: event.bufferDepthMs,
        ...(this.diagnostics.firstAudibleMs === undefined
          ? { firstAudibleMs: Math.max(0, event.atMs - this.startedAtMs) }
          : {}),
      };
    } else if (event.stage === "browser.context") {
      this.diagnostics = {
        ...this.diagnostics,
        contextState: event.state,
        contextSampleRate: event.sampleRate,
      };
    }
  }

  summary(): MediaDiagnostics {
    return { ...this.diagnostics };
  }

  export(): Record<string, unknown> {
    return {
      schema: "voxstudio.media-trace.v1",
      sessionId: this.sessionId,
      startedAtMs: this.startedAtMs,
      exportedAtMs: monotonicEpochMs(),
      privacy: "metadata_only",
      diagnostics: this.summary(),
      events: [...this.entries],
    };
  }

  private push(entry: { clock: "server" | "client"; event: GatewayEvent | BrowserMediaTelemetryEvent }): void {
    this.entries.push(entry);
    if (this.entries.length > maxEvents) this.entries.splice(0, this.entries.length - maxEvents);
  }
}

export function emptyMediaDiagnostics(): MediaDiagnostics {
  return {
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
    droppedFrames: 0,
    contextState: undefined,
    contextSampleRate: undefined,
  };
}
