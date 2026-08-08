import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "@voxstudio/agents";
import { parseConfig } from "@voxstudio/config";
import { TokenVerifier } from "livekit-server-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway, type GatewayServer } from "./server";
import type { LiveKitAgentBootstrap, LiveKitAgentMediaAdapter, OpenLiveKitSession } from "./livekit-agent-adapter";

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    llm: { base_url: "http://llm.test" },
    tts: { base_url: "http://tts.test" },
  },
});
const livekit = {
  serverUrl: "wss://media.voxstudio.example",
  apiKey: "test-api-key",
  apiSecret: "test-api-secret-that-is-long-enough",
};

function adapter(accept: (bootstrap: LiveKitAgentBootstrap, openSession: OpenLiveKitSession) => void | Promise<void> = () => {}): LiveKitAgentMediaAdapter {
  return { accept: async (bootstrap, openSession) => { await accept(bootstrap, openSession); }, close: async () => {} };
}

let gateway: GatewayServer | undefined;
let agentsDir: string;
beforeEach(async () => {
  agentsDir = await mkdtemp(join(tmpdir(), "vox-livekit-agent-"));
  const agents = new AgentRegistry(agentsDir);
  const created = await agents.create("owner", {
    id: "support",
    name: "Support",
    spec: { instructions: "Bound instructions", voice: "bound-voice" },
  });
  await agents.publish("owner", "support", created.revision);
  const alice = await agents.create("alice", {
    id: "support",
    name: "Alice Support",
    spec: { instructions: "Alice-bound instructions", voice: "alice-voice" },
  });
  await agents.publish("alice", "support", alice.revision);
});
afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  await rm(agentsDir, { recursive: true, force: true });
});

