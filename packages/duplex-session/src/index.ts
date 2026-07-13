export type DuplexState =
  | "idle"
  | "listening"
  | "speech_started"
  | "finalizing"
  | "thinking"
  | "speaking"
  | "reconfiguring"
  | "closed";

export type InterruptionReason = "barge_in" | "cancel" | "shutdown" | "reconfigure";

export interface OutputAudioFrame {
  samples: Float32Array;
  sampleRate: number;
  timestampMs: number;
}

export interface QueuedOutputAudio {
  turnId: string;
  audio: OutputAudioFrame;
}

export interface DuplexStateEvent {
  type: "session.state";
  state: DuplexState;
  previous: DuplexState;
}

export interface DuplexTurnEvent {
  type: "turn.started" | "vad.end" | "turn.interrupted" | "turn.completed" | "turn.false_barge_in" | "turn.reopened";
  turnId: string;
  reason?: InterruptionReason;
  revision?: number;
}

export type TurnTimingPoint =
  | "vad_end"
  | "thinking"
  | "asr_done"
  | "llm_first"
  | "speaking"
  | "tts_first_audio"
  | "playback_first";

/**
 * Emitted once per turn when it ends, however it ends. Offsets are milliseconds from the
 * start of user speech, present only for points the turn actually reached — the profile of
 * a reply's latency, and the baseline any end-of-turn policy change must beat.
 */
export interface DuplexTimingEvent {
  type: "turn.timing";
  turnId: string;
  endReason: "completed" | InterruptionReason;
  offsetsMs: Partial<Record<TurnTimingPoint, number>>;
}

export interface DuplexQueueEvent {
  type: "audio.queue_overflow" | "audio.discarded";
  turnId: string;
  queuedMs: number;
  maxQueuedMs: number;
}

export type DuplexEventPayload = DuplexStateEvent | DuplexTurnEvent | DuplexTimingEvent | DuplexQueueEvent;

export type DuplexEvent = DuplexEventPayload & {
  sequence: number;
  sessionId: string;
  timestampMs: number;
};

export interface DuplexTurn {
  id: string;
  /**
   * Increments when a soft-ended turn reopens. The signal below belongs to this revision:
   * reopening aborts it (reason "reopened") and hands the caller a fresh handle, so work
   * started for a superseded revision cancels exactly like work for a superseded turn.
   */
  revision: number;
  signal: AbortSignal;
}

export interface DuplexSessionSnapshot {
  sessionId: string;
  state: DuplexState;
  currentTurnId?: string;
  lastSequence: number;
  queuedAudioMs: number;
}

export interface DuplexSessionOptions {
  sessionId?: string;
  maxQueuedAudioMs?: number;
  now?: () => number;
  newTurnId?: () => string;
  onEvent?: (event: DuplexEvent) => void;
}

export interface VadSegmenterOptions {
  sampleRate: number;
  threshold?: number;
  minSpeechMs?: number;
  silenceMs?: number;
  maxSpeechMs?: number;
  preRollMs?: number;
}

export interface SpeechStarted {
  type: "speech.start";
  timestampMs: number;
  rms: number;
}

/**
 * Emitted once per utterance, when its accumulated voiced audio reaches `minSpeechMs`.
 * `speech.start` fires on the first over-threshold frame, so a single 20ms transient — a
 * residual echo spike, a keyboard tap — raises it. Interruption policy must wait for this
 * event: a provisional barge-in is not real until enough voiced audio has confirmed it.
 */
export interface SpeechConfirmed {
  type: "speech.confirmed";
  timestampMs: number;
  startedAtMs: number;
}

/** The utterance ended below `minSpeechMs` of voiced audio: noise, not speech. */
export interface SpeechDropped {
  type: "speech.dropped";
  timestampMs: number;
  startedAtMs: number;
}

export interface SpeechEnded {
  type: "speech.end";
  timestampMs: number;
  startedAtMs: number;
  reason: "silence" | "max_duration";
  samples: Float32Array;
}

export type VadSegmentEvent = SpeechStarted | SpeechConfirmed | SpeechDropped | SpeechEnded;

