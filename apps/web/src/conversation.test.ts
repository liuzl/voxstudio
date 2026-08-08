import { describe, expect, test } from "bun:test";
import { GatewayApiError } from "./lib/api";
import { liveKitFallbackReason, mayFallbackFromLiveKit, mediaTraceFilename } from "./conversation";

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

  test("classifies only safe, user-visible fallback reasons", () => {
    expect(liveKitFallbackReason(failure("room connect", new Error("network down")))).toBe("livekit_room_connection_failed");
    expect(liveKitFallbackReason(failure("bootstrap", new GatewayApiError("unavailable", 503)))).toBe("livekit_service_unavailable");
    expect(liveKitFallbackReason(failure("bootstrap", new GatewayApiError("capacity", 429)))).toBeUndefined();
  });
});

describe("media trace export", () => {
  test("keeps the recorded session id after the live store session is reset", () => {
    expect(mediaTraceFilename({ sessionId: "session-123" })).toBe("voxstudio-media-trace-session-123.json");
  });

  test("sanitizes an untrusted session id before using it as a filename", () => {
    expect(mediaTraceFilename({ sessionId: "../../room one" })).toBe("voxstudio-media-trace-room-one.json");
  });
});
