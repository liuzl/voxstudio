import {
  protocolVersion,
  type GatewayEvent,
  type MediaPlaybackConfiguration,
  type SessionStartOptions,
} from "@voxstudio/realtime-gateway/protocol";
import { decodePcm16 } from "@voxstudio/audio";
import { parseMediaV2Frame } from "@voxstudio/realtime-gateway/media-v2";

export type MediaFrameEvent = Extract<GatewayEvent, { type: "media.frame" }>;

export interface AudioFrameDelivery {
  frame: MediaFrameEvent | undefined;
  receivedAtMs: number;
  decodedAtMs: number;
  media?: {
    streamId: string;
    sequence: number;
    timestampSamples: number;
    durationSamples: number;
  };
}

export function monotonicEpochMs(): number {
  return performance.timeOrigin + performance.now();
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/** The subset of the WebSocket API the client uses; tests inject a scripted one. */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferLike): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface GatewayClientOptions {
  /** WebSocket URL of the gateway's /v1/realtime endpoint. */
  url: string;
  startOptions: SessionStartOptions;
  onEvent(event: GatewayEvent): void;
  /** Reply audio: raw float32 samples at the rate announced by the last playback.format. */
  onAudio(samples: Float32Array, delivery: AudioFrameDelivery): void;
  onConnectionChange(state: ConnectionState): void;
  makeSocket?(url: string): SocketLike;
  /** Reconnect backoff base; tests shrink it. */
  backoffMs?: number;
  newIdempotencyKey?(): string;
}

const maxBackoffMs = 5_000;
const commandAcceptanceTimeoutMs = 10_000;

interface PendingCommandAcceptance {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Protocol v1 client: opens the socket, starts (or, after a drop, reattaches to) the
 * session, stamps every command with a fresh idempotency key, and resynchronizes from the
 * pushed snapshot on reconnect. Stale commands are never replayed — command history dies
 * with the socket; only the sessionId survives.
 */
export class GatewayClient {
  private readonly options: GatewayClientOptions;
  private socket: SocketLike | undefined;
  private sessionId: string | undefined;
  private attempts = 0;
  private closed = false;
  private lastSequence = 0;
  private readonly pendingMediaFrames: MediaFrameEvent[] = [];
  private mediaPlayback: MediaPlaybackConfiguration | undefined;
  private playbackStreamId: string | undefined;
  private expectedMediaSequence = 0;
  private expectedTimestampSamples = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pendingCommandAcceptances = new Map<string, PendingCommandAcceptance>();

