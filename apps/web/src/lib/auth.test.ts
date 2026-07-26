import { afterEach, describe, expect, test } from "bun:test";
import {
  AuthError,
  createApiKey,
  fetchAuthMode,
  fetchSession,
  listApiKeys,
  resendVerification,
  revokeApiKey,
  signIn,
  signOut,
  signUp,
} from "./auth";

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** Scripted gateway: the test answers /healthz and /v1/auth/* exactly as the real one does. */
function stubFetch(routes: Record<string, (call: Call) => Response>): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${call.method} ${url}`);
    return route(call);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("auth mode discovery", () => {
  test("reads the gateway's door from /healthz", async () => {
    stubFetch({ "/healthz": () => Response.json({ ok: true, auth: "accounts" }) });
    expect(await fetchAuthMode()).toBe("accounts");

    stubFetch({ "/healthz": () => Response.json({ ok: true, auth: "self" }) });
    expect(await fetchAuthMode()).toBe("self");
  });

  test("an unreachable or older gateway reads as self-hosted, never as a login wall", async () => {
    stubFetch({ "/healthz": () => new Response("nope", { status: 503 }) });
    expect(await fetchAuthMode()).toBe("self");

    // A gateway predating the field (no `auth` key at all).
    stubFetch({ "/healthz": () => Response.json({ ok: true, protocol: 1 }) });
    expect(await fetchAuthMode()).toBe("self");

    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await fetchAuthMode()).toBe("self");
  });
});

describe("session", () => {
  test("returns the signed-in user, with verification state", async () => {
    stubFetch({
      "/v1/auth/get-session": () => Response.json({
        session: { token: "s" },
        user: { id: "u-1", email: "alice@test.dev", name: "Alice", emailVerified: true },
      }),
    });
    expect(await fetchSession()).toEqual({ id: "u-1", email: "alice@test.dev", name: "Alice", emailVerified: true });
  });

  test("no session is null, not an error — 401 and an empty body alike", async () => {
    stubFetch({ "/v1/auth/get-session": () => new Response("", { status: 401 }) });
    expect(await fetchSession()).toBeNull();

    // Better Auth answers 200 with a null body when nobody is signed in.
    stubFetch({ "/v1/auth/get-session": () => new Response("null", { status: 200, headers: { "content-type": "application/json" } }) });
    expect(await fetchSession()).toBeNull();
  });

  test("an unverified account is reported, not hidden", async () => {
    stubFetch({
      "/v1/auth/get-session": () => Response.json({ user: { id: "u-2", email: "carol@test.dev", emailVerified: false } }),
    });
    expect((await fetchSession())?.emailVerified).toBe(false);
  });
});

describe("sign up, in, out", () => {
  test("each verb posts to its own endpoint with the expected body", async () => {
    stubFetch({
      "/v1/auth/sign-up/email": () => Response.json({ token: "t" }),
      "/v1/auth/sign-in/email": () => Response.json({ token: "t" }),
      "/v1/auth/sign-out": () => Response.json({ success: true }),
      "/v1/auth/send-verification-email": () => Response.json({ status: true }),
    });
    await signUp("alice@test.dev", "password1234", "Alice");
    await signIn("alice@test.dev", "password1234");
    await signOut();
    await resendVerification("alice@test.dev");

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      "POST /v1/auth/sign-up/email",
      "POST /v1/auth/sign-in/email",
      "POST /v1/auth/sign-out",
      "POST /v1/auth/send-verification-email",
    ]);
    expect(calls[0]?.body).toEqual({ email: "alice@test.dev", password: "password1234", name: "Alice" });
    expect(calls[1]?.body).toEqual({ email: "alice@test.dev", password: "password1234" });
  });

  test("a nameless signup derives one from the address instead of sending blank", async () => {
    stubFetch({ "/v1/auth/sign-up/email": () => Response.json({ token: "t" }) });
    await signUp("dave@test.dev", "password1234", "   ");
    expect((calls[0]?.body as { name: string }).name).toBe("dave");
  });

  test("the server's own refusal reaches the caller with code and message", async () => {
    stubFetch({
      "/v1/auth/sign-in/email": () => Response.json({ code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }, { status: 403 }),
    });
    const failure = await signIn("carol@test.dev", "password1234").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthError);
    expect((failure as AuthError).status).toBe(403);
    expect((failure as AuthError).code).toBe("EMAIL_NOT_VERIFIED");
    expect((failure as AuthError).message).toBe("Email not verified");
  });

  test("a non-JSON failure still throws with its status", async () => {
    stubFetch({ "/v1/auth/sign-out": () => new Response("gateway down", { status: 502 }) });
    const failure = await signOut().catch((error: unknown) => error);
    expect((failure as AuthError).status).toBe(502);
    expect((failure as AuthError).message).toContain("502");
  });
});

describe("api keys", () => {
  test("the list carries id, name and prefix — never a usable key", async () => {
    stubFetch({
      "/v1/auth/api-key/list": () => Response.json({
        apiKeys: [
          { id: "k-1", name: "cli", start: "abc123", createdAt: "2026-07-26T00:00:00.000Z", lastRequest: null },
          { id: "k-2", name: null, start: null, createdAt: "2026-07-26T01:00:00.000Z", lastRequest: "2026-07-26T02:00:00.000Z" },
          { name: "no id — dropped" },
        ],
      }),
    });
    const keys = await listApiKeys();
    expect(keys).toEqual([
      { id: "k-1", name: "cli", start: "abc123", createdAt: "2026-07-26T00:00:00.000Z", lastRequest: null },
      { id: "k-2", name: "", start: "", createdAt: "2026-07-26T01:00:00.000Z", lastRequest: "2026-07-26T02:00:00.000Z" },
    ]);
  });

  test("creating returns the key once; revoking names the key id", async () => {
    stubFetch({
      "/v1/auth/api-key/create": () => Response.json({ id: "k-9", key: "vox-secret-key-value", start: "vox-se" }),
      "/v1/auth/api-key/delete": () => Response.json({ success: true }),
    });
    expect(await createApiKey("my agent")).toBe("vox-secret-key-value");
    expect(calls[0]?.body).toEqual({ name: "my agent" });

    await revokeApiKey("k-9");
    expect(calls[1]?.body).toEqual({ keyId: "k-9" });
  });

  test("a create that returns no key is an error, not an empty string handed to the user", async () => {
    stubFetch({ "/v1/auth/api-key/create": () => Response.json({ id: "k-9" }) });
    await expect(createApiKey("broken")).rejects.toThrow("no key");
  });
});
