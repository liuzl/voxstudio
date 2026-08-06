import { describe, expect, test } from "bun:test";
import {
  AgentLifecycle,
  FakeAgentExecutor,
  FakeToolRunner,
  InvocationLedger,
  ToolPolicyError,
  validateToolPolicy,
  type AgentEvent,
  type InvocationIdentity,
  type ToolPolicy,
  type ToolRunResult,
} from "./index";

const context = { runId: "run-1", sessionId: "session-1", userId: "user-1" };
const input = { inputId: "input-1", text: "do the task" };

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const output: AgentEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

describe("fake agent executor", () => {
  test("orders events, steering, and completion under a Vox-owned contract", async () => {
    let now = 100;
    const executor = new FakeAgentExecutor(() => now++);
    const run = executor.start(input, context);
    const collecting = collect(run.events);
    run.emit({ type: "text.delta", text: "working" });
    await run.steer({ inputId: "input-2", text: "only today" });
    run.emit({ type: "tool.started", invocationId: "call-1", name: "search" });
    run.complete();

    expect(await collecting).toEqual([
      expect.objectContaining({ type: "run.started", runId: "run-1", sequence: 1, timestampMs: 100 }),
      expect.objectContaining({ type: "text.delta", sequence: 2 }),
      expect.objectContaining({ type: "run.steered", inputId: "input-2", sequence: 3 }),
      expect.objectContaining({ type: "tool.started", invocationId: "call-1", sequence: 4 }),
      expect.objectContaining({ type: "run.completed", sequence: 5 }),
    ]);
    expect(run.state).toBe("completed");
    expect(run.steering).toEqual([{ inputId: "input-2", text: "only today" }]);
  });

  test("deduplicates steering and rejects it after terminal state", async () => {
    const run = new FakeAgentExecutor().start(input, context);
    const duplicate = { inputId: "input-2", text: "same command" };
    await run.steer(duplicate);
    await run.steer(duplicate);
    expect(run.steering).toHaveLength(1);
    run.complete();
    await expect(run.steer({ inputId: "input-3", text: "late" })).rejects.toThrow("completed");
  });

  test("cancellation is terminal, observable exactly once, and drops zombie events", async () => {
    const run = new FakeAgentExecutor().start(input, context);
    const collecting = collect(run.events);
    await run.cancel("user_cancelled");
    await run.cancel("duplicate");
    expect(run.emit({ type: "text.delta", text: "zombie" })).toBe(false);
    const events = await collecting;
    expect(events.filter(event => event.type === "run.cancelled")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "run.cancelled", reason: "user_cancelled" });
    expect(run.state).toBe("cancelled");
  });

  test("a speech stop has no representation here and therefore cannot abort hands", () => {
    const run = new FakeAgentExecutor().start(input, context);
    // The executor boundary deliberately exposes steer/cancel/close, not stopSpeech.
    expect("stopSpeech" in run).toBe(false);
    expect(run.state).toBe("running");
  });

  test("run ids are unique within an executor", () => {
    const executor = new FakeAgentExecutor();
    executor.start(input, context);
    expect(() => executor.start({ inputId: "other", text: "other" }, context)).toThrow("duplicate run id");
  });

  test("the ordered event stream has one consumer", () => {
    const run = new FakeAgentExecutor().start(input, context);
    run.events[Symbol.asyncIterator]();
    expect(() => run.events[Symbol.asyncIterator]()).toThrow("already has a consumer");
  });
});

