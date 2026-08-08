import { describe, expect, test } from "bun:test";
import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import { reduceEvent, type TurnView } from "./store";

const base = {
  turns: [] as TurnView[],
  notices: [],
  sessionState: "listening",
  sessionId: "session",
  agentRun: undefined,
};

function event(payload: object, sequence: number): GatewayEvent {
  return {
    v: 1,
    sequence,
    sessionId: "session",
    timestampMs: sequence,
    ...payload,
  } as GatewayEvent;
}

describe("conversation event reducer", () => {
  test("keeps a turn-scoped TTS failure distinct from a user interruption", () => {
    const started = reduceEvent(base, event({ type: "turn.started", turnId: "turn" }, 1));
    const state = { ...base, ...started };
    const failed = reduceEvent(state, event({
      type: "error",
      code: "turn_failed",
      message: "[400] voice_not_found: Unknown voice id.",
      recoverable: true,
      turnId: "turn",
    }, 2));
    const afterFailure = { ...state, ...failed };

    expect(afterFailure.turns[0]).toMatchObject({
      status: "failed",
      endReason: "error",
      failure: "turn_failed: [400] voice_not_found: Unknown voice id.",
    });
    expect(afterFailure.notices.at(-1)?.kind).toBe("error");

    const timed = reduceEvent(afterFailure, event({
      type: "turn.timing",
      turnId: "turn",
      endReason: "cancel",
      offsetsMs: {},
    }, 3));
    const cancelled = reduceEvent({ ...afterFailure, ...timed }, event({
      type: "turn.interrupted",
      turnId: "turn",
      reason: "cancel",
    }, 4));
    expect(cancelled.turns?.[0]).toMatchObject({ status: "failed", endReason: "error" });
  });

  test("still marks an actual barge-in as interrupted", () => {
    const started = reduceEvent(base, event({ type: "turn.started", turnId: "turn" }, 1));
    const interrupted = reduceEvent({ ...base, ...started }, event({
      type: "turn.interrupted",
      turnId: "turn",
      reason: "barge_in",
    }, 2));
    expect(interrupted.turns?.[0]).toMatchObject({ status: "interrupted", endReason: "barge_in" });
  });

  test("moves a typed turn to thinking when its transcript arrives without a VAD event", () => {
    const started = reduceEvent(base, event({ type: "turn.started", turnId: "typed", revision: 0 }, 1));
    expect(started.turns?.[0]?.status).toBe("capturing");
    const transcript = reduceEvent({ ...base, ...started }, event({
      type: "transcript.final",
      turnId: "typed",
      revision: 0,
      text: "typed hello",
    }, 2));
    expect(transcript.turns?.[0]).toMatchObject({ transcript: "typed hello", status: "thinking" });
  });

  test("tracks one autonomous run from progress through its terminal state", () => {
    const started = reduceEvent(base, event({ type: "agent.run.started", runId: "run-1" }, 1));
    const running = { ...base, ...started };
    const progressed = reduceEvent(running, event({
      type: "agent.run.progress",
      runId: "run-1",
      summary: "正在搜索…",
    }, 2));
    const answered = reduceEvent({ ...running, ...progressed }, event({
      type: "agent.run.answer",
      runId: "run-1",
      text: "找到结果",
    }, 3));
    const terminal = reduceEvent({ ...running, ...progressed, ...answered }, event({
      type: "agent.run.terminal",
      runId: "run-1",
      state: "completed",
    }, 4));

    expect(terminal.agentRun).toEqual({
      runId: "run-1",
      state: "completed",
      progress: [{ at: 2, summary: "正在搜索…" }],
      answer: "找到结果",
    });
  });

  test("ignores stale run ids and post-terminal events while preserving a reconnect", () => {
    const running = {
      ...base,
      agentRun: { runId: "run-2", state: "running" as const, progress: [], answer: undefined },
    };
    expect(reduceEvent(running, event({
      type: "agent.run.progress", runId: "old-run", summary: "stale",
    }, 2))).toEqual({});

    const terminal = reduceEvent(running, event({
      type: "agent.run.terminal", runId: "run-2", state: "cancelled",
    }, 3));
    const ended = { ...running, ...terminal };
    expect(reduceEvent(ended, event({
      type: "agent.run.answer", runId: "run-2", text: "too late",
    }, 4))).toEqual({});
    const reattached = {
      ...ended,
      ...reduceEvent(ended, event({
        type: "session.state", state: "listening", previous: "thinking",
      }, 5)),
    };
    expect(reattached.agentRun).toEqual(ended.agentRun);
    expect(reduceEvent(ended, {
      ...event({ type: "session.state", state: "listening", previous: "thinking" }, 6),
      sessionId: "new-session",
    })).toMatchObject({ agentRun: undefined });
  });
});
