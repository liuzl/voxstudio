import { afterEach, describe, expect, test } from "bun:test";
import { listVoices } from "./api";
import { onUnauthorized, reportUnauthorized } from "./unauthorized";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("unauthorized reporting", () => {
  test("listeners fire, and unsubscribing stops them", () => {
    let seen = 0;
    const stop = onUnauthorized(() => { seen += 1; });
    reportUnauthorized();
    expect(seen).toBe(1);
    stop();
    reportUnauthorized();
    expect(seen).toBe(1);
  });

  test("a 401 from a /v1 helper reports it, and other failures do not", async () => {
    let seen = 0;
    const stop = onUnauthorized(() => { seen += 1; });

    globalThis.fetch = (() => Promise.resolve(new Response("unauthorized", { status: 401 }))) as unknown as typeof fetch;
    await expect(listVoices()).rejects.toThrow();
    expect(seen).toBe(1);

    // A 502 is an engine problem, not a credential problem: the shell must not log out.
    globalThis.fetch = (() => Promise.resolve(Response.json({ error: { message: "engine unreachable" } }, { status: 502 }))) as unknown as typeof fetch;
    await expect(listVoices()).rejects.toThrow();
    expect(seen).toBe(1);
    stop();
  });
});