describe("agent lifecycle", () => {
  test("barge-in stops the mouth without stopping the hands", () => {
    const lifecycle = new AgentLifecycle();
    lifecycle.startExecution();
    lifecycle.startSpeech();
    expect(lifecycle.stopSpeech()).toBe(true);
    expect(lifecycle.speech).toBe("silent");
    expect(lifecycle.execution).toBe("running");
  });

  test("steering remains a live execution and cancellation owns both scopes", () => {
    const lifecycle = new AgentLifecycle();
    lifecycle.startExecution();
    lifecycle.beginSteering();
    lifecycle.startSpeech();
    lifecycle.requestCancel();
    expect(lifecycle.execution).toBe("cancelling");
    expect(lifecycle.speech).toBe("silent");
    lifecycle.finish("cancelled");
    expect(lifecycle.execution).toBe("cancelled");
    expect(() => lifecycle.startSpeech()).toThrow("cancelled");
  });

  test("rejects impossible and post-terminal transitions", () => {
    const lifecycle = new AgentLifecycle();
    expect(() => lifecycle.startSpeech()).toThrow("idle");
    expect(lifecycle.requestCancel()).toBe(false);
    lifecycle.startExecution();
    expect(() => lifecycle.finish("cancelled")).toThrow("running");
    lifecycle.finish("completed");
    expect(() => lifecycle.beginSteering()).toThrow("completed");
  });

  test("executor-boundary failures close every nonterminal state", () => {
    const beforeStart = new AgentLifecycle();
    beforeStart.fail();
    expect(beforeStart.execution).toBe("failed");

    const whileCancelling = new AgentLifecycle();
    whileCancelling.startExecution();
    whileCancelling.requestCancel();
    whileCancelling.fail();
    expect(whileCancelling.execution).toBe("failed");
    expect(() => whileCancelling.fail()).toThrow("failed");
  });
});

describe("tool sandbox policy", () => {
  const structured: ToolPolicy = {
    effect: "read",
    mode: "in_process",
    capabilities: ["structured"],
    limits: { timeoutMs: 1_000, maxOutputBytes: 4_096 },
    cancellable: true,
  };

  test("accepts a bounded structured in-process tool", () => {
    expect(() => validateToolPolicy(structured)).not.toThrow();
  });

  test("requires external effects to cross a broker or sandbox boundary", () => {
    expect(() => validateToolPolicy({ ...structured, effect: "external" }))
      .toThrow("brokered or sandbox");
    expect(() => validateToolPolicy({ ...structured, effect: "external", mode: "brokered" }))
      .not.toThrow();
  });

  test("rejects host authority in process", () => {
    for (const capability of ["filesystem", "process", "network"] as const) {
      expect(() => validateToolPolicy({
        ...structured,
        capabilities: ["structured", capability],
        ...(capability === "network"
          ? { networkAllowlist: [{ scheme: "https" as const, host: "example.com", port: 443 }] }
          : { workspace: true }),
      })).toThrow(ToolPolicyError);
    }
    expect(() => validateToolPolicy({
      ...structured,
      mode: "brokered",
      effect: "external",
      capabilities: ["structured", "network"],
      networkAllowlist: [{ scheme: "https", host: "example.com", port: 443 }],
    })).toThrow("sandbox mode");
  });

  test("requires workspace and explicit network destinations in a sandbox", () => {
    expect(() => validateToolPolicy({
      ...structured, mode: "sandbox", capabilities: ["filesystem"],
    })).toThrow("isolated workspace");
    expect(() => validateToolPolicy({
      ...structured, mode: "sandbox", capabilities: ["network"],
    })).toThrow("destination allowlist");
    expect(() => validateToolPolicy({
      ...structured,
      mode: "sandbox",
      capabilities: ["filesystem", "process", "network"],
      workspace: true,
      networkAllowlist: [{ scheme: "https", host: "api.example.com", port: 443 }],
      limits: { timeoutMs: 5_000, maxOutputBytes: 1_000_000, maxProcesses: 4, maxWorkspaceBytes: 10_000_000 },
    })).not.toThrow();
  });

  test("rejects invalid or contradictory limits and declarations", () => {
    expect(() => validateToolPolicy({ ...structured, capabilities: [] })).toThrow("capability");
    expect(() => validateToolPolicy({ ...structured, capabilities: ["structured", "structured"] })).toThrow("unique");
    expect(() => validateToolPolicy({
      ...structured, networkAllowlist: [{ scheme: "https", host: "example.com", port: 443 }],
    })).toThrow("network capability");
    expect(() => validateToolPolicy({ ...structured, limits: { timeoutMs: 0, maxOutputBytes: 1 } })).toThrow("timeoutMs");
  });

  test("rejects private or malformed destinations and malformed secret names", () => {
    for (const host of [
      "localhost", "127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1",
      "::", "::1", "[::1]", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fe80::1", "ff02::1",
      "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "*.example.com",
    ]) {
      expect(() => validateToolPolicy({
        ...structured,
        mode: "sandbox",
        capabilities: ["network"],
        networkAllowlist: [{ scheme: "https", host, port: 443 }],
      })).toThrow();
    }
    expect(() => validateToolPolicy({ ...structured, secretNames: ["api-key"] })).toThrow("secret name");
    expect(() => validateToolPolicy({ ...structured, secretNames: ["API_KEY", "API_KEY"] })).toThrow("unique");
    expect(() => validateToolPolicy({ ...structured, secretNames: ["API_KEY"] }))
      .toThrow("brokered or sandbox");
    expect(() => validateToolPolicy({
      ...structured, mode: "brokered", effect: "external", secretNames: ["API_KEY"],
    })).not.toThrow();
    expect(() => validateToolPolicy({
      ...structured,
      mode: "sandbox",
      capabilities: ["network"],
      networkAllowlist: [{ scheme: "https", host: "[2606:4700:4700::1111]", port: 443 }],
    })).not.toThrow();
  });
});

