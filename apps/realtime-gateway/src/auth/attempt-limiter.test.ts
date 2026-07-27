import { afterEach, describe, expect, test } from "bun:test";
import { parseConfig } from "@voxstudio/config";
import { AuthAttemptLimiter, claimedEmail } from "./attempt-limiter";
import { startGateway, type GatewayServer } from "../server";

/**
 * The brute-force limiter keys on the account being attacked, not on a header the
 * attacker writes (adversarial review 2026-07-27: rotating `x-forwarded-for` defeated
 * the previous, address-keyed protection entirely).
 */

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    llm: { base_url: "http://llm.test" },
    tts: { base_url: "http://tts.test" },
  },
});

const SECRET = "an-adequately-long-test-secret-0123456789";
const limits = {
  signIn: { window: 900, max: 3 },
  perEmail: { window: 3_600, max: 2 },
  signUp: { window: 3_600, max: 50 },
  overall: { window: 60, max: 500 },
};

let gateway: GatewayServer | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  for (const dir of dirs.splice(0)) await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

function tempDir(): string {
  const dir = `${import.meta.dir}/../../node_modules/.test-attempts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  dirs.push(dir);
  return dir;
}

describe("AuthAttemptLimiter", () => {
  test("failed sign-ins ration the attacked account, and a success gives its charge back", () => {
    const limiter = new AuthAttemptLimiter(limits);
    // Three failures exhaust the allowance for that address.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(limiter.begin("/sign-in/email", "victim@test.dev").allowed).toBe(true);
      limiter.settle("/sign-in/email", "victim@test.dev", 401);
    }
    const refused = limiter.begin("/sign-in/email", "victim@test.dev");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);

    // Another account is untouched, and its correct password never counts against it.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(limiter.begin("/sign-in/email", "other@test.dev").allowed).toBe(true);
      limiter.settle("/sign-in/email", "other@test.dev", 200);
    }
  });

  test("the key is the claimed account, so it cannot be varied to escape", () => {
    const limiter = new AuthAttemptLimiter(limits);
    // Whatever an attacker varies, attacking one account draws on one allowance.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      limiter.begin("/sign-in/email", "VICTIM@test.dev");
      limiter.settle("/sign-in/email", "VICTIM@test.dev", 401);
    }
    // Case and surrounding space are not a new account.
    expect(limiter.begin("/sign-in/email", " victim@test.dev ").allowed).toBe(false);
  });

  test("a body with no readable email falls back to the ceiling instead of refusing", () => {
    const limiter = new AuthAttemptLimiter(limits);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(limiter.begin("/sign-in/email", undefined).allowed).toBe(true);
    }
  });

  test("password reset counts every request, successful or not", () => {
    const limiter = new AuthAttemptLimiter(limits);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(limiter.begin("/forget-password", "victim@test.dev").allowed).toBe(true);
      limiter.settle("/forget-password", "victim@test.dev", 200);
    }
    // A reset mail is sent whether or not the account exists; success is not a reason
    // to hand the allowance back.
    expect(limiter.begin("/forget-password", "victim@test.dev").allowed).toBe(false);
  });

  test("signup draws on a deployment-wide ceiling, not on any per-caller key", () => {
    const limiter = new AuthAttemptLimiter({ ...limits, signUp: { window: 3_600, max: 2 } });
    expect(limiter.begin("/sign-up/email", "one@test.dev").allowed).toBe(true);
    expect(limiter.begin("/sign-up/email", "two@test.dev").allowed).toBe(true);
    // A different address buys nothing: varying the email is the attack, not the defence.
    expect(limiter.begin("/sign-up/email", "three@test.dev").allowed).toBe(false);
  });

  test("an unknown auth route is bounded only by the overall ceiling", () => {
    const limiter = new AuthAttemptLimiter({ ...limits, overall: { window: 60, max: 3 } });
    expect(limiter.begin("/get-session", undefined).allowed).toBe(true);
    expect(limiter.begin("/get-session", undefined).allowed).toBe(true);
    expect(limiter.begin("/get-session", undefined).allowed).toBe(true);
    expect(limiter.begin("/get-session", undefined).allowed).toBe(false);
  });
});

describe("claimedEmail", () => {
  test("reads the address without consuming the body", async () => {
    const request = new Request("http://gw.test/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@test.dev", password: "x" }),
    });
    expect(await claimedEmail(request)).toBe("alice@test.dev");
    // The handler downstream still gets a readable body.
    expect(await request.json()).toEqual({ email: "alice@test.dev", password: "x" });
  });

  test("a malformed or GET request simply has no claim", async () => {
    expect(await claimedEmail(new Request("http://gw.test/v1/auth/get-session"))).toBeUndefined();
    expect(await claimedEmail(new Request("http://gw.test/v1/auth/sign-in/email", { method: "POST", body: "not json" }))).toBeUndefined();
  });
});

describe("the limiter on a live gateway", () => {
  const signIn = (base: string, email: string, forwardedFor: string): Promise<Response> =>
    fetch(new URL("/v1/auth/sign-in/email", base), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(base).origin, "x-forwarded-for": forwardedFor },
      body: JSON.stringify({ email, password: "definitely-wrong" }),
    });

  test("rotating x-forwarded-for no longer escapes the limit", async () => {
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET, attemptLimits: limits },
      fetch: async () => Response.json({}),
    });
    const origin = new URL(gateway.url).origin;
    expect((await fetch(new URL("/v1/auth/sign-up/email", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "victim@test.dev", password: "password1234", name: "V" }),
    })).status).toBe(200);

    // Every attempt claims a different address; the account is still what is rationed.
    const codes: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      codes.push((await signIn(gateway.url, "victim@test.dev", `10.0.0.${attempt + 1}`)).status);
    }
    expect(codes.filter(code => code === 429).length).toBeGreaterThan(0);

    const refused = await signIn(gateway.url, "victim@test.dev", "10.0.0.99");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
    const body = await refused.json() as { error: { code: string; retryAfterSeconds: number } };
    expect(body.error.code).toBe("too_many_attempts");
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);

    // A different account is unaffected — no shared bucket, no collateral lockout.
    expect((await signIn(gateway.url, "bystander@test.dev", "10.0.0.1")).status).toBe(401);
  });

  test("signing in correctly is never rationed, however often it happens", async () => {
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET, attemptLimits: limits },
      fetch: async () => Response.json({}),
    });
    const origin = new URL(gateway.url).origin;
    await fetch(new URL("/v1/auth/sign-up/email", gateway.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "regular@test.dev", password: "password1234", name: "R" }),
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(new URL("/v1/auth/sign-in/email", gateway.url), {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email: "regular@test.dev", password: "password1234" }),
      });
      expect(response.status).toBe(200);
    }
  });
});
