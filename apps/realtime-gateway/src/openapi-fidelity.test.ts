import { afterEach, describe, expect, test } from "bun:test";
import { parseConfig } from "@voxstudio/config";
import { openApiDocument, type DiscoveryOptions } from "./discovery";
import { apiRoutes, discoveryRoutesCatalog, routeFor } from "./routes";
import { startGateway, type GatewayServer } from "./server";

/**
 * The document must describe the gateway that serves it. The old check compared the
 * OpenAPI paths against a hand-written constant, so a route could gain a method, a
 * parameter, or a status code with the test still green (adversarial review 2026-07-26
 * found four such drifts). These compare against the catalog the router dispatches from,
 * and — for methods — against a running gateway.
 */

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    llm: { base_url: "http://llm.test" },
    tts: { base_url: "http://tts.test" },
  },
});

const options: DiscoveryOptions = { baseUrl: "https://voxstudio.example", library: true, demo: false, livekit: true };
const document = openApiDocument(options) as {
  paths: Record<string, Record<string, { security?: unknown[]; parameters?: { name: string }[]; responses: Record<string, unknown> }>>;
};

let gateway: GatewayServer | undefined;

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
});

describe("the OpenAPI paths come from the router's own catalog", () => {
  test("every catalog route is documented, and every documented path is a catalog route", () => {
    const catalogPaths = [...apiRoutes, ...discoveryRoutesCatalog].map(route => route.path).sort();
    expect(Object.keys(document.paths).sort()).toEqual(catalogPaths);
  });

  test("every catalog method is documented, and no extra ones are", () => {
    for (const route of [...apiRoutes, ...discoveryRoutesCatalog]) {
      const documented = Object.keys(document.paths[route.path] ?? {})
        .filter(key => key !== "parameters")
        .map(key => key.toUpperCase())
        .sort();
      // HEAD rides along with GET; the document describes GET.
      const expected = route.methods.filter(method => method !== "HEAD").sort();
      expect(documented).toEqual(expected);
    }
  });

  test("a route that reads ?engine= documents it", () => {
    for (const route of apiRoutes.filter(entry => entry.engineParam === true)) {
      for (const method of route.methods) {
        const operation = document.paths[route.path]?.[method.toLowerCase()];
        const names = [
          ...(document.paths[route.path]?.parameters as { name: string }[] | undefined ?? []),
          ...(operation?.parameters ?? []),
        ].map(parameter => parameter.name);
        expect(names).toContain("engine");
      }
    }
  });

  test("authenticated operations declare 401 and 405; charged/capacity-limited ones declare 429; public ones declare neither", () => {
    for (const route of apiRoutes) {
      for (const method of route.methods.filter(entry => entry !== "HEAD")) {
        const responses = Object.keys(document.paths[route.path]?.[method.toLowerCase()]?.responses ?? {});
        if (route.public === true) {
          expect(responses).not.toContain("401");
          continue;
        }
        expect(responses).toContain("401");
        expect(responses).toContain("405");
        if (route.charged?.includes(method) || route.capacityLimited?.includes(method)) expect(responses).toContain("429");
        else expect(responses).not.toContain("429");
        if (route.library === true) expect(responses).toContain("503");
      }
    }
  });

  test("library routes appear only when the library is enabled", () => {
    const withoutLibrary = openApiDocument({ ...options, library: false }) as { paths: Record<string, unknown> };
    const libraryPaths = apiRoutes.filter(route => route.library === true).map(route => route.path);
    expect(libraryPaths.length).toBeGreaterThan(0);
    for (const path of libraryPaths) {
      expect(document.paths[path]).toBeDefined();
      expect(withoutLibrary.paths[path]).toBeUndefined();
    }
  });

  test("LiveKit bootstrap appears only when its signer and adapter are configured", () => {
    const withoutLiveKit = openApiDocument({ ...options, livekit: false }) as { paths: Record<string, unknown> };
    expect(document.paths["/v1/realtime/livekit/token"]).toBeDefined();
    expect(withoutLiveKit.paths["/v1/realtime/livekit/token"]).toBeUndefined();
  });
});

