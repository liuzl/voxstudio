import { describe, expect, test } from "bun:test";
import {
  FakeAgentExecutor,
  type AgentEvent,
  type AgentExecutor,
  type AgentInput,
  type AgentRun,
  type ScriptedAgentEventPayload,
} from "@voxstudio/agent-executor";
import {
  AgentRunController,
  type AgentSpeechKind,
  type AgentSpeechSink,
} from "./agent-run-controller";

const context = { runId: "run-1", sessionId: "session-1", userId: "user-1" };
const input: AgentInput = { inputId: "input-1", text: "do the task" };

class RecordingSink implements AgentSpeechSink {
  readonly spoken: { kind: AgentSpeechKind; text: string; atMs: number }[] = [];
  stopCalls = 0;
  stopAtMs = -1;
  cancelQueuedCalls = 0;

  constructor(private readonly clock: { now: number }) {}

  speak(kind: AgentSpeechKind, text: string): void {
    this.spoken.push({ kind, text, atMs: this.clock.now });
  }

  cancelQueued(): void {
    this.cancelQueuedCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
    this.stopAtMs = this.clock.now;
  }
}

interface Harness {
  clock: { now: number };
  executor: FakeAgentExecutor;
  run: ReturnType<FakeAgentExecutor["start"]>;
  sink: RecordingSink;
  controller: AgentRunController;
  terminal: ("completed" | "failed" | "cancelled")[];
  events: AgentEvent[];
}

function harness(milestoneIntervalMs = 5_000): Harness {
  const clock = { now: 1_000 };
  const executor = new FakeAgentExecutor(() => clock.now);
  const sink = new RecordingSink(clock);
  const terminal: Harness["terminal"] = [];
  const events: AgentEvent[] = [];
  const controller = new AgentRunController({
    executor,
    speech: sink,
    input,
    context,
    now: () => clock.now,
    milestoneIntervalMs,
    onEvent: event => events.push(event),
    onTerminal: state => terminal.push(state),
  });
  return {
    clock,
    executor,
    run: executor.runs[0]!,
    sink,
    controller,
    terminal,
    events,
  };
}

