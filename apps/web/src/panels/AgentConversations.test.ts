import { describe, expect, test } from "bun:test";
import { conversationTurns, durationLabel } from "./AgentConversations";

describe("Agent Conversations presentation", () => {
  test("builds one transcript row per turn from final text and interruption truth", () => {
    expect(conversationTurns([
      { type: "response.text.delta", sequence: 1, timestampMs: 1, sessionId: "s", turnId: "t1", text: "hel" },
      { type: "transcript.final", sequence: 2, timestampMs: 2, sessionId: "s", turnId: "t1", text: "hello" },
      { type: "response.text.final", sequence: 3, timestampMs: 3, sessionId: "s", turnId: "t1", text: "hi" },
      { type: "playback.interrupted", sequence: 4, timestampMs: 4, sessionId: "s", turnId: "t1" },
      { type: "tool.call", sequence: 5, timestampMs: 5, sessionId: "s", turnId: "t2", name: "lookup" },
    ])).toEqual([{ id: "t1", transcript: "hello", reply: "hi", interrupted: true }]);
  });

  test("formats short and multi-minute durations compactly", () => {
    expect(durationLabel(1_400)).toBe("1s");
    expect(durationLabel(125_000)).toBe("2m 05s");
  });
});