function durationMs(audio: OutputAudioFrame): number {
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new TypeError("audio sampleRate must be a positive finite number");
  }
  return audio.samples.length * 1_000 / audio.sampleRate;
}

export class BoundedAudioQueue {
  private readonly maxDurationMs: number;
  private readonly values: QueuedOutputAudio[] = [];
  private duration = 0;

  constructor(maxDurationMs: number) {
    if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
      throw new TypeError("maxQueuedAudioMs must be a positive finite number");
    }
    this.maxDurationMs = maxDurationMs;
  }

  get queuedDurationMs(): number {
    return this.duration;
  }

  get maxQueuedDurationMs(): number {
    return this.maxDurationMs;
  }

  get length(): number {
    return this.values.length;
  }

  push(value: QueuedOutputAudio): boolean {
    const nextDuration = this.duration + durationMs(value.audio);
    if (nextDuration > this.maxDurationMs) return false;
    this.values.push(value);
    this.duration = nextDuration;
    return true;
  }

  shift(): QueuedOutputAudio | undefined {
    const value = this.values.shift();
    if (!value) return undefined;
    this.duration = Math.max(0, this.duration - durationMs(value.audio));
    return value;
  }

  clear(): void {
    this.values.length = 0;
    this.duration = 0;
  }
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function joinSamples(parts: Float32Array[]): Float32Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/**
 * A segmenter as `listen` consumes one: audio frames in, segment events out. `push` may be
 * synchronous (energy) or asynchronous (a model inference per window); callers await it
 * either way.
 */
export interface VadSegmenter {
  push(samples: Float32Array, timestampMs: number): VadSegmentEvent[] | Promise<VadSegmentEvent[]>;
  reset(): void;
}

/**
 * The segmentation state machine shared by every detector: pre-roll retention, provisional
 * `speech.start`, confirmation after `minSpeechMs` of voiced audio, silence/max-duration
 * ends, and dropped bursts. Detectors differ only in how a piece of audio is judged voiced;
 * this lifecycle — the part the barge-in policy and the AEC gate certify — must not fork
 * per detector.
 */
export class VadSegmentAssembler {
  private readonly minSpeechSamples: number;
  private readonly silenceSamples: number;
  private readonly maxSpeechSamples: number;
  private readonly preRollSamples: number;
  private readonly preRoll: Float32Array[] = [];
  private readonly speech: Float32Array[] = [];
  private speaking = false;
  private confirmed = false;
  private speechSamples = 0;
  private voicedSamples = 0;
  private silenceSamplesSeen = 0;
  private startedAtMs = 0;

