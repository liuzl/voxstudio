import { describe, expect, test } from "bun:test";
import { GatewayApiError } from "./lib/api";
import { mayFallbackFromLiveKit } from "./conversation";

function failure(
  phase: "bootstrap" | "room connect" | "microphone capture" | "microphone publish",
  cause: unknown,
): Error {
  return Object.assign(new Error("LiveKit failed", { cause }), { liveKitPhase: phase });
}

describe("LiveKit compatibility fallback", () => {
  test("falls back only before microphone capture and never hides caller refusals", () => {
    expect(mayFallbackFromLiveKit(failure("room connect", new Error("network down")))).toBe(true);
    expect(mayFallbackFromLiveKit(failure("bootstrap", new TypeError("fetch failed")))).toBe(true);
    expect(mayFallbackFromLiveKit(failure("bootstrap", new GatewayApiError("unavailable", 503)))).toBe(true);
    expect(mayFallbackFromLiveKit(failure("bootstrap", new GatewayApiError("capacity", 429)))).toBe(false);
    expect(mayFallbackFromLiveKit(failure("bootstrap", new GatewayApiError("unauthorized", 401)))).toBe(false);
    expect(mayFallbackFromLiveKit(failure("microphone capture", new Error("denied")))).toBe(false);
    expect(mayFallbackFromLiveKit(failure("microphone publish", new Error("denied")))).toBe(false);
  });
});
