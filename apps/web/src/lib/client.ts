import {
  protocolVersion,
  type GatewayEvent,
  type SessionStartOptions,
} from "@voxstudio/realtime-gateway/protocol";

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
  onAudio(samples: Float32Array): void;
  onConnectionChange(state: ConnectionState): void;
  makeSocket?(url: string): SocketLike;
  /** Reconnect backoff base; tests shrink it. */
  backoffMs?: number;
  newIdempotencyKey?(): string;
}

const maxBackoffMs = 5_000;

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
        this.sessionId ??= parsed.sessionId || undefined;
        if (parsed.sequence > 0) this.lastSequence = parsed.sequence;
        // A rejected attach means the session expired while we were gone: the next
        // connection starts fresh instead of retrying a dead id forever.
        if (parsed.type === "command.rejected" && parsed.reason === "unknown_session") {
          this.sessionId = undefined;
          this.command({ type: "session.start", options: this.options.startOptions });
        }
        this.options.onEvent(parsed);
      } else if (event.data instanceof ArrayBuffer) {
        this.options.onAudio(new Float32Array(event.data));
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
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
    this.socket?.close();
    this.socket = undefined;
    this.options.onConnectionChange("disconnected");
  }

  private command(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== 1) return;
    const key = this.options.newIdempotencyKey?.() ?? crypto.randomUUID();
    this.socket.send(JSON.stringify({ v: protocolVersion, idempotencyKey: key, ...payload }));
  }
}
