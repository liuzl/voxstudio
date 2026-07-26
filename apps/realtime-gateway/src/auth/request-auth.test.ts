import { describe, expect, test } from "bun:test";
import { OWNER_USER_ID } from "./auth-context";
import { isLoopbackHost, resolveAuthContext, upgradeOriginAllowed } from "./request-auth";

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

  test("loopback origins pass only when the exception is granted (a local bind)", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
      const upgrade = request("http://127.0.0.1:8790/v1/realtime", { origin, host: "127.0.0.1:8790" });
      expect(upgradeOriginAllowed(upgrade, { allowLoopback: true })).toBe(true);
      // A gateway bound to a network interface (or one serving accounts) grants nothing.
      expect(upgradeOriginAllowed(upgrade)).toBe(false);
    }
  });

  test("an allowed-origins policy matches the full origin and grants no exceptions", () => {
    const allowedOrigins = ["https://voxstudio.example"];
    const upgrade = (origin: string): Request =>
      request("http://127.0.0.1:8790/v1/realtime", { origin, host: "127.0.0.1:8790" });
    expect(upgradeOriginAllowed(upgrade("https://voxstudio.example"), { allowedOrigins })).toBe(true);
    // The scheme is part of identity, and loopback is not on the list.
    expect(upgradeOriginAllowed(upgrade("http://voxstudio.example"), { allowedOrigins })).toBe(false);
    expect(upgradeOriginAllowed(upgrade("http://localhost:5173"), { allowedOrigins, allowLoopback: true })).toBe(false);
    expect(upgradeOriginAllowed(upgrade("https://evil.example"), { allowedOrigins })).toBe(false);
    // Header-less clients still pass: an agent is not a browser.
    expect(upgradeOriginAllowed(request("http://127.0.0.1:8790/v1/realtime"), { allowedOrigins })).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  test("recognizes the local binds and nothing else", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["0.0.0.0", "192.168.1.10", "voxstudio.example"]) expect(isLoopbackHost(host)).toBe(false);
  });
});
