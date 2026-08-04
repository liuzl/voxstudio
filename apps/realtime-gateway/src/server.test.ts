import { afterEach, describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { parseConfig } from "@voxstudio/config";
import type { Fetch } from "@voxstudio/clients";
import { protocolVersion, type GatewayEvent } from "./protocol";
import { startGateway, type GatewayServer } from "./server";
import { CaptureLibrary } from "./library";
import { voicePrefix } from "./voice-namespace";
import type { AuthContext } from "./auth/auth-context";

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    llm: { base_url: "http://llm.test" },
    tts: { base_url: "http://tts.test", api_key: "sk-engine-secret" },
  },
});

function engineFetch(overrides: Partial<Record<string, (request: Request) => Promise<Response>>> = {}): Fetch {
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    const path = new URL(request.url).pathname;
    const override = overrides[path];
    if (override) return override(request);
    if (path === "/v1/audio/transcriptions") return Response.json({ text: "你好" });
    if (path === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: "回答完毕。" } }] });
    if (path === "/v1/audio/speech") {
      return new Response(new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000)));
    }
    if (path === "/v1/voices") return Response.json({ voices: [] });
    throw new Error(`unexpected engine path ${path}`);
  };
}

/** A test client: JSON events and binary audio collected, with promise-based waiting. */
class TestClient {
  readonly events: GatewayEvent[] = [];
  readonly audio: Uint8Array[] = [];
  private readonly socket: WebSocket;
  private wake: (() => void) | undefined;
  private readonly opened: Promise<void>;
  readonly closed: Promise<void>;

