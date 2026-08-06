import { describe, expect, test } from "bun:test";
import { ProtocolError, parseCommand } from "./protocol";

const command = (text: unknown): string => JSON.stringify({
  v: 1,
  type: "turn.text",
  idempotencyKey: "typed-1",
  text,
});

describe("turn.text protocol", () => {
  test("normalizes a non-empty typed turn", () => {
    expect(parseCommand(command("  hello from text  "))).toEqual({
      v: 1,
      type: "turn.text",
      idempotencyKey: "typed-1",
      text: "hello from text",
    });
  });

  test("rejects missing, blank, and oversized text", () => {
    expect(() => parseCommand(command(undefined))).toThrow(ProtocolError);
    expect(() => parseCommand(command(" \n "))).toThrow("must not be empty");
    expect(() => parseCommand(command("x".repeat(8_001)))).toThrow("at most 8000 characters");
  });
});

describe("agent protocol", () => {
  test("agentMode parses as a boolean and defaults to absent", () => {
    expect(parseCommand(JSON.stringify({
      v: 1,
      type: "session.start",
      idempotencyKey: "start-1",
      options: { agentMode: true },
    }))).toEqual({
      v: 1,
      type: "session.start",
      idempotencyKey: "start-1",
      options: { agentMode: true },
    });
    expect(() => parseCommand(JSON.stringify({
      v: 1,
      type: "session.start",
      idempotencyKey: "start-1",
      options: { agentMode: "yes" },
    }))).toThrow("agentMode must be a boolean");
  });

  test("agent.cancel normalizes an optional reason", () => {
    expect(parseCommand(JSON.stringify({
      v: 1,
      type: "agent.cancel",
      idempotencyKey: "cancel-1",
      reason: "  user_cancelled  ",
    }))).toEqual({
      v: 1,
      type: "agent.cancel",
      idempotencyKey: "cancel-1",
      reason: "user_cancelled",
    });
    expect(parseCommand(JSON.stringify({
      v: 1,
      type: "agent.cancel",
      idempotencyKey: "cancel-2",
    }))).toEqual({
      v: 1,
      type: "agent.cancel",
      idempotencyKey: "cancel-2",
    });
    expect(() => parseCommand(JSON.stringify({
      v: 1,
      type: "agent.cancel",
      idempotencyKey: "cancel-3",
      reason: " ",
    }))).toThrow("must not be empty");
    expect(() => parseCommand(JSON.stringify({
      v: 1,
      type: "agent.cancel",
      idempotencyKey: "cancel-4",
      reason: "x".repeat(201),
    }))).toThrow("at most 200 characters");
  });
});
