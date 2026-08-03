import { afterEach, describe, expect, test } from "bun:test";
import {
  bootstrapGatewayToken,
  configureGatewayAuth,
  clearGatewayToken,
  gatewayFetch,
  gatewayRealtimeUrl,
  gatewayResourceUrl,
  hasGatewayToken,
  setGatewayToken,
} from "./gateway-auth";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  bootstrapGatewayToken({ href: "http://studio.test/", storage: new MemoryStorage(), replaceUrl: () => {} });
  configureGatewayAuth("unavailable");
});

describe("self-hosted shared token", () => {
  test("captures a query token, redacts the URL, and adds Authorization to gateway REST", async () => {
    const storage = new MemoryStorage();
    let replaced = "";
    bootstrapGatewayToken({
      href: "http://studio.test/agents/support?token=top-secret&section=deploy#details",
      storage,
      replaceUrl: url => { replaced = url; },
    });
    configureGatewayAuth("self", true);

    let request: { input: string; headers: Headers } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { input: String(input), headers: new Headers(init?.headers) };
      return Response.json({ ok: true });
    }) as typeof fetch;

    await gatewayFetch("/v1/agents", { headers: { "x-client": "studio" } });
    expect(replaced).toBe("/agents/support?section=deploy#details");
    expect(request?.input).toBe("/v1/agents");
    expect(request?.headers.get("authorization")).toBe("Bearer top-secret");
    expect(request?.headers.get("x-client")).toBe("studio");
  });

  test("prefers a fragment token, survives reload in this tab, and never decorates health checks", async () => {
    const storage = new MemoryStorage();
    let replaced = "";
    bootstrapGatewayToken({
      href: "https://studio.test/settings?theme=dark#token=fragment-secret&panel=runtime",
      storage,
      replaceUrl: url => { replaced = url; },
    });
    configureGatewayAuth("self", true);
    expect(replaced).toBe("/settings?theme=dark#panel=runtime");
    expect(gatewayRealtimeUrl("https://studio.test/settings")).toBe(
      "wss://studio.test/v1/realtime?token=fragment-secret",
    );

    // A reload has no token in its address bar, but this tab retains the captured value.
    bootstrapGatewayToken({ href: "https://studio.test/settings", storage, replaceUrl: () => {} });
    configureGatewayAuth("self", true);
    expect(gatewayResourceUrl("/v1/library/c-1/audio", "https://studio.test/settings"))
      .toBe("/v1/library/c-1/audio?token=fragment-secret");
    expect(gatewayResourceUrl("https://cdn.example/audio.wav", "https://studio.test/settings"))
      .toBe("https://cdn.example/audio.wav");

    let headers = new Headers();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return Response.json({ ok: true });
    }) as typeof fetch;
    await gatewayFetch("/healthz");
    expect(headers.has("authorization")).toBe(false);
  });

  test("does not overwrite an explicit credential", async () => {
    bootstrapGatewayToken({
      href: "http://studio.test/#token=shared",
      storage: new MemoryStorage(),
      replaceUrl: () => {},
    });
    configureGatewayAuth("self", true);

    let authorization = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ ok: true });
    }) as typeof fetch;
    await gatewayFetch("/v1/agents", { headers: { authorization: "Bearer explicit" } });
    expect(authorization).toBe("Bearer explicit");
  });

  test("lets the token entrance replace and clear the tab-scoped credential", () => {
    const storage = new MemoryStorage();
    bootstrapGatewayToken({ href: "http://studio.test/", storage, replaceUrl: () => {} });
    configureGatewayAuth("self", true);
    expect(hasGatewayToken()).toBe(false);
    setGatewayToken("entered-secret");
    expect(hasGatewayToken()).toBe(true);
    expect(gatewayRealtimeUrl("http://studio.test/")).toContain("token=entered-secret");
    clearGatewayToken();
    expect(hasGatewayToken()).toBe(false);
  });

  test("clears a captured token when discovery reports accounts or unprotected self-host", async () => {
    const storage = new MemoryStorage();
    bootstrapGatewayToken({
      href: "http://studio.test/#token=shared",
      storage,
      replaceUrl: () => {},
    });
    configureGatewayAuth("accounts");

    let headers = new Headers();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return Response.json({ ok: true });
    }) as typeof fetch;
    await gatewayFetch("/v1/auth/get-session");
    expect(headers.has("authorization")).toBe(false);

    bootstrapGatewayToken({ href: "http://studio.test/", storage, replaceUrl: () => {} });
    configureGatewayAuth("self", true);
    expect(gatewayRealtimeUrl("http://studio.test/")).toBe("ws://studio.test/v1/realtime");
  });
});