  constructor(options: Omit<VadSegmenterOptions, "threshold">) {
    if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0) {
      throw new TypeError("VAD sampleRate must be a positive finite number");
    }
    const milliseconds = (value: number | undefined, fallback: number, name: string): number => {
      const resolved = value ?? fallback;
      if (!Number.isFinite(resolved) || resolved < 0) throw new TypeError(`VAD ${name} must be a non-negative finite number`);
      return Math.round(options.sampleRate * resolved / 1_000);
    };
    this.minSpeechSamples = milliseconds(options.minSpeechMs, 250, "minSpeechMs");
    this.silenceSamples = milliseconds(options.silenceMs, 650, "silenceMs");
    this.maxSpeechSamples = milliseconds(options.maxSpeechMs, 15_000, "maxSpeechMs");
    this.preRollSamples = milliseconds(options.preRollMs, 250, "preRollMs");
    if (this.maxSpeechSamples === 0) throw new TypeError("VAD maxSpeechMs must be greater than zero");
  }

  /** `level` is embedded in `speech.start` as `rms`: an energy for the RMS detector, a probability for a model. */
  push(samples: Float32Array, timestampMs: number, voiced: boolean, level: number): VadSegmentEvent[] {
    if (samples.length === 0) return [];
    if (!this.speaking) {
      if (!voiced) {
        this.pushPreRoll(samples);
        return [];
      }
      // The triggering audio enters the utterance once, through append below. Adding it to
      // the pre-roll first duplicated it: the pre-roll copy and the appended copy both
      // landed in the segment, giving ASR a stuttered onset.
      this.speaking = true;
      this.startedAtMs = timestampMs;
      this.speech.push(...this.preRoll);
      this.speechSamples = this.preRoll.reduce((total, frame) => total + frame.length, 0);
      this.voicedSamples = 0;
      this.silenceSamplesSeen = 0;
      this.preRoll.length = 0;
      return [
        { type: "speech.start", timestampMs, rms: level },
        ...this.append(samples, timestampMs, true),
      ];
    }
    return this.append(samples, timestampMs, voiced);
  }

  reset(): void {
    this.preRoll.length = 0;
    this.speech.length = 0;
    this.speaking = false;
    this.confirmed = false;
    this.speechSamples = 0;
    this.voicedSamples = 0;
    this.silenceSamplesSeen = 0;
    this.startedAtMs = 0;
  }

  private append(samples: Float32Array, timestampMs: number, voiced: boolean): VadSegmentEvent[] {
    this.speech.push(samples);
    this.speechSamples += samples.length;
    if (voiced) {
      this.voicedSamples += samples.length;
      this.silenceSamplesSeen = 0;
    } else {
      this.silenceSamplesSeen += samples.length;
    }
    const events: VadSegmentEvent[] = [];
    if (!this.confirmed && this.voicedSamples >= this.minSpeechSamples) {
      this.confirmed = true;
      events.push({ type: "speech.confirmed", timestampMs, startedAtMs: this.startedAtMs });
    }
    const reason = this.speechSamples >= this.maxSpeechSamples
      ? "max_duration"
      : this.silenceSamplesSeen >= this.silenceSamples ? "silence" : undefined;
    if (!reason) return events;
    if (this.confirmed) {
      events.push({
        type: "speech.end",
        timestampMs,
        startedAtMs: this.startedAtMs,
        reason,
        samples: joinSamples(this.speech),
      });
    } else {
      // Ended below minSpeechMs of voiced audio. Without this event, a consumer that acted
      // on speech.start has no way to learn the sound was never speech.
      events.push({ type: "speech.dropped", timestampMs, startedAtMs: this.startedAtMs });
    }
    this.reset();
    return events;
  }

  private pushPreRoll(samples: Float32Array): void {
    if (this.preRollSamples === 0) return;
    this.preRoll.push(samples);
    let total = this.preRoll.reduce((sum, frame) => sum + frame.length, 0);
    while (total > this.preRollSamples) {
      const first = this.preRoll.shift();
      if (!first) break;
      total -= first.length;
    }
  }
}

export class EnergyVadSegmenter implements VadSegmenter {
  private readonly assembler: VadSegmentAssembler;
  private readonly threshold: number;

  constructor(options: VadSegmenterOptions) {
    const threshold = options.threshold ?? 0.01;
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new TypeError("VAD threshold must be a non-negative finite number");
    }
    this.threshold = threshold;
    this.assembler = new VadSegmentAssembler(options);
  }

  push(samples: Float32Array, timestampMs: number): VadSegmentEvent[] {
    const level = rms(samples);
    return this.assembler.push(samples, timestampMs, level >= this.threshold, level);
  }

  reset(): void {
    this.assembler.reset();
  }
}

/**
 * A model that scores fixed-size 16kHz windows with a speech probability. The Silero VAD
 * ONNX model is the production implementation; tests inject a scripted one. Models are
 * stateful across windows (Silero carries an RNN state), hence `reset`.
 */
export interface SpeechProbabilityModel {
  /** Window length the model requires, in samples at 16kHz. Silero v5 uses 512 (32ms). */
  readonly windowSamples: number;
  process(window: Float32Array): number | Promise<number>;
  reset(): void;
}

