import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@voxstudio/config";
import { writeWav } from "@voxstudio/audio";
import type { Fetch } from "@voxstudio/clients";
import type { AuthContext } from "./auth/auth-context";
import { startGateway, type GatewayServer } from "./server";
import { parseCommand, protocolVersion, type GatewayEvent } from "./protocol";
import { voicePrefix } from "./voice-namespace";

const config = parseConfig();
let gateway: GatewayServer | undefined;
let roots: string[] = [];

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "vox-gateway-agents-"));
  roots.push(value);
  return value;
}

function identity(request: Request): AuthContext | null {
  const userId = request.headers.get("x-test-user") ?? new URL(request.url).searchParams.get("user");
  if (!userId) return null;
  return { userId, via: request.headers.get("x-test-via") === "session" ? "session" : "apiKey" };
}

function request(path: string, init: RequestInit & { user?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-test-user", init.user ?? "alice");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(new URL(path, gateway?.url), { ...init, headers });
}

class RealtimeClient {
  readonly events: GatewayEvent[] = [];
  private readonly socket: WebSocket;
  private readonly opened: Promise<void>;
  private wake: (() => void) | undefined;

  constructor(base: string, user = "alice") {
    this.socket = new WebSocket(new URL(`/v1/realtime?user=${user}`, base).toString().replace(/^http/, "ws"));
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error("websocket error")));
    });
    this.socket.addEventListener("message", event => {
      if (typeof event.data === "string") this.events.push(JSON.parse(event.data) as GatewayEvent);
      this.wake?.();
    });
  }

  async ready(): Promise<void> { await this.opened; }

  command(options: Record<string, unknown>, idempotencyKey = crypto.randomUUID()): void {
    this.socket.send(JSON.stringify({ v: protocolVersion, type: "session.start", idempotencyKey, options }));
  }

  sendTurn(): void {
    for (const amplitude of [0.2, 0.2, 0, 0]) this.socket.send(new Float32Array(320).fill(amplitude).buffer);
  }

  stop(): void {
    this.socket.send(JSON.stringify({
      v: protocolVersion,
      type: "session.stop",
      idempotencyKey: crypto.randomUUID(),
    }));
  }

  async until(predicate: (events: GatewayEvent[]) => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate(this.events)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${this.events.map(event => event.type).join(",")}`);
      await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, 30); });
      this.wake = undefined;
    }
  }

  close(): void { this.socket.close(); }
}

describe("Agent REST registry", () => {
  test("draft preview is revision-pinned", () => {
    expect(() => parseCommand(JSON.stringify({
      v: protocolVersion,
      type: "session.start",
      idempotencyKey: "draft-without-revision",
      options: { agent: "support", agentSource: "draft" },
    }))).toThrow("agentRevision is required");

    expect(parseCommand(JSON.stringify({
      v: protocolVersion,
      type: "session.start",
      idempotencyKey: "draft-at-revision",
      options: { agent: "support", agentSource: "draft", agentRevision: 3 },
    }))).toMatchObject({ options: { agent: "support", agentSource: "draft", agentRevision: 3 } });
  });

  test("CRUD, revision conflicts, publish, versions, and audit share one owner-scoped object", async () => {
    gateway = startGateway({ config, port: 0, agentsDir: await root(), authResolver: identity });

    const createdResponse = await request("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ id: "support", name: "Support", spec: { instructions: "First", voice: "laok" } }),
    });
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("etag")).toBe('"1"');
    const created = await createdResponse.json() as { revision: number };

    expect((await request("/v1/agents")).status).toBe(200);
    expect((await request("/v1/agents").then(response => response.json()) as { agents: unknown[] }).agents).toHaveLength(1);
    expect((await request("/v1/agents/support", { user: "bob" })).status).toBe(404);

    const bobCreate = await request("/v1/agents", {
      method: "POST", user: "bob",
      body: JSON.stringify({ id: "support", name: "Bob support", spec: { voice: "bob" } }),
    });
    expect(bobCreate.status).toBe(201);

    const stale = await request("/v1/agents/support", {
      method: "PATCH",
      body: JSON.stringify({ revision: created.revision + 1, name: "Stale" }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: { code: string } }).error.code).toBe("agent_conflict");

    const updatedResponse = await request("/v1/agents/support", {
      method: "PATCH",
      body: JSON.stringify({ revision: created.revision, name: "Support agent", spec: { instructions: "Published behavior", voice: "laok" } }),
    });
    const updated = await updatedResponse.json() as { revision: number };
    expect(updated.revision).toBe(2);

    const publishResponse = await request("/v1/agents/support/publish", {
      method: "POST",
      body: JSON.stringify({ revision: updated.revision }),
    });
    expect(publishResponse.status).toBe(200);
    const published = await publishResponse.json() as { record: { revision: number }; version: { version: number; hash: string } };
    expect(published.version.version).toBe(1);
    expect(published.version.hash).toHaveLength(64);

    const versions = await request("/v1/agents/support/versions").then(response => response.json()) as { versions: Array<{ version: number }> };
    expect(versions.versions.map(version => version.version)).toEqual([1]);
    expect(await request("/v1/agents/support/audit", { method: "POST" }).then(response => response.json()))
      .toMatchObject({ status: "current", version: 1 });

    const deleted = await request("/v1/agents/support", {
      method: "DELETE",
      body: JSON.stringify({ revision: published.record.revision }),
    });
    expect(deleted.status).toBe(200);
    expect((await request("/v1/agents/support")).status).toBe(404);
    // Bob's same-id Agent is a different resource.
    expect((await request("/v1/agents/support", { user: "bob" })).status).toBe(200);
  });

  test("demo mode and ambient browser sessions cannot mutate through the wrong origin", async () => {
    const agentsDir = await root();
    gateway = startGateway({ config, port: 0, agentsDir, authResolver: identity, demoMode: true });
    expect((await request("/v1/agents", { method: "POST", body: JSON.stringify({ id: "x", name: "X" }) })).status).toBe(403);
    await gateway.stop();

    gateway = startGateway({ config, port: 0, agentsDir, authResolver: identity });
    const crossSite = await request("/v1/agents", {
      method: "POST",
      headers: { origin: "https://attacker.example", "x-test-via": "session" },
      body: JSON.stringify({ id: "x", name: "X" }),
    });
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json() as { error: { code: string } }).error.code).toBe("forbidden_origin");
    // An explicit API key does not depend on ambient browser Origin.
    expect((await request("/v1/agents", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
      body: JSON.stringify({ id: "x", name: "X" }),
    })).status).toBe(201);

    await gateway.stop();
    gateway = startGateway({ config, port: 0, agentsDir });
    const selfHostedCrossSite = await fetch(new URL("/v1/agents", gateway.url), {
      method: "POST",
      // text/plain is a browser "simple" request: rejecting it here is the localhost
      // CSRF boundary, not something a CORS preflight can be trusted to do for us.
      headers: { origin: "https://attacker.example", "content-type": "text/plain" },
      body: JSON.stringify({ id: "cross-site", name: "Cross-site" }),
    });
    expect(selfHostedCrossSite.status).toBe(403);
    expect((await selfHostedCrossSite.json() as { error: { code: string } }).error.code).toBe("forbidden_origin");
    expect((await fetch(new URL("/v1/agents", gateway.url)).then(response => response.json()) as { agents: unknown[] }).agents).toHaveLength(0);
  });

  test("reports the feature boundary when no Agent directory is configured", async () => {
    gateway = startGateway({ config, port: 0, authResolver: identity });
    const response = await request("/v1/agents");
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("agents_disabled");
  });

  test("serializes asynchronous Agent start and retains audio queued behind it", async () => {
    const engineFetch: Fetch = async (input, init) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      const path = new URL(request.url).pathname;
      if (path === "/v1/audio/transcriptions") return Response.json({ text: "buffered speech" });
      if (path === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: "heard" } }] });
      if (path === "/v1/audio/speech") return new Response(new Uint8Array(writeWav(new Float32Array(1_200), 24_000)));
      if (path === "/v1/voices") return Response.json({ voices: [] });
      throw new Error(`unexpected engine path ${path}`);
    };
    gateway = startGateway({ config, port: 0, agentsDir: await root(), authResolver: identity, fetch: engineFetch });
    const created = await request("/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "queued-agent",
        name: "Queued agent",
        spec: { vad: "energy", threshold: 0.1, minSpeechMs: 40, silenceMs: 20 },
      }),
    }).then(response => response.json()) as { revision: number };
    await request("/v1/agents/queued-agent/publish", {
      method: "POST", body: JSON.stringify({ revision: created.revision }),
    });

    const client = new RealtimeClient(gateway.url);
    await client.ready();
    client.command({ agent: "queued-agent" });
    client.command({ agent: "queued-agent" });
    client.sendTurn();
    await client.until(events => events.some(event => event.type === "session.snapshot"), "snapshot");
    await client.until(events => events.some(event => event.type === "transcript.final"), "buffered transcript");
    expect(client.events.some(event => event.type === "command.rejected" && event.reason === "session_starting")).toBe(true);
    expect(client.events.some(event => event.type === "transcript.final" && event.text === "buffered speech")).toBe(true);
    expect(gateway.sessionCount()).toBe(1);
    client.close();
  });

  test("session.start resolves the owner's published Agent into the existing conversation path", async () => {
    const speech: Array<{ input: string; voice?: string }> = [];
    const chats: Array<{
      messages: Array<{ role: string; content: string }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    const engineFetch: Fetch = async (input, init) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      const path = new URL(request.url).pathname;
      if (path === "/v1/audio/transcriptions") return Response.json({ text: "你好" });
      if (path === "/v1/chat/completions") {
        chats.push(await request.json() as typeof chats[number]);
        return Response.json({ choices: [{ message: { content: "很高兴帮助你。" } }] });
      }
      if (path === "/v1/audio/speech") {
        speech.push(await request.json() as { input: string; voice?: string });
        return new Response(new Uint8Array(writeWav(new Float32Array(2_400).fill(0.1), 24_000)));
      }
      if (path === "/v1/voices") return Response.json({ voices: [] });
      throw new Error(`unexpected engine path ${path}`);
    };
    gateway = startGateway({ config, port: 0, agentsDir: await root(), authResolver: identity, fetch: engineFetch });
    const created = await request("/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "published-agent",
        name: "Published agent",
        spec: {
          instructions: "You are the published support persona.",
          voice: "agentvoice",
          welcome: "欢迎来到已发布的助手。",
          vad: "energy",
          threshold: 0.1,
          minSpeechMs: 40,
          silenceMs: 20,
          studioTools: false,
        },
      }),
    }).then(response => response.json()) as { revision: number };
    await request("/v1/agents/published-agent/publish", {
      method: "POST", body: JSON.stringify({ revision: created.revision }),
    });

    const client = new RealtimeClient(gateway.url);
    await client.ready();
    client.command({ agent: "published-agent", turnTaking: "conservative", bargeIn: true });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "snapshot");
    await client.until(events => events.some(event => event.type === "turn.completed"), "welcome completion");
    client.sendTurn();
    await client.until(events => events.filter(event => event.type === "turn.completed").length >= 2, "turn completion");

    expect(speech.length).toBeGreaterThanOrEqual(2);
    expect(speech[0]?.input).toBe("欢迎来到已发布的助手。");
    expect(speech.every(call => call.voice === `${voicePrefix("alice")}agentvoice`)).toBe(true);
    expect(chats[0]?.messages[0]?.role).toBe("system");
    expect(chats[0]?.messages[0]?.content).toStartWith("You are the published support persona.");
    expect(chats[0]?.tools?.some(tool => tool.function.name === "save_last_utterance_as_voice")).toBe(false);
    client.close();
  });

  test("Agent conversations persist an owner-scoped, version-pinned trace only when configured", async () => {
    const agentsDir = await root();
    const traceDir = await root();
    const engineFetch: Fetch = async (input, init) => {
      const engineRequest = new Request(input instanceof Request ? input : String(input), init);
      const path = new URL(engineRequest.url).pathname;
      if (path === "/v1/audio/transcriptions") return Response.json({ text: "retained question" });
      if (path === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: "retained answer" } }] });
      if (path === "/v1/audio/speech") return new Response(new Uint8Array(writeWav(new Float32Array(1_200), 24_000)));
      if (path === "/v1/voices") return Response.json({ voices: [] });
      throw new Error(`unexpected engine path ${path}`);
    };
    gateway = startGateway({
      config,
      port: 0,
      agentsDir,
      traceDir,
      traceContent: true,
      authResolver: identity,
      fetch: engineFetch,
    });
    const created = await request("/v1/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "traced",
        name: "Traced",
        spec: { vad: "energy", threshold: 0.1, minSpeechMs: 40, silenceMs: 20 },
      }),
    }).then(response => response.json()) as { revision: number };
    const published = await request("/v1/agents/traced/publish", {
      method: "POST", body: JSON.stringify({ revision: created.revision }),
    }).then(response => response.json()) as { version: { version: number; hash: string } };

    const client = new RealtimeClient(gateway.url);
    await client.ready();
    client.command({ agent: "traced", bargeIn: true });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "snapshot");
    client.sendTurn();
    await client.until(events => events.some(event => event.type === "turn.completed"), "completed turn");
    const sessionId = client.events[0]?.sessionId as string;
    client.stop();
    await client.until(events => events.some(event => event.type === "session.state" && event.state === "closed"), "closed state");

    const listResponse = await request("/v1/agents/traced/conversations");
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as {
      conversations: Array<{ id: string; agentVersion: number; agentHash: string; outcome: string; turnCount: number }>;
      policy: { content: boolean; audio: boolean };
    };
    expect(list.policy).toEqual(expect.objectContaining({ content: true, audio: false }));
    expect(list.conversations).toEqual([expect.objectContaining({
      id: sessionId,
      agentVersion: published.version.version,
      agentHash: published.version.hash,
      outcome: "completed",
      turnCount: 1,
    })]);

    const detail = await request(`/v1/agents/traced/conversations/${sessionId}`).then(response => response.json()) as {
      conversation: { events: GatewayEvent[] };
    };
    expect(detail.conversation.events).toContainEqual(expect.objectContaining({ type: "transcript.final", text: "retained question" }));
    expect(detail.conversation.events).toContainEqual(expect.objectContaining({ type: "response.text.final", text: "retained answer" }));
    expect((await request(`/v1/agents/traced/conversations/${sessionId}`, { user: "bob" })).status).toBe(404);
    expect((await request(`/v1/agents/traced/conversations/${sessionId}`, { method: "DELETE", user: "bob" })).status).toBe(404);
    expect((await request(`/v1/agents/traced/conversations/${sessionId}`, { method: "DELETE" })).status).toBe(200);
    client.close();
  });

  test("the Conversations API reports that retention is disabled instead of returning a fake empty history", async () => {
    gateway = startGateway({ config, port: 0, agentsDir: await root(), authResolver: identity });
    const response = await request("/v1/agents/support/conversations");
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("traces_disabled");
  });

  test("a demo deployment stays pinned to the operator-selected immutable version", async () => {
    const agentsDir = await root();
    gateway = startGateway({ config, port: 0, agentsDir });
    const created = await fetch(new URL("/v1/agents", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "demo",
        name: "Demo",
        spec: { instructions: "Version one", vad: "energy", threshold: 0.1, minSpeechMs: 40, silenceMs: 20 },
      }),
    }).then(response => response.json()) as { revision: number };
    const first = await fetch(new URL("/v1/agents/demo/publish", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: created.revision }),
    }).then(response => response.json()) as { record: { revision: number }; version: { version: number } };
    const updated = await fetch(new URL("/v1/agents/demo", gateway.url), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: first.record.revision,
        spec: { instructions: "Version two", vad: "energy", threshold: 0.1, minSpeechMs: 40, silenceMs: 20 },
      }),
    }).then(response => response.json()) as { revision: number };
    await fetch(new URL("/v1/agents/demo/publish", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: updated.revision }),
    });
    await gateway.stop();

    const chats: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const engineFetch: Fetch = async (input, init) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      const path = new URL(request.url).pathname;
      if (path === "/v1/audio/transcriptions") return Response.json({ text: "hello" });
      if (path === "/v1/chat/completions") {
        chats.push(await request.json() as typeof chats[number]);
        return Response.json({ choices: [{ message: { content: "reply" } }] });
      }
      if (path === "/v1/audio/speech") return new Response(new Uint8Array(writeWav(new Float32Array(1_200), 24_000)));
      if (path === "/v1/voices") return Response.json({ voices: [] });
      throw new Error(`unexpected engine path ${path}`);
    };
    gateway = startGateway({
      config,
      port: 0,
      agentsDir,
      demoMode: true,
      demoAgent: { id: "demo", version: first.version.version },
      fetch: engineFetch,
    });
    const conflictingVersion = await fetch(new URL("/v1/realtime?agent=demo&agent_version=2", gateway.url));
    expect(conflictingVersion.status).toBe(400);
    expect((await conflictingVersion.json() as { error: { code: string } }).error.code).toBe("agent_invalid");
    const client = new RealtimeClient(gateway.url);
    await client.ready();
    client.command({ bargeIn: true });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "snapshot");
    client.sendTurn();
    await client.until(events => events.some(event => event.type === "turn.completed"), "turn completion");
    expect(chats[0]?.messages[0]?.content).toStartWith("Version one");
    client.close();
  });
});
