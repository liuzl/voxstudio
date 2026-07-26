import { describe, expect, test } from "bun:test";
import { fromEngineVoiceId, toEngineVoiceId, voicePrefix } from "./voice-namespace";

describe("voice namespace", () => {
  test("the owner keeps bare names in both directions", () => {
    expect(toEngineVoiceId("owner", "laok")).toBe("laok");
    expect(fromEngineVoiceId("owner", "laok")).toBe("laok");
  });

  test("account holders get a deterministic prefix within the engine id contract", () => {
    const engineId = toEngineVoiceId("alice", "myvoice");
    expect(engineId).toBe(`${voicePrefix("alice")}myvoice`);
    expect(engineId).toMatch(/^u[0-9a-f]{12}\.myvoice$/);
    // Deterministic: the same user maps the same way every time.
    expect(toEngineVoiceId("alice", "myvoice")).toBe(engineId);
    // Round trip.
    expect(fromEngineVoiceId("alice", engineId as string)).toBe("myvoice");
  });

  test("same display name, different users — different engine ids, mutual invisibility", () => {
    const alices = toEngineVoiceId("alice", "myvoice") as string;
    const bobs = toEngineVoiceId("bob", "myvoice") as string;
    expect(alices).not.toBe(bobs);
    expect(fromEngineVoiceId("alice", bobs)).toBeNull();
    expect(fromEngineVoiceId("bob", alices)).toBeNull();
    // Bare (owner) names are invisible to account holders, and namespaced entries
    // are invisible to the owner: the prefix pattern is a reserved namespace.
    expect(fromEngineVoiceId("alice", "laok")).toBeNull();
    expect(fromEngineVoiceId("owner", alices)).toBeNull();
  });

  test("a name that cannot fit the 64-char engine contract prefixed is refused", () => {
    const long = "x".repeat(64);
    expect(toEngineVoiceId("alice", long)).toBeNull();
    // The owner's bare names keep the full budget.
    expect(toEngineVoiceId("owner", long)).toBe(long);
  });
});