export interface SileroVadOptions {
  model: SpeechProbabilityModel;
  /** Probability at or above which an idle stream turns voiced. Silero's recommended default. */
  startProbability?: number;
  /** Probability below which a voiced stream turns silent — hysteresis against flutter. */
  endProbability?: number;
  /**
   * RMS below which a window is unvoiced without consulting the model. Measured necessity,
   * not an optimization: residual echo after cancellation IS quiet speech — the agent's own
   * leaked voice — and a good speech model recognizes it where an energy threshold ignores
   * it. Rescoring the certified AEC-gate captures showed silero confirming self-interruptions
   * on residual echo the energy detector never saw. The gate also skips inference on
   * silence. Set 0 to disable (headset routes with no echo path).
   */
  minLevel?: number;
  minSpeechMs?: number;
  silenceMs?: number;
  maxSpeechMs?: number;
  preRollMs?: number;
}

const sileroSampleRate = 16_000;

/**
 * Silero-backed segmenter with the same contract and the same certified segment lifecycle
 * as `EnergyVadSegmenter`. It buffers arbitrary capture frames into the model's fixed
 * windows and classifies each window with hysteresis: a window must clear
 * `startProbability` to open speech but only fall below `endProbability` to leave it.
 */
export class SileroVadSegmenter implements VadSegmenter {
  private readonly assembler: VadSegmentAssembler;
  private readonly model: SpeechProbabilityModel;
  private readonly startProbability: number;
  private readonly endProbability: number;
  private readonly minLevel: number;
  private readonly pending: Float32Array[] = [];
  private pendingSamples = 0;
  private anchorMs: number | undefined;
  private consumedSamples = 0;
  private voiced = false;

  constructor(options: SileroVadOptions) {
    const start = options.startProbability ?? 0.5;
    const end = options.endProbability ?? 0.35;
    if (!Number.isFinite(start) || start <= 0 || start > 1) {
      throw new TypeError("VAD startProbability must be within (0, 1]");
    }
    if (!Number.isFinite(end) || end < 0 || end > start) {
      throw new TypeError("VAD endProbability must be within [0, startProbability]");
    }
    if (!Number.isInteger(options.model.windowSamples) || options.model.windowSamples <= 0) {
      throw new TypeError("VAD model windowSamples must be a positive integer");
    }
    const minLevel = options.minLevel ?? 0.01;
    if (!Number.isFinite(minLevel) || minLevel < 0) {
      throw new TypeError("VAD minLevel must be a non-negative finite number");
    }
    this.model = options.model;
    this.startProbability = start;
    this.endProbability = end;
    this.minLevel = minLevel;
    this.assembler = new VadSegmentAssembler({ ...options, sampleRate: sileroSampleRate });
  }

  async push(samples: Float32Array, timestampMs: number): Promise<VadSegmentEvent[]> {
    if (samples.length === 0) return [];
    if (this.anchorMs === undefined) {
      this.anchorMs = timestampMs;
      this.consumedSamples = 0;
    }
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    const events: VadSegmentEvent[] = [];
    while (this.pendingSamples >= this.model.windowSamples) {
      // The window's timestamp is derived from the sample count, not the arrival clock, so
      // it stays aligned with the frame timestamps the caller derives the same way.
      const windowStartMs = this.anchorMs + 1_000 * this.consumedSamples / sileroSampleRate;
      const window = this.takeWindow();
      this.consumedSamples += window.length;
      if (rms(window) < this.minLevel) {
        this.voiced = false;
        events.push(...this.assembler.push(window, windowStartMs, false, 0));
        continue;
      }
      const probability = await this.model.process(window);
      this.voiced = probability >= (this.voiced ? this.endProbability : this.startProbability);
      events.push(...this.assembler.push(window, windowStartMs, this.voiced, probability));
    }
    return events;
  }

  reset(): void {
    this.assembler.reset();
    this.model.reset();
    this.pending.length = 0;
    this.pendingSamples = 0;
    this.anchorMs = undefined;
    this.consumedSamples = 0;
    this.voiced = false;
  }

  private takeWindow(): Float32Array {
    const window = new Float32Array(this.model.windowSamples);
    let filled = 0;
    while (filled < window.length) {
      const head = this.pending[0] as Float32Array;
      const take = Math.min(head.length, window.length - filled);
      window.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(take);
    }
    this.pendingSamples -= window.length;
    return window;
  }
}

interface ActiveTurn extends DuplexTurn {
  controller: AbortController;
  startedAtMs: number;
  timing: Partial<Record<TurnTimingPoint, number>>;
  reopenable: boolean;
}

