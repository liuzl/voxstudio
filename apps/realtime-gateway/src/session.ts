import { type PcmStreamDecoder, AsrClient, LlmClient, TtsClient, type Fetch } from "@voxstudio/clients";
import { encodePcm16, LinearResampler } from "@voxstudio/audio";
import type { AgentSpec } from "@voxstudio/agents";
import { engine, enginesOfKind, roleInstance } from "@voxstudio/config";
import {
  builtinToolNames,
  createBuiltinTools,
  createKeytermProvider,
  createSessionVad,
  createStudioReferents,
  createStudioTools,
  runConversation,
  type ConversationControls,
  type ConversationFrame,
  type ConversationPlayer,
  type ConversationTool,
  type FinalizedInputAudio,
  type FinalizedUtterance,
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
  type GatewayEvent,
  type GatewayEventPayload,
  type MediaPlaybackConfiguration,
  type SessionStartOptions,
} from "./protocol";
import { encodeMediaV2Frame, mediaV2FlagStart } from "./media-v2";

/** Where a session's outbound traffic goes: the WebSocket currently attached to it. */
export interface SinkSendObservation {
  /** Bun: -1 enqueued with backpressure, 0 dropped, positive is bytes sent. */
  sendResult?: number;
  bufferedBytes?: number;
}

export interface EventSink {
  send(data: string | Uint8Array): SinkSendObservation | void;
  /** Abruptly drops bytes already buffered by the transport after a congestion timeout. */
  terminate?(): void;
}

export interface GatewaySessionOptions {
  /** Preallocated when a retention coordinator must durably claim the session first. */
  sessionId?: string;
  config: VoxConfig;
  fetch?: Fetch;
  /**
   * Whose session this is (docs/auth.md phase 2): reattach is refused across owners,
   * and captures ingest under this id. A plain userId string — the session never sees
   * credentials. Defaults to the self-hosted owner.
   */
  owner?: string;
  /**
   * Display voice name → the engine-side id for this session's owner, or null when the
   * name may not be used. Injected by the gateway, which owns namespacing; the session
   * applies it at the one place a voice reaches an engine, so `session.start`, the
   * `set_voice` tool, and queued agent speech are covered by construction (adversarial
   * review 2026-07-26). Absent, voices pass through unchanged.
   */
  mapVoiceId?: (displayName: string) => string | null;
  /**
   * Deployment-owned voice that account sessions may use without a user namespace.
   * When `tts_defaults.voice` is empty this stays absent and the selected engine applies
   * its own native default; a configured registered id remains shared deployment state.
   */
  deploymentDefaultVoice?: string;
  /** Resolved Agent behavior for overlays that are not direct realtime wire fields. */
  agentSpec?: AgentSpec;
  /**
   * Asks whether this conversation may spend one more turn (docs/auth.md phase 4).
   * Called once per conversational turn, when the user's utterance is finalized and
   * before the reply's model work begins — never per audio frame. A refusal ends the
   * session with a notice; the turn already in flight may finish, so a conversation
   * overshoots its allowance by at most one turn.
   */
  chargeTurn?: (turnId: string) => { allowed: boolean; retryAfterSeconds?: number };
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
  onUtterance?: (utterance: FinalizedUtterance) => void | Promise<void>;
  /** Canonical input submitted to ASR, observed before a reopen can cancel ASR. */
  onFinalizedInput?: (input: FinalizedInputAudio) => void;
  /**
   * Optional non-blocking observer for canonical Agent PCM that was successfully handed
   * to the active transport. It is absent unless conversation output retention is on.
   */
  createOutputRecording?: (identity: { sessionId: string; turnId: string; revision: number }) => {
    write(samples: Float32Array, sampleRate: number): void;
    finalize(delivery: "sent" | "playback_acknowledged" | "interrupted" | "superseded"): void;
  } | undefined;
  /**
   * Whether a session may request the Studio tools (docs/voice-studio-control.md).
   * The server sets this false in demo mode — an anonymous visitor must not write the
   * voice bank by talking at it, the same rule that refuses MCP.
   */
  allowStudioTools?: boolean;
  /** Registers a clone voice from utterance audio; omitted, the save tool refuses. */
  registerVoice?: (id: string, wav: Uint8Array, transcript: string) => Promise<{ engine?: string }>;
  /** Writes session-added pronunciations to the gateway host's config file. */
  persistPronunciations?: (entries: Record<string, string>) => Promise<void>;
  /** Compares a design profile against the live TTS runtime, for the audit tool. */
  auditProfile?: (id: string) => Promise<{ status: string; model?: string; detail?: string }>;
  loadSileroVad?: (() => Promise<SpeechProbabilityModel>) | undefined;
  /** How long a detached session survives waiting for a reconnect. */
  reconnectGraceMs?: number;
  /** Test/deployment ceiling before a blocked media socket aborts its current rendition. */
  mediaBackpressureTimeoutMs?: number;
  /** Demo guardrail (docs/public-demo.md): the session notices and stops at this ceiling. */
  maxSessionSeconds?: number;
  /** Called when the session ends for any reason, so the registry can forget it. */
  onClosed?: (session: GatewaySession) => void;
  /** Optional trace observer. It must never become part of the conversation's critical path. */
  onEvent?: (event: GatewayEvent) => void;
  /** Operational logging (session lifecycle, turn milestones, errors). No transcript text. */
  log?: (line: string) => void;
}

