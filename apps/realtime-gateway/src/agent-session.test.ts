import { describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { FakeAgentExecutor } from "@voxstudio/agent-executor";
import { parseConfig } from "@voxstudio/config";
import type { Fetch } from "@voxstudio/clients";
import { protocolVersion, type GatewayEvent, type SessionStartOptions } from "./protocol";
import { GatewaySession, type EventSink } from "./session";

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    llm: { base_url: "http://llm.test" },
    tts: { base_url: "http://tts.test" },
  },
});

function engineFetch(): Fetch {
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    const path = new URL(request.url).pathname;
    if (path === "/v1/audio/transcriptions") return Response.json({ text: "你好" });
    if (path === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: "回答完毕。" } }] });
    if (path === "/v1/audio/speech") {
      return new Response(new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000)));
    }
    if (path === "/v1/voices") return Response.json({ voices: [] });
    throw new Error(`unexpected engine path ${path}`);
  };
}

const startOptions = {
  language: "zh",
  voice: "demo",
  vad: "energy",
  threshold: 0.1,
  minSpeechMs: 40,
  silenceMs: 20,
  turnTaking: "conservative",
  bargeIn: true,
} satisfies SessionStartOptions;

const sink: EventSink = { send: () => ({ sendResult: 0, bufferedBytes: 0 }) };

