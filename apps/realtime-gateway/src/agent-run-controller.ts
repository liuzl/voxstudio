/**
 * Agent-run composition for the gateway (Phase A, docs/voice-agent-roadmap.md §7).
 *
 * Owns the seams between one executor run and the audio surface. It enforces the
 * accepted lifecycle contract (docs/agent-lifecycle.md): speech never owns
 * execution, barge-in stops only the mouth, steering appends one input at most
 * once, explicit cancellation owns both scopes, and events after a terminal
 * state are dead on arrival. Events that race an explicit cancellation are
 * dropped in favor of the deterministic cancellation outcome.
 *
 * Slice 1 drives the deterministic fake executor only; a pi backend lands in
 * Phase C behind the same AgentExecutor boundary.
 */

import {
  AgentLifecycle,
  type AgentEvent,
  type AgentExecutor,
  type AgentInput,
  type AgentRun,
} from "@voxstudio/agent-executor";

export type AgentSpeechKind = "answer" | "milestone" | "failure";

/**
 * The speech side of agent mode, injected by the gateway session. The controller
 * owns scheduling and priority; the sink owns the audio surface (a real
 * implementation maps to queueAgentSpeech plus playback interruption).
 */
export interface AgentSpeechSink {
  /** Present text for narration. The sink owns queueing and playback. */
  speak(kind: AgentSpeechKind, text: string): void;
  /** Drop queued narration that has not started; current playback continues. */
  cancelQueued(): void;
  /** Stop current playback and drop everything queued (barge-in / cancel / end). */
  stop(): void;
}

export interface AgentRunContext {
  runId: string;
  sessionId: string;
  userId: string;
}

export interface AgentRunControllerOptions {
  executor: AgentExecutor;
  speech: AgentSpeechSink;
  input: AgentInput;
  context: AgentRunContext;
  now?: () => number;
  /** Minimum gap between audible milestone updates (docs/agent-lifecycle.md). */
  milestoneIntervalMs?: number;
  /** Text for a milestone-eligible event; undefined keeps it silent. */
  describeMilestone?(event: AgentEvent): string | undefined;
  /** Failure narration; default "任务失败：{message}". Never gated by the interval. */
  describeFailure?(event: Extract<AgentEvent, { type: "run.failed" }>): string;
  /** Protocol fan-out; invoked once per accepted event and never after terminal. */
  onEvent?(event: AgentEvent): void;
  /** Exactly one call when the run reaches a terminal state. */
  onTerminal?(state: "completed" | "failed" | "cancelled"): void;
}

const defaultMilestoneIntervalMs = 5_000;

function defaultMilestoneText(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "tool.started":
      return `正在${event.name}…`;
    case "tool.progress":
      return event.summary;
    default:
      // Artifacts are shown in the UI, not read aloud; completion is covered by
      // the run's final answer text. Keep those milestones silent by default.
      return undefined;
  }
}

function defaultFailureText(event: Extract<AgentEvent, { type: "run.failed" }>): string {
  return `任务失败：${event.message}`;
}

/**
 * Composes one executor run with the lifecycle, the speech sink, and the
 * protocol fan-out. All state transitions are checked; illegal ones throw.
 */
export class AgentRunController {
  readonly lifecycle = new AgentLifecycle();
  readonly run: AgentRun;
  /** Resolves when the run's event stream ended and the controller drained it. */
  readonly drained: Promise<void>;

  private readonly speech: AgentSpeechSink;
  private readonly now: () => number;
  private readonly milestoneIntervalMs: number;
  private readonly describeMilestone: (event: AgentEvent) => string | undefined;
  private readonly describeFailure: (event: Extract<AgentEvent, { type: "run.failed" }>) => string;
  private readonly onEvent: ((event: AgentEvent) => void) | undefined;
  private readonly onTerminal: ((state: "completed" | "failed" | "cancelled") => void) | undefined;

  private pendingMilestone: { text: string } | undefined;
  private lastAudibleAtMs = -Infinity;
  private terminal = false;
  private terminalReported = false;
  private resolveDrained!: () => void;

  constructor(options: AgentRunControllerOptions) {
    const { executor, speech, input, context } = options;
    this.speech = speech;
    this.now = options.now ?? Date.now;
    this.milestoneIntervalMs = options.milestoneIntervalMs ?? defaultMilestoneIntervalMs;
    this.describeMilestone = options.describeMilestone ?? defaultMilestoneText;
    this.describeFailure = options.describeFailure ?? defaultFailureText;
    this.onEvent = options.onEvent;
    this.onTerminal = options.onTerminal;
    this.drained = new Promise(resolve => { this.resolveDrained = resolve; });
    this.run = executor.start(input, context);
    void this.consume();
  }

  /**
   * Barge-in gate: stops the mouth only. Execution and committed tool calls keep
   * running. Returns false when nothing was audible.
   */
  stopSpeech(): boolean {
    if (!this.lifecycle.stopSpeech()) return false;
    this.speech.stop();
    this.pendingMilestone = undefined;
    this.lastAudibleAtMs = this.now();
    return true;
  }