/** Drains the microtask-driven event loop of the controller. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

function emit(run: Harness["run"], payload: ScriptedAgentEventPayload): void {
  if (run.emit(payload) === false) throw new TypeError("fake run refused the event");
}

describe("agent run controller (Phase A gateway/player composition)", () => {
  test("barge-in stops audible speech within 150ms and never aborts execution", async () => {
    const h = harness();
    await flush();
    expect(h.controller.lifecycle.execution).toBe("running");
    expect(h.controller.stopSpeech()).toBe(false); // nothing audible yet

    emit(h.run, { type: "tool.started", invocationId: "call-1", name: "search" });
    await flush();
    expect(h.sink.spoken).toEqual([
      { kind: "milestone", text: "正在search…", atMs: 1_000 },
    ]);

    h.clock.now += 50;
    expect(h.controller.stopSpeech()).toBe(true);
    expect(h.sink.stopCalls).toBe(1);
    expect(h.sink.stopAtMs - 1_000).toBe(50); // well inside the 150ms gate
    expect(h.controller.lifecycle.speech).toBe("silent");
    expect(h.controller.run.state).toBe("running"); // hands untouched

    // Steering still works after the barge-in.
    await h.controller.steer({ inputId: "input-2", text: "keep going" });
    expect(h.controller.lifecycle.execution).toBe("running");
    expect(h.run.steering).toEqual([{ inputId: "input-2", text: "keep going" }]);

    // The mouth may speak again for the same run.
    emit(h.run, { type: "text.final", text: "结果在这里" });
    await flush();
    expect(h.sink.spoken.at(-1)).toEqual({ kind: "answer", text: "结果在这里", atMs: 1_050 });
  });

  test("explicit cancellation emits exactly one terminal event and drops zombies", async () => {
    const h = harness();
    await flush();
    emit(h.run, { type: "text.final", text: "开始处理" });
    await flush();
    expect(h.sink.spoken).toHaveLength(1);

    await h.controller.cancel("user_cancelled");
    await h.controller.drained;
    expect(h.run.state).toBe("cancelled");
    expect(h.controller.lifecycle.execution).toBe("cancelled");
    expect(h.terminal).toEqual(["cancelled"]);
    expect(h.sink.stopCalls).toBe(1);
    expect(h.events.at(-1)?.type).toBe("run.cancelled");

    // Duplicate cancel is a no-op, and late events are dead on arrival.
    await h.controller.cancel("again");
    expect(h.sink.stopCalls).toBe(1);
    const spoken = h.sink.spoken.length;
    expect(h.run.emit({ type: "text.delta", text: "zombie" })).toBe(false);
    await flush();
    expect(h.sink.spoken.length).toBe(spoken);
    expect(h.events.every(event => event.type !== "text.delta")).toBe(true);
  });

  test("events queued while cancel is in flight are dropped and cancel wins", async () => {
    const h = harness();
    await flush();

    // The executor emitted a final answer just before it processed the cancel;
    // the event sits in the queue while requestCancel flips the run to cancelling.
    emit(h.run, { type: "text.final", text: "stale answer" });
    await h.controller.cancel("user_cancelled");
    await h.controller.drained;

    expect(h.terminal).toEqual(["cancelled"]);
    expect(h.run.state).toBe("cancelled");
    expect(h.controller.lifecycle.execution).toBe("cancelled");
    expect(h.sink.stopCalls).toBe(1);
    // Stale text was never narrated and never fanned out.
    expect(h.sink.spoken).toEqual([]);
    expect(h.events.some(event => event.type === "text.final")).toBe(false);
    expect(h.events.at(-1)?.type).toBe("run.cancelled");
  });

  test("a terminal event that races cancel still reports the user's cancellation", async () => {
    const h = harness();
    await flush();

    // The executor failed and emitted run.failed, but the controller consumed
    // the user's cancel first; the explicit cancel owns the terminal outcome.
    h.run.fail("engine_timeout", "引擎超时");
    await h.controller.cancel("user_cancelled");
    await h.controller.drained;

    expect(h.terminal).toEqual(["cancelled"]);
    expect(h.controller.lifecycle.execution).toBe("cancelled");
    expect(h.sink.spoken).toEqual([]);
    expect(h.events.some(event => event.type === "run.failed")).toBe(false);
    expect(h.sink.stopCalls).toBe(1);
  });

  test("duplicate cancel during the cancelling window is a no-op", async () => {
    const h = harness();
    await flush();

    const first = h.controller.cancel("first");
    const second = h.controller.cancel("second"); // lands before the run drained
    await Promise.all([first, second]);
    await h.controller.drained;

    expect(h.terminal).toEqual(["cancelled"]);
    expect(h.sink.stopCalls).toBe(1);
  });

  test("endSession after cancel is idempotent and still reports cancellation once", async () => {
    const h = harness();
    await flush();

    await h.controller.cancel("user_cancelled");
    await h.controller.endSession("hang_up");

    expect(h.terminal).toEqual(["cancelled"]);
    expect(h.run.state).toBe("cancelled");
    expect(h.sink.stopCalls).toBe(1);
  });

  test("steering is ordered, at-most-once, and rejected after terminal", async () => {
    const h = harness();
    await flush();
    await h.controller.steer({ inputId: "input-2", text: "a" });
    await h.controller.steer({ inputId: "input-2", text: "a" });
    expect(h.run.steering).toHaveLength(1);
    await h.controller.steer({ inputId: "input-3", text: "b" });
    expect(h.run.steering.map(entry => entry.inputId)).toEqual(["input-2", "input-3"]);

    h.run.complete();
    await h.controller.drained;
    expect(h.terminal).toEqual(["completed"]);
    await expect(h.controller.steer({ inputId: "input-4", text: "late" })).rejects.toThrow(
      "terminal",
    );
  });

  test("superseded milestone narration is not heard after steering", async () => {
    const h = harness();
    await flush();
    emit(h.run, { type: "tool.progress", invocationId: "call-1", summary: "处理中 10%" });
    await flush();
    expect(h.sink.spoken).toHaveLength(1);

    h.clock.now += 1_000;
    emit(h.run, { type: "tool.progress", invocationId: "call-1", summary: "处理中 50%" });
    await flush();
    expect(h.sink.spoken).toHaveLength(1); // staged, not audible

    h.controller.stopSpeech();
    await h.controller.steer({ inputId: "input-2", text: "改成只处理今天的数据" });
    emit(h.run, { type: "text.final", text: "好的，只处理今天的数据。" });
    await flush();
    expect(h.sink.spoken.map(entry => entry.text)).toEqual([
      "处理中 10%",
      "好的，只处理今天的数据。",
    ]);
  });

  test("milestones coalesce to one audible update per interval and answers preempt them", async () => {
    const h = harness();
    await flush();
    emit(h.run, { type: "tool.progress", invocationId: "call-1", summary: "A" });
    await flush();
    h.clock.now += 1_500;
    emit(h.run, { type: "tool.progress", invocationId: "call-1", summary: "B" });
    await flush();
    h.clock.now += 500;
    emit(h.run, { type: "tool.progress", invocationId: "call-1", summary: "C" });
    await flush();
    expect(h.sink.spoken.map(entry => entry.text)).toEqual(["A"]); // B replaced by C

    h.clock.now += 3_000; // 5000ms since the last audible update
    emit(h.run, { type: "tool.progress", invocationId: "call-1", summary: "D" });
    await flush();
    expect(h.sink.spoken.map(entry => entry.text)).toEqual(["A", "C"]);

    emit(h.run, { type: "text.final", text: "完成" });
    await flush();
    expect(h.sink.spoken.map(entry => entry.text)).toEqual(["A", "C", "完成"]);
    expect(h.sink.spoken.at(-1)?.kind).toBe("answer");
  });

  test("failure narration is immediate and never gated by the interval", async () => {
    const h = harness();
    await flush();
    emit(h.run, { type: "tool.progress", invocationId: "call-1", summary: "仍在处理" });
    await flush();
    h.clock.now += 1_000;
    emit(h.run, { type: "tool.progress", invocationId: "call-1", summary: "遇到阻力" });
    await flush();
    expect(h.sink.spoken).toHaveLength(1); // second update staged

    h.run.fail("engine_timeout", "引擎超时");
    await h.controller.drained;
    expect(h.terminal).toEqual(["failed"]);
    expect(h.controller.lifecycle.execution).toBe("failed");
    expect(h.sink.spoken.map(entry => entry.text)).toEqual([
      "仍在处理",
      "任务失败：引擎超时",
    ]);
    expect(h.sink.spoken.at(-1)?.kind).toBe("failure");
  });

  test("endSession cancels the run with bounded cleanup and one terminal report", async () => {
    const h = harness();
    await flush();
    emit(h.run, { type: "tool.progress", invocationId: "call-1", summary: "工作中" });
    await flush();
    await h.controller.endSession("hang_up");
    expect(h.run.state).toBe("cancelled");
    expect(h.terminal).toEqual(["cancelled"]);
    expect(h.controller.lifecycle.execution).toBe("cancelled");
    expect(h.sink.stopCalls).toBe(1);
  });

  test("a broken event stream releases speech and reports failed exactly once", async () => {
    const clock = { now: 1_000 };
    const sink = new RecordingSink(clock);
    const terminal: ("completed" | "failed" | "cancelled")[] = [];
    const broken: AgentExecutor = {
      start(_input, runContext) {
        const run = {
          context: runContext,
          state: "running",
          events: {
            [Symbol.asyncIterator]() {
              return { next: async () => { throw new TypeError("stream broke"); } };
            },
          },
          steer: async () => {},
          cancel: async () => {},
          close: async () => {},
        } as unknown as AgentRun;
        return run;
      },
    };
    const controller = new AgentRunController({
      executor: broken,
      speech: sink,
      input,
      context,
      now: () => clock.now,
      onTerminal: state => terminal.push(state),
    });
    await controller.drained;
    expect(terminal).toEqual(["failed"]);
    expect(controller.lifecycle.execution).toBe("failed");
    expect(sink.stopCalls).toBe(1);
  });

  test("an event stream that ends without a terminal event fails closed", async () => {
    const clock = { now: 1_000 };
    const sink = new RecordingSink(clock);
    const terminal: ("completed" | "failed" | "cancelled")[] = [];
    const incomplete: AgentExecutor = {
      start(_input, runContext) {
        return {
          context: runContext,
          state: "running",
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "run.started", runId: runContext.runId, sequence: 1, timestampMs: 1_000 };
            },
          },
          steer: async () => {},
          cancel: async () => {},
          close: async () => {},
        } as AgentRun;
      },
    };
    const controller = new AgentRunController({
      executor: incomplete,
      speech: sink,
      input,
      context,
      onTerminal: state => terminal.push(state),
    });

    await controller.drained;
    expect(controller.lifecycle.execution).toBe("failed");
    expect(terminal).toEqual(["failed"]);
    expect(sink.stopCalls).toBe(1);
  });

  test("session shutdown returns at its deadline when an executor wedges", async () => {
    const clock = { now: 1_000 };
    const sink = new RecordingSink(clock);
    const terminal: ("completed" | "failed" | "cancelled")[] = [];
    let cancelCalls = 0;
    let closeCalls = 0;
    const never = new Promise<void>(() => {});
    const wedged: AgentExecutor = {
      start(_input, runContext) {
        let deliveredStart = false;
        return {
          context: runContext,
          state: "running",
          events: {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  if (!deliveredStart) {
                    deliveredStart = true;
                    return { done: false, value: {
                      type: "run.started", runId: runContext.runId, sequence: 1, timestampMs: 1_000,
                    } };
                  }
                  return never.then(() => ({ done: true as const, value: undefined }));
                },
              };
            },
          },
          steer: async () => {},
          cancel: async () => { cancelCalls += 1; await never; },
          close: async () => { closeCalls += 1; await never; },
        } as AgentRun;
      },
    };
    const controller = new AgentRunController({
      executor: wedged,
      speech: sink,
      input,
      context,
      drainTimeoutMs: 10,
      onTerminal: state => terminal.push(state),
    });
    await flush();

    void controller.cancel("user_cancelled");
    await flush();
    await controller.endSession();
    expect(controller.lifecycle.execution).toBe("failed");
    expect(terminal).toEqual(["failed"]);
    expect(cancelCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(sink.stopCalls).toBe(1);
  });
});
