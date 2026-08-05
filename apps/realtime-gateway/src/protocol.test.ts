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
