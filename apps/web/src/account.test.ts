import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useAccount } from "./account";
import { configureGatewayAuth, setGatewayToken } from "./lib/gateway-auth";
import { reportUnauthorized } from "./lib/unauthorized";

const realFetch = globalThis.fetch;

function stubGateway(auth: "self" | "accounts", session: unknown, options: { signOutStatus?: number; tokenRequired?: boolean; validToken?: string } = {}): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/healthz") return Response.json({ ok: true, auth, deployment: { tokenRequired: options.tokenRequired === true } });
    if (url === "/v1/engines") {
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === `Bearer ${options.validToken}` ? Response.json({ engines: [] }) : Response.json({}, { status: 401 });
    }
    if (url === "/v1/auth/get-session") {
      return session === null ? new Response("null", { status: 200, headers: { "content-type": "application/json" } }) : Response.json(session);
    }
    if (url === "/v1/auth/sign-out") return new Response("{}", { status: options.signOutStatus ?? 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  return seen;
}

beforeEach(() => {
  configureGatewayAuth("unavailable");
  setGatewayToken("");
  useAccount.setState({ status: "loading", mode: undefined, doors: { password: false, providers: [] }, user: null, tokenRequired: false, tokenRejected: false });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("account state", () => {
  test("a self-hosted gateway settles on self and never probes for a session", async () => {
    const seen = stubGateway("self", null);
    await useAccount.getState().refresh();
    expect(useAccount.getState().status).toBe("self");
    expect(useAccount.getState().user).toBeNull();
    expect(seen).toEqual(["GET /healthz"]);
  });

  test("a protected self-host stays locked until a presented token passes a protected probe", async () => {
    const seen = stubGateway("self", null, { tokenRequired: true, validToken: "correct-secret" });
    await useAccount.getState().refresh();
    expect(useAccount.getState().status).toBe("token-required");
    expect(seen).toEqual(["GET /healthz"]);

    await useAccount.getState().unlockSelfHosted("wrong-secret");
    expect(useAccount.getState().status).toBe("token-required");
    expect(useAccount.getState().tokenRejected).toBe(true);

    await useAccount.getState().unlockSelfHosted("correct-secret");
    expect(useAccount.getState().status).toBe("self");
    expect(seen.filter(entry => entry === "GET /v1/engines")).toHaveLength(2);
  });

  test("an unreachable gateway stays outside the studio instead of becoming self-hosted", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    await useAccount.getState().refresh();
    expect(useAccount.getState().status).toBe("unavailable");
    expect(useAccount.getState().mode).toBe("unavailable");
    expect(useAccount.getState().user).toBeNull();
  });

  test("hosted with no session is signed-out; with one, signed-in and carrying the user", async () => {
    stubGateway("accounts", null);
    await useAccount.getState().refresh();
    expect(useAccount.getState().status).toBe("signed-out");

    useAccount.setState({ mode: undefined });
    stubGateway("accounts", { user: { id: "u-1", email: "alice@test.dev", name: "Alice", emailVerified: true } });
    await useAccount.getState().refresh();
    expect(useAccount.getState().status).toBe("signed-in");
    expect(useAccount.getState().user?.email).toBe("alice@test.dev");
  });

  test("an unverified account still signs in — the shell nudges rather than blocks", async () => {
    stubGateway("accounts", { user: { id: "u-2", email: "carol@test.dev", emailVerified: false } });
    await useAccount.getState().refresh();
    expect(useAccount.getState().status).toBe("signed-in");
    expect(useAccount.getState().user?.emailVerified).toBe(false);
  });

  test("a 401 anywhere in the app sends a hosted shell back to the card", async () => {
    stubGateway("accounts", { user: { id: "u-1", email: "alice@test.dev", emailVerified: true } });
    await useAccount.getState().refresh();
    expect(useAccount.getState().status).toBe("signed-in");

    reportUnauthorized();
    expect(useAccount.getState().status).toBe("signed-out");
    expect(useAccount.getState().user).toBeNull();
  });

  test("a 401 in an unprotected self-hosted studio changes nothing", async () => {
    stubGateway("self", null);
    await useAccount.getState().refresh();
    reportUnauthorized();
    expect(useAccount.getState().status).toBe("self");
  });

  test("a 401 in a protected self-host forgets the rejected token and returns to the token entrance", async () => {
    stubGateway("self", null, { tokenRequired: true, validToken: "correct-secret" });
    await useAccount.getState().refresh();
    await useAccount.getState().unlockSelfHosted("correct-secret");
    expect(useAccount.getState().status).toBe("self");
    reportUnauthorized();
    expect(useAccount.getState().status).toBe("token-required");
    expect(useAccount.getState().tokenRejected).toBe(true);
  });

  test("signing out lands on the card even when the request itself fails", async () => {
    stubGateway("accounts", { user: { id: "u-1", email: "alice@test.dev", emailVerified: true } }, { signOutStatus: 502 });
    await useAccount.getState().refresh();
    await useAccount.getState().signOut();
    expect(useAccount.getState().status).toBe("signed-out");
    expect(useAccount.getState().user).toBeNull();
    // The mode survives: the deployment is still a hosted one.
    expect(useAccount.getState().mode).toBe("accounts");
  });
});