/** Drains the microtask-driven event loop. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

async function startAgentSession(options: {
  events: GatewayEvent[];
  executor: FakeAgentExecutor;
}): Promise<GatewaySession> {
  const session = new GatewaySession({
    config,
    fetch: engineFetch(),
    agentExecutor: options.executor,
    onEvent: event => { options.events.push(event); },
  });
  await session.start({ ...startOptions, agentMode: true }, sink);
  return session;
}

describe("agent mode session (Phase B gateway/session integration)", () => {
  test("the first typed input starts the run; progress, answer, and terminal events flow", async () => {
    const events: GatewayEvent[] = [];
    const executor = new FakeAgentExecutor();
    const session = await startAgentSession({ events, executor });

    session.handleCommand({ v: protocolVersion, type: "turn.text", idempotencyKey: "input-1", text: "第一个任务" });
    await waitFor(() => executor.runs.length === 1);

    const run = executor.runs[0]!;
    expect(run.context.userId).toBe("owner");
    expect(run.context.sessionId).toBe(session.id);
    expect(events.some(event =>
      event.type === "agent.run.started" && event.runId === run.context.runId)).toBe(true);

    run.emit({ type: "tool.started", invocationId: "call-1", name: "search" });
    run.emit({ type: "text.final", text: "结果在这里" });
    await flush();
    expect(events.some(event =>
      event.type === "agent.run.progress" && event.summary === "正在search…")).toBe(true);
    expect(events.some(event =>
      event.type === "agent.run.answer" && event.text === "结果在这里")).toBe(true);

    run.complete();
    await waitFor(() => events.some(event => event.type === "agent.run.terminal"));
    expect(events.find(event => event.type === "agent.run.terminal")).toMatchObject({
      runId: run.context.runId,
      state: "completed",
    });

    session.stop();
    await session.done;
  });

  test("an audio utterance after the run started steers it", async () => {
    const events: GatewayEvent[] = [];
    const executor = new FakeAgentExecutor();
    const session = await startAgentSession({ events, executor });

    session.handleCommand({ v: protocolVersion, type: "turn.text", idempotencyKey: "input-1", text: "第一个任务" });
    await waitFor(() => executor.runs.length === 1);
    const run = executor.runs[0]!;

    // A VAD-confirmed utterance: two loud 20ms frames confirm, silence ends it.
    session.pushAudioSamples(new Float32Array(320).fill(0.2));
    session.pushAudioSamples(new Float32Array(320).fill(0.2));
    session.pushAudioSamples(new Float32Array(320));
    await waitFor(() => run.steering.length === 1);

    expect(run.steering[0]?.text).toBe("你好");
    expect(run.steering[0]?.inputId).toBeDefined();

    session.stop();
    await session.done;
  });

  test("agent.cancel cancels the run and reports exactly one terminal", async () => {
    const events: GatewayEvent[] = [];
    const executor = new FakeAgentExecutor();
    const session = await startAgentSession({ events, executor });

    session.handleCommand({ v: protocolVersion, type: "turn.text", idempotencyKey: "input-1", text: "第一个任务" });
    await waitFor(() => executor.runs.length === 1);

    session.handleCommand({ v: protocolVersion, type: "agent.cancel", idempotencyKey: "cancel-1", reason: "user_cancelled" });
    await waitFor(() => events.some(event => event.type === "agent.run.terminal"));

    // A replayed cancel (same idempotency key) is a duplicate, never a second terminal.
    session.handleCommand({ v: protocolVersion, type: "agent.cancel", idempotencyKey: "cancel-1", reason: "again" });
    await flush();
    const terminals = events.filter(event => event.type === "agent.run.terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ state: "cancelled" });
    expect(events.some(event => event.type === "command.duplicate")).toBe(true);

    session.stop();
    await session.done;
  });

  test("agent.cancel before a run exists is rejected", async () => {
    const events: GatewayEvent[] = [];
    const session = await startAgentSession({ events, executor: new FakeAgentExecutor() });

    session.handleCommand({ v: protocolVersion, type: "agent.cancel", idempotencyKey: "cancel-1" });
    await flush();
    expect(events.some(event =>
      event.type === "command.rejected" && event.reason === "no_active_agent_run")).toBe(true);

    session.stop();
    await session.done;
  });

  test("agent.cancel after the run terminated is rejected as no longer active", async () => {
    const events: GatewayEvent[] = [];
    const executor = new FakeAgentExecutor();
    const session = await startAgentSession({ events, executor });

    session.handleCommand({ v: protocolVersion, type: "turn.text", idempotencyKey: "input-1", text: "任务" });
    await waitFor(() => executor.runs.length === 1);
    executor.runs[0]!.complete();
    await waitFor(() => events.some(event => event.type === "agent.run.terminal"));

    session.handleCommand({ v: protocolVersion, type: "agent.cancel", idempotencyKey: "cancel-after-terminal" });
    await flush();
    expect(events.some(event => event.type === "command.rejected"
      && event.idempotencyKey === "cancel-after-terminal"
      && event.reason === "no_active_agent_run")).toBe(true);

    session.stop();
    await session.done;
  });

  test("hang-up cancels the session-scoped run with bounded cleanup", async () => {
    const events: GatewayEvent[] = [];
    const executor = new FakeAgentExecutor();
    const session = await startAgentSession({ events, executor });

    session.handleCommand({ v: protocolVersion, type: "turn.text", idempotencyKey: "input-1", text: "第一个任务" });
    await waitFor(() => executor.runs.length === 1);
    const run = executor.runs[0]!;

    session.stop();
    await waitFor(() => events.some(event => event.type === "agent.run.terminal"));
    expect(events.find(event => event.type === "agent.run.terminal")).toMatchObject({
      runId: run.context.runId,
      state: "cancelled",
    });
    await session.done;
  });

  test("reconnect attaches to the same run and steers it, not a second run", async () => {
    const events: GatewayEvent[] = [];
    const executor = new FakeAgentExecutor();
    const session = new GatewaySession({
      config,
      fetch: engineFetch(),
      agentExecutor: executor,
      onEvent: event => { events.push(event); },
    });
    await session.start({ ...startOptions, agentMode: true }, sink);
    session.handleCommand({ v: protocolVersion, type: "turn.text", idempotencyKey: "input-1", text: "第一个任务" });
    await waitFor(() => executor.runs.length === 1);
    const run = executor.runs[0]!;

    const replacement: EventSink = { send: () => ({ sendResult: 0, bufferedBytes: 0 }) };
    session.detach(sink);
    session.attach(replacement);
    session.handleCommand({ v: protocolVersion, type: "turn.text", idempotencyKey: "input-2", text: "补充说明" });
    await waitFor(() => run.steering.length === 1);

    expect(executor.runs).toHaveLength(1);
    expect(run.steering[0]?.text).toBe("补充说明");

    session.stop();
    await session.done;
  });

  test("a follow-up input after a completed run starts a fresh run instead of failing the turn", async () => {
    const events: GatewayEvent[] = [];
    const executor = new FakeAgentExecutor();
    const session = await startAgentSession({ events, executor });

    session.handleCommand({ v: protocolVersion, type: "turn.text", idempotencyKey: "input-1", text: "第一个任务" });
    await waitFor(() => executor.runs.length === 1);
    const first = executor.runs[0]!;
    first.emit({ type: "text.final", text: "第一个回答" });
    first.complete();
    await waitFor(() => events.some(event =>
      event.type === "agent.run.terminal" && event.runId === first.context.runId));

    // Steering a terminal run is rejected by the lifecycle contract; the session must
    // start a new run for the follow-up rather than surface a generic turn failure.
    session.handleCommand({ v: protocolVersion, type: "turn.text", idempotencyKey: "input-2", text: "第二个任务" });
    await waitFor(() => executor.runs.length === 2);
    const second = executor.runs[1]!;
    expect(events.some(event =>
      event.type === "agent.run.started" && event.runId === second.context.runId)).toBe(true);
    expect(events.some(event => event.type === "error" && event.code === "turn_failed")).toBe(false);

    second.emit({ type: "text.final", text: "第二个回答" });
    second.complete();
    await waitFor(() => events.some(event =>
      event.type === "agent.run.terminal" && event.runId === second.context.runId));

    session.stop();
    await session.done;
  });

  test("done captured at session-open settles only after an in-flight run drains", async () => {
    const order: string[] = [];
    const executor = new FakeAgentExecutor();
    const session = new GatewaySession({
      config,
      fetch: engineFetch(),
      agentExecutor: executor,
      onEvent: event => {
        // The LiveKit adapter captures `done` at session-open and closes its sink when
        // it settles; the terminal event must reach the session before that happens.
        if (event.type === "agent.run.terminal") order.push("terminal");
      },
    });
    await session.start({ ...startOptions, agentMode: true }, sink);
    const done = session.done;
    void done.then(() => order.push("done"));

    session.handleCommand({ v: protocolVersion, type: "turn.text", idempotencyKey: "input-1", text: "任务" });
    await waitFor(() => executor.runs.length === 1);

    // Stop while the run is in flight: bounded shutdown cancels and drains it.
    session.stop();
    await done;

    expect(order).toEqual(["terminal", "done"]);
  });
});
