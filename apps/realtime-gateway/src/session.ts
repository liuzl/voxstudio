import { type PcmStreamDecoder, AsrClient, LlmClient, TtsClient, type Fetch } from "@voxstudio/clients";
import { engine, enginesOfKind, roleInstance } from "@voxstudio/config";
import {
  builtinToolNames,
  createBuiltinTools,
  createKeytermProvider,
  createSessionVad,
  runConversation,
  type ConversationFrame,
  type ConversationPlayer,
  type ConversationTool,
} from "@voxstudio/conversation";
import type { EngineKind, ResolvedEngineConfig, SpeechInput, VoxConfig } from "@voxstudio/contracts";
import {
  DuplexSession,
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
  /** Decodes compressed (Opus) TTS streams; without it engines stream raw PCM. */
  pcmDecoder?: PcmStreamDecoder;
  /** The union voice bank, for the set_voice tool's validation and engine routing. */
  listVoices?: () => Promise<{ id: string; engine: string }[]>;
  /** Live engine health, for the get_engine_status tool. */
  engineStatus?: () => Promise<{ name: string; kind: string | null; healthy: boolean }[]>;
  /**
   * Surface-injected tools appended after the built-in session tools — MCP bridge
   * tools and the OpenAI adapter's client-declared functions arrive here. A provider,
   * awaited at session start, because the MCP connection races gateway startup. Names
   * must not collide with `builtinToolNames`; the injecting surface guards that.
   */
  extraTools?: () => Promise<ConversationTool[]>;
  /**
   * The retention opt-in (docs/web-studio.md 素材库): every finalized utterance's WAV and
   * raw ASR text. Absent, nothing is kept — the conversation loop's own privacy rule.
   */
  onUtterance?: (wav: Uint8Array, transcript: string) => void | Promise<void>;
  loadSileroVad?: (() => Promise<SpeechProbabilityModel>) | undefined;
  /** How long a detached session survives waiting for a reconnect. */
  reconnectGraceMs?: number;
  /** Demo guardrail (docs/public-demo.md): the session notices and stops at this ceiling. */
  maxSessionSeconds?: number;
  /** Called when the session ends for any reason, so the registry can forget it. */
  onClosed?: (session: GatewaySession) => void;
  /** Operational logging (session lifecycle, turn milestones, errors). No transcript text. */
  log?: (line: string) => void;
}

