import { afterEach, describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { parseConfig } from "@voxstudio/config";
import type { Fetch } from "@voxstudio/clients";
import { startGateway, type GatewayServer } from "../server";
import { voicePrefix } from "../voice-namespace";
import { protocolVersion } from "../protocol";

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    llm: { base_url: "http://llm.test" },
    tts: { base_url: "http://tts.test", api_key: "sk-engine-secret" },
  },
});

const SECRET = "an-adequately-long-test-secret-0123456789";

function engineFetch(): Fetch {
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    const path = new URL(request.url).pathname;
    if (path === "/v1/voices" && request.method === "GET") {
      return Response.json({ voices: [{ id: "laok" }] });
    }
    if (path === "/v1/voices" && request.method === "POST") {
      const form = await request.formData();
      return Response.json({ id: form.get("id") }, { status: 201 });
    }
    if (path === "/v1/audio/speech") {
      return new Response(new Uint8Array(writeWav(new Float32Array(24_000).fill(0.1), 24_000)));
    }
    if (path === "/v1/audio/transcriptions") return Response.json({ text: "你好" });
    if (path === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: "回答完毕。" } }] });
    throw new Error(`unexpected engine path ${path}`);
  };
}

const tempDir = (): string => `${import.meta.dir}/../../node_modules/.test-accounts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let gateway: GatewayServer | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  for (const dir of dirs.splice(0)) await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

function accountsGateway(extra: { sendVerificationEmail?: (email: string, url: string) => Promise<void>; log?: (line: string) => void } = {}): GatewayServer {
  const dir = tempDir();
  dirs.push(dir);
  return startGateway({
    config,
    fetch: engineFetch(),
    port: 0,
    accounts: { dir, secret: SECRET, ...(extra.sendVerificationEmail === undefined ? {} : { sendVerificationEmail: extra.sendVerificationEmail }) },
    ...(extra.log === undefined ? {} : { log: extra.log }),
  });
}

async function signUp(base: string, email: string): Promise<string> {
  const response = await fetch(new URL("/v1/auth/sign-up/email", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234", name: email.split("@")[0] }),
  });
  expect(response.status).toBe(200);
  // The session cookie (possibly several set-cookie headers) becomes one cookie header.
  const cookies = response.headers.getSetCookie().map(entry => entry.split(";")[0]).join("; ");
  expect(cookies.length).toBeGreaterThan(0);
  return cookies;
}

describe("hosted accounts (docs/auth.md phase 3)", () => {
  test("accounts and the shared token are mutually exclusive at startup", () => {
    const dir = tempDir();
    dirs.push(dir);
    expect(() => startGateway({ config, port: 0, token: "gw-secret", accounts: { dir, secret: SECRET } }))
      .toThrow("mutually exclusive");
    expect(() => startGateway({ config, port: 0, accounts: { dir, secret: "short" } }))
      .toThrow("32 characters");
  });

  test("an authResolver may not stand beside hosted accounts — the test seam cannot become a bypass", () => {
    const dir = tempDir();
    dirs.push(dir);
    expect(() => startGateway({
      config,
      port: 0,
      accounts: { dir, secret: SECRET },
      authResolver: () => ({ userId: "anyone", via: "session" }),
    })).toThrow("authResolver");
  });

  test("hosted mode refuses a loopback Origin: the dev-server exception is local-only", async () => {
    gateway = accountsGateway();
    const cookie = await signUp(gateway.url, "helen@test.dev");
    const wsUrl = new URL("/v1/realtime", gateway.url).toString().replace(/^http/, "ws");
    const connect = (origin: string): Promise<WebSocket> => new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { headers: { cookie, origin } } as never);
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", () => reject(new Error(`refused (${origin})`)));
    });

    // A hosted deployment's cookie must not be usable from a dev server or any other site.
    await expect(connect("http://localhost:5173")).rejects.toThrow();
    await expect(connect("https://evil.example")).rejects.toThrow();
    // The scheme is part of the origin: http against an https deployment is not same-origin.
    await expect(connect(new URL(gateway.url).origin.replace("http://", "https://"))).rejects.toThrow();

    const allowed = await connect(new URL(gateway.url).origin);
    allowed.close();
  });

  test("no credential means 401 on /v1; signup mints a session that opens the same doors", async () => {
    gateway = accountsGateway();
    expect((await fetch(new URL("/v1/engines", gateway.url))).status).toBe(401);
    expect((await fetch(new URL("/healthz", gateway.url))).status).toBe(200);

    const cookie = await signUp(gateway.url, "alice@test.dev");
    const listed = await fetch(new URL("/v1/voices", gateway.url), { headers: { cookie } });
    expect(listed.status).toBe(200);
    // The engine's bare bank belongs to the self-hosted owner; an account holder
    // starts with an empty namespace.
    expect(await listed.json()).toEqual({ voices: [] });

    // Registration lands in the account's namespace on the engine.
    const form = new FormData();
    form.set("id", "myvoice");
    form.set("text", "参考音");
    form.set("audio", new File([new Uint8Array(16)], "ref.wav", { type: "audio/wav" }));
    const created = await fetch(new URL("/v1/voices", gateway.url), { method: "POST", headers: { cookie }, body: form });
    expect(created.status).toBe(201);
    const payload = await created.json() as { id: string };
    expect(payload.id.startsWith("u")).toBe(true);
    expect(payload.id.endsWith(".myvoice")).toBe(true);
  });

  test("an API key opens the same doors as its owner's session — machine parity", async () => {
    gateway = accountsGateway();
    const cookie = await signUp(gateway.url, "bob@test.dev");

    const minted = await fetch(new URL("/v1/auth/api-key/create", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "agent" }),
    });
    expect(minted.status).toBe(200);
    const { key } = await minted.json() as { key: string };
    expect(typeof key).toBe("string");

    // The key and the cookie resolve to the same user: same (empty) voice namespace,
    // and the speech facade answers both identically.
    const viaKey = await fetch(new URL("/v1/voices", gateway.url), { headers: { "x-api-key": key } });
    expect(viaKey.status).toBe(200);
    expect(await viaKey.json()).toEqual({ voices: [] });
    const spoken = await fetch(new URL("/v1/audio/speech", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ input: "你好", voice: "laok" }),
    });
    expect(spoken.status).toBe(200);

    expect((await fetch(new URL("/v1/engines", gateway.url), { headers: { "x-api-key": "vox_not_a_key" } })).status).toBe(401);
  });

  test("with a verification sender wired, an unverified login is refused until the link is followed", async () => {
    const sent: { email: string; url: string }[] = [];
    gateway = accountsGateway({ sendVerificationEmail: async (email, url) => { sent.push({ email, url }); } });

    const signup = await fetch(new URL("/v1/auth/sign-up/email", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "carol@test.dev", password: "password1234", name: "Carol" }),
    });
    expect(signup.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email).toBe("carol@test.dev");

    const login = (): Promise<Response> => fetch(new URL("/v1/auth/sign-in/email", gateway?.url ?? ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "carol@test.dev", password: "password1234" }),
    });
    expect((await login()).status).toBe(403);
    // Following the emailed link verifies; the login then succeeds.
    expect([200, 302]).toContain((await fetch(sent[0]?.url ?? "", { redirect: "manual" })).status);
    expect((await login()).status).toBe(200);
  });

  test("without a sender, verification is off and the boundary is said out loud", async () => {
    const lines: string[] = [];
    gateway = accountsGateway({ log: line => lines.push(line) });
    const cookie = await signUp(gateway.url, "dave@test.dev");
    expect((await fetch(new URL("/v1/engines", gateway.url), { headers: { cookie } })).status).toBe(200);
    expect(lines.some(line => line.includes("email verification is OFF"))).toBe(true);
  });

  test("the realtime socket takes a cookie at upgrade; no credential is refused", async () => {
    gateway = accountsGateway();
    const cookie = await signUp(gateway.url, "eve@test.dev");
    const wsUrl = new URL("/v1/realtime", gateway.url).toString().replace(/^http/, "ws");

    await expect(new Promise((resolve, reject) => {
      const denied = new WebSocket(wsUrl);
      denied.addEventListener("open", () => resolve(undefined));
      denied.addEventListener("error", () => reject(new Error("refused")));
    })).rejects.toThrow();

    const events: { type: string }[] = [];
    const socket = new WebSocket(wsUrl, { headers: { cookie } } as never);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("cookie upgrade refused")));
    });
    socket.addEventListener("message", event => {
      if (typeof event.data === "string") events.push(JSON.parse(event.data) as { type: string });
    });
    socket.send(JSON.stringify({
      v: protocolVersion,
      type: "session.start",
      idempotencyKey: "acct-1",
      options: { language: "zh", voice: "demo", vad: "energy", threshold: 0.1, minSpeechMs: 40, silenceMs: 20, turnTaking: "conservative", bargeIn: true },
    }));
    const deadline = Date.now() + 5_000;
    while (!events.some(event => event.type === "session.snapshot")) {
      if (Date.now() > deadline) throw new Error(`no snapshot; saw ${events.map(event => event.type).join(", ")}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    socket.close();
  });

  test("synthesis runs inside the account's namespace, and another holder's engine id is refused", async () => {
    const bodies: { voice?: string }[] = [];
    const dir = tempDir();
    dirs.push(dir);
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir, secret: SECRET },
      fetch: async (input, init) => {
        const request = new Request(input instanceof Request ? input : String(input), init);
        const path = new URL(request.url).pathname;
        if (path === "/v1/audio/speech") {
          bodies.push(await request.json() as { voice?: string });
          return new Response(new Uint8Array(writeWav(new Float32Array(2_400).fill(0.1), 24_000)));
        }
        if (path === "/v1/voices") return Response.json({ voices: [] });
        throw new Error(`unexpected engine path ${path}`);
      },
    });
    const cookie = await signUp(gateway.url, "iris@test.dev");
    const speak = (voice: string): Promise<Response> => fetch(new URL("/v1/audio/speech", gateway?.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ input: "你好", voice }),
    });

    expect((await speak("mine")).status).toBe(200);
    expect(bodies[0]?.voice).toMatch(/^u[0-9a-f]{12}\.mine$/);
    // A raw namespaced id (another holder's, or a guess) never reaches an engine.
    expect((await speak(`${voicePrefix("someone-else")}mine`)).status).toBe(400);
    expect(bodies).toHaveLength(1);
  });

  test("voice namespaces are per account: two users, same display name, no collision", async () => {
    gateway = accountsGateway();
    const frank = await signUp(gateway.url, "frank@test.dev");
    const grace = await signUp(gateway.url, "grace@test.dev");
    const register = async (cookie: string): Promise<string> => {
      const form = new FormData();
      form.set("id", "same-name");
      form.set("text", "参考音");
      form.set("audio", new File([new Uint8Array(16)], "ref.wav", { type: "audio/wav" }));
      const response = await fetch(new URL("/v1/voices", gateway?.url ?? ""), { method: "POST", headers: { cookie }, body: form });
      expect(response.status).toBe(201);
      return (await response.json() as { id: string }).id;
    };
    const frankId = await register(frank);
    const graceId = await register(grace);
    expect(frankId).not.toBe(graceId);
    expect(frankId).toMatch(/^u[0-9a-f]{12}\.same-name$/);
    // Neither engine id is any user's chosen prefix pattern by accident.
    expect(voicePrefix("frank")).not.toBe(voicePrefix("grace"));
  });
});
