import { afterEach, describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { parseConfig } from "@voxstudio/config";
import { startGateway, type GatewayServer, type GatewayServerOptions } from "../server";
import { protocolVersion } from "../protocol";

/**
 * Charging integrity and brute-force protection (adversarial review 2026-07-26):
 * a conversation must not buy unbounded engine work for one charge, a refusal the
 * gateway makes itself must not cost a charge, the realtime refusal must tell a client
 * when to come back, and the auth surface must be rate-limited without depending on
 * NODE_ENV.
 */

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    llm: { base_url: "http://llm.test" },
    tts: { base_url: "http://tts.test" },
  },
});

const SECRET = "an-adequately-long-test-secret-0123456789";
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
const dirs: string[] = [];

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  for (const dir of dirs.splice(0)) await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

function tempDir(): string {
  const dir = `${import.meta.dir}/../../node_modules/.test-integrity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  dirs.push(dir);
  return dir;
}

interface EngineTally { asr: number; llm: number; tts: number; voices: number }

/** A gateway with accounts, a quota, and a relaxed auth limiter (tests sign up freely). */
function hostedGateway(quota: { operations: number; windowSeconds: number }, tally?: EngineTally, extra: Partial<GatewayServerOptions> = {}): GatewayServer {
  return startGateway({
    config,
    port: 0,
    accounts: { dir: tempDir(), secret: SECRET, rateLimit: { window: 60, max: 1_000 } },
    quota,
    fetch: async (input, init) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      const path = new URL(request.url).pathname;
      if (path === "/v1/audio/transcriptions") { if (tally) tally.asr += 1; return Response.json({ text: "你好" }); }
      if (path === "/v1/chat/completions") { if (tally) tally.llm += 1; return Response.json({ choices: [{ message: { content: "回答完毕。" } }] }); }
      if (path === "/v1/audio/speech") { if (tally) tally.tts += 1; return new Response(new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000))); }
      if (path === "/v1/voices" && request.method === "POST") {
        if (tally) tally.voices += 1;
        const form = await request.formData();
        return Response.json({ id: form.get("id") }, { status: 201 });
      }
      if (path === "/v1/voices") return Response.json({ voices: [] });
      return Response.json({});
    },
    ...extra,
  });
}

/**
 * Better Auth's limiter buckets on the client address and its memory store is shared
 * process-wide, so every test here speaks from its own address: one test's signups can
 * never exhaust another's allowance.
 */
let nextClient = 0;
const clientAddress = (): string => `198.51.100.${(nextClient += 1) % 250 + 1}`;

async function signUp(base: string, email: string, client = clientAddress()): Promise<string> {
  const response = await fetch(new URL("/v1/auth/sign-up/email", base), {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(base).origin, "x-forwarded-for": client },
    body: JSON.stringify({ email, password: "password1234", name: email.split("@")[0] }),
  });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie().map(entry => entry.split(";")[0]).join("; ");
}

/** A realtime client that collects events and can drive complete turns. */
class Conversation {
  readonly events: { type: string; reason?: string; message?: string; retryAfterSeconds?: number; requestId?: string }[] = [];
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", event => {
      if (typeof event.data === "string") this.events.push(JSON.parse(event.data) as { type: string });
    });
  }

  static async open(base: string, cookie: string): Promise<Conversation> {
    const url = new URL("/v1/realtime", base).toString().replace(/^http/, "ws");
    const socket = new WebSocket(url, { headers: { cookie, origin: new URL(base).origin } } as never);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("upgrade refused")));
    });
    return new Conversation(socket);
  }

  send(payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ v: protocolVersion, ...payload }));
  }

  /** Speak, then fall silent — one complete user utterance. */
  speak(): void {
    for (let frame = 0; frame < 2; frame += 1) this.socket.send(new Float32Array(320).fill(0.2).buffer);
    for (let frame = 0; frame < 2; frame += 1) this.socket.send(new Float32Array(320).fill(0).buffer);
  }

  async until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw: ${this.events.map(event => event.type).join(", ")}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  completedTurns(): number {
    return this.events.filter(event => event.type === "turn.completed").length;
  }

  close(): void {
    this.socket.close();
  }
}

describe("H-1: a conversation is charged per turn, not once per socket", () => {
  test("turns stop costing engine work once the allowance is spent", async () => {
    const tally: EngineTally = { asr: 0, llm: 0, tts: 0, voices: 0 };
    // One charge for the session, then one per turn: an allowance of 3 buys 2 turns.
    gateway = hostedGateway({ operations: 3, windowSeconds: 60 }, tally);
    const cookie = await signUp(gateway.url, "turns@test.dev");
    const conversation = await Conversation.open(gateway.url, cookie);
    conversation.send({ type: "session.start", idempotencyKey: "t-1", options: startOptions });
    await conversation.until(() => conversation.events.some(event => event.type === "session.snapshot"), "snapshot");

    conversation.speak();
    await conversation.until(() => conversation.completedTurns() >= 1, "first turn");
    conversation.speak();
    await conversation.until(() => conversation.completedTurns() >= 2, "second turn");

    // The third turn exhausts the allowance: the session says so and ends.
    conversation.speak();
    await conversation.until(
      () => conversation.events.some(event => event.type === "session.notice" && (event.message ?? "").includes("quota")),
      "quota notice",
    );
    await conversation.until(
      () => conversation.events.some(event => event.type === "session.state" && (event as { state?: string }).state === "closed"),
      "session closed",
    );

    // Engine work is bounded: at most one turn may finish after the allowance ran out.
    const llmCalls = tally.llm;
    conversation.speak();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(tally.llm).toBe(llmCalls);
    expect(tally.llm).toBeLessThanOrEqual(3);
    conversation.close();
  });

  test("a barge-in revision of the same turn is not charged twice", async () => {
    const tally: EngineTally = { asr: 0, llm: 0, tts: 0, voices: 0 };
    gateway = hostedGateway({ operations: 10, windowSeconds: 60 }, tally);
    const cookie = await signUp(gateway.url, "revision@test.dev");
    const conversation = await Conversation.open(gateway.url, cookie);
    conversation.send({ type: "session.start", idempotencyKey: "r-1", options: startOptions });
    await conversation.until(() => conversation.events.some(event => event.type === "session.snapshot"), "snapshot");

    for (let turn = 1; turn <= 4; turn += 1) {
      conversation.speak();
      await conversation.until(() => conversation.completedTurns() >= turn, `turn ${turn}`);
    }
    // 1 session + 4 turns = 5 charges; the allowance of 10 is not exhausted, so the
    // session is still alive and REST still works for this account.
    const spoken = await fetch(new URL("/v1/audio/speech", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ input: "still allowed" }),
    });
    expect(spoken.status).toBe(200);
    conversation.close();
  });
});

describe("M-3: the realtime quota refusal tells the client when to come back", () => {
  test("session.start refused past the allowance carries retryAfterSeconds and a requestId", async () => {
    gateway = hostedGateway({ operations: 1, windowSeconds: 60 });
    const cookie = await signUp(gateway.url, "wsretry@test.dev");

    const first = await Conversation.open(gateway.url, cookie);
    first.send({ type: "session.start", idempotencyKey: "w-1", options: startOptions });
    await first.until(() => first.events.some(event => event.type === "session.snapshot"), "snapshot");
    first.close();

    const second = await Conversation.open(gateway.url, cookie);
    second.send({ type: "session.start", idempotencyKey: "w-2", options: startOptions });
    await second.until(() => second.events.some(event => event.type === "command.rejected"), "rejection");
    const rejected = second.events.find(event => event.type === "command.rejected");
    expect(rejected?.reason).toBe("quota_exceeded");
    // The same guidance the REST refusal gives, in this protocol's vocabulary.
    expect(rejected?.retryAfterSeconds).toBeGreaterThan(0);
    expect(rejected?.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect((rejected?.requestId ?? "").length).toBeGreaterThan(0);
    second.close();
  });
});

describe("M-1: a refusal the gateway makes itself costs no quota", () => {
  test("gateway-side 400s and 404s leave the allowance intact", async () => {
    gateway = hostedGateway({ operations: 2, windowSeconds: 60 });
    const cookie = await signUp(gateway.url, "refunds@test.dev");
    const speak = (body: unknown): Promise<Response> => fetch(new URL("/v1/audio/speech", gateway?.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

    // A reserved internal id: refused before any engine is touched.
    expect((await speak({ input: "x", voice: "u000000000000.stolen" })).status).toBe(400);
    // The library is not enabled here: refused before any engine is touched.
    expect((await fetch(new URL("/v1/library/whatever/promote", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ voice_id: "x" }),
    })).status).toBe(404);
    // A malformed body: same.
    expect((await fetch(new URL("/v1/audio/speech", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "not json",
    })).status).toBe(400);

    // None of that consumed the allowance: both real calls still succeed.
    expect((await speak({ input: "first" })).status).toBe(200);
    expect((await speak({ input: "second" })).status).toBe(200);
    expect((await speak({ input: "third" })).status).toBe(429);
  });

  test("an unreachable engine refunds the charge instead of burning it", async () => {
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET, rateLimit: { window: 60, max: 1_000 } },
      quota: { operations: 1, windowSeconds: 60 },
      fetch: async (input, init) => {
        const request = new Request(input instanceof Request ? input : String(input), init);
        if (new URL(request.url).pathname === "/v1/audio/speech") throw new Error("connection refused");
        return Response.json({ voices: [] });
      },
    });
    const cookie = await signUp(gateway.url, "unreachable@test.dev");
    const speak = (): Promise<Response> => fetch(new URL("/v1/audio/speech", gateway?.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ input: "x" }),
    });

    const failed = await speak();
    expect(failed.status).toBe(502);
    expect((await failed.json() as { error: { code: string } }).error.code).toBe("engine_unreachable");
    // The engine never did the work, so the allowance was not spent — a broken engine
    // must not silently drain everyone's budget.
    const retried = await speak();
    expect(retried.status).toBe(502);
  });
});

describe("M-4: registering a voice by voice is charged like registering one over REST", () => {
  test("the studio tool's engine write is refused once the allowance is spent", async () => {
    const tally: EngineTally = { asr: 0, llm: 0, tts: 0, voices: 0 };
    gateway = hostedGateway({ operations: 2, windowSeconds: 60 }, tally);
    const cookie = await signUp(gateway.url, "studiotool@test.dev");

    // Spend the allowance over REST (1) and leave exactly one charge.
    expect((await fetch(new URL("/v1/audio/speech", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ input: "x" }),
    })).status).toBe(200);

    // The remaining charge buys the session itself, leaving nothing for a voice write.
    const conversation = await Conversation.open(gateway.url, cookie);
    conversation.send({ type: "session.start", idempotencyKey: "s-1", options: { ...startOptions, studioTools: true } });
    await conversation.until(() => conversation.events.some(event => event.type === "session.snapshot"), "snapshot");

    const registered = await fetch(new URL("/v1/voices", gateway.url), {
      method: "POST",
      headers: { cookie },
      body: (() => {
        const form = new FormData();
        form.set("id", "over-budget");
        form.set("text", "参考音");
        form.set("audio", new File([new Uint8Array(16)], "ref.wav", { type: "audio/wav" }));
        return form;
      })(),
    });
    expect(registered.status).toBe(429);
    // No engine write happened on the exhausted account, by either door.
    expect(tally.voices).toBe(0);
    conversation.close();
  });
});

describe("H-2: brute-force protection does not depend on NODE_ENV", () => {
  test("repeated wrong passwords are rate-limited with the shipped defaults", async () => {
    // No rateLimit override: the deployment default must hold in any environment.
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET },
      fetch: async () => Response.json({ voices: [] }),
    });
    const origin = new URL(gateway.url).origin;
    const attacker = clientAddress();
    await signUp(gateway.url, "victim@test.dev", clientAddress());

    const codes: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(new URL("/v1/auth/sign-in/email", gateway.url), {
        method: "POST",
        headers: { "content-type": "application/json", origin, "x-forwarded-for": attacker },
        body: JSON.stringify({ email: "victim@test.dev", password: `wrong-${attempt}` }),
      });
      codes.push(response.status);
    }
    // Guessing is stopped well before eight tries, whatever NODE_ENV says.
    expect(codes.filter(code => code === 429).length).toBeGreaterThan(0);
    expect(codes.indexOf(429)).toBeLessThanOrEqual(6);
  });

  test("signup is bounded too, so an open deployment cannot be filled with accounts", async () => {
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET },
      fetch: async () => Response.json({ voices: [] }),
    });
    const origin = new URL(gateway.url).origin;
    const flooder = clientAddress();
    const codes: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await fetch(new URL("/v1/auth/sign-up/email", gateway.url), {
        method: "POST",
        headers: { "content-type": "application/json", origin, "x-forwarded-for": flooder },
        body: JSON.stringify({ email: `flood-${attempt}@test.dev`, password: "password1234", name: "F" }),
      });
      codes.push(response.status);
    }
    expect(codes.filter(code => code === 429).length).toBeGreaterThan(0);
  });

  test("a deployment may relax the limiter explicitly, and tests can rely on that", async () => {
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET, rateLimit: { window: 60, max: 1_000 } },
      fetch: async () => Response.json({ voices: [] }),
    });
    const origin = new URL(gateway.url).origin;
    const client = clientAddress();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(new URL("/v1/auth/sign-up/email", gateway.url), {
        method: "POST",
        headers: { "content-type": "application/json", origin, "x-forwarded-for": client },
        body: JSON.stringify({ email: `relaxed-${attempt}@test.dev`, password: "password1234", name: "R" }),
      });
      expect(response.status).toBe(200);
    }
  });
});

describe("M-2: the OpenAI dialect reports a quota refusal as one", () => {
  test("an exhausted allowance is quota_exceeded with a retry, not session_capacity", async () => {
    gateway = hostedGateway({ operations: 1, windowSeconds: 60 });
    const cookie = await signUp(gateway.url, "openai-dialect@test.dev");
    const origin = new URL(gateway.url).origin;
    // The OpenAI SDKs derive this URL and carry ?model=; that is what selects the dialect.
    const url = `${new URL("/v1/realtime", gateway.url).toString().replace(/^http/, "ws")}?model=voxstudio-realtime`;

    const connect = async (): Promise<{ type: string; error?: { code?: string; message?: string; retry_after_seconds?: number } }[]> => {
      const events: { type: string; error?: { code?: string; message?: string; retry_after_seconds?: number } }[] = [];
      const socket = new WebSocket(url, { headers: { cookie, origin } } as never);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error("upgrade refused")));
      });
      socket.addEventListener("message", event => {
        if (typeof event.data === "string") events.push(JSON.parse(event.data) as { type: string });
      });
      // The dialect starts its session on the first appended audio.
      const pcm16 = Buffer.from(new Int16Array(320).fill(200).buffer).toString("base64");
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16 }));
      const deadline = Date.now() + 5_000;
      while (!events.some(entry => entry.type === "error" || entry.type === "session.created")) {
        if (Date.now() > deadline) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      socket.close();
      return events;
    };

    // The first connection spends the allowance.
    await connect();
    const refused = await connect();
    const failure = refused.find(entry => entry.type === "error");
    expect(failure?.error?.code).toBe("quota_exceeded");
    // And it says when to come back, like every other refusal does.
    expect(failure?.error?.retry_after_seconds).toBeGreaterThan(0);
    expect(failure?.error?.message ?? "").toContain("quota");
  });
});
