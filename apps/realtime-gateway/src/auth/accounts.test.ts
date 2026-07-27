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
    // Signing up many times from one address is a test artifact, not a threat model.
    accounts: { dir, secret: SECRET, rateLimit: { window: 60, max: 1_000 }, ...(extra.sendVerificationEmail === undefined ? {} : { sendVerificationEmail: extra.sendVerificationEmail }) },
    ...(extra.log === undefined ? {} : { log: extra.log }),
  });
}

/**
 * Mint a key the way the Studio does — cookie plus Origin, since Better Auth enforces
 * its own origin check on every mutation (a browser always sends one).
 */
async function mintKey(base: string, cookie: string, name = "agent"): Promise<string> {
  const response = await fetch(new URL("/v1/auth/api-key/create", base), {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: new URL(base).origin },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(200);
  const { key } = await response.json() as { key: string };
  expect(typeof key).toBe("string");
  return key;
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
    const key = await mintKey(gateway.url, cookie);

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

  test("the machine door speaks Authorization: Bearer as well as x-api-key", async () => {
    gateway = accountsGateway();
    const cookie = await signUp(gateway.url, "agent-owner@test.dev");
    const key = await mintKey(gateway.url, cookie);
    const bearer = (path: string): Promise<Response> =>
      fetch(new URL(path, gateway?.url), { headers: { authorization: `Bearer ${key}` } });

    // The contract AI clients and CLIs already speak.
    expect((await bearer("/v1/engines")).status).toBe(200);
    const viaBearer = await bearer("/v1/voices");
    expect(await viaBearer.json()).toEqual({ voices: [] });

    // Same key, both headers, one identity: a voice registered through Bearer is
    // visible through the native header, and vice versa.
    const form = new FormData();
    form.set("id", "bearer-made");
    form.set("text", "参考音");
    form.set("audio", new File([new Uint8Array(16)], "ref.wav", { type: "audio/wav" }));
    const created = await fetch(new URL("/v1/voices", gateway.url), {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    expect(created.status).toBe(201);
    const engineId = (await created.json() as { id: string }).id;
    expect(engineId).toMatch(/^u[0-9a-f]{12}\.bearer-made$/);

    // A bad Bearer is refused, and never falls through to an ambient cookie: the same
    // request with a valid cookie *and* a bogus Bearer stays 401 — an agent's broken
    // credential must not silently borrow a browser's identity.
    expect((await fetch(new URL("/v1/engines", gateway.url), { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(new URL("/v1/engines", gateway.url), {
      headers: { authorization: "Bearer nope", cookie },
    })).status).toBe(401);
  });

  test("healthz reports which door this deployment serves, without a credential", async () => {
    gateway = accountsGateway();
    const hosted = await fetch(new URL("/healthz", gateway.url));
    expect(hosted.status).toBe(200);
    expect((await hosted.json() as { auth: string }).auth).toBe("accounts");
    await gateway.stop();

    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const selfHosted = await fetch(new URL("/healthz", gateway.url));
    expect((await selfHosted.json() as { auth: string }).auth).toBe("self");
  });

  test("keys can be listed and revoked, and a revoked key stops opening the door", async () => {
    gateway = accountsGateway();
    const cookie = await signUp(gateway.url, "revoker@test.dev");
    const origin = new URL(gateway.url).origin;
    const key = await mintKey(gateway.url, cookie);
    expect((await fetch(new URL("/v1/engines", gateway.url), { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);

    const listed = await fetch(new URL("/v1/auth/api-key/list", gateway.url), { headers: { cookie } });
    const keys = (await listed.json() as { apiKeys: { id: string; name: string; start: string }[] }).apiKeys;
    expect(keys).toHaveLength(1);
    expect(keys[0]?.name).toBe("agent");
    // The list carries an id and a prefix to show, never the key itself.
    expect(keys[0]?.id.length).toBeGreaterThan(0);
    expect(JSON.stringify(keys)).not.toContain(key);

    const revoked = await fetch(new URL("/v1/auth/api-key/delete", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ keyId: keys[0]?.id }),
    });
    expect(revoked.status).toBe(200);
    expect((await fetch(new URL("/v1/engines", gateway.url), { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
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
      accounts: { dir, secret: SECRET, rateLimit: { window: 60, max: 1_000 } },
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

  test("the Studio's own auth client drives the whole loop against a real gateway", async () => {
    // The web client is same-origin `fetch` over /v1/auth/*; pointing global fetch at the
    // live gateway runs the exact code the browser ships, contracts and all. A cookie jar
    // stands in for the browser's, and Origin for what a browser always sends.
    gateway = accountsGateway();
    const base = gateway.url;
    const origin = new URL(base).origin;
    const realFetch = globalThis.fetch;
    let jar = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const response = await realFetch(new URL(path, base), {
        ...init,
        headers: { ...(init?.headers ?? {}), origin, ...(jar === "" ? {} : { cookie: jar }) },
      });
      const issued = response.headers.getSetCookie().map(entry => entry.split(";")[0]);
      if (issued.length > 0) jar = issued.join("; ");
      return response;
    }) as unknown as typeof fetch;

    try {
      const auth = await import("../../../web/src/lib/auth");
      expect(await auth.fetchAuthMode()).toBe("accounts");
      expect(await auth.fetchSession()).toBeNull();

      await auth.signUp("studio@test.dev", "password1234");
      const user = await auth.fetchSession();
      expect(user?.email).toBe("studio@test.dev");
      // No sender is configured on this gateway, so the account is usable unverified.
      expect(user?.emailVerified).toBe(false);

      expect(await auth.listApiKeys()).toEqual([]);
      const key = await auth.createApiKey("from-studio");
      const listed = await auth.listApiKeys();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.name).toBe("from-studio");
      expect(key.startsWith(listed[0]?.start ?? " ")).toBe(true);

      // The key the Studio just minted is a working machine credential — Bearer, no cookie.
      const machine = await realFetch(new URL("/v1/engines", base), { headers: { authorization: `Bearer ${key}` } });
      expect(machine.status).toBe(200);

      await auth.revokeApiKey(listed[0]?.id as string);
      expect(await auth.listApiKeys()).toEqual([]);
      expect((await realFetch(new URL("/v1/engines", base), { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);

      await auth.signOut();
      jar = "";
      expect(await auth.fetchSession()).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a self-hosted gateway tells the Studio to stay exactly as it was", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const base = gateway.url;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return realFetch(new URL(path, base), init);
    }) as unknown as typeof fetch;
    try {
      const auth = await import("../../../web/src/lib/auth");
      // "self" is what keeps the login card unmounted and the studio unchanged.
      expect(await auth.fetchAuthMode()).toBe("self");
      // And the auth surface simply does not exist on this deployment — not a 401 to
      // sign past, a 404: there is nothing to sign into.
      expect((await realFetch(new URL("/v1/auth/get-session", base))).status).toBe(404);
      // The studio's own routes stay open exactly as before accounts existed.
      expect((await realFetch(new URL("/v1/engines", base))).status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("the discovery surface is served without a credential, with the right content types", async () => {
    gateway = accountsGateway();
    const fetchDoc = (path: string): Promise<Response> => fetch(new URL(path, gateway?.url));

    const page = await fetchDoc("/agent");
    expect(page.status).toBe(200);
    // Markdown as text/plain: inline in any browser, no markup for an agent to strip.
    expect(page.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await page.text();
    expect(body).toContain("Authorization: Bearer <key>");
    expect(body).toContain("x-api-key");
    expect(body).toContain("Retry-After");

    const index = await fetchDoc("/llms.txt");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await index.text()).toContain("# voxstudio");

    const contract = await fetchDoc("/openapi.json");
    expect(contract.status).toBe(200);
    expect(contract.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const document = await contract.json() as { openapi: string; servers: { url: string }[]; paths: Record<string, unknown> };
    expect(document.openapi).toBe("3.1.0");
    // The server URL is this deployment, and the library is off here so its paths are absent.
    expect(document.servers[0]?.url).toBe(new URL(gateway.url).origin);
    expect(Object.keys(document.paths).some(path => path.startsWith("/v1/library"))).toBe(false);

    // Read-only: the surface is documentation, not an endpoint to poke.
    expect((await fetch(new URL("/agent", gateway.url), { method: "POST" })).status).toBe(405);
  });

  test("the discovery documents describe the deployment they are served from", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const libraryDir = tempDir();
    dirs.push(libraryDir);
    gateway = startGateway({
      config,
      fetch: engineFetch(),
      port: 0,
      libraryDir,
      accounts: { dir, secret: SECRET, baseUrl: "https://voxstudio.example", rateLimit: { window: 60, max: 1_000 } },
    });

    const document = await (await fetch(new URL("/openapi.json", gateway.url))).json() as { servers: { url: string }[]; paths: Record<string, unknown> };
    // A tunnelled deployment documents its public origin, not the loopback bind.
    expect(document.servers[0]?.url).toBe("https://voxstudio.example");
    // With a library configured, its routes are part of the contract.
    expect(document.paths["/v1/library"]).toBeDefined();
    expect(document.paths["/v1/library/{id}/promote"]).toBeDefined();

    const page = await (await fetch(new URL("/agent", gateway.url))).text();
    expect(page).toContain("https://voxstudio.example/llms.txt");
    expect(page).not.toContain("library is not enabled");
  });

  test("a self-hosted studio has no discovery surface — those paths stay the app shell", async () => {
    const assets = tempDir();
    dirs.push(assets);
    await Bun.write(`${assets}/index.html`, "<html><body>studio-shell</body></html>");
    gateway = startGateway({
      config,
      fetch: engineFetch(),
      port: 0,
      staticAssets: { "/index.html": `${assets}/index.html` },
    });

    // Not the agent page, and not the app shell either: a machine gets a structured
    // 404 it can act on (adversarial review 2026-07-26, L-1).
    for (const path of ["/agent", "/llms.txt", "/openapi.json"]) {
      const response = await fetch(new URL(path, gateway.url));
      expect(response.status).toBe(404);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("discovery_disabled");
    }
    // Ordinary deep links still reach the studio.
    expect(await (await fetch(new URL("/settings", gateway.url))).text()).toContain("studio-shell");
  });

  describe("per-user quota (docs/auth.md phase 4)", () => {
    /** A gateway whose allowance is small enough to exhaust in a test. */
    function quotaGateway(operations: number, windowSeconds = 60): GatewayServer {
      const dir = tempDir();
      dirs.push(dir);
      return startGateway({
        config,
        fetch: engineFetch(),
        port: 0,
        accounts: { dir, secret: SECRET, rateLimit: { window: 60, max: 1_000 } },
        quota: { operations, windowSeconds },
      });
    }

    const speak = (base: string, credential: Record<string, string>): Promise<Response> =>
      fetch(new URL("/v1/audio/speech", base), {
        method: "POST",
        headers: { "content-type": "application/json", ...credential },
        body: JSON.stringify({ input: "你好" }),
      });

    test("an exhausted allowance answers 429 with Retry-After, a request id, and a stable code", async () => {
      gateway = quotaGateway(2);
      const cookie = await signUp(gateway.url, "quota-a@test.dev");

      expect((await speak(gateway.url, { cookie })).status).toBe(200);
      expect((await speak(gateway.url, { cookie })).status).toBe(200);

      const refused = await speak(gateway.url, { cookie });
      expect(refused.status).toBe(429);
      const retryAfter = Number(refused.headers.get("retry-after"));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      const requestId = refused.headers.get("x-request-id") ?? "";
      expect(requestId.length).toBeGreaterThan(0);
      const body = await refused.json() as { error: { code: string; message: string; requestId: string; retryAfterSeconds: number } };
      expect(body.error.code).toBe("quota_exceeded");
      // The body agrees with the headers — a client may read either.
      expect(body.error.requestId).toBe(requestId);
      expect(body.error.retryAfterSeconds).toBe(retryAfter);
      // Two refusals never share a request id.
      const second = await speak(gateway.url, { cookie });
      expect((await second.json() as { error: { requestId: string } }).error.requestId).not.toBe(requestId);
    });

    test("one user's exhaustion leaves another user untouched", async () => {
      gateway = quotaGateway(1);
      const alice = await signUp(gateway.url, "quota-alice@test.dev");
      const bob = await signUp(gateway.url, "quota-bob@test.dev");

      expect((await speak(gateway.url, { cookie: alice })).status).toBe(200);
      expect((await speak(gateway.url, { cookie: alice })).status).toBe(429);
      // Bob's allowance is his own.
      expect((await speak(gateway.url, { cookie: bob })).status).toBe(200);
      expect((await speak(gateway.url, { cookie: bob })).status).toBe(429);
    });

    test("a key and its owner's cookie draw on one allowance", async () => {
      gateway = quotaGateway(2);
      const cookie = await signUp(gateway.url, "quota-shared@test.dev");
      const key = await mintKey(gateway.url, cookie);

      expect((await speak(gateway.url, { cookie })).status).toBe(200);
      // The agent spends the same budget as the human — one account, one quota.
      expect((await speak(gateway.url, { authorization: `Bearer ${key}` })).status).toBe(200);
      expect((await speak(gateway.url, { authorization: `Bearer ${key}` })).status).toBe(429);
      expect((await speak(gateway.url, { cookie })).status).toBe(429);
    });

    test("the window recovers: a short window lets the same user through again", async () => {
      gateway = quotaGateway(1, 1);
      const cookie = await signUp(gateway.url, "quota-window@test.dev");
      expect((await speak(gateway.url, { cookie })).status).toBe(200);
      expect((await speak(gateway.url, { cookie })).status).toBe(429);
      await new Promise(resolve => setTimeout(resolve, 1_100));
      expect((await speak(gateway.url, { cookie })).status).toBe(200);
    });

    test("expensive work counts; browsing does not", async () => {
      gateway = quotaGateway(1);
      const cookie = await signUp(gateway.url, "quota-reads@test.dev");

      // Reads and deletes are free: they cost no engine time.
      for (const path of ["/v1/voices", "/v1/engines"]) {
        expect((await fetch(new URL(path, gateway.url), { headers: { cookie } })).status).toBe(200);
      }
      // The discovery surface and health are free and need no credential at all.
      expect((await fetch(new URL("/agent", gateway.url))).status).toBe(200);
      expect((await fetch(new URL("/healthz", gateway.url))).status).toBe(200);
      // Signing in again is not a charge either.
      expect((await fetch(new URL("/v1/auth/get-session", gateway.url), { headers: { cookie } })).status).toBe(200);

      // The allowance is still intact for the one thing that costs.
      expect((await speak(gateway.url, { cookie })).status).toBe(200);
      expect((await speak(gateway.url, { cookie })).status).toBe(429);
    });

    test("transcription and chat draw on the same allowance as synthesis", async () => {
      gateway = quotaGateway(2);
      const cookie = await signUp(gateway.url, "quota-mixed@test.dev");

      const form = new FormData();
      form.set("file", new File([new Uint8Array(16)], "clip.wav", { type: "audio/wav" }));
      expect((await fetch(new URL("/v1/audio/transcriptions", gateway.url), { method: "POST", headers: { cookie }, body: form })).status).toBe(200);
      expect((await fetch(new URL("/v1/chat/completions", gateway.url), {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      })).status).toBe(200);
      // Two charges spent: synthesis now refuses.
      expect((await speak(gateway.url, { cookie })).status).toBe(429);
    });

    test("starting a realtime conversation is a charge, and an exhausted user is rejected at session.start", async () => {
      gateway = quotaGateway(1);
      const cookie = await signUp(gateway.url, "quota-ws@test.dev");
      const wsUrl = new URL("/v1/realtime", gateway.url).toString().replace(/^http/, "ws");
      const origin = new URL(gateway.url).origin;

      const open = async (): Promise<{ socket: WebSocket; events: { type: string; reason?: string }[] }> => {
        const events: { type: string; reason?: string }[] = [];
        const socket = new WebSocket(wsUrl, { headers: { cookie, origin } } as never);
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve());
          socket.addEventListener("error", () => reject(new Error("upgrade refused")));
        });
        socket.addEventListener("message", event => {
          if (typeof event.data === "string") events.push(JSON.parse(event.data) as { type: string; reason?: string });
        });
        return { socket, events };
      };
      const until = async (events: { type: string }[], type: string): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (!events.some(event => event.type === type)) {
          if (Date.now() > deadline) throw new Error(`no ${type}; saw ${events.map(event => event.type).join(", ")}`);
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      };

      const first = await open();
      first.socket.send(JSON.stringify({
        v: protocolVersion,
        type: "session.start",
        idempotencyKey: "q-1",
        options: { language: "zh", voice: "demo", vad: "energy", threshold: 0.1, minSpeechMs: 40, silenceMs: 20, turnTaking: "conservative", bargeIn: true },
      }));
      await until(first.events, "session.snapshot");
      first.socket.close();

      // The allowance is spent; the next conversation is refused at start, not at upgrade.
      const second = await open();
      second.socket.send(JSON.stringify({
        v: protocolVersion,
        type: "session.start",
        idempotencyKey: "q-2",
        options: { language: "zh", voice: "demo", vad: "energy", threshold: 0.1, minSpeechMs: 40, silenceMs: 20, turnTaking: "conservative", bargeIn: true },
      }));
      await until(second.events, "command.rejected");
      expect(second.events.find(event => event.type === "command.rejected")?.reason).toBe("quota_exceeded");
      second.socket.close();
    });

    test("a quota without accounts is refused at startup — there would be one account to meter", () => {
      // The CLIs already refuse it; the library refuses it too, rather than starting up
      // metering nobody and logging about it (adversarial review 2026-07-26, L-4).
      expect(() => startGateway({ config, fetch: engineFetch(), port: 0, quota: { operations: 1, windowSeconds: 60 } }))
        .toThrow("accounts");
    });
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

describe("sign-in doors (docs/auth.md — the human door)", () => {
  const providers = { github: { clientId: "test-client-id", clientSecret: "test-client-secret" } };

  test("healthz reports which doors are open, without a credential", async () => {
    const dir = tempDir();
    dirs.push(dir);
    gateway = startGateway({
      config,
      fetch: engineFetch(),
      port: 0,
      accounts: { dir, secret: SECRET, socialProviders: providers, passwordLogin: false, rateLimit: { window: 60, max: 1_000 } },
    });
    const health = await (await fetch(new URL("/healthz", gateway.url))).json() as { login: { password: boolean; providers: string[] } };
    expect(health.login).toEqual({ password: false, providers: ["github"] });
  });

  test("a social sign-in hands back the provider's authorize URL, with our callback", async () => {
    const dir = tempDir();
    dirs.push(dir);
    gateway = startGateway({
      config,
      fetch: engineFetch(),
      port: 0,
      accounts: { dir, secret: SECRET, socialProviders: providers, passwordLogin: false, rateLimit: { window: 60, max: 1_000 } },
    });
    const origin = new URL(gateway.url).origin;
    const started = await fetch(new URL("/v1/auth/sign-in/social", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    });
    expect(started.status).toBe(200);
    const authorize = new URL((await started.json() as { url: string }).url);
    expect(authorize.host).toBe("github.com");
    expect(authorize.searchParams.get("client_id")).toBe("test-client-id");
    // The provider returns to us, at the origin this deployment publishes.
    expect(new URL(authorize.searchParams.get("redirect_uri") as string).pathname).toBe("/v1/auth/callback/github");
  });

  test("closing the password door actually closes it", async () => {
    const dir = tempDir();
    dirs.push(dir);
    gateway = startGateway({
      config,
      fetch: engineFetch(),
      port: 0,
      accounts: { dir, secret: SECRET, socialProviders: providers, passwordLogin: false, rateLimit: { window: 60, max: 1_000 } },
    });
    const origin = new URL(gateway.url).origin;
    const refused = await fetch(new URL("/v1/auth/sign-up/email", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "nope@test.dev", password: "password1234", name: "N" }),
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  test("a deployment with no way in at all is refused at startup", () => {
    const dir = tempDir();
    dirs.push(dir);
    expect(() => startGateway({ config, port: 0, accounts: { dir, secret: SECRET, passwordLogin: false } }))
      .toThrow("no way to sign in");
  });

  test("a provider beside an unverified password door is called out", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const lines: string[] = [];
    gateway = startGateway({
      config,
      fetch: engineFetch(),
      port: 0,
      accounts: { dir, secret: SECRET, socialProviders: providers, rateLimit: { window: 60, max: 1_000 } },
      log: line => lines.push(line),
    });
    // Touch the auth surface so the module loads, then check what it said.
    await fetch(new URL("/healthz", gateway.url));
    expect(lines.some(line => line.includes("weakest way in"))).toBe(true);
  });
});