describe("fake tool runner", () => {
  const policy: ToolPolicy = {
    effect: "read",
    mode: "in_process",
    capabilities: ["structured"],
    limits: { timeoutMs: 1_000, maxOutputBytes: 4_096 },
    cancellable: true,
  };
  const request = {
    invocationId: "call-1",
    runId: "run-1",
    sessionId: "session-1",
    userId: "user-1",
    toolName: "lookup",
    arguments: { q: "vox" },
    policy,
  };

  test("dispatches a stable invocation id at most once", async () => {
    let calls = 0;
    const runner = new FakeToolRunner(async () => {
      calls += 1;
      return { status: "completed", output: "done" };
    });
    const signal = new AbortController().signal;
    const [first, duplicate] = await Promise.all([runner.run(request, signal), runner.run(request, signal)]);
    expect(first).toEqual({ status: "completed", output: "done" });
    expect(duplicate).toEqual(first);
    expect(calls).toBe(1);
    expect(runner.requests).toHaveLength(1);
  });

  test("scopes duplicate ids by owner/run and refuses identity reuse with changed arguments", async () => {
    let calls = 0;
    const runner = new FakeToolRunner(async request => {
      calls += 1;
      return { status: "completed", output: request.userId };
    });
    const signal = new AbortController().signal;
    expect(await runner.run(request, signal)).toEqual({ status: "completed", output: "user-1" });
    expect(await runner.run({ ...request, userId: "user-2" }, signal))
      .toEqual({ status: "completed", output: "user-2" });
    expect(await runner.run({ ...request, arguments: { q: "changed" } }, signal))
      .toEqual({ status: "failed", error: "invocation identity reused with a different request" });
    expect(calls).toBe(2);
  });

  test("turns cancellation into a terminal result for cancellable work", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const runner = new FakeToolRunner(async () => {
      await waiting;
      return { status: "completed", output: "too late" };
    });
    const controller = new AbortController();
    const running = runner.run(request, controller.signal);
    controller.abort("user_cancelled");
    expect(await running).toEqual({ status: "cancelled", reason: "tool_cancelled" });
    release();
  });

  test("does not dispatch a handler when the caller was already cancelled", async () => {
    let calls = 0;
    const runner = new FakeToolRunner(async () => {
      calls += 1;
      return { status: "completed", output: "wrong" };
    });
    const controller = new AbortController();
    controller.abort("already_cancelled");
    expect(await runner.run(request, controller.signal))
      .toEqual({ status: "cancelled", reason: "tool_cancelled" });
    expect(calls).toBe(0);
  });

  test("validates policy before dispatch and refuses new work after close", async () => {
    const runner = new FakeToolRunner();
    expect(() => runner.run({
      ...request,
      policy: { ...policy, capabilities: ["filesystem"] },
    }, new AbortController().signal)).toThrow(ToolPolicyError);
    expect(runner.requests).toHaveLength(0);
    expect(await runner.close()).toEqual({ drained: true, pending: 0 });
    expect(await runner.run(request, new AbortController().signal)).toEqual({
      status: "failed", error: "tool runner is closed",
    });
  });

  test("replays a prior result after close but refuses a new invocation", async () => {
    const runner = new FakeToolRunner();
    const signal = new AbortController().signal;
    const result = await runner.run(request, signal);
    await runner.close();
    expect(await runner.run(request, signal)).toEqual(result);
    expect(await runner.run({ ...request, invocationId: "call-2" }, signal))
      .toEqual({ status: "failed", error: "tool runner is closed" });
  });

  test("enforces timeout and output limits", async () => {
    const slow = new FakeToolRunner(async (_request, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled", reason: "handler observed abort" };
    });
    expect(await slow.run({
      ...request, policy: { ...policy, limits: { ...policy.limits, timeoutMs: 5 } },
    }, new AbortController().signal)).toEqual({ status: "failed", error: "tool_failed" });

    const verbose = new FakeToolRunner(async () => ({ status: "completed", output: "too large" }));
    expect(await verbose.run({
      ...request, policy: { ...policy, limits: { ...policy.limits, maxOutputBytes: 3 } },
    }, new AbortController().signal)).toEqual({ status: "failed", error: "too" });

    for (const result of [
      { status: "failed", error: "too large" },
      { status: "cancelled", reason: "too large" },
      { status: "outcome_unknown", error: "too large" },
    ] as ToolRunResult[]) {
      const bounded = new FakeToolRunner(async () => result);
      const actual = await bounded.run({
        ...request, policy: { ...policy, limits: { ...policy.limits, maxOutputBytes: 3 } },
      }, new AbortController().signal);
      expect(JSON.stringify(actual)).not.toContain("too large");
      expect(actual.status).toBe(result.status === "failed" ? "failed" : result.status);
    }
  });

  test("does not expose thrown handler errors", async () => {
    const runner = new FakeToolRunner(async () => {
      throw new Error("SECRET_VALUE");
    });
    expect(await runner.run(request, new AbortController().signal))
      .toEqual({ status: "failed", error: "tool_failed" });
  });

  test("bounds cancellation reasons supplied by the caller", async () => {
    const runner = new FakeToolRunner();
    const controller = new AbortController();
    controller.abort("sensitive and too large");
    expect(await runner.run({
      ...request, policy: { ...policy, limits: { ...policy.limits, maxOutputBytes: 3 } },
    }, controller.signal)).toEqual({
      status: "cancelled", reason: "too",
    });
  });

  test("rejects every non-JSON completed output and bounds the replacement error", async () => {
    for (const output of [undefined, Number.NaN, Number.POSITIVE_INFINITY, BigInt(1), () => {}]) {
      const runner = new FakeToolRunner(async () => ({ status: "completed", output } as never));
      expect(await runner.run({
        ...request, policy: { ...policy, limits: { ...policy.limits, maxOutputBytes: 4 } },
      }, new AbortController().signal)).toEqual({ status: "failed", error: "tool" });
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const runner = new FakeToolRunner(async () => ({ status: "completed", output: cyclic } as never));
    expect(await runner.run({
      ...request, policy: { ...policy, limits: { ...policy.limits, maxOutputBytes: 2 } },
    }, new AbortController().signal)).toEqual({ status: "failed", error: "to" });
  });

  test("rejects non-JSON and cyclic request arguments before dispatch", () => {
    const runner = new FakeToolRunner();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => runner.run({
      ...request, arguments: cyclic as never,
    }, new AbortController().signal)).toThrow("cyclic");
    expect(() => runner.run({
      ...request, arguments: { invalid: BigInt(1) } as never,
    }, new AbortController().signal)).toThrow("JSON-safe");
    expect(runner.requests).toHaveLength(0);
  });

  test("bounded close reports a handler that ignores cancellation", async () => {
    const runner = new FakeToolRunner(async () => await new Promise<ToolRunResult>(() => {}));
    void runner.run(request, new AbortController().signal);
    expect(await runner.close({ deadlineMs: 5 })).toEqual({ drained: false, pending: 1 });
  });
});