  /** Append one user input to the live run; ordered and at most once. */
  async steer(input: AgentInput): Promise<void> {
    if (this.terminal) throw new TypeError("cannot steer a terminal run");
    this.lifecycle.beginSteering();
    this.speech.cancelQueued();
    this.pendingMilestone = undefined;
    try {
      await this.run.steer(input);
    } finally {
      if (this.lifecycle.execution === "steering") this.lifecycle.finishSteering();
    }
  }

  /** Explicit cancellation owns speech and execution; committed invocations survive. */
  async cancel(reason: string): Promise<void> {
    if (this.terminal || this.lifecycle.execution === "cancelling") return;
    if (!this.lifecycle.requestCancel()) return;
    this.speech.stop();
    this.pendingMilestone = undefined;
    this.lastAudibleAtMs = this.now();
    await this.run.cancel(reason);
  }

  /** Hang-up: Phase A policy cancels the session-scoped run with bounded cleanup. */
  async endSession(reason = "session_ended"): Promise<void> {
    if (!this.terminal && this.lifecycle.execution !== "cancelling" && this.lifecycle.requestCancel()) {
      this.speech.stop();
      this.pendingMilestone = undefined;
      this.lastAudibleAtMs = this.now();
    }
    if (!this.terminal) await this.run.cancel(reason).catch(() => {});
    await this.run.close().catch(() => {});
    await this.drained;
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.run.events) {
        this.accept(event);
      }
    } catch {
      // A broken executor must still release the audio surface and report a terminal.
      this.speech.stop();
      this.pendingMilestone = undefined;
      this.reportTerminal("failed");
    } finally {
      this.resolveDrained();
    }
  }

  private accept(event: AgentEvent): void {
    if (this.terminal) return; // zombie guard: late events never mutate the run
    if (this.lifecycle.execution === "cancelling") {
      // The user's explicit cancel owns the outcome. Events that raced it are
      // stale: drop them without fan-out or speech. The first terminal event
      // still reports the cancellation exactly once, so a misbehaving executor
      // cannot leave the run dangling between cancelling and cancelled.
      switch (event.type) {
        case "run.cancelled":
          this.onEvent?.(event);
          this.finishRun("cancelled");
          break;
        case "run.completed":
        case "run.failed":
          this.finishRun("cancelled");
          break;
        default:
          break;
      }
      return;
    }
    this.onEvent?.(event);
    switch (event.type) {
      case "run.started":
        this.lifecycle.startExecution();
        break;
      case "text.final":
        this.speakAnswer(event.text);
        break;
      case "tool.started":
      case "tool.progress":
      case "tool.completed":
      case "artifact.created": {
        this.flushPendingMilestone();
        const text = this.describeMilestone(event);
        if (text !== undefined) this.speakMilestone(text);
        break;
      }
      case "run.completed": {
        this.flushPendingMilestone();
        const text = this.describeMilestone(event);
        if (text !== undefined) {
          // Terminal narration is heard even inside the milestone interval.
          this.speech.cancelQueued();
          this.pendingMilestone = undefined;
          this.deliver("milestone", text);
        }
        this.finishRun("completed");
        break;
      }
      case "run.failed":
        this.speech.cancelQueued();
        this.pendingMilestone = undefined;
        this.deliver("failure", this.describeFailure(event));
        this.lifecycle.finish("failed");
        this.reportTerminal("failed");
        break;
      case "run.cancelled":
        this.finishRun("cancelled");
        break;
      default:
        break;
    }
  }

  private speakAnswer(text: string): void {
    this.speech.cancelQueued();
    this.pendingMilestone = undefined;
    this.deliver("answer", text);
  }

  private speakMilestone(text: string): void {
    const now = this.now();
    if (now - this.lastAudibleAtMs >= this.milestoneIntervalMs) {
      this.deliver("milestone", text, now);
      return;
    }
    // Staged until the interval elapses; a newer milestone replaces this one.
    this.pendingMilestone = { text };
  }

  private flushPendingMilestone(): void {
    if (this.pendingMilestone === undefined) return;
    const now = this.now();
    if (now - this.lastAudibleAtMs < this.milestoneIntervalMs) return;
    const text = this.pendingMilestone.text;
    this.pendingMilestone = undefined;
    this.deliver("milestone", text, now);
  }

  private deliver(kind: AgentSpeechKind, text: string, atMs = this.now()): void {
    if (this.terminal) return;
    if (this.lifecycle.speech === "silent") this.lifecycle.startSpeech();
    this.speech.speak(kind, text);
    this.lastAudibleAtMs = atMs;
  }

  private finishRun(state: "completed" | "cancelled"): void {
    if (this.terminal) return;
    this.pendingMilestone = undefined;
    this.lifecycle.finish(state);
    this.reportTerminal(state);
  }

  private reportTerminal(state: "completed" | "failed" | "cancelled"): void {
    if (this.terminalReported) return;
    this.terminalReported = true;
    this.terminal = true;
    this.pendingMilestone = undefined;
    this.onTerminal?.(state);
  }
}
