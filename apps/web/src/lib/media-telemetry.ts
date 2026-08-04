import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import { monotonicEpochMs, type AudioFrameDelivery } from "./client";

export type BrowserMediaTelemetryEvent =
  | { stage: "browser.receive"; atMs: number; frameId?: number; bytes: number; decodedAtMs: number }
  | { stage: "browser.enqueue"; atMs: number; frameId?: number; bufferBeforeMs: number; bufferAfterMs: number; targetBufferMs: number }
  | { stage: "browser.render"; atMs: number; frameId?: number; scheduledAtMs: number; latenessMs: number; bufferDepthMs: number; estimated: true }
  | { stage: "browser.underrun"; atMs: number; frameId?: number; durationMs: number }
  | { stage: "browser.stop"; atMs: number; reason: "interrupted" | "closed"; sourceCount: number; operationMs: number }
  | { stage: "browser.context"; atMs: number; state: AudioContextState; sampleRate: number; outputLatencyMs?: number }
  | { stage: "browser.route"; atMs: number; deviceId?: string; label?: string; trackState?: MediaStreamTrackState; recoveries: number }
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

  constructor(private readonly now: () => number = monotonicEpochMs) {
    this.startedAtMs = this.now();
  }

  reset(): void {
    this.entries.length = 0;
    this.diagnostics = emptyMediaDiagnostics();
    this.sessionId = undefined;
    this.startedAtMs = this.now();
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
      const clientReceivedAtMs = this.now();
      const rttMs = Math.max(0, clientReceivedAtMs - event.clientSentAtMs - (event.serverSentAtMs - event.serverReceivedAtMs));
      const serverClockOffsetMs = ((event.serverReceivedAtMs - event.clientSentAtMs)
        + (event.serverSentAtMs - clientReceivedAtMs)) / 2;
      this.diagnostics = { ...this.diagnostics, rttMs, serverClockOffsetMs };
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