describe("POST /v1/realtime/livekit/token", () => {
  test("refuses to advertise an adapter without both signing configuration and an Agent registry", () => {
    expect(() => startGateway({ config, port: 0, livekitAdapter: adapter() }))
      .toThrow("requires LiveKit signing configuration");
    expect(() => startGateway({ config, port: 0, livekit, livekitAdapter: adapter() }))
      .toThrow("requires an Agent registry");
  });

  test("is authenticated and returns a verifiable, least-privilege grant without exposing the signer secret", async () => {
    let accepted: LiveKitAgentBootstrap | undefined;
    gateway = startGateway({
      config,
      port: 0,
      token: "gateway-secret",
      livekit,
      agentsDir,
      livekitAdapter: adapter(bootstrap => { accepted = bootstrap; }),
    });
    const url = new URL("/v1/realtime/livekit/token", gateway.url);
    expect((await fetch(url, { method: "POST" })).status).toBe(401);

    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer gateway-secret", origin: "https://unrelated.example" },
      body: JSON.stringify({ agent: "support", agentSource: "published", agentVersion: 1, agentMode: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    const raw = await response.text();
    expect(raw).not.toContain(livekit.apiSecret);
    const body = JSON.parse(raw) as { participant_token: string; room_name: string; participant_identity: string; agent: { agentId: string; source: string; version: number } };
    const claims = await new TokenVerifier(livekit.apiKey, livekit.apiSecret).verify(body.participant_token);
    // The non-secret API key is the JWT issuer by protocol and is therefore decodable;
    // the API secret is the credential that must never cross this boundary.
    expect(claims.iss).toBe(livekit.apiKey);
    expect(claims.video?.room).toBe(body.room_name);
    expect(claims.video?.canPublishSources as unknown).toEqual(["microphone"]);
    expect(body.agent).toMatchObject({ agentId: "support", source: "published", version: 1 });
    expect(accepted).toMatchObject({
      roomName: body.room_name,
      participantIdentity: body.participant_identity,
      ownerUserId: "owner",
      start: {
        system: "Bound instructions",
        voice: "bound-voice",
        bargeIn: true,
        playbackAck: true,
        mediaTelemetry: true,
        agentMode: true,
      },
      agent: { agentId: "support", source: "published", version: 1 },
    });

    const healthResponse = await fetch(new URL("/healthz", gateway.url));
    const health = await healthResponse.text();
    expect(health).not.toContain(livekit.apiKey);
    expect(health).not.toContain(livekit.apiSecret);
    expect((JSON.parse(health) as { deployment: { livekit: boolean } }).deployment.livekit).toBe(true);
  });

  test("returns the public browser URL while the adapter keeps the private endpoint", async () => {
    let accepted: LiveKitAgentBootstrap | undefined;
    const privateLivekit = {
      serverUrl: "ws://127.0.0.1:7880",
      publicServerUrl: "wss://yutu.tail1e4ec4.ts.net:8443",
      apiKey: "devkey",
      apiSecret: "voxstudio-local-livekit-secret-2026-08-05",
    };
    gateway = startGateway({
      config,
      port: 0,
      token: "gateway-secret",
      livekit: privateLivekit,
      agentsDir,
      livekitAdapter: adapter(bootstrap => { accepted = bootstrap; }),
    });
    const response = await fetch(new URL("/v1/realtime/livekit/token", gateway.url), {
      method: "POST",
      headers: { authorization: "Bearer gateway-secret", origin: "https://unrelated.example" },
      body: JSON.stringify({ agent: "support", agentSource: "published", agentVersion: 1 }),
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(await response.text()) as { server_url: string };
    expect(body.server_url).toBe(privateLivekit.publicServerUrl);
    // The server-side adapter contract never sees the browser-facing endpoint.
    expect(accepted?.roomName).toBeDefined();
  });

  test("binds the Agent from the authenticated account namespace, never the same id from another owner", async () => {
    let accepted: LiveKitAgentBootstrap | undefined;
    gateway = startGateway({
      config,
      port: 0,
      livekit,
      agentsDir,
      authResolver: request => request.headers.get("authorization") === "Bearer alice-key"
        ? { userId: "alice", via: "apiKey" }
        : null,
      livekitAdapter: adapter(bootstrap => { accepted = bootstrap; }),
    });
    const response = await fetch(new URL("/v1/realtime/livekit/token", gateway.url), {
      method: "POST",
      headers: { authorization: "Bearer alice-key" },
      body: JSON.stringify({ agent: "support" }),
    });
    expect(response.status).toBe(200);
    expect(accepted).toMatchObject({
      ownerUserId: "alice",
      start: {
        system: "Alice-bound instructions",
        voice: "alice-voice",
        bargeIn: true,
        playbackAck: true,
        mediaTelemetry: true,
      },
      agent: { agentId: "support", source: "published", version: 1 },
    });
  });

  test("bootstraps an ordinary Studio conversation without inventing an Agent binding", async () => {
    let accepted: LiveKitAgentBootstrap | undefined;
    gateway = startGateway({
      config,
      port: 0,
      livekit,
      agentsDir,
      livekitAdapter: adapter(bootstrap => { accepted = bootstrap; }),
    });
    const response = await fetch(new URL("/v1/realtime/livekit/token", gateway.url), {
      method: "POST",
      body: JSON.stringify({
        language: "auto",
        voice: "shuber",
        ttsEngine: "tts",
        turnTaking: "speculative",
      }),
    });
    expect(response.status).toBe(200);
    expect(accepted).toMatchObject({
      ownerUserId: "owner",
      start: {
        language: "auto",
        voice: "shuber",
        ttsEngine: "tts",
        turnTaking: "speculative",
        bargeIn: true,
        playbackAck: true,
        mediaTelemetry: true,
      },
    });
    expect(accepted?.spec).toBeUndefined();
    expect(accepted?.agent).toBeUndefined();
    expect((await response.json() as { agent?: unknown }).agent).toBeUndefined();
  });

  test("does not pass a WebSocket media offer into the native LiveKit adapter", async () => {
    gateway = startGateway({ config, port: 0, livekit, agentsDir, livekitAdapter: adapter() });
    const response = await fetch(new URL("/v1/realtime/livekit/token", gateway.url), {
      method: "POST",
      body: JSON.stringify({ media: { version: 2, playback: [] } }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("bad_request");
  });

  test("applies same-origin protection to ambient browser authority", async () => {
    gateway = startGateway({ config, port: 0, livekit, agentsDir, livekitAdapter: adapter() });
    const url = new URL("/v1/realtime/livekit/token", gateway.url);
    const refused = await fetch(url, { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ agent: "support" }) });
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("forbidden_origin");

    const allowed = await fetch(url, { method: "POST", headers: { origin: new URL(gateway.url).origin }, body: JSON.stringify({ agent: "support" }) });
    expect(allowed.status).toBe(200);
  });

  test("does not mint an orphan token when the media adapter is absent or refuses the binding", async () => {
    gateway = startGateway({ config, port: 0, livekit, agentsDir });
    const url = new URL("/v1/realtime/livekit/token", gateway.url);
    const unavailable = await fetch(url, { method: "POST", body: JSON.stringify({ agent: "support" }) });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json() as { error: { code: string } }).error.code).toBe("livekit_adapter_unavailable");
    await gateway.stop();

    gateway = startGateway({
      config,
      port: 0,
      livekit,
      agentsDir,
      livekitAdapter: adapter(() => { throw new Error("adapter down"); }),
    });
    const refused = await fetch(new URL("/v1/realtime/livekit/token", gateway.url), {
      method: "POST",
      body: JSON.stringify({ agent: "support" }),
    });
    expect(refused.status).toBe(503);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("livekit_adapter_unavailable");
  });

  test("bounds free pending bootstraps per owner and returns retry guidance", async () => {
    gateway = startGateway({ config, port: 0, livekit, agentsDir, livekitAdapter: adapter() });
    const url = new URL("/v1/realtime/livekit/token", gateway.url);
    for (let index = 0; index < 4; index += 1) {
      expect((await fetch(url, { method: "POST", body: JSON.stringify({ agent: "support" }) })).status).toBe(200);
    }
    const refused = await fetch(url, { method: "POST", body: JSON.stringify({ agent: "support" }) });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("livekit_bootstrap_capacity");
  });

  test("is absent by default and still has catalog-driven method refusal", async () => {
    gateway = startGateway({ config, port: 0 });
    const url = new URL("/v1/realtime/livekit/token", gateway.url);
    const disabled = await fetch(url, { method: "POST" });
    expect(disabled.status).toBe(404);
    expect((await disabled.json() as { error: { code: string } }).error.code).toBe("livekit_disabled");
    const wrongMethod = await fetch(url, { method: "PUT" });
    expect(wrongMethod.status).toBe(405);
  });
});
