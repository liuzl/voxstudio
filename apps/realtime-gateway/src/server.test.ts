import { afterEach, describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { parseConfig } from "@voxstudio/config";
import type { Fetch } from "@voxstudio/clients";
import { protocolVersion, type GatewayEvent } from "./protocol";
import { startGateway, type GatewayServer } from "./server";

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
    gateway = startGateway({
      config: registry,
      port: 0,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        hits.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.host}${url.pathname}`);
        if (url.pathname === "/v1/voices" && url.host === "kokoro.test") {
          return Response.json({ voices: [{ id: "zf_001" }] });
        }
        if (url.pathname === "/v1/voices" && url.host === "voxcpm2.test") {
          return url.searchParams.toString() === "" && (init?.method ?? "GET") === "POST"
            ? Response.json({ id: "laok" }, { status: 201 })
            : Response.json({ voices: [{ id: "laok" }] });
        }
        if (url.pathname === "/health") return Response.json({ status: "ok" });
        if (url.pathname === "/v1/audio/speech") return new Response(new Uint8Array(8));
        throw new Error(`unexpected ${url.href}`);
      },
    });

    // The bank is the union, each entry attributed to its engine.
    const bank = await (await fetch(new URL("/v1/voices", gateway.url))).json() as { voices: { id: string; engine: string }[] };
    expect(bank.voices).toEqual([
      { id: "zf_001", engine: "kokoro" },
      { id: "laok", engine: "voxcpm2" },
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
      body: JSON.stringify({ input: "你好" }),
    });
    expect((await speak()).status).toBe(200);
    expect(hits.at(-1)).toBe("POST kokoro.test/v1/audio/speech");
    expect((await speak("?engine=voxcpm2")).status).toBe(200);
    expect(hits.at(-1)).toBe("POST voxcpm2.test/v1/audio/speech");
    expect((await speak("?engine=ghost")).status).toBe(400);
    expect((await speak("?engine=asr")).status).toBe(400);

    // The sanitized registry: names, kinds, capabilities, roles, health — no addresses.
    const listed = await (await fetch(new URL("/v1/engines", gateway.url))).json() as { engines: Record<string, unknown>[] };
    const names = listed.engines.map(entry => entry.name);
    expect(names).toContain("kokoro");
    expect(names).toContain("voxcpm2");
    const kokoro = listed.engines.find(entry => entry.name === "kokoro");
    expect(kokoro).toMatchObject({ kind: "tts", roles: ["tts"], healthy: true, capabilities: ["preset", "fast"] });
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

  test("a configured token gates both the facade and the realtime endpoint", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, token: "gw-secret" });

    const denied = await fetch(new URL("/v1/voices", gateway.url));
    expect(denied.status).toBe(401);
    const allowed = await fetch(new URL("/v1/voices", gateway.url), {
      headers: { authorization: "Bearer gw-secret" },
    });
    expect(allowed.status).toBe(200);
    // Health stays reachable for probes, and reports no session details.
    const health = await fetch(new URL("/healthz", gateway.url));
    expect(health.status).toBe(200);

    const deniedSocket = new TestClient(gateway.url);
    await expect(deniedSocket.ready()).rejects.toThrow();
    const allowedSocket = new TestClient(gateway.url, "/v1/realtime?token=gw-secret");
    await allowedSocket.ready();
    allowedSocket.close();
  });
});