function defaultTurnId(): string {
  return crypto.randomUUID();
}

export class DuplexSession {
  readonly sessionId: string;
  readonly output: BoundedAudioQueue;
  private readonly now: () => number;
  private readonly newTurnId: () => string;
  private readonly onEvent: ((event: DuplexEvent) => void) | undefined;
  private sequence = 0;
  private active: ActiveTurn | undefined;
  private currentState: DuplexState = "idle";

  constructor(options: DuplexSessionOptions = {}) {
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.output = new BoundedAudioQueue(options.maxQueuedAudioMs ?? 2_000);
    this.now = options.now ?? Date.now;
    this.newTurnId = options.newTurnId ?? defaultTurnId;
    this.onEvent = options.onEvent;
  }

  get state(): DuplexState {
    return this.currentState;
  }

  get currentTurn(): DuplexTurn | undefined {
    return this.active;
  }

  snapshot(): DuplexSessionSnapshot {
    return {
      sessionId: this.sessionId,
      state: this.currentState,
      lastSequence: this.sequence,
      queuedAudioMs: this.output.queuedDurationMs,
      ...(this.active === undefined ? {} : { currentTurnId: this.active.id }),
    };
  }

  start(): void {
    this.transition("listening");
  }

  startUserSpeech(): DuplexTurn {
    this.requireState("listening", "speech_started", "finalizing", "thinking", "speaking");
    if (this.active) this.interrupt("barge_in");
    const controller = new AbortController();
    const turn: ActiveTurn = {
      id: this.newTurnId(),
      revision: 0,
      signal: controller.signal,
      controller,
      startedAtMs: this.now(),
      timing: {},
      reopenable: false,
    };
    this.active = turn;
    this.transition("speech_started");
    this.emit({ type: "turn.started", turnId: turn.id });
    // A snapshot, not the live turn: reopening swaps the live signal for a fresh one, and a
    // handle that silently followed it would let superseded work escape its abort.
    return { id: turn.id, revision: turn.revision, signal: turn.signal };
  }

  finalizeUserSpeech(turnId: string): boolean {
    if (!this.isCurrent(turnId) || this.currentState !== "speech_started") return false;
    if (this.active) this.active.reopenable = false;
    this.mark(turnId, "vad_end");
    this.transition("finalizing");
    this.emit({ type: "vad.end", turnId });
    return true;
  }

  /**
   * Finalize speculatively: the turn proceeds to processing exactly as after
   * `finalizeUserSpeech`, but stays reopenable until it starts speaking. The kernel owns
   * only the mechanism — whether resumed speech is recent enough to reopen rather than
   * start a new turn is the turn-taking policy's decision.
   */
  softFinalizeUserSpeech(turnId: string): boolean {
    if (!this.isCurrent(turnId) || this.currentState !== "speech_started") return false;
    if (this.active) this.active.reopenable = true;
    this.mark(turnId, "vad_end");
    this.transition("finalizing");
    this.emit({ type: "vad.end", turnId });
    return true;
  }

  /**
   * Resume a soft-ended turn because the user kept talking. Aborts the superseded
   * revision's in-flight work, returns a fresh handle for the same turn, and restarts the
   * timing profile — the reply the user will actually hear is the one answering their
   * complete utterance. Refused once the turn is speaking: that is the commitment point,
   * and interrupting playback is the barge-in path, not a reopen.
   */
  reopen(turnId: string): DuplexTurn | undefined {
    const active = this.active;
    if (!active || active.id !== turnId || !active.reopenable) return undefined;
    if (this.currentState !== "finalizing" && this.currentState !== "thinking") return undefined;
    active.controller.abort("reopened");
    active.controller = new AbortController();
    active.signal = active.controller.signal;
    active.revision += 1;
    active.timing = {};
    this.transition("speech_started");
    this.emit({ type: "turn.reopened", turnId, revision: active.revision });
    return { id: active.id, revision: active.revision, signal: active.signal };
  }

  startThinking(turnId: string): boolean {
    if (!this.isCurrent(turnId) || this.currentState !== "finalizing") return false;
    this.mark(turnId, "thinking");
    this.transition("thinking");
    return true;
  }