describe("invocation ledger", () => {
  const identity: InvocationIdentity = {
    invocationId: "call-1", runId: "run-1", sessionId: "session-1", userId: "user-1",
  };

  test("deduplicates stable invocation ids", () => {
    const ledger = new InvocationLedger();
    expect(ledger.prepare(identity, "read")).toBe(true);
    expect(ledger.prepare(identity, "read")).toBe(false);
    expect(ledger.state(identity)).toBe("prepared");
    const otherUser = { ...identity, userId: "user-2" };
    expect(ledger.prepare(otherUser, "read")).toBe(true);
    expect(ledger.state(otherUser)).toBe("prepared");
  });

  test("rejects reuse of one scoped identity with a different effect or request", () => {
    const ledger = new InvocationLedger();
    ledger.prepare(identity, "read", "request-a");
    expect(() => ledger.prepare(identity, "external", "request-a")).toThrow("different policy");
    expect(() => ledger.prepare(identity, "read", "request-b")).toThrow("different policy");
  });

  test("cancels before commit but never labels committed work cancelled", () => {
    const ledger = new InvocationLedger();
    const early = { ...identity, invocationId: "early" };
    ledger.prepare(early, "external");
    ledger.start(early);
    expect(ledger.cancel(early)).toBe(true);
    expect(ledger.state(early)).toBe("cancelled");

    const late = { ...identity, invocationId: "late" };
    ledger.prepare(late, "external");
    ledger.waitForConfirmation(late);
    ledger.start(late);
    ledger.commit(late);
    expect(ledger.cancel(late)).toBe(false);
    ledger.finish(late, "outcome_unknown");
    expect(ledger.state(late)).toBe("outcome_unknown");
  });

  test("fails closed on impossible transitions", () => {
    const ledger = new InvocationLedger();
    ledger.prepare(identity, "read");
    expect(() => ledger.commit(identity)).toThrow("cannot move");
    ledger.start(identity);
    expect(() => ledger.finish(identity, "outcome_unknown")).toThrow("cannot move");
    ledger.finish(identity, "completed");
    expect(() => ledger.finish(identity, "failed")).toThrow("cannot move");
  });

  test("requires an external effect to commit before completion or unknown outcome", () => {
    const ledger = new InvocationLedger();
    ledger.prepare(identity, "external");
    ledger.start(identity);
    expect(() => ledger.finish(identity, "completed")).toThrow("cannot move");
    expect(() => ledger.finish(identity, "outcome_unknown")).toThrow("cannot move");
    ledger.commit(identity);
    ledger.finish(identity, "completed");
    expect(ledger.state(identity)).toBe("completed");
  });

  test("serializes cancel versus commit without an impossible cancelled commit", () => {
    const cancelFirst = new InvocationLedger();
    cancelFirst.prepare(identity, "external");
    cancelFirst.start(identity);
    expect(cancelFirst.cancel(identity)).toBe(true);
    expect(() => cancelFirst.commit(identity)).toThrow("cancelled");

    const commitFirst = new InvocationLedger();
    commitFirst.prepare(identity, "external");
    commitFirst.start(identity);
    commitFirst.commit(identity);
    expect(commitFirst.cancel(identity)).toBe(false);
    expect(commitFirst.state(identity)).toBe("committed");
  });

  test("a read tool may complete while barge-in stops only speech", () => {
    const lifecycle = new AgentLifecycle();
    const ledger = new InvocationLedger();
    lifecycle.startExecution();
    lifecycle.startSpeech();
    ledger.prepare(identity, "read");
    ledger.start(identity);
    expect(lifecycle.stopSpeech()).toBe(true);
    ledger.finish(identity, "completed");
    expect(lifecycle.execution).toBe("running");
    expect(ledger.state(identity)).toBe("completed");
  });
});