/** The session tools every conversation gets; surface-injected extras may not shadow them. */
export { builtinToolNames };

const inputSampleRate = 16_000;
/** Buffered microphone audio beyond this is dropped oldest-first; the VAD sees a gap, not unbounded memory. */
const maxBufferedInputMs = 30_000;
const maxIdempotencyKeys = 512;
const legacyPcmFrameMs = 240;
const maxQueuedOutputMs = 1_000;
const defaultMediaBackpressureTimeoutMs = 2_000;
const mediaV2InitialBurstMs = 200;
const mediaV2Pcm16Playback = {
  codec: "pcm_s16le",
  sampleRate: 24_000,
  channels: 1,
  packetDurationMs: 20,
} as const satisfies MediaPlaybackConfiguration;

/**
 * Formats the deliberately low-volume operational session log. Media telemetry stays
 * available on the wire and in trace exports; writing every 20 ms frame to a terminal
 * would turn one healthy session into roughly one hundred log lines per second.
 */
export function formatOperationalEventLog(sessionId: string, event: GatewayEvent): string | undefined {
  const prefix = `session ${sessionId.slice(0, 8)} #${event.sequence}`;
  if (event.type === "error" || event.type === "session.notice" || event.type === "command.rejected") {
    const detail = "message" in event ? event.message : "reason" in event ? event.reason : "";
    return `${prefix} ${event.type}: ${detail}`;
  }
  if (event.type === "response.text.delta"
      || event.type === "media.frame"
      || event.type === "media.socket"
      || event.type === "media.pong") {
    return undefined;
  }
  if (event.type === "command.accepted" && event.commandType === "media.ping") {
    return `${prefix} command.accepted media.ping`;
  }
  if (event.type === "media.socket.drain") {
    return `${prefix} media.socket.drain duration=${Math.round(event.durationMs)}ms high_water=${event.highWaterBytes}B`;
  }
  if (event.type === "media.rendition") {
    return `${prefix} media.rendition turn ${event.turnId.slice(0, 8)} ${event.status}`
      + ` frames=${event.frames} audio=${Math.round(event.audioMs)}ms stale=${event.staleFramesDiscarded}`;
  }
  const turn = "turnId" in event ? ` turn ${event.turnId.slice(0, 8)}` : "";
  const state = event.type === "session.state" ? ` ${event.state}` : "";
  return `${prefix} ${event.type}${turn}${state}`;
}

type MediaBackpressureOutcome = "drained" | "detached" | "cancelled" | "timeout";

class MediaTransportError extends Error {
  constructor(
    readonly code: "network_congested" | "media_disconnected",
    readonly discardReason: "network_congested" | "detached",
    message: string,
  ) {
    super(message);
    this.name = "MediaTransportError";
  }
}