  constructor(options: GatewayClientOptions) {
    this.options = options;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  connect(): void {
    if (this.closed) throw new Error("client is closed");
    this.options.onConnectionChange(this.attempts > 0 ? "reconnecting" : "connecting");
    const make = this.options.makeSocket ?? (url => new WebSocket(url) as unknown as SocketLike);
    const socket = make(this.options.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.options.onConnectionChange("connected");
      if (this.sessionId === undefined) {
        this.command({ type: "session.start", options: this.options.startOptions });
      } else {
        this.command({ type: "session.attach", sessionId: this.sessionId });
      }
    });
    socket.addEventListener("message", event => {
      if (this.socket !== socket) return;
      if (typeof event.data === "string") {
        const parsed = JSON.parse(event.data) as GatewayEvent;
        this.settleCommandAcceptance(parsed);
        this.sessionId ??= parsed.sessionId || undefined;
        if (parsed.sequence > 0) this.lastSequence = parsed.sequence;
        if (parsed.type === "media.frame") this.pendingMediaFrames.push(parsed);
        if (parsed.type === "media.socket" && parsed.dropped) {
          const index = this.pendingMediaFrames.findIndex(frame => frame.frameId === parsed.frameId);
          if (index >= 0) this.pendingMediaFrames.splice(index, 1);
        }
        if (parsed.type === "media.config") this.mediaPlayback = parsed.playback;
        if (parsed.type === "playback.start") {
          this.playbackStreamId = parsed.streamId;
          this.expectedMediaSequence = 0;
          this.expectedTimestampSamples = 0;
          for (let index = this.pendingMediaFrames.length - 1; index >= 0; index -= 1) {
            const frame = this.pendingMediaFrames[index];
            if (frame?.streamId !== undefined && frame.streamId !== parsed.streamId) {
              this.pendingMediaFrames.splice(index, 1);
            }
          }
        } else if (parsed.type === "playback.interrupted" || parsed.type === "turn.interrupted") {
          this.playbackStreamId = undefined;
          for (let index = this.pendingMediaFrames.length - 1; index >= 0; index -= 1) {
            if (this.pendingMediaFrames[index]?.streamId !== undefined) this.pendingMediaFrames.splice(index, 1);
          }
        }
        // A rejected attach means the session expired while we were gone: the next
        // connection starts fresh instead of retrying a dead id forever.
        if (parsed.type === "command.rejected" && parsed.reason === "unknown_session") {
          this.sessionId = undefined;
          this.command({ type: "session.start", options: this.options.startOptions });
        }
        this.options.onEvent(parsed);
        if (this.options.startOptions.mediaTelemetry === true && this.pingTimer === undefined
            && parsed.type === "command.accepted"
            && (parsed.commandType === "session.start" || parsed.commandType === "session.attach")) {
          this.sendMediaPing();
          this.pingTimer = setInterval(() => this.sendMediaPing(), 5_000);
        }
      } else if (event.data instanceof ArrayBuffer) {
        const receivedAtMs = monotonicEpochMs();
        if (this.mediaPlayback === undefined) {
          const samples = new Float32Array(event.data);
          this.options.onAudio(samples, {
            frame: this.pendingMediaFrames.shift(),
            receivedAtMs,
            decodedAtMs: monotonicEpochMs(),
          });
          return;
        }
        try {
          const media = parseMediaV2Frame(event.data);
          if (media.kind !== "playback" || media.codec !== this.mediaPlayback.codec
              || media.sampleRate !== this.mediaPlayback.sampleRate
              || media.channels !== this.mediaPlayback.channels) {
            throw new TypeError("Media v2 frame does not match the negotiated playback configuration");
          }
          const frameIndex = this.pendingMediaFrames.findIndex(frame => frame.streamId === media.streamId
            && frame.mediaSequence === media.sequence);
          const frame = frameIndex < 0 ? undefined : this.pendingMediaFrames.splice(frameIndex, 1)[0];
          // A newer playback.start supersedes old bytes even if a transport adapter ever
          // delivers them late. They must not re-arm the speaker after interruption.
          if (media.streamId !== this.playbackStreamId) return;
          if (media.sequence !== this.expectedMediaSequence
              || media.timestampSamples !== BigInt(this.expectedTimestampSamples)) {
            throw new TypeError("Media v2 sequence or timestamp discontinuity");
          }
          this.expectedMediaSequence += 1;
          this.expectedTimestampSamples += media.durationSamples;
          if (media.codec !== "pcm_s16le") throw new TypeError(`unsupported browser media codec ${media.codec}`);
          const samples = decodePcm16(media.payload);
          this.options.onAudio(samples, {
            frame,
            receivedAtMs,
            decodedAtMs: monotonicEpochMs(),
            media: {
              streamId: media.streamId,
              sequence: media.sequence,
              timestampSamples: Number(media.timestampSamples),
              durationSamples: media.durationSamples,
            },
          });
        } catch {
          // Never reinterpret a malformed negotiated envelope as raw float PCM. Closing
          // forces the normal snapshot-based reconnect path and keeps noise off speakers.
          socket.close();
        }
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.rejectCommandAcceptances("connection closed before the command was accepted");
      this.stopMediaPing();
      this.pendingMediaFrames.length = 0;
      this.playbackStreamId = undefined;
      if (this.closed) {
        this.options.onConnectionChange("disconnected");
        return;
      }
      this.attempts += 1;
      this.options.onConnectionChange("reconnecting");
      const delay = Math.min(maxBackoffMs, (this.options.backoffMs ?? 500) * this.attempts);
      setTimeout(() => {
        if (!this.closed) this.connect();
      }, delay);
    });
    socket.addEventListener("error", () => {
      // The close event carries the reconnect; error alone is informational.
    });
  }

  sendAudio(samples: Float32Array): void {
    if (this.socket?.readyState !== 1) return;
    this.socket.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  }

  async sendText(text: string): Promise<void> {
    await this.commandAndWaitForAcceptance({ type: "turn.text", text });
  }

  interruptTurn(turnId: string): void {
    this.command({ type: "turn.interrupt", turnId });
  }

  playbackComplete(turnId: string): void {
    this.command({ type: "playback.complete", turnId });
  }

  requestSnapshot(): void {
    this.command({ type: "session.snapshot.request" });
  }

  stopSession(): void {
    this.command({ type: "session.stop" });
    this.close();
  }

  close(): void {
    this.closed = true;
    this.rejectCommandAcceptances("client closed before the command was accepted");
    this.stopMediaPing();
    this.pendingMediaFrames.length = 0;
    this.socket?.close();
    this.socket = undefined;
    this.options.onConnectionChange("disconnected");
  }

  private command(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== 1) return;
    const key = this.options.newIdempotencyKey?.() ?? crypto.randomUUID();
    this.socket.send(JSON.stringify({ v: protocolVersion, idempotencyKey: key, ...payload }));
  }

  private commandAndWaitForAcceptance(payload: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (socket?.readyState !== 1) return Promise.reject(new Error("conversation is not connected"));
    const key = this.options.newIdempotencyKey?.() ?? crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommandAcceptances.delete(key);
        reject(new Error("command acceptance timed out"));
      }, commandAcceptanceTimeoutMs);
      this.pendingCommandAcceptances.set(key, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ v: protocolVersion, idempotencyKey: key, ...payload }));
      } catch (error) {
        clearTimeout(timer);
        this.pendingCommandAcceptances.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private settleCommandAcceptance(event: GatewayEvent): void {
    if ((event.type !== "command.accepted" && event.type !== "command.rejected") || event.idempotencyKey === undefined) return;
    const pending = this.pendingCommandAcceptances.get(event.idempotencyKey);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingCommandAcceptances.delete(event.idempotencyKey);
    if (event.type === "command.accepted") pending.resolve();
    else pending.reject(new Error(`command rejected: ${event.reason}`));
  }

  private rejectCommandAcceptances(message: string): void {
    for (const pending of this.pendingCommandAcceptances.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingCommandAcceptances.clear();
  }

  private sendMediaPing(): void {
    this.command({ type: "media.ping", clientSentAtMs: monotonicEpochMs() });
  }

  private stopMediaPing(): void {
    if (this.pingTimer === undefined) return;
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }
}