/** The session tools every conversation gets; surface-injected extras may not shadow them. */
export { builtinToolNames };

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
  private lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  private conversation: Promise<void> | undefined;
  private stopped = false;
  private playbackAck = false;
  private playbackWaiter: { turnId: string; resolve: () => void } | undefined;
  private lastAckedTurnId: string | undefined;
  private readonly sawDelta = new Set<string>();
  /** Set by the end_call tool: hang up after the current turn finishes audibly. */
  private endAfterTurn = false;
  constructor(options: GatewaySessionOptions) {
    this.options = options;
    this.duplex = new DuplexSession({
      onEvent: event => {
        // Re-sequence through the gateway envelope: one monotonic counter covers kernel
        // events, engine text, and command acknowledgements alike.
        const { sequence: _sequence, sessionId: _sessionId, timestampMs: _timestampMs, ...payload } = event;
        this.emit(payload);
        // The end_call tool hangs up only after the farewell finished audibly:
        // turn.completed fires downstream of the player's audible clock.
        if (payload.type === "turn.completed" && this.endAfterTurn) {
          queueMicrotask(() => { this.stop(); });
        }
      },
    });
    this.id = this.duplex.sessionId;
  }

  get done(): Promise<void> {
    return this.conversation ?? Promise.resolve();
  }

  async start(start: SessionStartOptions, sink: EventSink): Promise<void> {
    this.sink = sink;
    this.playbackAck = start.playbackAck ?? false;
    const vad = await this.createVad(start);
    // A socket that closed while the awaits above ran already stopped this session;
    // starting the kernel now would revive a session the registry has forgotten.
    if (this.stopped) return;
    if (this.options.maxSessionSeconds !== undefined) {
      // A demo conversation ends; a forgotten tab does not hold a slot forever.
      this.lifetimeTimer = setTimeout(() => {
        this.emit({ type: "session.notice", message: `session reached the ${this.options.maxSessionSeconds}s demo ceiling` });
        this.stop();
      }, this.options.maxSessionSeconds * 1_000);
    }
    const turnTaking = start.turnTaking ?? "speculative";
    const config = this.options.config;
    // Engine overrides are validated against the registry before the session runs; a
    // typo rejects the start instead of wiring the conversation to a misroute.
    const pick = (kind: EngineKind, role: string, requested: string | undefined): ResolvedEngineConfig => {
      if (requested === undefined) return engine(config, role);
      const found = enginesOfKind(config, kind).find(([name]) => name === requested);
      if (!found) throw new TypeError(`no ${kind} engine named ${requested}; see /v1/engines`);
      return found[1];
    };
    this.duplex.start();
    // The session tools may retarget TTS mid-session (a clone voice lives on another
    // engine), so the loop speaks through a delegator over a swappable client.
    let ttsClient = new TtsClient(pick("tts", "tts", start.ttsEngine), this.options.fetch, this.options.pcmDecoder);
    let ttsEngineName = start.ttsEngine ?? roleInstance(config, "tts");
    const conversationOptions = {
      language: start.language ?? "auto",
      ...(start.system === undefined ? {} : { system: start.system }),
      ...(start.maxTokens === undefined ? {} : { maxTokens: start.maxTokens }),
      ...(start.voice === undefined ? {} : { voice: start.voice }),
      chunking: config.chunking,
      // A session-local copy: the set_speed tool mutates it, config stays shared.
      ttsDefaults: { ...config.ttsDefaults },
      // Protected mode unless the endpoint declared an echo-cancelled route: the same safe
      // default as the CLI, and the browser client opts in after negotiating AEC.
      allowBargeIn: start.bargeIn ?? false,
      turnTaking,
      reopenMs: start.reopenMs ?? 7_000,
      ...(start.welcome === undefined ? {} : { welcome: start.welcome }),
      ...(start.nudgeAfterSeconds === undefined ? {} : { nudgeAfterSeconds: start.nudgeAfterSeconds }),
      ...(Object.keys(config.pronunciations).length === 0 ? {} : { pronunciations: config.pronunciations }),
    } as Parameters<typeof runConversation>[1];
    conversationOptions.keyterms = createKeytermProvider({
      configTerms: config.keyterms,
      listVoices: async () => await this.options.listVoices?.() ?? [],
    });
    // The shared phase-1 session tools (docs/tool-loop.md), wired to this session's
    // capabilities: the union voice bank with cross-engine retargeting, the registry's
    // live health, and the hang-up flag. Handlers mutate the live conversation options —
    // voice and speed take effect from the next reply chunk resolution (per turn).
    conversationOptions.tools = [
      ...createBuiltinTools({
        listVoices: async () => await this.options.listVoices?.() ?? [],
        onVoiceAccepted: entry => {
          if (entry.engine && entry.engine !== ttsEngineName) {
            ttsClient = new TtsClient(pick("tts", "tts", entry.engine), this.options.fetch, this.options.pcmDecoder);
            ttsEngineName = entry.engine;
          }
        },
        setVoice: voice => { conversationOptions.voice = voice; },
        setSpeed: rate => { conversationOptions.speed = rate; },
        engineStatus: async () => {
          const engines = await this.options.engineStatus?.();
          return engines?.map(entry => ({
            name: entry.name,
            ...(entry.kind === null ? {} : { kind: entry.kind }),
            healthy: entry.healthy,
          }));
        },
        endCall: () => { this.endAfterTurn = true; },
      }),
      ...(await this.options.extraTools?.() ?? []),
    ];
    if (this.stopped) return;
    this.conversation = runConversation({
      session: this.duplex,
      vad,
      frames: this.frames,
      createPlayer: turn => this.createPlayer(turn.id, turn.revision),
      asr: new AsrClient(pick("asr", "asr", start.asrEngine), this.options.fetch),
      llm: new LlmClient(pick("llm", "llm", start.llmEngine), this.options.fetch),
      tts: {
        speech: (input: SpeechInput, signal?: AbortSignal) => ttsClient.speech(input, signal),
        speechStream: (input: SpeechInput, signal?: AbortSignal) => ttsClient.speechStream(input, signal),
      },
    }, conversationOptions, {
      onTranscript: (text, turn) => this.emit({ type: "transcript.final", turnId: turn.id, revision: turn.revision, text }),
      onReplyDelta: (text, turn) => {
        if (text.length > 0 && this.options.log && !this.sawDelta.has(`${turn.id}/${turn.revision}`)) {
          this.sawDelta.add(`${turn.id}/${turn.revision}`);
          this.options.log(`session ${this.id.slice(0, 8)} llm first delta turn ${turn.id.slice(0, 8)} rev ${turn.revision}`);
        }
        this.emit({ type: "response.text.delta", turnId: turn.id, revision: turn.revision, text });
      },
      onReply: (text, turn) => this.emit({ type: "response.text.final", turnId: turn.id, revision: turn.revision, text }),
      onError: (code, message, turn) => this.emit({
        type: "error",
        code,
        message,
        recoverable: true,
        ...(turn === undefined ? {} : { turnId: turn.id }),
      }),
      onToolCall: (name, args, turn) => this.emit({ type: "tool.call", turnId: turn.id, name, arguments: args }),
      onToolResult: (name, ok, result, turn) => this.emit({ type: "tool.result", turnId: turn.id, name, ok, result }),
      onToolPending: (name, args, turn) => this.emit({ type: "tool.pending", turnId: turn.id, name, arguments: args }),
      ...(this.options.onUtterance === undefined ? {} : { onUtterance: this.options.onUtterance }),
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
    // A stopped session must not re-arm a reconnect grace: the timer would keep the dead
    // object referenced for 30s per start/stop/close cycle (adversarial review 2026-07-19).
    if (this.stopped) return;
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
      case "playback.complete":
        // The endpoint's audible clock: the reply for this turn has finished rendering.
        // Arrival before the server-side close() starts waiting is a legal race, so the
        // ack is remembered rather than required to find a waiter.
        this.accept(command);
        this.lastAckedTurnId = command.turnId;
        if (this.playbackWaiter?.turnId === command.turnId) {
          this.playbackWaiter.resolve();
          this.playbackWaiter = undefined;
        }
        return;
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
    if (this.options.log) {
      // Milestones and problems only — never transcript text (the privacy rules).
      if (payload.type === "error" || payload.type === "session.notice" || payload.type === "command.rejected") {
        const detail = "message" in payload ? payload.message : "reason" in payload ? payload.reason : "";
        this.options.log(`session ${this.id.slice(0, 8)} #${event.sequence} ${payload.type}: ${detail}`);
      } else if (payload.type !== "response.text.delta") {
        const turn = "turnId" in payload ? ` turn ${payload.turnId.slice(0, 8)}` : "";
        const state = payload.type === "session.state" ? ` ${payload.state}` : "";
        this.options.log(`session ${this.id.slice(0, 8)} #${event.sequence} ${payload.type}${turn}${state}`);
      }
    }
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
    if (this.lifetimeTimer !== undefined) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = undefined;
    }
    this.frames.end();
    this.duplex.close();
    this.options.onClosed?.(this);
  }

  private async createVad(start: SessionStartOptions): Promise<VadSegmenter> {
    return createSessionVad({
      ...(start.vad === undefined ? {} : { choice: start.vad }),
      explicit: start.vad === "silero",
      sampleRate: inputSampleRate,
      ...(start.threshold === undefined ? {} : { threshold: start.threshold }),
      silenceMs: start.silenceMs ?? ((start.turnTaking ?? "speculative") === "speculative" ? 150 : 650),
      minSpeechMs: start.minSpeechMs ?? 250,
      ...(this.options.loadSileroVad === undefined ? {} : { loadSileroVad: this.options.loadSileroVad }),
      onFallback: message => this.emit({ type: "session.notice", message }),
    });
  }

  private createPlayer(turnId: string, revision: number): ConversationPlayer {
    let announcedRate: number | undefined;
    let sentMs = 0;
    return {
      write: async audio => {
        if (audio.sampleRate !== announcedRate) {
          announcedRate = audio.sampleRate;
          this.emit({ type: "playback.format", turnId, revision, sampleRate: audio.sampleRate });
        }
        sentMs += audio.samples.length * 1_000 / audio.sampleRate;
        const bytes = new Uint8Array(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength);
        this.sink?.send(bytes);
      },
      // The gateway cannot hear the client's speaker, so the audible clock belongs to the
      // endpoint. With playbackAck the turn stays `speaking` until the client reports the
      // reply finished rendering — capped by the audio's own duration plus slack, so a
      // silent client cannot wedge the session. Without it, close resolves when the last
      // piece has been sent.
      close: async () => {
        this.emit({ type: "playback.ended", turnId });
        if (!this.playbackAck || this.stopped) return;
        if (this.lastAckedTurnId === turnId) return;
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.ceil(sentMs) + 5_000);
          this.playbackWaiter = {
            turnId,
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
          };
        });
        if (this.playbackWaiter?.turnId === turnId) this.playbackWaiter = undefined;
      },
      abort: async () => {
        // Interruption or shutdown while waiting for the ack must release the wait: the
        // reply is dead either way.
        if (this.playbackWaiter?.turnId === turnId) {
          this.playbackWaiter.resolve();
          this.playbackWaiter = undefined;
        }
        this.emit({ type: "playback.interrupted", turnId });
      },
    };
  }
}
