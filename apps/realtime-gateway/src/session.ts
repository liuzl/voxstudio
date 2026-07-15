import { AsrClient, LlmClient, TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import { runConversation, type ConversationFrame, type ConversationPlayer } from "@voxstudio/conversation";
import type { VoxConfig } from "@voxstudio/contracts";
import {
  DuplexSession,
  EnergyVadSegmenter,
  SileroVadSegmenter,
  type SpeechProbabilityModel,
  type VadSegmenter,
} from "@voxstudio/duplex-session";
import {
  protocolVersion,
  snapshotEvent,
  type GatewayCommand,
  type GatewayEventPayload,
  type SessionStartOptions,
} from "./protocol";

/** Where a session's outbound traffic goes: the WebSocket currently attached to it. */
export interface EventSink {
  send(data: string | Uint8Array): void;
}

export interface GatewaySessionOptions {
  config: VoxConfig;
  fetch?: Fetch;
  loadSileroVad?: (() => Promise<SpeechProbabilityModel>) | undefined;
  /** How long a detached session survives waiting for a reconnect. */
  reconnectGraceMs?: number;
  /** Called when the session ends for any reason, so the registry can forget it. */
  onClosed?: (session: GatewaySession) => void;
}

const inputSampleRate = 16_000;
/** Buffered microphone audio beyond this is dropped oldest-first; the VAD sees a gap, not unbounded memory. */
const maxBufferedInputMs = 30_000;
const maxIdempotencyKeys = 512;

/**
 * Push-based frame source for the conversation loop. The gateway stamps timestamps from
 * the sample count anchored at arrival wall-clock time — the loop's suppression and reopen
 * windows compare against Date.now(), so client clocks stay out of the protocol. A pause
 * in the incoming stream re-anchors instead of letting the derived clock fall behind.
 */
class FrameQueue implements AsyncIterable<ConversationFrame> {
  private readonly buffer: ConversationFrame[] = [];
  private bufferedSamples = 0;
  private wake: (() => void) | undefined;
  private ended = false;
  private anchorMs: number | undefined;
  private consumedSamples = 0;

  push(samples: Float32Array): void {
    if (this.ended || samples.length === 0) return;
    const now = Date.now();
    if (this.anchorMs === undefined) this.anchorMs = now;
    let timestampMs = this.anchorMs + this.consumedSamples * 1_000 / inputSampleRate;
    if (now - timestampMs > 1_000) {
      this.anchorMs += now - timestampMs;
      timestampMs = now;
    }
    this.consumedSamples += samples.length;
    this.buffer.push({ samples, timestampMs });
    this.bufferedSamples += samples.length;
    while (this.bufferedSamples > maxBufferedInputMs * inputSampleRate / 1_000) {
      const dropped = this.buffer.shift();
      if (!dropped) break;
      this.bufferedSamples -= dropped.samples.length;
    }
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ConversationFrame> {
    while (true) {
      while (this.buffer.length > 0) {
        const frame = this.buffer.shift() as ConversationFrame;
        this.bufferedSamples -= frame.samples.length;
        yield frame;
      }
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

/**
 * One realtime conversation behind one WebSocket at a time. The session owns the duplex
 * kernel, the conversation loop, outbound event sequencing, and command idempotency; it
 * outlives its socket by a reconnect grace so a dropped connection resumes with a snapshot
 * instead of a dead conversation.
 */
export class GatewaySession {
  readonly id: string;
  private readonly duplex: DuplexSession;
  private readonly frames = new FrameQueue();
  private readonly options: GatewaySessionOptions;
  private readonly seenCommands = new Map<string, GatewayCommand["type"]>();
  private sequence = 0;
  private sink: EventSink | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private conversation: Promise<void> | undefined;
  private stopped = false;

  constructor(options: GatewaySessionOptions) {
    this.options = options;
    this.duplex = new DuplexSession({
      onEvent: event => {
        // Re-sequence through the gateway envelope: one monotonic counter covers kernel
        // events, engine text, and command acknowledgements alike.
        const { sequence: _sequence, sessionId: _sessionId, timestampMs: _timestampMs, ...payload } = event;
        this.emit(payload);
      },
    });
    this.id = this.duplex.sessionId;
  }

  get done(): Promise<void> {
    return this.conversation ?? Promise.resolve();
  }

  async start(start: SessionStartOptions, sink: EventSink): Promise<void> {
    this.sink = sink;
    const vad = await this.createVad(start);
    const turnTaking = start.turnTaking ?? "speculative";
    const config = this.options.config;
    this.duplex.start();
    this.conversation = runConversation({
      session: this.duplex,
      vad,
      frames: this.frames,
      createPlayer: turn => this.createPlayer(turn.id, turn.revision),
      asr: new AsrClient(engine(config, "asr"), this.options.fetch),
      llm: new LlmClient(engine(config, "llm"), this.options.fetch),
      tts: new TtsClient(engine(config, "tts"), this.options.fetch),
    }, {
      language: start.language ?? "auto",
      ...(start.system === undefined ? {} : { system: start.system }),
      ...(start.maxTokens === undefined ? {} : { maxTokens: start.maxTokens }),
      ...(start.voice === undefined ? {} : { voice: start.voice }),
      chunking: config.chunking,
      ttsDefaults: config.ttsDefaults,
      // Protected mode unless the endpoint declared an echo-cancelled route: the same safe
      // default as the CLI, and the browser client opts in after negotiating AEC.
      allowBargeIn: start.bargeIn ?? false,
      turnTaking,
      reopenMs: start.reopenMs ?? 7_000,
    }, {
      onTranscript: (text, turn) => this.emit({ type: "transcript.final", turnId: turn.id, revision: turn.revision, text }),
      onReplyDelta: (text, turn) => this.emit({ type: "response.text.delta", turnId: turn.id, revision: turn.revision, text }),
      onReply: (text, turn) => this.emit({ type: "response.text.final", turnId: turn.id, revision: turn.revision, text }),
      onError: (code, message, turn) => this.emit({
        type: "error",
        code,
        message,
        recoverable: true,
        ...(turn === undefined ? {} : { turnId: turn.id }),
      }),
    });
    // The loop ending — frame source closed, session closed, or a crash — always tears the
    // session down; a gateway session with no loop behind it would accept audio into a void.
    void this.conversation
      .catch(error => {
        this.emit({
          type: "error",
          code: "conversation_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: false,
        });
      })
      .finally(() => { this.stop(); });
  }

  attach(sink: EventSink): void {
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    this.sink = sink;
    // The reconnect contract: the client resynchronizes from a snapshot rather than
    // replaying history, so the snapshot is pushed rather than waited for.
    this.emit(snapshotEvent(this.duplex.snapshot(), this.sequence + 1));
  }

  detach(sink: EventSink): void {
    if (this.sink !== sink) return;
    this.sink = undefined;
    const grace = this.options.reconnectGraceMs ?? 30_000;
    this.graceTimer = setTimeout(() => { this.stop(); }, grace);
  }

  handleCommand(command: GatewayCommand): void {
    const seen = this.seenCommands.get(command.idempotencyKey);
    if (seen !== undefined) {
      this.emit({ type: "command.duplicate", commandType: command.type, idempotencyKey: command.idempotencyKey });
      return;
    }
    this.recordCommand(command);
    switch (command.type) {
      case "session.snapshot.request":
        this.accept(command);
        this.emit(snapshotEvent(this.duplex.snapshot(), this.sequence + 1));
        return;
      case "turn.interrupt": {
        // Turn-scoped by design: a stop that raced a turn change — or was replayed after a
        // reconnect — names a superseded turn and must not kill the reply now playing.
        if (this.duplex.currentTurn?.id !== command.turnId) {
          this.emit({
            type: "command.rejected",
            reason: "stale_turn",
            commandType: command.type,
            idempotencyKey: command.idempotencyKey,
          });
          return;
        }
        this.accept(command);
        this.duplex.interrupt("cancel");
        return;
      }
      case "session.stop":
        this.accept(command);
        this.stop();
        return;
      default:
        this.emit({
          type: "command.rejected",
          reason: "not_valid_for_attached_session",
          commandType: command.type,
          idempotencyKey: command.idempotencyKey,
        });
    }
  }

  pushAudio(bytes: Uint8Array): void {
    if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
      this.emit({ type: "error", code: "bad_audio_frame", message: "binary frames must be float32 PCM", recoverable: true });
      return;
    }
    const samples = new Float32Array(bytes.byteLength / 4);
    new Uint8Array(samples.buffer).set(bytes);
    this.frames.push(samples);
  }

  snapshotPayload(): GatewayEventPayload {
    return snapshotEvent(this.duplex.snapshot(), this.sequence + 1);
  }

  emit(payload: GatewayEventPayload): void {
    const event = {
      ...payload,
      v: protocolVersion,
      sequence: ++this.sequence,
      sessionId: this.id,
      timestampMs: Date.now(),
    };
    // A detached session keeps running; events during the gap are not buffered because the
    // reconnecting client resynchronizes from the snapshot, not from a replay.
    this.sink?.send(JSON.stringify(event));
  }

  accept(command: GatewayCommand): void {
    this.emit({ type: "command.accepted", commandType: command.type, idempotencyKey: command.idempotencyKey });
  }

  recordCommand(command: GatewayCommand): void {
    this.seenCommands.set(command.idempotencyKey, command.type);
    while (this.seenCommands.size > maxIdempotencyKeys) {
      const oldest = this.seenCommands.keys().next().value;
      if (oldest === undefined) break;
      this.seenCommands.delete(oldest);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    this.frames.end();
    this.duplex.close();
    this.options.onClosed?.(this);
  }

  private async createVad(start: SessionStartOptions): Promise<VadSegmenter> {
    const silenceMs = start.silenceMs ?? ((start.turnTaking ?? "speculative") === "speculative" ? 150 : 650);
    const minSpeechMs = start.minSpeechMs ?? 250;
    const energy = (): VadSegmenter => new EnergyVadSegmenter({
      sampleRate: inputSampleRate,
      threshold: start.threshold ?? 0.01,
      silenceMs,
      minSpeechMs,
    });
    if (start.vad === "energy") return energy();
    try {
      if (!this.options.loadSileroVad) throw new TypeError("the silero VAD is not available on this gateway");
      return new SileroVadSegmenter({
        model: await this.options.loadSileroVad(),
        silenceMs,
        minSpeechMs,
        ...(start.threshold === undefined ? {} : { minLevel: start.threshold }),
      });
    } catch (error) {
      // Same policy as the CLI: asked-for silero fails loudly, the default degrades loudly
      // to the equally certified energy detector.
      if (start.vad === "silero") throw error;
      this.emit({
        type: "session.notice",
        message: `silero VAD unavailable (${error instanceof Error ? error.message : String(error)}); using the energy detector`,
      });
      return energy();
    }
  }

  private createPlayer(turnId: string, revision: number): ConversationPlayer {
    let announcedRate: number | undefined;
    return {
      write: async audio => {
        if (audio.sampleRate !== announcedRate) {
          announcedRate = audio.sampleRate;
          this.emit({ type: "playback.format", turnId, revision, sampleRate: audio.sampleRate });
        }
        const bytes = new Uint8Array(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength);
        this.sink?.send(bytes);
      },
      // The gateway cannot hear the client's speaker: audible-end accounting belongs to
      // the endpoint (the browser Conversation panel's Phase 2 gate), so close resolves
      // when the last piece has been sent.
      close: async () => { this.emit({ type: "playback.ended", turnId }); },
      abort: async () => { this.emit({ type: "playback.interrupted", turnId }); },
    };
  }
}