  constructor(url: string, path = "/v1/realtime") {
    this.socket = new WebSocket(new URL(path, url).toString().replace(/^http/, "ws"));
    this.socket.binaryType = "arraybuffer";
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error("websocket error")));
    });
    this.closed = new Promise(resolve => {
      this.socket.addEventListener("close", () => {
        resolve();
        this.wake?.();
      });
    });
    this.socket.addEventListener("message", event => {
      if (typeof event.data === "string") this.events.push(JSON.parse(event.data) as GatewayEvent);
      else this.audio.push(new Uint8Array(event.data as ArrayBuffer));
      this.wake?.();
    });
  }

  async ready(): Promise<void> {
    await this.opened;
  }

  command(payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ v: protocolVersion, ...payload }));
  }

  /** Send `count` frames of 20ms (320-sample) PCM at the given amplitude. */
  sendPcm(count: number, amplitude: number): void {
    for (let index = 0; index < count; index += 1) {
      const samples = new Float32Array(320).fill(amplitude);
      this.socket.send(samples.buffer);
    }
  }

  async until(predicate: (events: GatewayEvent[]) => boolean, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; saw: ${this.events.map(event => event.type).join(", ")}`);
      }
      await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, 50); });
      this.wake = undefined;
    }
  }

  close(): void {
    this.socket.close();
  }
}

const startOptions = {
  language: "zh",
  voice: "demo",
  vad: "energy",
  threshold: 0.1,
  minSpeechMs: 40,
  silenceMs: 20,
  turnTaking: "conservative",
  bargeIn: true,
};

let gateway: GatewayServer | undefined;

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
});

describe("realtime gateway", () => {
  test("refuses a shared token that Realtime SDK clients cannot offer", () => {
    expect(() => startGateway({ config, fetch: engineFetch(), port: 0, token: "base64/secret=" }))
      .toThrow("WebSocket protocol-token");
  });

  test("runs a simulated duplex turn over the WebSocket protocol", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const client = new TestClient(gateway.url);
    await client.ready();

    client.command({ type: "session.start", idempotencyKey: "start-1", options: startOptions });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "session.snapshot");
    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(events => events.some(event => event.type === "turn.completed"), "turn.completed");

    const types = client.events.map(event => event.type);
    expect(types).toContain("command.accepted");
    expect(types).toContain("turn.started");
    expect(types).toContain("vad.end");
    expect(types).toContain("transcript.final");
    expect(types).toContain("response.text.delta");
    expect(types).toContain("response.text.final");
    expect(types).toContain("playback.format");
    expect(types).toContain("playback.ended");
    expect(types).toContain("turn.timing");

    const transcript = client.events.find(event => event.type === "transcript.final");
    expect(transcript && "text" in transcript ? transcript.text : "").toBe("你好");
    const reply = client.events.find(event => event.type === "response.text.final");
    expect(reply && "text" in reply ? reply.text : "").toBe("回答完毕。");
    const format = client.events.find(event => event.type === "playback.format");
    expect(format && "sampleRate" in format ? format.sampleRate : 0).toBe(24_000);
    expect(client.audio.length).toBeGreaterThan(0);
    expect((client.audio[0] as Uint8Array).byteLength % 4).toBe(0);

    // The envelope contract: one session, one schema version, strictly monotonic sequence.
    const sessionIds = new Set(client.events.map(event => event.sessionId));
    expect(sessionIds.size).toBe(1);
    for (const event of client.events) expect(event.v).toBe(protocolVersion);
    const sequences = client.events.map(event => event.sequence);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index] as number).toBeGreaterThan(sequences[index - 1] as number);
    }
    // Latency points ride the same schema the CLI certifies.
    const timing = client.events.find(event => event.type === "turn.timing");
    expect(timing && "offsetsMs" in timing ? Object.keys(timing.offsetsMs) : []).toContain("asr_done");

    client.close();
  });

  test("a tool call executes mid-turn and retargets the next reply's voice", async () => {
    const speechBodies: { voice?: string }[] = [];
    let chatRound = 0;
    gateway = startGateway({
      config,
      port: 0,
      fetch: engineFetch({
        "/v1/voices": async () => Response.json({ voices: [{ id: "zliu" }] }),
        "/v1/audio/speech": async request => {
          speechBodies.push(await request.json() as { voice?: string });
          return new Response(new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000)));
        },
        "/v1/chat/completions": async () => {
          chatRound += 1;
          // Round 1: the model asks for the tool. Round 2 (tool result appended): words.
          // Later turns: plain replies. Plain JSON exercises the degrade path too.
          if (chatRound === 1) {
            return Response.json({ choices: [{ message: { content: "", tool_calls: [
              { id: "c1", type: "function", function: { name: "set_voice", arguments: "{\"voice\":\"zliu\"}" } },
            ] } }] });
          }
          return Response.json({ choices: [{ message: { content: "好的，已切换。" } }] });
        },
      }),
    });
    const client = new TestClient(gateway.url);
    await client.ready();
    client.command({ type: "session.start", idempotencyKey: "start-1", options: startOptions });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "session.snapshot");

    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(events => events.some(event => event.type === "turn.completed"), "tool turn");

    const call = client.events.find(event => event.type === "tool.call");
    expect(call && "name" in call ? call.name : "").toBe("set_voice");
    expect(call && "arguments" in call ? call.arguments : {}).toEqual({ voice: "zliu" });
    const result = client.events.find(event => event.type === "tool.result");
    expect(result && "ok" in result ? result.ok : false).toBe(true);
    const reply = client.events.find(event => event.type === "response.text.final");
    expect(reply && "text" in reply ? reply.text : "").toBe("好的，已切换。");

    // The switch lands on the next turn's synthesis.
    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(
      events => events.filter(event => event.type === "turn.completed").length >= 2, "second turn");
    expect(speechBodies.length).toBeGreaterThan(1);
    expect(speechBodies[speechBodies.length - 1]?.voice).toBe("zliu");

    client.close();
  });

  test("survives a dropped socket: reattach, snapshot resync, no stale or replayed commands", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, reconnectGraceMs: 2_000 });
    const first = new TestClient(gateway.url);
    await first.ready();
    first.command({ type: "session.start", idempotencyKey: "start-1", options: startOptions });
    await first.until(events => events.some(event => event.type === "session.snapshot"), "session.snapshot");
    first.sendPcm(2, 0.2);
    first.sendPcm(2, 0);
    await first.until(events => events.some(event => event.type === "turn.completed"), "first turn");
    const sessionId = (first.events[0] as GatewayEvent).sessionId;
    const staleTurn = first.events.find(event => event.type === "turn.completed");
    const staleTurnId = staleTurn && "turnId" in staleTurn ? staleTurn.turnId : "";
    const lastSeen = Math.max(...first.events.map(event => event.sequence));

    // The connection dies mid-conversation; the session must outlive it.
    first.close();
    await first.closed;
    expect(gateway.sessionCount()).toBe(1);

    const second = new TestClient(gateway.url);
    await second.ready();
    second.command({ type: "session.attach", idempotencyKey: "attach-1", sessionId });
    await second.until(events => events.some(event => event.type === "session.snapshot"), "snapshot after attach");
    const snapshot = second.events.find(event => event.type === "session.snapshot");
    if (!snapshot || !("lastSequence" in snapshot)) throw new Error("missing snapshot");
    // Sequencing continues across the reconnect instead of restarting.
    expect(snapshot.lastSequence).toBeGreaterThan(lastSeen);
    expect(snapshot.state).toBe("listening");

    // A stop replayed from before the drop names a finished turn: rejected as stale, and
    // the session keeps running.
    second.command({ type: "turn.interrupt", idempotencyKey: "int-1", turnId: staleTurnId });
    await second.until(events => events.some(event => event.type === "command.rejected"), "stale rejection");
    const rejected = second.events.find(event => event.type === "command.rejected");
    expect(rejected && "reason" in rejected ? rejected.reason : "").toBe("stale_turn");

    // The same command replayed with the same idempotency key is acknowledged, not re-run.
    second.command({ type: "turn.interrupt", idempotencyKey: "int-1", turnId: staleTurnId });
    await second.until(events => events.some(event => event.type === "command.duplicate"), "duplicate ack");
    expect(second.events.filter(event => event.type === "command.rejected")).toHaveLength(1);

    // The conversation still works on the new socket.
    second.sendPcm(2, 0.2);
    second.sendPcm(2, 0);
    await second.until(events => events.some(event => event.type === "turn.completed"), "turn after reconnect");
    expect(second.events.some(event => event.type === "transcript.final")).toBe(true);

    second.command({ type: "session.stop", idempotencyKey: "stop-1" });
    await second.until(
      events => events.some(event => event.type === "command.accepted" && "idempotencyKey" in event && event.idempotencyKey === "stop-1"),
      "stop accepted",
    );
    second.close();
    await second.closed;
    expect(gateway.sessionCount()).toBe(0);
  });

  test("with playbackAck the turn stays speaking until the client reports audible end", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const client = new TestClient(gateway.url);
    await client.ready();
    client.command({ type: "session.start", idempotencyKey: "start-1", options: { ...startOptions, playbackAck: true } });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "session.snapshot");
    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(events => events.some(event => event.type === "playback.ended"), "playback.ended");

    // The last piece was sent, but the client is still rendering: no completion yet.
    await Bun.sleep(50);
    expect(client.events.some(event => event.type === "turn.completed")).toBe(false);
    const ended = client.events.find(event => event.type === "playback.ended");
    const turnId = ended && "turnId" in ended ? ended.turnId : "";

    client.command({ type: "playback.complete", idempotencyKey: "done-1", turnId });
    await client.until(events => events.some(event => event.type === "turn.completed"), "turn.completed after ack");
    client.close();
  });

  test("an expired reconnect grace ends the session and a late attach is rejected", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, reconnectGraceMs: 50 });
    const first = new TestClient(gateway.url);
    await first.ready();
    first.command({ type: "session.start", idempotencyKey: "start-1", options: startOptions });
    await first.until(events => events.some(event => event.type === "session.snapshot"), "session.snapshot");
    const sessionId = (first.events[0] as GatewayEvent).sessionId;
    first.close();
    await first.closed;

    const deadline = Date.now() + 2_000;
    while (gateway.sessionCount() > 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(gateway.sessionCount()).toBe(0);

    const second = new TestClient(gateway.url);
    await second.ready();
    second.command({ type: "session.attach", idempotencyKey: "attach-1", sessionId });
    await second.until(events => events.some(event => event.type === "command.rejected"), "late attach rejected");
    const rejected = second.events.find(event => event.type === "command.rejected");
    expect(rejected && "reason" in rejected ? rejected.reason : "").toBe("unknown_session");
    second.close();
  });

  test("rejects malformed commands and audio before a session exists", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const client = new TestClient(gateway.url);
    await client.ready();

    client.command({ type: "session.snapshot.request", idempotencyKey: "snap-1" });
    await client.until(events => events.some(event => event.type === "command.rejected"), "no_session rejection");
    expect(client.events.map(event => "reason" in event ? event.reason : "")).toContain("no_session");

    client.command({ type: "session.start" });
    await client.until(
      events => events.filter(event => event.type === "command.rejected").length >= 2,
      "missing idempotency key rejection",
    );
    const reasons = client.events.filter(event => event.type === "command.rejected").map(event => "reason" in event ? event.reason : "");
    expect(reasons.some(reason => String(reason).includes("idempotencyKey"))).toBe(true);
    client.close();
  });

  test("the REST facade proxies the engine contract and injects credentials server-side", async () => {
    const seenAuth: (string | null)[] = [];
    gateway = startGateway({
      config,
      port: 0,
      fetch: engineFetch({
        "/v1/voices": async request => {
          seenAuth.push(request.headers.get("authorization"));
          return Response.json({ voices: [{ id: "laok" }] });
        },
        "/v1/chat/completions": async request => {
          const body = await request.json() as { messages: unknown[] };
          return Response.json({ choices: [{ message: { content: `echo ${body.messages.length}` } }] });
        },
      }),
    });

    const voices = await fetch(new URL("/v1/voices", gateway.url));
    expect(voices.status).toBe(200);
    // The bank is aggregated with engine attribution even for a single instance.
    expect(await voices.json()).toEqual({ voices: [{ id: "laok", engine: "tts" }] });
    // The engine key was injected by the gateway, never supplied by the client.
    expect(seenAuth).toEqual(["Bearer sk-engine-secret"]);

    const chat = await fetch(new URL("/v1/chat/completions", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.status).toBe(200);
    expect(await chat.json()).toEqual({ choices: [{ message: { content: "echo 1" } }] });

    const missing = await fetch(new URL("/v1/other", gateway.url));
    expect(missing.status).toBe(404);
    const wrongMethod = await fetch(new URL("/v1/voices", gateway.url), { method: "PUT" });
    expect(wrongMethod.status).toBe(405);
  });

  test("routes across a multi-engine registry: aggregation, capability, explicit override", async () => {
    // Two TTS instances: the fast lane serves the tts role; the clone line declares clone.
    const registry = parseConfig({
      engines: {
        kokoro: { kind: "tts", base_url: "http://kokoro.test", model: "kokoro", capabilities: ["preset", "fast"] },
        voxcpm2: { kind: "tts", base_url: "http://voxcpm2.test", model: "voxcpm2", capabilities: ["clone", "design"] },
        asr: { base_url: "http://asr.test" },
        llm: { base_url: "http://llm.test" },
      },
      roles: { tts: "kokoro" },
    });
    const hits: string[] = [];
    const speechBodies: Record<string, unknown>[] = [];
    gateway = startGateway({
      config: registry,
      port: 0,
      fetch: async (input, init) => {
        const engineRequest = new Request(input instanceof Request ? input : String(input), init);
        const url = new URL(engineRequest.url);
        hits.push(`${engineRequest.method} ${url.host}${url.pathname}`);
        if (url.pathname === "/v1/voices" && url.host === "kokoro.test") {
          return Response.json({ voices: [{ id: "zf_001" }] });
        }
        if (url.pathname === "/v1/voices" && url.host === "voxcpm2.test") {
          return url.searchParams.toString() === "" && (init?.method ?? "GET") === "POST"
            ? Response.json({ id: "laok" }, { status: 201 })
            : Response.json({ voices: [{ id: "laok", design_profile: { description: "calm", seed: 7 } }] });
        }
        if (url.pathname === "/v1/design-profiles") return Response.json({ id: "calm" }, { status: 201 });
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", model: `${url.host.split(".")[0]}@1.0`, model_manifest_sha256: "abc123" });
        }
        if (url.pathname === "/v1/audio/speech") {
          speechBodies.push(await engineRequest.json() as Record<string, unknown>);
          return new Response(new Uint8Array(8));
        }
        throw new Error(`unexpected ${url.href}`);
      },
    });

    // The bank is the union, each entry attributed to its engine; design-profile
    // metadata rides through for fingerprint badges and audits.
    const bank = await (await fetch(new URL("/v1/voices", gateway.url))).json() as { voices: Record<string, unknown>[] };
    expect(bank.voices).toEqual([
      { id: "zf_001", engine: "kokoro" },
      { id: "laok", engine: "voxcpm2", design_profile: { description: "calm", seed: 7 } },
    ]);

    // Registration auto-routes to the clone-capable instance, not the fast lane.
    const form = new FormData();
    form.set("id", "laok");
    form.set("text", "参考音");
    form.set("audio", new File([new Uint8Array(8)], "ref.wav"));
    expect((await fetch(new URL("/v1/voices", gateway.url), { method: "POST", body: form })).status).toBe(201);
    expect(hits.some(hit => hit === "POST voxcpm2.test/v1/voices")).toBe(true);

    // Synthesis defaults to the role engine; ?engine= overrides; wrong names are 400.
    const base = gateway.url;
    const speak = (query = "") => fetch(new URL(`/v1/audio/speech${query}`, base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", input: "你好" }),
    });
    expect((await speak()).status).toBe(200);
    expect(hits.at(-1)).toBe("POST kokoro.test/v1/audio/speech");
    expect(speechBodies.at(-1)?.model).toBe("kokoro");
    expect((await speak("?engine=voxcpm2")).status).toBe(200);
    expect(hits.at(-1)).toBe("POST voxcpm2.test/v1/audio/speech");
    expect(speechBodies.at(-1)?.model).toBe("voxcpm2");
    expect((await speak("?engine=ghost")).status).toBe(400);
    expect((await speak("?engine=asr")).status).toBe(400);

    // Design-profile creation routes by the design capability.
    const created = await fetch(new URL("/v1/design-profiles", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "calm", description: "calm voice", anchor_text: "锚文本。", seed: 7 }),
    });
    expect(created.status).toBe(201);
    expect(hits.at(-1)).toBe("POST voxcpm2.test/v1/design-profiles");

    // The sanitized registry: names, kinds, capabilities, roles, health — no addresses.
    const listed = await (await fetch(new URL("/v1/engines", gateway.url))).json() as {
      engines: Record<string, unknown>[];
      mcpServers: string[];
    };
    const names = listed.engines.map(entry => entry.name);
    expect(names).toContain("kokoro");
    expect(names).toContain("voxcpm2");
    const kokoro = listed.engines.find(entry => entry.name === "kokoro");
    expect(kokoro).toMatchObject({
      kind: "tts",
      roles: ["tts"],
      healthy: true,
      capabilities: ["preset", "fast"],
      runtime: { model: "kokoro@1.0", manifestSha256: "abc123" },
    });
    expect(listed.mcpServers).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain("kokoro.test");
  });

  test("the facade proxies voice registration and per-voice entries", async () => {
    const seen: { method: string; path: string; contentType: string | null }[] = [];
    gateway = startGateway({
      config,
      port: 0,
      fetch: engineFetch({
        "/v1/voices": async request => {
          seen.push({
            method: request.method,
            path: new URL(request.url).pathname,
            contentType: request.headers.get("content-type"),
          });
          if (request.method === "POST") {
            const form = await request.formData();
            return Response.json({ id: form.get("id") }, { status: 201 });
          }
          return Response.json({ voices: [] });
        },
        "/v1/voices/laok": async request => {
          seen.push({ method: request.method, path: new URL(request.url).pathname, contentType: null });
          return request.method === "DELETE" ? Response.json({ deleted: true }) : Response.json({ id: "laok" });
        },
      }),
    });

    const form = new FormData();
    form.set("id", "laok");
    form.set("text", "参考音的逐字稿");
    form.set("audio", new File([new Uint8Array(16)], "ref.wav", { type: "audio/wav" }));
    const created = await fetch(new URL("/v1/voices", gateway.url), { method: "POST", body: form });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: "laok" });
    // Multipart bodies stream through intact, boundary and all.
    expect(seen[0]?.contentType).toStartWith("multipart/form-data");

    expect((await fetch(new URL("/v1/voices/laok", gateway.url))).status).toBe(200);
    expect((await fetch(new URL("/v1/voices/laok", gateway.url), { method: "DELETE" })).status).toBe(200);
    // Path traversal and malformed ids never reach an engine.
    expect((await fetch(new URL("/v1/voices/laok/extra", gateway.url))).status).toBe(404);
    expect(seen.map(entry => entry.method)).toEqual(["POST", "GET", "DELETE"]);
  });

  test("registers one uploaded reference on explicit clone-engine replicas and reports partial failure", async () => {
    const registry = parseConfig({
      engines: {
        primary: { kind: "tts", base_url: "http://primary.test", model: "voxcpm2", capabilities: ["clone"] },
        remote: { kind: "tts", base_url: "http://remote.test", model: "voxcpm2", capabilities: ["clone"] },
        asr: { base_url: "http://asr.test" },
        llm: { base_url: "http://llm.test" },
      },
      roles: { tts: "primary" },
    });
    const received: { engine: string; id: string; text: string; bytes: number }[] = [];
    let remoteFails = true;
    gateway = startGateway({
      config: registry,
      port: 0,
      fetch: async (input, init) => {
        const engineRequest = new Request(input instanceof Request ? input : String(input), init);
        const url = new URL(engineRequest.url);
        if (url.pathname !== "/v1/voices") throw new Error(`unexpected engine path ${url.pathname}`);
        if (engineRequest.method === "GET") return Response.json({ voices: [] });
        const form = await engineRequest.formData();
        received.push({
          engine: url.hostname.split(".")[0] as string,
          id: String(form.get("id")),
          text: String(form.get("text")),
          bytes: (form.get("audio") as File).size,
        });
        if (url.hostname === "remote.test" && remoteFails) {
          return Response.json({ error: { code: "registry_busy", message: "try again" } }, { status: 503 });
        }
        return Response.json({ id: form.get("id") }, { status: 201 });
      },
    });

    const registration = (engines: string[]): FormData => {
      const form = new FormData();
      form.set("id", "shuber");
      form.set("text", "今天天气不太好，又下雨了。");
      form.set("audio", new File([new Uint8Array([1, 2, 3, 4])], "ref.wav", { type: "audio/wav" }));
      for (const engine of engines) form.append("engine", engine);
      return form;
    };

    const partial = await fetch(new URL("/v1/voices", gateway.url), {
      method: "POST",
      body: registration(["primary", "remote"]),
    });
    expect(partial.status).toBe(207);
    expect(await partial.json()).toEqual({
      id: "shuber",
      registered: ["primary"],
      failed: ["remote"],
      results: [
        { engine: "primary", ok: true, status: 201 },
        { engine: "remote", ok: false, status: 503, error: { code: "registry_busy", message: "try again" } },
      ],
    });
    expect(received).toEqual([
      { engine: "primary", id: "shuber", text: "今天天气不太好，又下雨了。", bytes: 4 },
      { engine: "remote", id: "shuber", text: "今天天气不太好，又下雨了。", bytes: 4 },
    ]);

    remoteFails = false;
    const retried = await fetch(new URL("/v1/voices", gateway.url), {
      method: "POST",
      body: registration(["remote"]),
    });
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({ id: "shuber", registered: ["remote"], failed: [] });

    const invalid = await fetch(new URL("/v1/voices", gateway.url), {
      method: "POST",
      body: registration(["missing"]),
    });
    expect(invalid.status).toBe(400);
    expect(received).toHaveLength(3);
  });

  test("a configured token gates both the facade and the realtime endpoint", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, token: "gw-secret" });

    const denied = await fetch(new URL("/v1/voices", gateway.url));
    expect(denied.status).toBe(401);
    const allowed = await fetch(new URL("/v1/voices", gateway.url), {
      headers: { authorization: "Bearer gw-secret" },
    });
    expect(allowed.status).toBe(200);

    // The library routes sit behind the same gate (this gateway has no library, so an
    // authorized request gets the structured 404, never a bare one).
    expect((await fetch(new URL("/v1/library", gateway.url))).status).toBe(401);
    expect((await fetch(new URL("/v1/library/x/promote", gateway.url), { method: "POST" })).status).toBe(401);
    const authorizedLibrary = await fetch(new URL("/v1/library", gateway.url), {
      headers: { authorization: "Bearer gw-secret" },
    });
    expect(authorizedLibrary.status).toBe(404);
    expect((await authorizedLibrary.json() as { error: { code: string } }).error.code).toBe("library_disabled");
    // Health stays reachable for probes, and reports no session details.
    const health = await fetch(new URL("/healthz", gateway.url));
    expect(health.status).toBe(200);

    const deniedSocket = new TestClient(gateway.url);
    await expect(deniedSocket.ready()).rejects.toThrow();
    const allowedSocket = new TestClient(gateway.url, "/v1/realtime?token=gw-secret");
    await allowedSocket.ready();
    allowedSocket.close();
  });

  test("a cross-site Origin is refused at the WebSocket upgrade; same-origin and loopback pass", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const wsUrl = new URL("/v1/realtime", gateway.url).toString().replace(/^http/, "ws");
    const connect = (origin?: string): Promise<WebSocket> => new Promise((resolve, reject) => {
      // Bun's WebSocket client accepts custom headers; browsers set Origin themselves.
      const socket = new WebSocket(wsUrl, (origin === undefined ? {} : { headers: { origin } }) as never);
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", () => reject(new Error(`refused (origin ${origin ?? "none"})`)));
    });

    await expect(connect("https://evil.example")).rejects.toThrow();

    const sameOrigin = await connect(new URL(gateway.url).origin);
    sameOrigin.close();
    const devServer = await connect("http://localhost:5173");
    devServer.close();
    const headerless = await connect();
    headerless.close();
  });

  test("serves the web app shell around the guarded API", async () => {
    const dir = `${import.meta.dir}/../node_modules/.test-static-${Date.now().toString(36)}`;
    await Bun.write(`${dir}/index.html`, "<html><body>studio-shell</body></html>");
    await Bun.write(`${dir}/assets/app-abc123.js`, "console.log('app');");
    gateway = startGateway({
      config,
      fetch: engineFetch(),
      port: 0,
      token: "gw-secret",
      staticAssets: {
        "/index.html": `${dir}/index.html`,
        "/assets/app-abc123.js": `${dir}/assets/app-abc123.js`,
      },
    });

    // The shell loads without the token: a page load cannot carry a bearer header.
    const home = await fetch(gateway.url);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("studio-shell");
    expect(home.headers.get("cache-control")).toBe("no-cache");

    // Hashed bundles are immutable; client-side routes fall back to the entry.
    const bundle = await fetch(new URL("/assets/app-abc123.js", gateway.url));
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("cache-control")).toContain("immutable");
    const deepLink = await fetch(new URL("/settings", gateway.url));
    expect(await deepLink.text()).toContain("studio-shell");

    // The API keeps its gate: static serving must not blanket /v1.
    expect((await fetch(new URL("/v1/engines", gateway.url))).status).toBe(401);
    expect((await fetch(gateway.url, { method: "POST" })).status).toBe(401);
  });
});

describe("public demo guardrails", () => {
  test("the session cap refuses the N+1th conversation and frees on close", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, maxSessions: 1 });
    const first = new TestClient(gateway.url);
    await first.ready();
    first.command({ type: "session.start", idempotencyKey: "cap-1", options: startOptions });
    await first.until(events => events.some(event => event.type === "session.snapshot"), "first session up");

    const second = new TestClient(gateway.url);
    await second.ready();
    second.command({ type: "session.start", idempotencyKey: "cap-2", options: startOptions });
    await second.until(events => events.some(event =>
      event.type === "command.rejected" && "reason" in event && event.reason === "session_capacity"), "capacity rejection");

    // A freed slot admits the next conversation: the cap gates concurrency, not totals.
    first.command({ type: "session.stop", idempotencyKey: "cap-3" });
    await first.until(events => events.some(event => event.type === "session.state" && "state" in event && event.state === "closed"), "closed");
    const third = new TestClient(gateway.url);
    await third.ready();
    third.command({ type: "session.start", idempotencyKey: "cap-4", options: startOptions });
    await third.until(events => events.some(event => event.type === "session.snapshot"), "slot reused");
    first.close(); second.close(); third.close();
  });

  test("a session notices and stops at the duration ceiling", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, maxSessionSeconds: 0.3 });
    const client = new TestClient(gateway.url);
    await client.ready();
    client.command({ type: "session.start", idempotencyKey: "ttl-1", options: startOptions });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "session up");
    await client.until(events => events.some(event =>
      event.type === "session.notice" && "message" in event && String(event.message).includes("demo ceiling")), "ceiling notice");
    await client.until(events => events.some(event =>
      event.type === "session.state" && "state" in event && event.state === "closed"), "stopped");
    client.close();
  });

  test("demo mode: registry writes 403, reads stay, MCP stays unconnected", async () => {
    const mcpConfig = parseConfig({
      engines: {
        asr: { base_url: "http://asr.test" },
        llm: { base_url: "http://llm.test" },
        tts: { base_url: "http://tts.test", api_key: "sk-engine-secret" },
      },
      mcp_servers: { memo: { command: "bun", args: ["packages/mcp/tools/memo-server.ts"] } },
    });
    const lines: string[] = [];
    gateway = startGateway({ config: mcpConfig, fetch: engineFetch(), port: 0, demoMode: true, log: line => lines.push(line) });

    const voicesPost = await fetch(new URL("/v1/voices", gateway.url), { method: "POST", body: "{}" });
    expect(voicesPost.status).toBe(403);
    const profilePost = await fetch(new URL("/v1/design-profiles", gateway.url), { method: "POST", body: "{}" });
    expect(profilePost.status).toBe(403);
    const voiceDelete = await fetch(new URL("/v1/voices/alice", gateway.url), { method: "DELETE" });
    expect(voiceDelete.status).toBe(403);
    expect((await voicesPost.json() as { error: { code: string } }).error.code).toBe("demo_mode");

    const voicesGet = await fetch(new URL("/v1/voices", gateway.url));
    expect(voicesGet.status).toBe(200);
    expect(lines.some(line => line.includes("mcp:"))).toBe(false);
  });
});

describe("capture library", () => {
  const tempDir = (): string => `${import.meta.dir}/../node_modules/.test-capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  test("a conversation turn ingests a capture; the REST workflow corrects, promotes, deletes", async () => {
    const dir = tempDir();
    const registrations: { id: string; text: string; audioBytes: number }[] = [];
    gateway = startGateway({
      config,
      port: 0,
      libraryDir: dir,
      fetch: engineFetch({
        "/v1/voices": async request => {
          if (request.method === "POST") {
            const form = await request.formData();
            registrations.push({
              id: String(form.get("id")),
              text: String(form.get("text")),
              audioBytes: (form.get("audio") as File).size,
            });
            return Response.json({ id: form.get("id") }, { status: 201 });
          }
          return Response.json({ voices: [] });
        },
      }),
    });
    const client = new TestClient(gateway.url);
    await client.ready();
    client.command({ type: "session.start", idempotencyKey: "lib-1", options: startOptions });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "session up");
    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(events => events.some(event => event.type === "turn.completed"), "turn.completed");
    client.close();

    // The utterance was retained with its raw ASR text and the owning session.
    const listed = await (await fetch(new URL("/v1/library", gateway.url))).json() as {
      captures: { id: string; transcript: string; corrected: string | null; session_id: string; duration_ms: number }[];
      total: number;
    };
    expect(listed.total).toBe(1);
    const capture = listed.captures[0]!;
    expect(capture.transcript).toBe("你好");
    expect(capture.corrected).toBeNull();
    expect(capture.session_id).not.toBe("");
    expect(capture.duration_ms).toBeGreaterThan(0);

    // The audio round-trips as a WAV.
    const audio = await fetch(new URL(`/v1/library/${capture.id}/audio`, gateway.url));
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    const bytes = new Uint8Array(await audio.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");

    // Inline correction: the reference lands next to the untouched raw transcript.
    const corrected = await fetch(new URL(`/v1/library/${capture.id}`, gateway.url), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ corrected: "你好。" }),
    });
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({ transcript: "你好", corrected: "你好。" });

    // Promote registers the capture as a voice sample with the corrected text.
    const promoted = await fetch(new URL(`/v1/library/${capture.id}/promote`, gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice_id: "lib-sample" }),
    });
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ engine: "tts", capture: { promoted_voice_id: "lib-sample" } });
    expect(registrations).toEqual([{ id: "lib-sample", text: "你好。", audioBytes: bytes.byteLength }]);

    // Bad promotes are refused before any engine sees them.
    const badVoice = await fetch(new URL(`/v1/library/${capture.id}/promote`, gateway.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice_id: "../evil" }),
    });
    expect(badVoice.status).toBe(400);

    const deleted = await fetch(new URL(`/v1/library/${capture.id}`, gateway.url), { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(((await (await fetch(new URL("/v1/library", gateway.url))).json()) as { total: number }).total).toBe(0);
    expect((await fetch(new URL(`/v1/library/${capture.id}/audio`, gateway.url))).status).toBe(404);

    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  });

  test("an empty-transcript capture is kept but refuses to promote until corrected", async () => {
    const dir = tempDir();
    gateway = startGateway({
      config,
      port: 0,
      libraryDir: dir,
      fetch: engineFetch({
        "/v1/audio/transcriptions": async () => Response.json({ text: "" }),
      }),
    });
    const client = new TestClient(gateway.url);
    await client.ready();
    client.command({ type: "session.start", idempotencyKey: "lib-2", options: startOptions });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "session up");
    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    // An empty transcript cancels the turn, but the sample is already retained.
    await client.until(events => events.some(event => event.type === "error"), "asr_empty error");
    client.close();

    const deadline = Date.now() + 2_000;
    let captures: { id: string; transcript: string }[] = [];
    while (Date.now() < deadline) {
      captures = ((await (await fetch(new URL("/v1/library", gateway.url))).json()) as { captures: typeof captures }).captures;
      if (captures.length > 0) break;
      await Bun.sleep(20);
    }
    expect(captures).toHaveLength(1);
    expect(captures[0]!.transcript).toBe("");

    const refused = await fetch(new URL(`/v1/library/${captures[0]!.id}/promote`, gateway.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice_id: "nope" }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("empty_transcript");

    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  });

  test("a delete during a promote's engine round-trip waits its turn", async () => {
    const dir = tempDir();
    let releaseEngine!: () => void;
    const engineGate = new Promise<void>(resolve => { releaseEngine = resolve; });
    gateway = startGateway({
      config,
      port: 0,
      libraryDir: dir,
      fetch: engineFetch({
        "/v1/voices": async request => {
          if (request.method === "POST") {
            await engineGate;
            return Response.json({ id: "race-voice" }, { status: 201 });
          }
          return Response.json({ voices: [] });
        },
      }),
    });
    const client = new TestClient(gateway.url);
    await client.ready();
    client.command({ type: "session.start", idempotencyKey: "race-1", options: startOptions });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "session up");
    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(events => events.some(event => event.type === "turn.completed"), "turn.completed");
    client.close();
    const capture = ((await (await fetch(new URL("/v1/library", gateway.url))).json()) as { captures: { id: string }[] }).captures[0]!;

    // Promote parks on the (held) clone engine; the delete queues behind its lock.
    const promoting = fetch(new URL(`/v1/library/${capture.id}/promote`, gateway.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice_id: "race-voice" }),
    });
    await Bun.sleep(50);
    const deleting = fetch(new URL(`/v1/library/${capture.id}`, gateway.url), { method: "DELETE" });
    await Bun.sleep(50);
    releaseEngine();

    const [promoted, deleted] = await Promise.all([promoting, deleting]);
    // The promote completed and was recorded before the delete ran — never a 200 with
    // an undefined capture and an untracked voice on the engine.
    expect(promoted.status).toBe(200);
    expect(((await promoted.json()) as { capture: { promoted_voice_id: string } }).capture.promoted_voice_id).toBe("race-voice");
    expect(deleted.status).toBe(200);
    expect(((await (await fetch(new URL("/v1/library", gateway.url))).json()) as { total: number }).total).toBe(0);
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  });

  test("shutdown drains an in-flight promote instead of closing the store under it", async () => {
    const dir = tempDir();
    let releaseEngine!: () => void;
    const engineGate = new Promise<void>(resolve => { releaseEngine = resolve; });
    gateway = startGateway({
      config,
      port: 0,
      libraryDir: dir,
      fetch: engineFetch({
        "/v1/voices": async request => {
          if (request.method === "POST") {
            await engineGate;
            return Response.json({ id: "drain-voice" }, { status: 201 });
          }
          return Response.json({ voices: [] });
        },
      }),
    });
    const client = new TestClient(gateway.url);
    await client.ready();
    client.command({ type: "session.start", idempotencyKey: "drain-1", options: startOptions });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "session up");
    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(events => events.some(event => event.type === "turn.completed"), "turn.completed");
    client.close();
    await client.closed;
    const capture = ((await (await fetch(new URL("/v1/library", gateway.url))).json()) as { captures: { id: string }[] }).captures[0]!;

    const promoting = fetch(new URL(`/v1/library/${capture.id}/promote`, gateway.url), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice_id: "drain-voice" }),
    }).then(response => response.status, () => "connection-lost" as const);
    await Bun.sleep(50);
    const stopping = gateway.stop();
    await Bun.sleep(50);
    releaseEngine();
    // The observable contract: stop() settles (no wedge, no crash on a closed database);
    // the response itself may be lost to the force-closed socket.
    await stopping;
    const outcome = await promoting;
    expect([200, 503, "connection-lost"]).toContain(outcome);

    // The drained write reached the store before it closed.
    const { CaptureLibrary } = await import("./library");
    const reopened = new CaptureLibrary(dir);
    expect(reopened.get(capture.id)?.promoted_voice_id).toBe("drain-voice");
    await reopened.close();
    gateway = undefined;
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  });

  test("without a library the routes answer a structured library_disabled", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const listed = await fetch(new URL("/v1/library", gateway.url));
    expect(listed.status).toBe(404);
    expect((await listed.json() as { error: { code: string } }).error.code).toBe("library_disabled");
  });

  test("demo mode keeps the library off even when a directory is configured", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, libraryDir: dir, demoMode: true, log: line => lines.push(line) });
    const listed = await fetch(new URL("/v1/library", gateway.url));
    expect(listed.status).toBe(404);
    expect((await listed.json() as { error: { code: string } }).error.code).toBe("library_disabled");
    expect(lines.some(line => line.includes("capture library stays off"))).toBe(true);
    // No store was created: nothing to retain into.
    expect(await Bun.file(`${dir}/library.db`).exists()).toBe(false);
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  });
});

