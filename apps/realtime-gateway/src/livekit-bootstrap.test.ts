import { describe, expect, test } from "bun:test";
import { TokenVerifier } from "livekit-server-sdk";
import {
  defaultLiveKitTokenTtlSeconds,
  issueLiveKitBrowserToken,
  liveKitBootstrapFromEnv,
  validateLiveKitBootstrapOptions,
  type LiveKitBootstrapOptions,
} from "./livekit-bootstrap";

const options: LiveKitBootstrapOptions = {
  serverUrl: "wss://media.voxstudio.example",
  apiKey: "test-api-key",
  apiSecret: "test-api-secret-that-is-long-enough",
};

describe("LiveKit browser bootstrap", () => {
  test("mints an opaque five-minute participant with only microphone, subscription, and data grants", async () => {
    const response = await issueLiveKitBrowserToken(options);
    const claims = await new TokenVerifier(options.apiKey, options.apiSecret).verify(response.participant_token);

    expect(response.server_url).toBe(options.serverUrl);
    expect(response.room_name).toMatch(/^vox-[0-9a-f]{32}$/);
    expect(response.participant_identity).toMatch(/^web-[0-9a-f]{32}$/);
    expect(response.room_name).not.toContain("owner");
    expect(response.participant_identity).not.toContain("owner");
    expect(Date.parse(response.expires_at)).toBe((claims.exp as number) * 1_000);
    expect(claims.sub).toBe(response.participant_identity);
    expect((claims.exp as number) - (claims.nbf as number)).toBe(defaultLiveKitTokenTtlSeconds);
    // The verifier's public type reuses VideoGrant (TrackSource enum), while JWT
    // serialization intentionally turns sources into protocol strings.
    expect(claims.video as unknown).toEqual({
      roomJoin: true,
      room: response.room_name,
      canPublish: true,
      canPublishSources: ["microphone"],
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });
    expect(claims.metadata).toBeUndefined();
    expect(claims.attributes).toBeUndefined();
  });

  test("never reuses a room or participant identity", async () => {
    const first = await issueLiveKitBrowserToken(options);
    const second = await issueLiveKitBrowserToken(options);
    expect(second.room_name).not.toBe(first.room_name);
    expect(second.participant_identity).not.toBe(first.participant_identity);
  });

  test("allows insecure WebSocket only for a loopback development server", () => {
    expect(() => validateLiveKitBootstrapOptions({ ...options, serverUrl: "ws://127.0.0.1:7880" })).not.toThrow();
    expect(() => validateLiveKitBootstrapOptions({ ...options, serverUrl: "ws://localhost:7880" })).not.toThrow();
    expect(() => validateLiveKitBootstrapOptions({ ...options, serverUrl: "ws://media.example" })).toThrow("wss://");
    expect(() => validateLiveKitBootstrapOptions({ ...options, serverUrl: "https://media.example" })).toThrow("wss://");
  });

  test("returns the public browser URL when configured, keeping the adapter endpoint private", async () => {
    const publicUrl = "wss://yutu.tail1e4ec4.ts.net:8443";
    const response = await issueLiveKitBrowserToken({ ...options, publicServerUrl: publicUrl });
    expect(response.server_url).toBe(publicUrl);
    const loopback = await issueLiveKitBrowserToken(options);
    expect(loopback.server_url).toBe(options.serverUrl);
  });

  test("validates the public browser URL strictly", () => {
    expect(() => validateLiveKitBootstrapOptions({ ...options, publicServerUrl: "wss://media.example" })).not.toThrow();
    expect(() => validateLiveKitBootstrapOptions({ ...options, publicServerUrl: "ws://media.example" })).toThrow("wss://");
    expect(() => validateLiveKitBootstrapOptions({ ...options, publicServerUrl: "https://media.example" })).toThrow("wss://");
    expect(() => validateLiveKitBootstrapOptions({ ...options, publicServerUrl: "wss://user:pass@media.example" })).toThrow("must not contain");
    expect(() => validateLiveKitBootstrapOptions({ ...options, publicServerUrl: "wss://media.example?x=1" })).toThrow("must not contain");
    expect(() => validateLiveKitBootstrapOptions({ ...options, publicServerUrl: "not a url" })).toThrow("absolute wss://");
  });

  test("fails closed on secrets in URLs, empty credentials, and long-lived tokens", () => {
    expect(() => validateLiveKitBootstrapOptions({ ...options, serverUrl: "wss://user:pass@media.example" })).toThrow("must not contain");
    expect(() => validateLiveKitBootstrapOptions({ ...options, serverUrl: "wss://media.example?secret=x" })).toThrow("must not contain");
    expect(() => validateLiveKitBootstrapOptions({ ...options, apiKey: " " })).toThrow("API key");
    expect(() => validateLiveKitBootstrapOptions({ ...options, apiSecret: "                                " })).toThrow("must not be empty");
    expect(() => validateLiveKitBootstrapOptions({ ...options, apiSecret: "short-secret" })).toThrow("at least 32 bytes");
    expect(() => validateLiveKitBootstrapOptions({ ...options, tokenTtlSeconds: 29 })).toThrow("between 30 and 600");
    expect(() => validateLiveKitBootstrapOptions({ ...options, tokenTtlSeconds: 601 })).toThrow("between 30 and 600");
  });

  test("accepts LiveKit's documented devkey/secret pair only on loopback development", () => {
    const development = { serverUrl: "ws://localhost:7880", apiKey: "devkey", apiSecret: "secret" };
    expect(() => validateLiveKitBootstrapOptions(development)).not.toThrow();
    expect(() => validateLiveKitBootstrapOptions({ ...development, serverUrl: "wss://media.example" }))
      .toThrow("production LiveKit API secret");
  });

  test("reads an all-or-nothing environment contract without inventing defaults", () => {
    expect(liveKitBootstrapFromEnv({})).toBeUndefined();
    expect(() => liveKitBootstrapFromEnv({ VOX_LIVEKIT_URL: options.serverUrl }, "gateway"))
      .toThrow("must be set together");
    expect(liveKitBootstrapFromEnv({
      VOX_LIVEKIT_URL: options.serverUrl,
      VOX_LIVEKIT_API_KEY: options.apiKey,
      VOX_LIVEKIT_API_SECRET: options.apiSecret,
    })).toEqual(options);
    expect(liveKitBootstrapFromEnv({
      VOX_LIVEKIT_URL: "ws://127.0.0.1:7880",
      VOX_LIVEKIT_API_KEY: options.apiKey,
      VOX_LIVEKIT_API_SECRET: options.apiSecret,
      VOX_LIVEKIT_PUBLIC_URL: "wss://media.example",
    })).toEqual({
      serverUrl: "ws://127.0.0.1:7880",
      publicServerUrl: "wss://media.example",
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
    });
    expect(() => liveKitBootstrapFromEnv({
      VOX_LIVEKIT_PUBLIC_URL: "wss://media.example",
    }, "gateway")).toThrow("must be set together");
    expect(() => liveKitBootstrapFromEnv({
      VOX_LIVEKIT_URL: options.serverUrl,
      VOX_LIVEKIT_API_KEY: options.apiKey,
      VOX_LIVEKIT_API_SECRET: options.apiSecret,
      VOX_LIVEKIT_PUBLIC_URL: "ws://media.example",
    })).toThrow("wss://");
    expect(() => liveKitBootstrapFromEnv({
      VOX_LIVEKIT_URL: options.serverUrl,
      VOX_LIVEKIT_API_KEY: options.apiKey,
      VOX_LIVEKIT_API_SECRET: options.apiSecret,
      VOX_LIVEKIT_TOKEN_TTL_SECONDS: "not-a-number",
    })).toThrow("between 30 and 600");
  });
});
