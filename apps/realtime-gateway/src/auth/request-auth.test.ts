import { describe, expect, test } from "bun:test";
import { OWNER_USER_ID } from "./auth-context";
import { resolveAuthContext, upgradeOriginAllowed } from "./request-auth";

const request = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { headers });

describe("resolveAuthContext", () => {
  test("without a configured token, every caller is the owner via none", () => {
    expect(resolveAuthContext(request("http://gw.test/v1/voices"), {}))
      .toEqual({ userId: OWNER_USER_ID, via: "none" });
    // An empty token means unset (the entrypoints' contract), not an empty password.
    expect(resolveAuthContext(request("http://gw.test/v1/voices"), { token: "" }))
      .toEqual({ userId: OWNER_USER_ID, via: "none" });
  });

  test("a configured token resolves via header or query, and refuses everything else", () => {
    const options = { token: "gw-secret" };
    expect(resolveAuthContext(request("http://gw.test/v1/voices", { authorization: "Bearer gw-secret" }), options))
      .toEqual({ userId: OWNER_USER_ID, via: "token" });
    expect(resolveAuthContext(request("http://gw.test/v1/realtime?token=gw-secret"), options))
      .toEqual({ userId: OWNER_USER_ID, via: "token" });
    expect(resolveAuthContext(request("http://gw.test/v1/voices"), options)).toBeNull();
    expect(resolveAuthContext(request("http://gw.test/v1/voices", { authorization: "Bearer wrong" }), options)).toBeNull();
    expect(resolveAuthContext(request("http://gw.test/v1/voices", { authorization: "gw-secret" }), options)).toBeNull();
    expect(resolveAuthContext(request("http://gw.test/v1/realtime?token=gw-secre"), options)).toBeNull();
  });
});

describe("upgradeOriginAllowed", () => {
  test("no Origin (non-browser clients) passes", () => {
    expect(upgradeOriginAllowed(request("http://gw.test/v1/realtime"))).toBe(true);
  });

  test("same-origin passes; a cross-site origin is refused", () => {
    expect(upgradeOriginAllowed(request("https://studio.example/v1/realtime", {
      origin: "https://studio.example",
      host: "studio.example",
    }))).toBe(true);
    expect(upgradeOriginAllowed(request("http://127.0.0.1:8790/v1/realtime", {
      origin: "https://evil.example",
      host: "127.0.0.1:8790",
    }))).toBe(false);
    expect(upgradeOriginAllowed(request("http://gw.test/v1/realtime", { origin: "not a url" }))).toBe(false);
  });

  test("loopback origins pass (the Vite dev server fronts the gateway)", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
      expect(upgradeOriginAllowed(request("http://127.0.0.1:8790/v1/realtime", {
        origin,
        host: "127.0.0.1:8790",
      }))).toBe(true);
    }
  });
});
