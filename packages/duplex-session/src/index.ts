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
  type: "turn.started" | "vad.end" | "turn.interrupted" | "turn.completed";
  turnId: string;
  reason?: InterruptionReason;
}

export interface DuplexQueueEvent {
  type: "audio.queue_overflow" | "audio.discarded";
  turnId: string;
  queuedMs: number;
  maxQueuedMs: number;
}

export type DuplexEventPayload = DuplexStateEvent | DuplexTurnEvent | DuplexQueueEvent;

export type DuplexEvent = DuplexEventPayload & {
  sequence: number;
  sessionId: string;
  timestampMs: number;
};

export interface DuplexTurn {
  id: string;
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

export interface SpeechEnded {
  type: "speech.end";
  timestampMs: number;
  startedAtMs: number;
  reason: "silence" | "max_duration";
  samples: Float32Array;
}

export type VadSegmentEvent = SpeechStarted | SpeechEnded;

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

export class EnergyVadSegmenter {
  private readonly sampleRate: number;
  private readonly threshold: number;
  private readonly minSpeechSamples: number;
  private readonly silenceSamples: number;
  private readonly maxSpeechSamples: number;
  private readonly preRollSamples: number;
  private readonly preRoll: Float32Array[] = [];
  private readonly speech: Float32Array[] = [];
  private speaking = false;
  private speechSamples = 0;
  private voicedSamples = 0;
  private silenceSamplesSeen = 0;
  private startedAtMs = 0;

  constructor(options: VadSegmenterOptions) {
    if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0) {
      throw new TypeError("VAD sampleRate must be a positive finite number");
    }
    const threshold = options.threshold ?? 0.01;
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new TypeError("VAD threshold must be a non-negative finite number");
    }
    const milliseconds = (value: number | undefined, fallback: number, name: string): number => {
      const resolved = value ?? fallback;
      if (!Number.isFinite(resolved) || resolved < 0) throw new TypeError(`VAD ${name} must be a non-negative finite number`);
      return Math.round(options.sampleRate * resolved / 1_000);
    };
    this.sampleRate = options.sampleRate;
    this.threshold = threshold;
    this.minSpeechSamples = milliseconds(options.minSpeechMs, 250, "minSpeechMs");
    this.silenceSamples = milliseconds(options.silenceMs, 650, "silenceMs");
    this.maxSpeechSamples = milliseconds(options.maxSpeechMs, 15_000, "maxSpeechMs");
    this.preRollSamples = milliseconds(options.preRollMs, 250, "preRollMs");
    if (this.maxSpeechSamples === 0) throw new TypeError("VAD maxSpeechMs must be greater than zero");
  }

  push(samples: Float32Array, timestampMs: number): VadSegmentEvent[] {
    if (samples.length === 0) return [];
    const level = rms(samples);
    const voiced = level >= this.threshold;
    if (!this.speaking) {
      this.pushPreRoll(samples);
      if (!voiced) return [];
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
    const reason = this.speechSamples >= this.maxSpeechSamples
      ? "max_duration"
      : this.silenceSamplesSeen >= this.silenceSamples ? "silence" : undefined;
    if (!reason) return events;
    if (this.voicedSamples >= this.minSpeechSamples) {
      events.push({
        type: "speech.end",
        timestampMs,
        startedAtMs: this.startedAtMs,
        reason,
        samples: joinSamples(this.speech),
      });
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

interface ActiveTurn extends DuplexTurn {
  controller: AbortController;
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
    const turn: ActiveTurn = { id: this.newTurnId(), signal: controller.signal, controller };
    this.active = turn;
    this.transition("speech_started");
    this.emit({ type: "turn.started", turnId: turn.id });
    return turn;
  }

  finalizeUserSpeech(turnId: string): boolean {
    if (!this.isCurrent(turnId) || this.currentState !== "speech_started") return false;
    this.transition("finalizing");
    this.emit({ type: "vad.end", turnId });
    return true;
  }

  startThinking(turnId: string): boolean {
    if (!this.isCurrent(turnId) || this.currentState !== "finalizing") return false;
    this.transition("thinking");
    return true;
  }

  startSpeaking(turnId: string): boolean {
    if (!this.isCurrent(turnId) || this.currentState !== "thinking") return false;
    this.transition("speaking");
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
    this.emit({ type: "turn.completed", turnId });
    this.active = undefined;
    this.transition("listening");
    return true;
  }

  interrupt(reason: InterruptionReason = "cancel"): boolean {
    const active = this.active;
    if (!active) return false;
    active.controller.abort(reason);
    this.output.clear();
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