describe("the catalog matches the gateway that runs", () => {
  test("a documented method is dispatched and an undocumented one is refused, on a live gateway", async () => {
    gateway = startGateway({ config, port: 0, fetch: async () => Response.json({ voices: [] }) });
    // A method no route serves: every documented path must refuse it as 405, which
    // also proves the path is routed at all rather than falling through to 404.
    for (const route of apiRoutes) {
      const probe = route.path
        .replace("{id}", route.path.startsWith("/v1/library") ? "00000000-0000-4000-8000-000000000000" : "probe-voice")
        .replace("{sessionId}", "00000000-0000-4000-8000-000000000000")
        .replace("{assetId}", "00000000-0000-4000-8000-000000000001");
      const refused = await fetch(new URL(probe, gateway.url), { method: "PUT" });
      expect({ path: route.path, status: refused.status }).toEqual({ path: route.path, status: 405 });
      const body = await refused.json() as { error: { code: string } };
      expect(body.error.code).toBe("method_not_allowed");
    }
  });

  test("healthz answers GET and refuses the rest", async () => {
    gateway = startGateway({ config, port: 0, fetch: async () => Response.json({}) });
    expect((await fetch(new URL("/healthz", gateway.url))).status).toBe(200);
    for (const method of ["POST", "DELETE", "PUT"]) {
      const refused = await fetch(new URL("/healthz", gateway.url), { method });
      expect(refused.status).toBe(405);
      expect((await refused.json() as { error: { code: string } }).error.code).toBe("method_not_allowed");
    }
  });

  test("the catalog's charged set is exactly what the quota charges", () => {
    // routeFor is what the quota asks; this pins the two together by construction.
    expect(routeFor("/v1/audio/speech")?.charged).toEqual(["POST"]);
    expect(routeFor("/v1/engines")?.charged).toBeUndefined();
    expect(routeFor("/v1/library/abc/promote")?.charged).toEqual(["POST"]);
    expect(routeFor("/v1/realtime/livekit/token")?.charged).toBeUndefined();
    expect(routeFor("/v1/library/abc")?.charged).toBeUndefined();
    // A path nothing serves has no route at all.
    expect(routeFor("/v1/nope")).toBeUndefined();
  });
});

describe("the document describes itself and the parts it used to leave out", () => {
  test("the discovery surface is documented, publicly and read-only", () => {
    for (const path of ["/agent", "/llms.txt", "/openapi.json"]) {
      const operation = document.paths[path]?.get as { security?: unknown[] } | undefined;
      expect(operation).toBeDefined();
      // No credential, and nothing but GET.
      expect(operation?.security).toEqual([]);
      expect(Object.keys(document.paths[path] ?? {}).filter(key => key !== "parameters")).toEqual(["get"]);
    }
  });

  test("the facade's passthrough is stated rather than implied", () => {
    // Extra fields reach the engine unchanged; a reader must not think the list is closed.
    for (const path of ["/v1/audio/speech", "/v1/chat/completions"]) {
      const body = (document.paths[path]?.post as unknown as { requestBody: { content: Record<string, { schema: Record<string, unknown> }> } })
        .requestBody.content["application/json"]?.schema;
      expect(body?.additionalProperties).toBe(true);
      expect(String(body?.description ?? "")).toContain("engine");
    }
  });

  test("pagination says that it clamps rather than rejects", () => {
    const list = document.paths["/v1/library"]?.get as { parameters: { name: string; description?: string }[] };
    const limit = list.parameters.find(parameter => parameter.name === "limit");
    expect(String(limit?.description ?? "").toLowerCase()).toContain("clamp");
  });

  test("the session count is described as self-hosted only", () => {
    const health = document.paths["/healthz"]?.get as unknown as { responses: Record<string, { content: Record<string, { schema: { properties: Record<string, { description?: string }> } }> }> };
    const properties = health.responses["200"]?.content["application/json"]?.schema.properties;
    expect(String(properties?.sessions?.description ?? "")).toContain("self-hosted");
  });
});

describe("the charged list agent-facing documents publish is derived, not restated", () => {
  test("every charged route and every non-route charge appears in /agent and llms.txt", async () => {
    const { agentPage, llmsTxt } = await import("./discovery");
    const { chargedBeyondRoutes } = await import("./routes");
    const metered = { ...options, quota: { operations: 100, windowSeconds: 3_600 } };
    const page = agentPage(metered);
    const index = llmsTxt(metered);

    for (const route of apiRoutes) {
      if (route.livekit === true && options.livekit !== true) continue;
      for (const method of route.charged ?? []) {
        expect(page).toContain(`${method} ${route.path}`);
        expect(index).toContain(`${method} ${route.path}`);
      }
    }
    // The two charges that are not HTTP routes — the omission that made /agent
    // under-report what an account pays for.
    for (const charge of chargedBeyondRoutes) {
      expect(page).toContain(charge);
      expect(index).toContain(charge);
    }
    expect(page).toContain("each turn within a realtime conversation");
  });
});