describe("resource ownership (docs/auth.md phase 2)", () => {
  // The phase-3 seam, used here to simulate account holders: identity from a test
  // header or query param, defaulting to the owner.
  const accountResolver = (request: Request): AuthContext => ({
    userId: request.headers.get("x-test-user") ?? new URL(request.url).searchParams.get("user") ?? "owner",
    via: "session",
  });
  const wavBytes = (): Uint8Array => new Uint8Array(writeWav(new Float32Array(16_000).fill(0.05), 16_000));
  const tempDir = (): string => `${import.meta.dir}/../node_modules/.test-owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  test("captures are visible only to their owner across every route", async () => {
    const dir = tempDir();
    const seeded = new CaptureLibrary(dir);
    const alices = await seeded.ingest(wavBytes(), "alice 的话", "session-a", "alice");
    const bobs = await seeded.ingest(wavBytes(), "bob 的话", "session-b", "bob");
    await seeded.close();

    gateway = startGateway({ config, fetch: engineFetch(), port: 0, libraryDir: dir, authResolver: accountResolver });
    const as = (user: string, path: string, init?: RequestInit): Promise<Response> =>
      fetch(new URL(path, gateway?.url), { ...init, headers: { ...(init?.headers ?? {}), "x-test-user": user } });

    const listed = await (await as("alice", "/v1/library")).json() as { captures: { id: string }[]; total: number };
    expect(listed.captures.map(capture => capture.id)).toEqual([alices.id]);
    expect(listed.total).toBe(1);
    expect((await as("alice", `/v1/library/${bobs.id}`)).status).toBe(404);
    expect((await as("alice", `/v1/library/${bobs.id}/audio`)).status).toBe(404);
    expect((await as("alice", `/v1/library/${bobs.id}`, { method: "PATCH", body: JSON.stringify({ corrected: "偷改" }) })).status).toBe(404);
    expect((await as("alice", `/v1/library/${bobs.id}`, { method: "DELETE" })).status).toBe(404);
    // Bob's capture survived it all, untouched.
    const bobsView = await (await as("bob", `/v1/library/${bobs.id}`)).json() as { corrected: string | null };
    expect(bobsView.corrected).toBeNull();
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  });

  test("voice names are namespaced per account holder; the owner keeps the bare bank", async () => {
    const seen: { method: string; path: string; formId?: string }[] = [];
    const bank = ["laok", `${voicePrefix("alice")}myvoice`, `${voicePrefix("bob")}myvoice`];
    gateway = startGateway({
      config,
      port: 0,
      authResolver: accountResolver,
      fetch: async (input, init) => {
        const request = new Request(input instanceof Request ? input : String(input), init);
        const path = new URL(request.url).pathname;
        if (path === "/v1/voices" && request.method === "GET") {
          return Response.json({ voices: bank.map(id => ({ id })) });
        }
        if (path === "/v1/voices" && request.method === "POST") {
          const form = await request.formData();
          seen.push({ method: "POST", path, formId: String(form.get("id")) });
          return Response.json({ id: form.get("id") }, { status: 201 });
        }
        if (path.startsWith("/v1/voices/")) {
          seen.push({ method: request.method, path });
          return Response.json({ deleted: true });
        }
        throw new Error(`unexpected engine path ${path}`);
      },
    });
    const as = (user: string, path: string, init?: RequestInit): Promise<Response> =>
      fetch(new URL(path, gateway?.url), { ...init, headers: { ...(init?.headers ?? {}), "x-test-user": user } });

    // Each viewer sees exactly their namespace, in display names.
    const aliceBank = await (await as("alice", "/v1/voices")).json() as { voices: { id: string }[] };
    expect(aliceBank.voices.map(voice => voice.id)).toEqual(["myvoice"]);
    const ownerBank = await (await as("owner", "/v1/voices")).json() as { voices: { id: string }[] };
    expect(ownerBank.voices.map(voice => voice.id)).toEqual(["laok"]);

    // Registration maps the display name onto the account's engine id.
    const form = new FormData();
    form.set("id", "fresh");
    form.set("text", "参考音");
    form.set("audio", new File([new Uint8Array(16)], "ref.wav", { type: "audio/wav" }));
    expect((await as("alice", "/v1/voices", { method: "POST", body: form })).status).toBe(201);
    expect(seen[0]?.formId).toBe(`${voicePrefix("alice")}fresh`);

    // Entry routes map the path; an unfittable name never reaches an engine.
    expect((await as("alice", "/v1/voices/fresh", { method: "DELETE" })).status).toBe(200);
    expect(seen[1]?.path).toBe(`/v1/voices/${voicePrefix("alice")}fresh`);
    expect((await as("alice", `/v1/voices/${"x".repeat(64)}`, { method: "DELETE" })).status).toBe(400);
  });

  test("a session can be reattached only by its owner; a cross-owner attach reads as unknown", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, reconnectGraceMs: 60_000, authResolver: accountResolver });
    const alice = new TestClient(gateway.url, "/v1/realtime?user=alice");
    await alice.ready();
    alice.command({ type: "session.start", idempotencyKey: "own-1", options: startOptions });
    await alice.until(events => events.some(event => event.type === "session.snapshot"), "session up");
    const sessionId = (alice.events[0] as GatewayEvent).sessionId;
    alice.close();
    await alice.closed;

    const bob = new TestClient(gateway.url, "/v1/realtime?user=bob");
    await bob.ready();
    bob.command({ type: "session.attach", idempotencyKey: "steal-1", sessionId });
    await bob.until(events => events.some(event => event.type === "command.rejected"), "cross-owner rejection");
    const rejected = bob.events.find(event => event.type === "command.rejected");
    expect(rejected && "reason" in rejected ? rejected.reason : "").toBe("unknown_session");
    bob.close();

    // The owner of the session reattaches as before.
    const aliceAgain = new TestClient(gateway.url, "/v1/realtime?user=alice");
    await aliceAgain.ready();
    aliceAgain.command({ type: "session.attach", idempotencyKey: "back-1", sessionId });
    await aliceAgain.until(events => events.some(event => event.type === "session.snapshot"), "owner reattach");
    aliceAgain.command({ type: "session.stop", idempotencyKey: "stop-1" });
    await aliceAgain.until(events => events.some(event => event.type === "command.accepted" && "idempotencyKey" in event && event.idempotencyKey === "stop-1"), "stopped");
  });

  test("promote records the display name while the engine hears the namespaced id", async () => {
    const dir = tempDir();
    const seeded = new CaptureLibrary(dir);
    const capture = await seeded.ingest(wavBytes(), "拿去克隆", "session-a", "alice");
    await seeded.close();

    let engineHeard: string | undefined;
    gateway = startGateway({
      config,
      port: 0,
      libraryDir: dir,
      authResolver: accountResolver,
      fetch: engineFetch({
        "/v1/voices": async request => {
          const form = await request.formData();
          engineHeard = String(form.get("id"));
          return Response.json({ id: form.get("id") }, { status: 201 });
        },
      }),
    });
    const promoted = await fetch(new URL(`/v1/library/${capture.id}/promote`, gateway.url), {
      method: "POST",
      headers: { "x-test-user": "alice" },
      body: JSON.stringify({ voice_id: "made" }),
    });
    expect(promoted.status).toBe(200);
    expect(engineHeard).toBe(`${voicePrefix("alice")}made`);
    const record = (await promoted.json() as { capture: { promoted_voice_id: string } }).capture;
    expect(record.promoted_voice_id).toBe("made");
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  });
});

describe("the JSON error contract the documents promise (adversarial review 2026-07-26)", () => {
  /** Every API error must be `{"error":{"message","code"}}` — agents branch on `code`. */
  const envelope = async (response: Response): Promise<{ status: number; code: string; message: string }> => {
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json() as { error?: { code?: string; message?: string } };
    return { status: response.status, code: body.error?.code ?? "", message: body.error?.message ?? "" };
  };

  test("an unauthenticated /v1 request is refused in the documented envelope", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, token: "gw-secret" });
    const refused = await envelope(await fetch(new URL("/v1/engines", gateway.url)));
    expect(refused.status).toBe(401);
    expect(refused.code).toBe("unauthorized");
    expect(refused.message.length).toBeGreaterThan(0);
  });

  test("a wrong method, an unknown /v1 path, and a non-upgrade socket all answer in the envelope", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const wrongMethod = await envelope(await fetch(new URL("/v1/engines", gateway.url), { method: "POST" }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.code).toBe("method_not_allowed");

    const unknown = await envelope(await fetch(new URL("/v1/nope", gateway.url)));
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe("not_found");

    // A plain GET on the realtime path is not an upgrade.
    const notUpgraded = await envelope(await fetch(new URL("/v1/realtime", gateway.url)));
    expect(notUpgraded.status).toBe(426);
    expect(notUpgraded.code).toBe("upgrade_required");
  });

  test("a cross-site upgrade is refused in the envelope too", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const forbidden = await envelope(await fetch(new URL("/v1/realtime", gateway.url), {
      headers: { origin: "https://evil.example", upgrade: "websocket", connection: "upgrade" },
    }));
    expect(forbidden.status).toBe(403);
    expect(forbidden.code).toBe("forbidden_origin");
  });

  test("the app shell is still HTML — the envelope is for the API, not for pages", async () => {
    const dir = `${import.meta.dir}/../node_modules/.test-envelope-${Date.now().toString(36)}`;
    await Bun.write(`${dir}/index.html`, "<html><body>studio-shell</body></html>");
    gateway = startGateway({
      config,
      fetch: engineFetch(),
      port: 0,
      staticAssets: { "/index.html": `${dir}/index.html` },
    });
    const page = await fetch(new URL("/settings", gateway.url));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("studio-shell");
    // But an API path under the same gateway keeps the JSON contract.
    const api = await envelope(await fetch(new URL("/v1/nope", gateway.url)));
    expect(api.code).toBe("not_found");
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  });
});

describe("voice namespace enforcement on every synthesis path (adversarial review 2026-07-26)", () => {
  const asAlice = (request: Request): AuthContext => ({
    userId: request.headers.get("x-test-user") ?? new URL(request.url).searchParams.get("user") ?? "alice",
    via: "session",
  });

  test("the speech facade maps the caller's display voice onto their engine namespace", async () => {
    const bodies: { voice?: string }[] = [];
    gateway = startGateway({
      config,
      port: 0,
      authResolver: asAlice,
      fetch: engineFetch({
        "/v1/audio/speech": async request => {
          bodies.push(await request.json() as { voice?: string });
          return new Response(new Uint8Array(writeWav(new Float32Array(2_400).fill(0.1), 24_000)));
        },
      }),
    });
    const speak = (voice: string | undefined, user = "alice"): Promise<Response> => fetch(new URL("/v1/audio/speech", gateway?.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": user },
      body: JSON.stringify({ input: "你好", ...(voice === undefined ? {} : { voice }) }),
    });

    expect((await speak("myvoice")).status).toBe(200);
    expect(bodies[0]?.voice).toBe(`${voicePrefix("alice")}myvoice`);

    // A voice-less request still reaches the engine without inventing a voice id.
    expect((await speak(undefined)).status).toBe(200);
    expect(bodies[1]?.voice).toBeUndefined();

    // Another holder's engine id, presented raw, is refused rather than synthesized.
    const stolen = await speak(`${voicePrefix("bob")}myvoice`);
    expect(stolen.status).toBe(400);
    expect((await stolen.json() as { error: { code: string } }).error.code).toBe("bad_voice_id");
    expect(bodies).toHaveLength(2);
  });

  test("an account's realtime default stays engine-owned instead of entering the user's namespace", async () => {
    const bodies: { voice?: string }[] = [];
    gateway = startGateway({
      config,
      port: 0,
      authResolver: asAlice,
      fetch: engineFetch({
        "/v1/chat/completions": async () => Response.json({
          choices: [{ message: {
            content: `${"第一句保持同一个音色".repeat(20)}。${"第二句仍然保持同一个音色".repeat(20)}。`,
          } }],
        }),
        "/v1/audio/speech": async request => {
          bodies.push(await request.json() as { voice?: string });
          return new Response(new Uint8Array(writeWav(new Float32Array(4_800).fill(0.1), 24_000)));
        },
      }),
    });
    const client = new TestClient(gateway.url, "/v1/realtime?user=alice");
    await client.ready();
    const { voice: _configuredVoice, ...engineDefaultOptions } = startOptions;
    client.command({ type: "session.start", idempotencyKey: "default-voice-1", options: engineDefaultOptions });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "snapshot");

    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(events => events.some(event => event.type === "turn.completed"), "turn");
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every(body => body.voice === config.ttsDefaults.voice)).toBe(true);
    client.close();
  });

  test("a realtime session synthesizes through its owner's namespace, at start and after set_voice", async () => {
    const bodies: { voice?: string }[] = [];
    let chatRound = 0;
    gateway = startGateway({
      config,
      port: 0,
      authResolver: asAlice,
      fetch: engineFetch({
        "/v1/voices": async () => Response.json({ voices: [{ id: `${voicePrefix("alice")}second` }] }),
        "/v1/audio/speech": async request => {
          bodies.push(await request.json() as { voice?: string });
          return new Response(new Uint8Array(writeWav(new Float32Array(4_800).fill(0.1), 24_000)));
        },
        "/v1/chat/completions": async () => {
          chatRound += 1;
          if (chatRound === 1) {
            return Response.json({ choices: [{ message: { content: "", tool_calls: [
              { id: "c1", type: "function", function: { name: "set_voice", arguments: "{\"voice\":\"second\"}" } },
            ] } }] });
          }
          return Response.json({ choices: [{ message: { content: "好的。" } }] });
        },
      }),
    });
    const client = new TestClient(gateway.url, "/v1/realtime?user=alice");
    await client.ready();
    client.command({ type: "session.start", idempotencyKey: "ns-1", options: { ...startOptions, voice: "first" } });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "snapshot");

    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(events => events.some(event => event.type === "turn.completed"), "tool turn");
    // The session's own start voice was namespaced before it reached the engine.
    expect(bodies[0]?.voice).toBe(`${voicePrefix("alice")}first`);

    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(events => events.filter(event => event.type === "turn.completed").length >= 2, "second turn");
    // And so was the tool's retarget: the display name never reaches the engine bare.
    expect(bodies[bodies.length - 1]?.voice).toBe(`${voicePrefix("alice")}second`);
    client.close();
  });

  test("audit_profile audits inside the caller's namespace, never another holder's entry", async () => {
    const audited: string[] = [];
    let chatRound = 0;
    gateway = startGateway({
      config,
      port: 0,
      authResolver: asAlice,
      fetch: engineFetch({
        "/v1/voices": async () => Response.json({ voices: [] }),
        "/v1/chat/completions": async () => {
          chatRound += 1;
          if (chatRound === 1) {
            return Response.json({ choices: [{ message: { content: "", tool_calls: [
              { id: "c1", type: "function", function: { name: "audit_profile", arguments: "{\"profile\":\"calm\"}" } },
            ] } }] });
          }
          return Response.json({ choices: [{ message: { content: "审计完成。" } }] });
        },
        [`/v1/voices/${voicePrefix("alice")}calm`]: async request => {
          audited.push(new URL(request.url).pathname);
          return Response.json({ id: `${voicePrefix("alice")}calm`, design_profile: { description: "calm", seed: 1, cfg_value: 2, timesteps: 10, model: "m", model_manifest_sha256: "abc", audio_sha256: "def" } });
        },
        "/healthz": async () => Response.json({ ok: true, model: "m", model_manifest_sha256: "abc" }),
      }),
    });
    const client = new TestClient(gateway.url, "/v1/realtime?user=alice");
    await client.ready();
    client.command({ type: "session.start", idempotencyKey: "aud-1", options: { ...startOptions, studioTools: true } });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "snapshot");
    client.sendPcm(2, 0.2);
    client.sendPcm(2, 0);
    await client.until(events => events.some(event => event.type === "tool.result"), "audit result");

    // The engine was asked about alice's namespaced entry, not the bare display name.
    expect(audited).toEqual([`/v1/voices/${voicePrefix("alice")}calm`]);
    client.close();
  });

  test("the reserved namespace pattern is never accepted as a display name, owner included", async () => {
    const reached: string[] = [];
    gateway = startGateway({
      config,
      port: 0,
      fetch: engineFetch({
        [`/v1/voices/${voicePrefix("alice")}myvoice`]: async request => {
          reached.push(new URL(request.url).pathname);
          return Response.json({ id: "leaked" });
        },
      }),
    });
    // The self-hosted owner cannot reach into an account holder's namespace by naming it.
    const probe = await fetch(new URL(`/v1/voices/${voicePrefix("alice")}myvoice`, gateway.url));
    expect(probe.status).toBe(400);
    expect(reached).toEqual([]);
  });
});

describe("guardrail parse hardening", () => {
  test("a stopped session's socket close does not re-arm the reconnect grace", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, reconnectGraceMs: 60_000 });
    const client = new TestClient(gateway.url);
    await client.ready();
    client.command({ type: "session.start", idempotencyKey: "g-1", options: startOptions });
    await client.until(events => events.some(event => event.type === "session.snapshot"), "up");
    client.command({ type: "session.stop", idempotencyKey: "g-2" });
    await client.until(events => events.some(event =>
      event.type === "session.state" && "state" in event && event.state === "closed"), "stopped");
    // Closing the socket after the stop must not retain the dead session behind a timer;
    // the registry forgetting it is the observable proxy.
    client.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(gateway.sessionCount()).toBe(0);
  });
});

describe("a single synthesis cannot buy unbounded engine time", () => {
  /** Roughly one minute of Chinese speech, per the estimator the UI shows. */
  const longText = "这是一段用于测试的长文本。".repeat(120);

  test("over the ceiling is refused before any engine is touched", async () => {
    const reached: string[] = [];
    gateway = startGateway({
      config,
      port: 0,
      maxSynthesisSeconds: 30,
      fetch: engineFetch({
        "/v1/audio/speech": async request => {
          reached.push(new URL(request.url).pathname);
          return new Response(new Uint8Array(writeWav(new Float32Array(2_400).fill(0.1), 24_000)));
        },
      }),
    });
    const speak = (input: string): Promise<Response> => fetch(new URL("/v1/audio/speech", gateway?.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });

    const refused = await speak(longText);
    expect(refused.status).toBe(400);
    const body = await refused.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("input_too_long");
    // The message says both numbers, so a caller can split the text without guessing.
    expect(body.error.message).toMatch(/\d+s/);
    expect(reached).toEqual([]);

    // A normal request still goes through.
    expect((await speak("你好，世界。")).status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  test("without a ceiling configured, nothing is bounded — today's behaviour", async () => {
    gateway = startGateway({ config, port: 0, fetch: engineFetch() });
    const long = await fetch(new URL("/v1/audio/speech", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: longText }),
    });
    expect(long.status).toBe(200);
  });

  test("a quota with no synthesis ceiling is called out at startup", () => {
    const lines: string[] = [];
    const dir = `${import.meta.dir}/../node_modules/.test-ceiling-${Date.now().toString(36)}`;
    expect(() => {
      gateway = startGateway({
        config,
        port: 0,
        fetch: engineFetch(),
        accounts: { dir, secret: "an-adequately-long-test-secret-0123456789" },
        quota: { operations: 100, windowSeconds: 3_600 },
        log: line => lines.push(line),
      });
    }).not.toThrow();
    // The quota counts requests; without a ceiling one request is unbounded work.
    expect(lines.some(line => line.includes("--max-synthesis-seconds"))).toBe(true);
  });
});

describe("the synthesis concurrency gate", () => {
  test("admits the limit, queues the next, and refuses the rest with Retry-After", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    gateway = startGateway({
      config,
      port: 0,
      synthesisConcurrency: { maxInFlight: 1, maxQueued: 1 },
      fetch: engineFetch({
        "/v1/audio/speech": async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>(resolve => release.push(resolve));
          inFlight -= 1;
          return new Response(new Uint8Array(writeWav(new Float32Array(2_400).fill(0.1), 24_000)));
        },
      }),
    });
    const speak = (): Promise<Response> => fetch(new URL("/v1/audio/speech", gateway?.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "你好" }),
    });

    const first = speak();
    const second = speak();
    await Bun.sleep(120);
    // One reached the engine, one is waiting for the slot.
    const third = await speak();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = await third.json() as { error: { code: string; retryAfterSeconds: number } };
    expect(body.error.code).toBe("synthesis_busy");
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);

    release.forEach(done => done());
    await Bun.sleep(60);
    release.forEach(done => done());
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    // The engine never saw more than the gate allowed.
    expect(peak).toBe(1);
  });

  test("without a gate configured, concurrency is unbounded — today's behaviour", async () => {
    let peak = 0;
    let inFlight = 0;
    gateway = startGateway({
      config,
      port: 0,
      fetch: engineFetch({
        "/v1/audio/speech": async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await Bun.sleep(40);
          inFlight -= 1;
          return new Response(new Uint8Array(writeWav(new Float32Array(2_400).fill(0.1), 24_000)));
        },
      }),
    });
    const all = await Promise.all(Array.from({ length: 5 }, () => fetch(new URL("/v1/audio/speech", gateway?.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "你好" }),
    })));
    expect(all.every(response => response.status === 200)).toBe(true);
    expect(peak).toBeGreaterThan(1);
  });
});