  startSpeaking(turnId: string): boolean {
    if (!this.isCurrent(turnId) || this.currentState !== "thinking") return false;
    // Commitment point: from here the reply is being delivered, and resumed user speech is
    // a barge-in for the interruption policy, never a reopen.
    if (this.active) this.active.reopenable = false;
    this.mark(turnId, "speaking");
    this.transition("speaking");
    return true;
  }

  /**
   * Stamp a timing point on the current turn. State transitions stamp their own points;
   * engine milestones (ASR done, first TTS audio, first playback write) are marked by the
   * loop that awaits them. First write wins, and stale turns are rejected like any other
   * stale work.
   */
  mark(turnId: string, point: TurnTimingPoint): boolean {
    const active = this.active;
    if (!active || active.id !== turnId) return false;
    active.timing[point] ??= Math.max(0, this.now() - active.startedAtMs);
    return true;
  }

  queueOutput(turnId: string, audio: OutputAudioFrame): boolean {
    if (!this.isCurrent(turnId) || this.currentState !== "speaking") {
      this.emit({
        type: "audio.discarded",
        turnId,
        queuedMs: this.output.queuedDurationMs,
        maxQueuedMs: this.output.maxQueuedDurationMs,
      });
      return false;
    }
    if (this.output.push({ turnId, audio })) return true;
    this.emit({
      type: "audio.queue_overflow",
      turnId,
      queuedMs: this.output.queuedDurationMs,
      maxQueuedMs: this.output.maxQueuedDurationMs,
    });
    return false;
  }

  complete(turnId: string): boolean {
    if (!this.isCurrent(turnId) || this.currentState !== "speaking") return false;
    this.emitTiming("completed");
    this.emit({ type: "turn.completed", turnId });
    this.active = undefined;
    this.transition("listening");
    return true;
  }

  /**
   * Record that a provisional interruption turned out not to be speech. Playback was never
   * stopped — the point of confirming first — so this only annotates the surviving turn.
   */
  recordFalseBargeIn(): boolean {
    if (this.currentState !== "speaking" || !this.active) return false;
    this.emit({ type: "turn.false_barge_in", turnId: this.active.id });
    return true;
  }

  interrupt(reason: InterruptionReason = "cancel"): boolean {
    const active = this.active;
    if (!active) return false;
    active.controller.abort(reason);
    this.output.clear();
    this.emitTiming(reason);
    this.emit({ type: "turn.interrupted", turnId: active.id, reason });
    this.active = undefined;
    if (this.currentState !== "closed" && this.currentState !== "reconfiguring") {
      this.transition("listening");
    }
    return true;
  }

  reconfigure(): void {
    this.requireState("listening", "speech_started", "finalizing", "thinking", "speaking");
    this.interrupt("reconfigure");
    this.transition("reconfiguring");
  }

  resumeAfterReconfigure(): void {
    this.requireState("reconfiguring");
    this.transition("listening");
  }

  close(): void {
    if (this.currentState === "closed") return;
    this.interrupt("shutdown");
    this.output.clear();
    this.transition("closed");
  }

  private emitTiming(endReason: "completed" | InterruptionReason): void {
    const active = this.active;
    if (!active) return;
    this.emit({ type: "turn.timing", turnId: active.id, endReason, offsetsMs: { ...active.timing } });
  }

  private isCurrent(turnId: string): boolean {
    return this.active?.id === turnId;
  }

  private requireState(...allowed: DuplexState[]): void {
    if (!allowed.includes(this.currentState)) {
      throw new TypeError(`cannot perform operation while session is ${this.currentState}`);
    }
  }

  private transition(state: DuplexState): void {
    const previous = this.currentState;
    if (previous === state) return;
    this.currentState = state;
    this.emit({ type: "session.state", state, previous });
  }

  private emit(payload: DuplexEventPayload): void {
    const event: DuplexEvent = {
      ...payload,
      sequence: ++this.sequence,
      sessionId: this.sessionId,
      timestampMs: this.now(),
    };
    this.onEvent?.(event);
  }
}
