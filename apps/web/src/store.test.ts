import { describe, expect, test } from "bun:test";
import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import { reduceEvent, type TurnView } from "./store";

const base = {
  turns: [] as TurnView[],
  notices: [],
  sessionState: "listening",
  sessionId: "session",
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
});
