import { describe, expect, test } from "bun:test";
import type { ConversationMediaDescriptor } from "../lib/api";
import { conversationTurns, durationLabel } from "./AgentConversations";

const media = (overrides: Partial<ConversationMediaDescriptor>): ConversationMediaDescriptor => ({
  id: "media-1",
  sessionId: "s",
  turnId: "t1",
  revision: 0,
  direction: "input",
  state: "ready",
  delivery: null,
  sampleRate: 16_000,
  channels: 1,
  sampleCount: 16_000,
  durationMs: 1_000,
  bytes: 32_044,
  sha256: "abc",
  createdAt: 10,
  errorCode: null,
  ...overrides,
});

describe("Agent Conversations presentation", () => {
  test("builds one transcript row per turn from final text and interruption truth", () => {
    expect(conversationTurns([
      { type: "response.text.delta", sequence: 1, timestampMs: 1, sessionId: "s", turnId: "t1", text: "hel" },
      { type: "transcript.final", sequence: 2, timestampMs: 2, sessionId: "s", turnId: "t1", text: "hello" },
      { type: "response.text.final", sequence: 3, timestampMs: 3, sessionId: "s", turnId: "t1", text: "hi" },
      { type: "playback.interrupted", sequence: 4, timestampMs: 4, sessionId: "s", turnId: "t1" },
      { type: "tool.call", sequence: 5, timestampMs: 5, sessionId: "s", turnId: "t2", name: "lookup" },
    ])).toEqual([{ id: "t1", revision: 0, transcript: "hello", reply: "hi", interrupted: true }]);
  });

  test("joins retained input and output audio by turn revision", () => {
    const input = media({ id: "input", direction: "input" });
    const output = media({ id: "output", direction: "output", delivery: "playback_acknowledged" });
    expect(conversationTurns([
      { type: "transcript.final", sequence: 1, timestampMs: 1, sessionId: "s", turnId: "t1", revision: 0, text: "hello" },
      { type: "response.text.final", sequence: 2, timestampMs: 2, sessionId: "s", turnId: "t1", revision: 0, text: "hi" },
    ], [output, input])).toEqual([{
      id: "t1",
      revision: 0,
      transcript: "hello",
      reply: "hi",
      interrupted: false,
      inputMedia: input,
      outputMedia: output,
    }]);
  });

  test("keeps revisions separate and exposes audio-only turns", () => {
    const revised = media({ id: "output-2", direction: "output", revision: 2, turnId: "t2" });
    expect(conversationTurns([], [revised])).toEqual([{
      id: "t2",
      revision: 2,
      interrupted: false,
      outputMedia: revised,
    }]);
  });

  test("formats short and multi-minute durations compactly", () => {
    expect(durationLabel(1_400)).toBe("1s");
    expect(durationLabel(125_000)).toBe("2m 05s");
  });
});