/** Epoch-shaped but monotonic within this process, so browser clock alignment is stable. */
function monotonicEpochMs(): number {
  return typeof performance !== "undefined"
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

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
  /** The owning userId; the server verifies it on every reattach. */
  readonly owner: string;
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
  private terminalErrorCode: string | undefined;
  private playbackAck = false;
  private mediaTelemetry = false;
  private mediaPlayback: typeof mediaV2Pcm16Playback | undefined;
  private mediaFrameSequence = 0;
  private mediaHighWaterBytes = 0;
  private mediaBackpressure: {
    sink: EventSink;
    frameId: number;
    startedAtMs: number;
    settled: Promise<MediaBackpressureOutcome>;
    resolve: (outcome: MediaBackpressureOutcome) => void;
  } | undefined;
  private playbackWaiter: { turnId: string; resolve: () => void } | undefined;
  private lastAckedTurnId: string | undefined;
  private readonly sawDelta = new Set<string>();
  /** Turns already charged, so a revision of one is not billed twice. */
  private readonly chargedTurns = new Set<string>();
  /** Set by the end_call tool: hang up after the current turn finishes audibly. */
  private endAfterTurn = false;
  private controls: ConversationControls | undefined;
  /** Conversation-referent bookkeeping for the Studio tools; in-memory only, never retained. */
  private readonly referents = createStudioReferents();
  constructor(options: GatewaySessionOptions) {
    this.options = options;
    this.duplex = new DuplexSession({
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      onEvent: event => {
        // Re-sequence through the gateway envelope: one monotonic counter covers kernel
        // events, engine text, and command acknowledgements alike.
        const { sequence: _sequence, sessionId: _sessionId, timestampMs: _timestampMs, ...payload } = event;
        this.emit(payload);
        // The end_call tool hangs up only after the farewell finished audibly:
        // turn.completed fires downstream of the player's audible clock.
        if (payload.type === "turn.completed" && this.endAfterTurn
          && (this.controls?.pendingAgentSpeech() ?? 0) === 0) {
          // Hang up after the farewell — and after any queued agent speech (a redo asked
          // in the same breath): its own completed turn re-arrives here, queue empty.
          queueMicrotask(() => { this.stop(); });
        }
      },
    });
    this.id = this.duplex.sessionId;
    this.owner = options.owner ?? "owner";
  }

  get done(): Promise<void> {
    return this.conversation ?? Promise.resolve();
  }

  get failureCode(): string | undefined {
    return this.terminalErrorCode;
  }

  /** Record a failure translated by the protocol adapter before it closes the session. */
  markFailed(code: string): void {
    this.terminalErrorCode ??= code;
  }

  /**
   * The single place a voice name crosses into an engine: whatever chose it — the start
   * options, the `set_voice` tool, a queued agent-speech override — is translated into
   * the owner's namespace here, and a name that may not be used fails the synthesis
   * instead of reaching somebody else's voice.
   */
  private ownedVoice(input: SpeechInput): SpeechInput {
    const map = this.options.mapVoiceId;
    if (map === undefined || input.voice === undefined) return input;
    if (input.voice === this.options.deploymentDefaultVoice) return input;
    const engineVoice = map(input.voice);
    if (engineVoice === null) throw new TypeError(`unknown voice ${input.voice}`);
    return { ...input, voice: engineVoice };
  }

  async start(start: SessionStartOptions, sink: EventSink): Promise<void> {
    this.sink = sink;
    this.playbackAck = start.playbackAck ?? false;
    this.mediaTelemetry = start.mediaTelemetry ?? false;
    if (start.media !== undefined) {
      const compatible = start.media.playback.some(candidate => candidate.codec === mediaV2Pcm16Playback.codec
        && candidate.sampleRate === mediaV2Pcm16Playback.sampleRate
        && candidate.channels === mediaV2Pcm16Playback.channels
        && candidate.packetDurationMs === mediaV2Pcm16Playback.packetDurationMs);
      if (!compatible) {
        throw new TypeError("no compatible Media v2 playback configuration; gateway supports pcm_s16le/24000/mono/20ms");
      }
      this.mediaPlayback = { ...mediaV2Pcm16Playback };
      this.emit({ type: "media.config", version: 2, playback: this.mediaPlayback });
    }
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
    const studioActive = start.studioTools === true && this.options.allowStudioTools === true;
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
      // A session-local copy: remember_pronunciation mutates it, config stays shared. The
      // map must exist whenever the studio tools do.
      ...(studioActive || Object.keys(config.pronunciations).length > 0
          || Object.keys(this.options.agentSpec?.pronunciations ?? {}).length > 0
        ? { pronunciations: { ...config.pronunciations, ...this.options.agentSpec?.pronunciations } } : {}),
    } as Parameters<typeof runConversation>[1];
    conversationOptions.onControls = handle => { this.controls = handle; };
    conversationOptions.keyterms = createKeytermProvider({
      configTerms: [...config.keyterms, ...(this.options.agentSpec?.keyterms ?? [])],
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
      // The Studio tools (docs/voice-studio-control.md) join only when the session asked
      // AND the deployment allows: demo mode never registers them, the same rule as MCP.
      ...(studioActive ? createStudioTools({
        lastUtterance: this.referents.lastUtterance,
        ...(this.options.registerVoice === undefined ? {} : {
          registerVoice: async (id: string, wav: Uint8Array, transcript: string) => {
            const registered = await this.options.registerVoice?.(id, wav, transcript);
            this.referents.clearPin();
            return registered;
          },
        }),
        lastReply: this.referents.lastReply,
        queueAgentSpeech: (text, overrides) => this.controls?.queueAgentSpeech(text, overrides),
        setPronunciation: (term, reading) => {
          (conversationOptions.pronunciations ??= {})[term] = reading;
        },
        ...(this.options.persistPronunciations === undefined ? {} : { persistPronunciations: this.options.persistPronunciations }),
        ...(this.options.auditProfile === undefined ? {} : { auditProfile: this.options.auditProfile }),
        // The take is produced by the client that asked for it: the event reaches the
        // same browser whose Generate panel runs the generation — the loop stays out of
        // the batch-synthesis business.
        generateTake: async (text, voice) => {
          this.emit({ type: "studio.take", text, ...(voice === undefined ? {} : { voice }) });
        },
      }) : []),
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
        speech: (input: SpeechInput, signal?: AbortSignal) => ttsClient.speech(this.ownedVoice(input), signal),
        speechStream: (input: SpeechInput, signal?: AbortSignal) => ttsClient.speechStream(this.ownedVoice(input), signal),
      },
    }, conversationOptions, {
      onTranscript: (text, turn) => {
        this.emit({ type: "transcript.final", turnId: turn.id, revision: turn.revision, text });
        // The turn's model work starts right after this callback returns, so this is
        // where a conversation's cost is metered — once per turn, not per revision.
        const charge = this.options.chargeTurn;
        if (charge === undefined || this.chargedTurns.has(turn.id)) return;
        this.chargedTurns.add(turn.id);
        const verdict = charge(turn.id);
        if (verdict.allowed) return;
        // The same contract the start-time refusal carries: a code to branch on and a
        // delay to wait (adversarial review 2026-07-27 — this used to be free text).
        this.emit({
          type: "session.notice",
          message: `quota exhausted: this account's allowance is spent — retry in ${verdict.retryAfterSeconds ?? 0}s`,
          code: "quota_exceeded",
          ...(verdict.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: verdict.retryAfterSeconds }),
        });
        this.stop();
      },
      onReplyDelta: (text, turn) => {
        if (text.length > 0 && this.options.log && !this.sawDelta.has(`${turn.id}/${turn.revision}`)) {
          this.sawDelta.add(`${turn.id}/${turn.revision}`);
          this.options.log(`session ${this.id.slice(0, 8)} llm first delta turn ${turn.id.slice(0, 8)} rev ${turn.revision}`);
        }
        this.emit({ type: "response.text.delta", turnId: turn.id, revision: turn.revision, text });
      },
      onReply: (text, turn) => {
        this.referents.recordReply(text);
        this.emit({ type: "response.text.final", turnId: turn.id, revision: turn.revision, text });
      },
      onError: (code, message, turn) => this.emit({
        type: "error",
        code,
        message,
        recoverable: true,
        ...(turn === undefined ? {} : { turnId: turn.id }),
      }),
      onToolCall: (name, args, turn) => this.emit({ type: "tool.call", turnId: turn.id, name, arguments: args }),
      onToolResult: (name, ok, result, turn) => {
        // A cancelled save drops its pinned audio; success clears it in registerVoice.
        if (name === "cancel_action") this.referents.clearPin();
        this.emit({ type: "tool.result", turnId: turn.id, name, ok, result });
      },
      onToolPending: (name, args, turn) => {
        this.referents.onToolPending(name);
        this.emit({ type: "tool.pending", turnId: turn.id, name, arguments: args });
      },
      ...(this.options.onFinalizedInput === undefined ? {} : {
        onFinalizedInput: this.options.onFinalizedInput,
      }),
      ...(this.options.onUtterance === undefined && !studioActive ? {} : {
        onUtterance: async utterance => {
          // The studio referents hold at most two utterances in memory — "把刚才那句存成
          // 音色" and its park-time pin — and are not retention: nothing persists unless
          // the user confirms the save aloud. The library opt-in still gets every utterance.
          if (studioActive) this.referents.recordUtterance(utterance.wav, utterance.rawTranscript);
          await this.options.onUtterance?.(utterance);
        },
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
    if (this.sink !== undefined && this.sink !== sink && this.mediaBackpressure?.sink === this.sink) {
      const pressure = this.mediaBackpressure;
      this.mediaBackpressure = undefined;
      pressure.resolve("detached");
      this.reportBackpressuredFrameDiscarded(pressure, "detached");
      // A second attach supersedes the old route. Do not let bytes already accepted by
      // Bun on that route arrive as stale speech in the old tab after the new one resumes.
      pressure.sink.terminate?.();
    }
    this.sink = sink;
    // The reconnect contract: the client resynchronizes from a snapshot rather than
    // replaying history, so the snapshot is pushed rather than waited for.
    this.emit(snapshotEvent(this.duplex.snapshot(), this.sequence + 1));
    if (this.mediaPlayback !== undefined) {
      this.emit({ type: "media.config", version: 2, playback: this.mediaPlayback });
    }
  }

  detach(sink: EventSink): void {
    // A stopped session must not re-arm a reconnect grace: the timer would keep the dead
    // object referenced for 30s per start/stop/close cycle (adversarial review 2026-07-19).
    if (this.stopped) return;
    if (this.sink !== sink) return;
    this.sink = undefined;
    if (this.mediaBackpressure?.sink === sink) {
      const pressure = this.mediaBackpressure;
      this.mediaBackpressure = undefined;
      pressure.resolve("detached");
      this.reportBackpressuredFrameDiscarded(pressure, "detached");
    }
    const grace = this.options.reconnectGraceMs ?? 30_000;
    this.graceTimer = setTimeout(() => { this.stop(); }, grace);
  }

  handleCommand(command: GatewayCommand): void {
    // Capture ping receipt before idempotency bookkeeping or any response event. JSON
    // parsing happened in the adapter; from this boundary onward all work is server time.
    const mediaPingReceivedAtMs = command.type === "media.ping" ? monotonicEpochMs() : undefined;
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
      case "turn.text": {
        const controls = this.controls;
        if (controls === undefined || this.duplex.state === "idle" || this.duplex.state === "closed") {
          this.emit({
            type: "command.rejected",
            reason: "session_not_active",
            commandType: command.type,
            idempotencyKey: command.idempotencyKey,
          });
          return;
        }
        // A typed message is an explicit user interruption. Admission, interruption, and
        // replacement are synchronous on the session event loop, so no microphone or text
        // turn can slip between the old turn ending and the new one starting. Acknowledge
        // first, then preserve the ordinary event order: old turn.interrupted before the
        // replacement turn.started.
        this.accept(command);
        if (this.duplex.state !== "listening") this.duplex.interrupt("barge_in");
        if (!controls.submitUserText(command.text)) {
          this.emit({ type: "error", code: "text_turn_failed", message: "text turn could not start", recoverable: true });
        }
        return;
      }
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
      case "media.ping": {
        this.accept(command);
        this.emit({
          type: "media.pong",
          clientSentAtMs: command.clientSentAtMs,
          serverReceivedAtMs: mediaPingReceivedAtMs ?? monotonicEpochMs(),
          serverSentAtMs: 0,
        }, event => {
          // NTP's t2 belongs at the socket-submit boundary. Logging, envelope construction,
          // and command.accepted are server residence time, not network transit.
          if (event.type === "media.pong") event.serverSentAtMs = monotonicEpochMs();
        });
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
    this.pushAudioSamples(samples);
  }

  /** Platform adapters that already own decoded 16 kHz mono PCM avoid a byte round-trip. */
  pushAudioSamples(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.frames.push(samples);
  }

  snapshotPayload(): GatewayEventPayload {
    return snapshotEvent(this.duplex.snapshot(), this.sequence + 1);
  }

  /** Bun calls this after a backpressured socket becomes writable again. */
  socketDrained(sink: EventSink): void {
    if (this.sink !== sink) return;
    const backpressure = this.mediaBackpressure;
    if (backpressure === undefined || backpressure.sink !== sink) return;
    const drainedAtMs = monotonicEpochMs();
    this.mediaBackpressure = undefined;
    backpressure.resolve("drained");
    if (this.mediaTelemetry) {
      this.emit({
        type: "media.socket.drain",
        startedAtMs: backpressure.startedAtMs,
        drainedAtMs,
        durationMs: Math.max(0, drainedAtMs - backpressure.startedAtMs),
        highWaterBytes: this.mediaHighWaterBytes,
      });
    }
  }

  private beginMediaBackpressure(sink: EventSink, frameId: number, startedAtMs: number): void {
    if (this.mediaBackpressure?.sink === sink) return;
    // A replaced sink cannot drain the previous socket. Wake its waiter so it observes the
    // route change instead of inheriting pressure from a dead connection.
    this.mediaBackpressure?.resolve("detached");
    let resolve = (_outcome: MediaBackpressureOutcome): void => {};
    const settled = new Promise<MediaBackpressureOutcome>(done => { resolve = done; });
    this.mediaBackpressure = { sink, frameId, startedAtMs, settled, resolve };
  }

  private reportBackpressuredFrameDiscarded(
    pressure: NonNullable<GatewaySession["mediaBackpressure"]>,
    reason: "network_congested" | "detached",
  ): void {
    if (!this.mediaTelemetry) return;
    this.emit({
      type: "media.socket",
      frameId: pressure.frameId,
      submittedAtMs: pressure.startedAtMs,
      highWaterBytes: this.mediaHighWaterBytes,
      queuedBytes: 0,
      queuedAudioMs: 0,
      backpressured: false,
      dropped: true,
      discardReason: reason,
    });
  }

  private async waitForMediaWritable(cancelled: Promise<void>): Promise<boolean> {
    while (true) {
      const pressure = this.mediaBackpressure;
      if (pressure === undefined) return true;
      const timeoutMs = this.options.mediaBackpressureTimeoutMs ?? defaultMediaBackpressureTimeoutMs;
      const remainingMs = Math.max(0, timeoutMs - (monotonicEpochMs() - pressure.startedAtMs));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        pressure.settled,
        cancelled.then(() => "cancelled" as const),
        new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), remainingMs); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === "cancelled") return false;
      if (outcome === "detached") {
        throw new MediaTransportError(
          "media_disconnected",
          "detached",
          "media endpoint detached while an outbound PCM frame was backpressured",
        );
      }
      if (outcome === "timeout") {
        if (this.mediaBackpressure === pressure) {
          this.mediaBackpressure = undefined;
          pressure.resolve("timeout");
          this.reportBackpressuredFrameDiscarded(pressure, "network_congested");
          // Bun already accepted the backpressured frame. An abrupt close is the only way
          // to prevent that stale audio from arriving after this rendition is aborted.
          pressure.sink.terminate?.();
        }
        throw new MediaTransportError(
          "network_congested",
          "network_congested",
          `media socket stayed backpressured for ${timeoutMs}ms`,
        );
      }
      // A drain, detach, or socket replacement may expose another pressure episode. Check
      // again before handing the caller permission to feed the ordered TCP connection.
    }
  }

  emit(payload: GatewayEventPayload, beforeSocketSend?: (event: GatewayEvent) => void): void {
    const event: GatewayEvent = {
      ...payload,
      v: protocolVersion,
      sequence: ++this.sequence,
      sessionId: this.id,
      timestampMs: Date.now(),
    };
    const operationalLog = this.options.log === undefined ? undefined : formatOperationalEventLog(this.id, event);
    if (operationalLog !== undefined) this.options.log?.(operationalLog);
    beforeSocketSend?.(event);
    // A detached session keeps running; events during the gap are not buffered because the
    // reconnecting client resynchronizes from the snapshot, not from a replay.
    this.sink?.send(JSON.stringify(event));
    try {
      this.options.onEvent?.(event);
    } catch (error) {
      // Retention is an observer. A full/corrupt trace store must not silence a live
      // conversation or prevent its endpoint from receiving the event.
      this.options.log?.(`session ${this.id.slice(0, 8)} trace write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    if (this.mediaBackpressure !== undefined) {
      const pressure = this.mediaBackpressure;
      this.mediaBackpressure = undefined;
      pressure.resolve("cancelled");
    }
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
    type QueuedFrame = {
      frameId: number;
      bytes: Uint8Array;
      samples: Float32Array;
      sampleRate: number;
      audioMs: number;
      codec: "pcm_f32le" | "pcm_s16le";
      mediaSequence?: number;
      timestampSamples?: number;
    };
    const mediaPlayback = this.mediaPlayback;
    const recording = this.options.createOutputRecording?.({ sessionId: this.id, turnId, revision });
    const streamId = mediaPlayback === undefined ? undefined : crypto.randomUUID();
    const queue: QueuedFrame[] = [];
    const capacityWaiters = new Set<() => void>();
    let submittedRate: number | undefined;
    let queuedMs = 0;
    let queuedBytes = 0;
    let sentMs = 0;
    let sentFrames = 0;
    let staleFramesDiscarded = 0;
    let renditionReported = false;
    let playbackTerminated = false;
    let pumping: Promise<void> | undefined;
    let failure: Error | undefined;
    let aborted = false;
    let closed = false;
    let playbackStarted = false;
    let sourceSampleRate: number | undefined;
    let resampler: LinearResampler | undefined;
    let nextMediaSequence = 0;
    let nextTimestampSamples = 0;
    let mediaPaceStartedAtMs: number | undefined;
    let pacedAudioMs = 0;
    let cancelWriter = (): void => {};
    const cancelled = new Promise<void>(resolve => { cancelWriter = resolve; });

    const wakeCapacity = (): void => {
      for (const wake of capacityWaiters) wake();
      capacityWaiters.clear();
    };

    const reportRendition = (status: "completed" | "interrupted"): void => {
      if (!this.mediaTelemetry || renditionReported) return;
      renditionReported = true;
      this.emit({
        type: "media.rendition",
        turnId,
        revision,
        status,
        frames: sentFrames,
        audioMs: sentMs,
        staleFramesDiscarded,
        endedAtMs: monotonicEpochMs(),
      });
    };

    const dropQueued = (reason: "stale_rendition" | "network_congested" | "detached"): void => {
      const dropped = queue.splice(0);
      if (dropped.length === 0) return;
      if (reason === "stale_rendition") staleFramesDiscarded += dropped.length;
      queuedMs = 0;
      queuedBytes = 0;
      wakeCapacity();
      if (!this.mediaTelemetry) return;
      const discardedAtMs = monotonicEpochMs();
      for (const frame of dropped) {
        this.emit({
          type: "media.socket",
          frameId: frame.frameId,
          submittedAtMs: discardedAtMs,
          highWaterBytes: this.mediaHighWaterBytes,
          queuedBytes: 0,
          queuedAudioMs: 0,
          backpressured: false,
          dropped: true,
          discardReason: reason,
        });
      }
    };

    const failTransport = (error: unknown): void => {
      if (failure !== undefined || aborted) return;
      const transport = error instanceof MediaTransportError
        ? error
        : new MediaTransportError("network_congested", "network_congested", error instanceof Error ? error.message : String(error));
      failure = transport;
      this.emit({
        type: "error",
        code: transport.code,
        message: failure.message,
        recoverable: true,
        turnId,
      });
      wakeCapacity();
      // Make the shared conversation loop treat the transport failure as an interrupted
      // rendition, not add a second generic turn_failed event.
      this.duplex.interrupt("cancel");
    };

    const pump = async (): Promise<void> => {
      while (!aborted && queue.length > 0) {
        // The no-pressure fast path must stay synchronous: yielding here lets write() fill
        // the whole 1s ceiling before the first 240ms frame reaches the socket.
        if (this.mediaBackpressure !== undefined
          && (!(await this.waitForMediaWritable(cancelled)) || aborted)) return;
        const frame = queue[0] as QueuedFrame;
        if (frame.sampleRate !== submittedRate) {
          submittedRate = frame.sampleRate;
          this.emit({ type: "playback.format", turnId, revision, sampleRate: frame.sampleRate });
        }
        if (!(await waitForMediaPace())) return;
        const bytes = frame.bytes;
        const submittedAtMs = monotonicEpochMs();
        const sink = this.sink;
        const observation = sink?.send(bytes);
        const sendResult = observation?.sendResult;
        const bufferedBytes = observation?.bufferedBytes;
        if (bufferedBytes !== undefined) this.mediaHighWaterBytes = Math.max(this.mediaHighWaterBytes, bufferedBytes);
        const backpressured = sendResult === -1;
        if (backpressured && sink !== undefined) this.beginMediaBackpressure(sink, frame.frameId, submittedAtMs);
        const dropped = sink === undefined || sendResult === 0;
        if (!dropped && mediaPlayback !== undefined) pacedAudioMs += frame.audioMs;
        queue.shift();
        queuedMs = Math.max(0, queuedMs - frame.audioMs);
        queuedBytes = Math.max(0, queuedBytes - bytes.byteLength);
        wakeCapacity();
        if (this.mediaTelemetry) {
          this.emit({
            type: "media.socket",
            frameId: frame.frameId,
            submittedAtMs,
            ...(sendResult === undefined ? {} : { sendResult }),
            ...(bufferedBytes === undefined ? {} : { bufferedBytes }),
            highWaterBytes: this.mediaHighWaterBytes,
            queuedBytes,
            queuedAudioMs: queuedMs,
            backpressured,
            dropped,
            ...(dropped ? { discardReason: sink === undefined ? "detached" as const : "network_congested" as const } : {}),
          });
        }
        if (dropped) throw sink === undefined
          ? new MediaTransportError("media_disconnected", "detached", "media endpoint detached before queued audio could be submitted")
          : new MediaTransportError("network_congested", "network_congested", "media socket dropped an outbound PCM frame");
        recording?.write(frame.samples, frame.sampleRate);
        // Keep the pump alive even when this was the last application-queued frame. The
        // congestion deadline belongs to the socket episode, not to a future TTS write or
        // close(), which may arrive several seconds later.
        if (backpressured && (!(await this.waitForMediaWritable(cancelled)) || aborted)) return;
      }
    };

    const ensurePump = (): void => {
      if (pumping !== undefined || aborted || failure !== undefined || queue.length === 0) return;
      pumping = pump()
        .catch(error => { failTransport(error); })
        .finally(() => {
          pumping = undefined;
          wakeCapacity();
          if (queue.length > 0 && !aborted && failure === undefined) ensurePump();
        });
    };

    const waitForCapacity = async (audioMs: number): Promise<boolean> => {
      while (!aborted && failure === undefined && queuedMs + audioMs > maxQueuedOutputMs + 0.001) {
        ensurePump();
        let wake = (): void => {};
        const available = new Promise<void>(resolve => { wake = resolve; });
        capacityWaiters.add(wake);
        await Promise.race([available, cancelled]);
        capacityWaiters.delete(wake);
      }
      if (failure !== undefined) throw failure;
      return !aborted;
    };

    const waitForMediaPace = async (): Promise<boolean> => {
      if (mediaPlayback === undefined) return !aborted;
      mediaPaceStartedAtMs ??= monotonicEpochMs();
      const dueAtMs = mediaPaceStartedAtMs + Math.max(0, pacedAudioMs - mediaV2InitialBurstMs);
      const delayMs = dueAtMs - monotonicEpochMs();
      if (delayMs <= 0) return !aborted;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>(resolve => { timer = setTimeout(resolve, delayMs); }),
        cancelled,
      ]);
      if (timer !== undefined) clearTimeout(timer);
      return !aborted;
    };

    return {
      write: async audio => {
        if (closed) throw new Error("cannot write after the media rendition closed");
        if (failure !== undefined) throw failure;
        if (aborted || audio.samples.length === 0) return;
        if (!Number.isFinite(audio.sampleRate) || audio.sampleRate < 1) {
          throw new TypeError("PCM sample rate must be a positive finite number");
        }
        const producedAtMs = monotonicEpochMs();
        let output = audio.samples;
        let outputRate = audio.sampleRate;
        if (mediaPlayback !== undefined) {
          if (sourceSampleRate === undefined) {
            sourceSampleRate = audio.sampleRate;
            resampler = new LinearResampler(sourceSampleRate, mediaPlayback.sampleRate);
          } else if (sourceSampleRate !== audio.sampleRate) {
            throw new TypeError("Media v2 rendition cannot change source sample rate");
          }
          output = resampler?.push(audio.samples) ?? new Float32Array(0);
          outputRate = mediaPlayback.sampleRate;
          if (output.length > 0 && !playbackStarted && streamId !== undefined) {
            playbackStarted = true;
            this.emit({
              type: "playback.start",
              turnId,
              revision,
              streamId,
              codec: mediaPlayback.codec,
              sampleRate: mediaPlayback.sampleRate,
              channels: mediaPlayback.channels,
              packetDurationMs: mediaPlayback.packetDurationMs,
            });
          }
        }
        const frameMs = mediaPlayback?.packetDurationMs ?? legacyPcmFrameMs;
        const frameSamples = Math.max(1, Math.floor(outputRate * frameMs / 1_000));
        for (let offset = 0; offset < output.length; offset += frameSamples) {
          const end = Math.min(output.length, offset + frameSamples);
          const durationSamples = end - offset;
          const audioMs = durationSamples * 1_000 / outputRate;
          if (!(await waitForCapacity(audioMs))) return;
          const samples = output.slice(offset, end);
          const frameId = ++this.mediaFrameSequence;
          let frame: QueuedFrame;
          if (mediaPlayback !== undefined && streamId !== undefined) {
            const mediaSequence = nextMediaSequence++;
            const timestampSamples = nextTimestampSamples;
            nextTimestampSamples += durationSamples;
            const bytes = encodeMediaV2Frame({
              kind: "playback",
              codec: "pcm_s16le",
              flags: mediaSequence === 0 ? mediaV2FlagStart : 0,
              streamId,
              sequence: mediaSequence,
              timestampSamples: BigInt(timestampSamples),
              durationSamples,
              sampleRate: outputRate,
              channels: 1,
              payload: encodePcm16(samples),
            });
            frame = {
              frameId,
              bytes,
              samples,
              sampleRate: outputRate,
              audioMs,
              codec: "pcm_s16le",
              mediaSequence,
              timestampSamples,
            };
          } else {
            frame = {
              frameId,
              bytes: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
              samples,
              sampleRate: outputRate,
              audioMs,
              codec: "pcm_f32le",
            };
          }
          queue.push(frame);
          queuedMs += audioMs;
          queuedBytes += frame.bytes.byteLength;
          sentMs += audioMs;
          sentFrames += 1;
          if (this.mediaTelemetry) {
            const common = {
              type: "media.frame" as const,
              frameId,
              turnId,
              revision,
              sampleRate: outputRate,
              channels: 1 as const,
              bytes: frame.bytes.byteLength,
              audioMs,
              producedAtMs,
              enqueuedAtMs: monotonicEpochMs(),
            };
            if (frame.codec === "pcm_s16le" && streamId !== undefined
                && frame.mediaSequence !== undefined && frame.timestampSamples !== undefined) {
              this.emit({
                ...common,
                codec: "pcm_s16le",
                streamId,
                mediaSequence: frame.mediaSequence,
                timestampSamples: frame.timestampSamples,
              });
            } else {
              this.emit({ ...common, codec: "pcm_f32le" });
            }
          }
          ensurePump();
        }
      },
      // The gateway cannot hear the client's speaker, so the audible clock belongs to the
      // endpoint. With playbackAck the turn stays `speaking` until the client reports the
      // reply finished rendering — capped by the audio's own duration plus slack, so a
      // silent client cannot wedge the session. Without it, close resolves when the last
      // piece has been sent.
      close: async () => {
        closed = true;
        ensurePump();
        while (pumping !== undefined) await pumping;
        if (failure !== undefined) throw failure;
        if (aborted) return;
        try {
          if (!(await this.waitForMediaWritable(cancelled))) return;
        } catch (error) {
          failTransport(error);
          throw failure ?? error;
        }
        if (failure !== undefined || aborted) return;
        if (mediaPlayback !== undefined && streamId !== undefined && playbackStarted) {
          this.emit({ type: "playback.end", turnId, revision, streamId, totalSamples: nextTimestampSamples });
        }
        reportRendition("completed");
        // A wordless successful tool turn has no endpoint playback clock. Emitting
        // playback.ended without playback.start makes the browser unable to acknowledge
        // this turn and adds a pointless timeout before end_call can finish.
        if (sentFrames === 0) return;
        this.emit({ type: "playback.ended", turnId });
        if (!this.playbackAck || this.stopped) {
          recording?.finalize("sent");
          return;
        }
        if (this.lastAckedTurnId === turnId) {
          recording?.finalize("playback_acknowledged");
          return;
        }
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
        recording?.finalize(this.lastAckedTurnId === turnId ? "playback_acknowledged" : "sent");
      },
      abort: async () => {
        if (playbackTerminated) return;
        playbackTerminated = true;
        aborted = true;
        cancelWriter();
        dropQueued(failure instanceof MediaTransportError ? failure.discardReason
          : failure === undefined ? "stale_rendition" : "network_congested");
        if (pumping !== undefined) await pumping;
        // Interruption or shutdown while waiting for the ack must release the wait: the
        // reply is dead either way.
        if (this.playbackWaiter?.turnId === turnId) {
          this.playbackWaiter.resolve();
          this.playbackWaiter = undefined;
        }
        reportRendition("interrupted");
        recording?.finalize("interrupted");
        this.emit({ type: "playback.interrupted", turnId });
      },
    };
  }
}
