import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useAccount } from "./account";
import { reportUnauthorized } from "./lib/unauthorized";

const realFetch = globalThis.fetch;

function stubGateway(auth: "self" | "accounts", session: unknown, options: { signOutStatus?: number } = {}): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/healthz") return Response.json({ ok: true, auth });
    if (url === "/v1/auth/get-session") {
      return session === null ? new Response("null", { status: 200, headers: { "content-type": "application/json" } }) : Response.json(session);
    }
    if (url === "/v1/auth/sign-out") return new Response("{}", { status: options.signOutStatus ?? 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  return seen;
}

beforeEach(() => {
  useAccount.setState({ status: "loading", mode: undefined, user: null });
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

  test("a 401 in a self-hosted studio changes nothing — there is no card to show", async () => {
    stubGateway("self", null);
    await useAccount.getState().refresh();
    reportUnauthorized();
    expect(useAccount.getState().status).toBe("self");
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
