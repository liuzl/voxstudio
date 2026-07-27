import { describe, expect, test } from "bun:test";
import { agentPage, llmsTxt, openApiDocument, type DiscoveryOptions } from "./discovery";

const options: DiscoveryOptions = { baseUrl: "https://voxstudio.example/", library: true, demo: false };

describe("agent onboarding page", () => {
  test("teaches the credential path, both headers, and their precedence", () => {
    const page = agentPage(options);
    expect(page).toContain("Authorization: Bearer <key>");
    expect(page).toContain("x-api-key: <key>");
    // Preference and the rule that keeps an agent from borrowing a browser session.
    expect(page).toContain("preferred");
    expect(page).toContain("A presented key decides the request");
    expect(page).toContain("Cookies belong to browsers");
    // Keys come from a human in the Studio — no signup API, no device flow.
    expect(page).toContain("/settings");
    expect(page).toContain("shown exactly once");
    expect(page).toContain("no device flow");
  });

  test("teaches error recovery, including 429 and Retry-After", () => {
    const page = agentPage(options);
    for (const status of ["**401**", "**429**", "**403**", "**502/503**"]) expect(page).toContain(status);
    expect(page).toContain("Retry-After");
    expect(page).toContain("60 seconds");
    // The codes an agent should branch on, not prose.
    for (const code of ["library_disabled", "bad_voice_id", "demo_mode"]) expect(page).toContain(code);
  });

  test("states the ownership and consent boundaries", () => {
    const page = agentPage(options);
    expect(page).toContain("belongs to the account that made it");
    expect(page).toContain("no admin scope");
    expect(page).toContain("display names");
    expect(page).toContain("consent");
    expect(page).toContain("Do not log it");
  });

  test("links the machine index and the contract at this deployment's origin", () => {
    const page = agentPage(options);
    expect(page).toContain("https://voxstudio.example/llms.txt");
    expect(page).toContain("https://voxstudio.example/openapi.json");
    expect(page).toContain("https://voxstudio.example/v1");
    // The trailing slash of baseUrl never doubles up.
    expect(page).not.toContain("voxstudio.example//");
  });

  test("describes the deployment as configured, not as imagined", () => {
    const withLibrary = agentPage(options);
    // The route list is generated from the catalog, so the library's routes appear
    // there verbatim when it is on.
    expect(withLibrary).toContain("GET /v1/library");
    expect(withLibrary).toContain("POST /v1/library/{id}/promote");
    expect(withLibrary).not.toContain("library is not enabled");

    const without = agentPage({ ...options, library: false });
    expect(without).toContain("library is not enabled");
    expect(without).not.toContain("/v1/library/{id}/promote");

    const demo = agentPage({ ...options, demo: true });
    expect(demo).toContain("demo mode");
    expect(agentPage(options)).not.toContain("runs in demo mode");
  });

  test("promises no SLA and no unimplemented surface", () => {
    const page = agentPage(options);
    expect(page).toContain("no SLA");
    // Nothing about signup, organizations, scopes, or device authorization: they do not exist.
    for (const absent of ["organization", "scope:", "device_code", "/v1/agents", "billing"]) {
      expect(page.toLowerCase()).not.toContain(absent.toLowerCase());
    }
  });
});

describe("llms.txt", () => {
  test("is a compact index: the summary block, the links, the rules", () => {
    const index = llmsTxt(options);
    expect(index.startsWith("# voxstudio")).toBe(true);
    expect(index).toContain("> Self-hosted voice stack");
    expect(index).toContain("https://voxstudio.example/agent");
    expect(index).toContain("https://voxstudio.example/openapi.json");
    expect(index).toContain("Authorization: Bearer <key>");
    expect(index).toContain("Retry-After");
    // Compact means compact: an index, not a manual.
    expect(index.split("\n").length).toBeLessThan(45);
  });

  test("lists every implemented route family and no others", () => {
    const index = llmsTxt(options);
    for (const path of ["/v1/audio/speech", "/v1/audio/transcriptions", "/v1/chat/completions", "/v1/engines", "/v1/voices", "/v1/design-profiles", "/v1/library", "/v1/realtime"]) {
      expect(index).toContain(path);
    }
    expect(index).not.toContain("/v1/auth");
    const off = llmsTxt({ ...options, library: false });
    expect(off).toContain("not enabled on this deployment");
  });
});

describe("quota in the documents (docs/auth.md phase 4)", () => {
  const metered: DiscoveryOptions = { ...options, quota: { operations: 500, windowSeconds: 3_600 } };

  test("the agent page states the real allowance and what it charges for", () => {
    const page = agentPage(metered);
    expect(page).toContain("500 chargeable operations per 3600 seconds, per account");
    // Charged and free are both named — a pacing agent needs the boundary, not a warning.
    expect(page).toContain("/v1/audio/speech");
    expect(page).toContain("session.start");
    expect(page).toContain("Free: every GET");
    expect(page).toContain("quota_exceeded");
    expect(page).toContain("requestId");
    expect(page).toContain("anchored at your first charged call");
    expect(page).toContain("Sharing an account with other agents shares the allowance");
  });

  test("an unmetered deployment says so instead of threatening a 429 it never sends", () => {
    const page = agentPage(options);
    expect(page).toContain("enforces no per-account quota");
    expect(page).not.toContain("chargeable operations per");
    // The honest caveat: something in front of the gateway may still refuse.
    expect(page).toContain("Rate limiting may still exist in front of the gateway");
  });

  test("llms.txt carries the same numbers, compactly", () => {
    const index = llmsTxt(metered);
    expect(index).toContain("500 chargeable operations per 3600s");
    expect(index).toContain("quota_exceeded");
    expect(llmsTxt(options)).toContain("No per-account quota on this deployment");
  });

  test("the OpenAPI description and every charged route document the refusal", () => {
    const document = openApiDocument(metered) as {
      info: { description: string };
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.info.description).toContain("500 chargeable operations per 3600s");

    // Exactly the chargeable operations declare 429 — no more, no fewer.
    const charged = [
      ["/v1/audio/speech", "post"],
      ["/v1/audio/transcriptions", "post"],
      ["/v1/chat/completions", "post"],
      ["/v1/voices", "post"],
      ["/v1/design-profiles", "post"],
      ["/v1/library/{id}/promote", "post"],
    ] as const;
    for (const [path, method] of charged) {
      expect(Object.keys(document.paths[path]?.[method]?.responses ?? {})).toContain("429");
    }
    const free = [["/v1/voices", "get"], ["/v1/engines", "get"], ["/v1/library", "get"], ["/healthz", "get"]] as const;
    for (const [path, method] of free) {
      expect(Object.keys(document.paths[path]?.[method]?.responses ?? {})).not.toContain("429");
    }

    // The refusal's body and headers are typed, not prose.
    const quotaError = document.components.schemas.QuotaError as { properties: { error: { properties: Record<string, unknown>; required: string[] } } };
    expect(quotaError.properties.error.required.sort()).toEqual(["code", "message", "requestId", "retryAfterSeconds"]);
    const refusal = document.paths["/v1/audio/speech"]?.post?.responses?.["429"] as { headers: Record<string, unknown> };
    expect(Object.keys(refusal.headers).sort()).toEqual(["Retry-After", "x-request-id"]);
  });
});

describe("openapi document", () => {
  const document = openApiDocument(options) as {
    openapi: string;
    servers: { url: string }[];
    security: unknown[];
    paths: Record<string, Record<string, unknown>>;
    components: { securitySchemes: Record<string, Record<string, unknown>>; schemas: Record<string, unknown> };
  };

  test("is OpenAPI 3.1 pointed at this deployment", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([{ url: "https://voxstudio.example" }]);
  });

  test("declares both API key headers as security schemes, and applies them", () => {
    const bearer = document.components.securitySchemes.bearerAuth;
    expect(bearer?.type).toBe("http");
    expect(bearer?.scheme).toBe("bearer");
    const native = document.components.securitySchemes.apiKeyHeader;
    expect(native?.type).toBe("apiKey");
    expect(native?.in).toBe("header");
    expect(native?.name).toBe("x-api-key");
    // Both accepted document-wide, and on a representative operation.
    expect(document.security).toEqual([{ bearerAuth: [] }, { apiKeyHeader: [] }]);
    const speech = document.paths["/v1/audio/speech"]?.post as { security: unknown };
    expect(speech.security).toEqual([{ bearerAuth: [] }, { apiKeyHeader: [] }]);
  });

  test("the realtime socket and the auth library's surface stay deliberately absent", () => {
    // Which paths *are* present is pinned against the router's catalog in
    // openapi-fidelity.test.ts; these two are the documented omissions.
    expect(document.paths["/v1/realtime"]).toBeUndefined();
    expect(Object.keys(document.paths).some(path => path.startsWith("/v1/auth"))).toBe(false);
  });

  test("only the public surface is unauthenticated; every /v1 operation is guarded", () => {
    const health = document.paths["/healthz"]?.get as { security: unknown[] };
    expect(health.security).toEqual([]);
    // /healthz and the discovery documents are the public set, by design.
    const publicPaths = ["/healthz", "/agent", "/llms.txt", "/openapi.json"];
    for (const [path, operations] of Object.entries(document.paths)) {
      if (publicPaths.includes(path)) continue;
      for (const [method, operation] of Object.entries(operations)) {
        if (method === "parameters") continue;
        expect((operation as { security?: unknown[] }).security).toEqual([{ bearerAuth: [] }, { apiKeyHeader: [] }]);
      }
    }
  });

  test("library paths appear only when the library is enabled", () => {
    const off = openApiDocument({ ...options, library: false }) as { paths: Record<string, unknown> };
    expect(Object.keys(off.paths).some(path => path.startsWith("/v1/library"))).toBe(false);
    expect(off.paths["/v1/audio/speech"]).toBeDefined();
  });

  test("every $ref resolves inside the document", () => {
    const refs = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { for (const item of node) walk(item); return; }
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") refs.add(value);
        else walk(value);
      }
    };
    walk(document);
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      expect(document.components.schemas[ref.replace("#/components/schemas/", "")]).toBeDefined();
    }
  });

  test("the documented request bodies match what the gateway actually accepts", () => {
    const speech = document.paths["/v1/audio/speech"]?.post as {
      requestBody: { content: Record<string, { schema: { properties: Record<string, unknown>; required: string[] } }> };
    };
    const body = speech.requestBody.content["application/json"]?.schema;
    // `input` is the only required field; voice is optional (the engine default applies).
    expect(body?.required).toEqual(["input"]);
    for (const field of ["input", "voice", "response_format", "cfg_value", "timesteps", "seed", "speed", "stream"]) {
      expect(Object.keys(body?.properties ?? {})).toContain(field);
    }

    // Transcription is multipart with `file`, as the ASR client sends.
    const transcribe = document.paths["/v1/audio/transcriptions"]?.post as {
      requestBody: { content: Record<string, { schema: { properties: Record<string, unknown>; required: string[] } }> };
    };
    const form = transcribe.requestBody.content["multipart/form-data"]?.schema;
    expect(form?.required).toEqual(["file"]);
    expect(Object.keys(form?.properties ?? {})).toContain("language");

    // Voice registration is multipart id/text/audio, and the id pattern is the engine's.
    const register = document.paths["/v1/voices"]?.post as {
      requestBody: { content: Record<string, { schema: { properties: Record<string, { pattern?: string }>; required: string[] } }> };
    };
    const registerForm = register.requestBody.content["multipart/form-data"]?.schema;
    expect(registerForm?.required.sort()).toEqual(["audio", "id", "text"]);
    // The pattern now excludes names shaped like an internal engine id, which the
    // gateway refuses with bad_voice_id (adversarial review 2026-07-26, M-10).
    expect(registerForm?.properties.id?.pattern).toBe("^(?!u[0-9a-f]{12}\\.)[A-Za-z0-9._-]{1,64}$");
  });

  test("documents the error envelope and the codes callers branch on", () => {
    expect(document.components.schemas.Error).toBeDefined();
    const serialized = JSON.stringify(document);
    for (const code of ["engine_unreachable", "demo_mode", "library_disabled", "unknown_capture", "bad_voice_id", "library_closing", "empty_transcript"]) {
      expect(serialized).toContain(code);
    }
    // 429 and its backoff instruction are part of the contract, not folklore.
    expect(serialized).toContain("Retry-After");
    const speech = document.paths["/v1/audio/speech"]?.post as { responses: Record<string, unknown> };
    expect(Object.keys(speech.responses)).toContain("429");
  });

  test("the skill agrees with the served surface, and stays thin", async () => {
    const skill = await Bun.file(`${import.meta.dir}/../../../skills/vox-api/SKILL.md`).text();
    // Same contract as the page and the document: both headers, Bearer preferred.
    expect(skill).toContain("Authorization: Bearer");
    expect(skill).toContain("x-api-key");
    expect(skill).toContain("Prefer the first form");
    expect(skill).toContain("A presented key decides the request");
    // Discovery first, and the same four documents the gateway serves.
    for (const path of ["/llms.txt", "/agent", "/openapi.json", "/healthz"]) expect(skill).toContain(path);
    // Every error code it teaches must be one the gateway actually emits.
    const serialized = JSON.stringify(document);
    for (const code of ["demo_mode", "library_disabled", "bad_voice_id", "engine_unreachable"]) {
      expect(skill).toContain(code);
      expect(serialized).toContain(code);
    }
    expect(skill).toContain("Retry-After");

    // Thin: it teaches discovery, auth, calling, and recovery — it does not install,
    // configure, or run anything, and carries no business logic of its own.
    for (const forbidden of ["npm install", "bun install", "pip install", "docker run", "systemctl", "git clone", "wrangler", "VOX_AUTH_SECRET"]) {
      expect(skill).not.toContain(forbidden);
    }
    // And it does not invent capabilities the product does not have.
    const lowered = skill.toLowerCase();
    for (const absent of ["device_code", "organization", "rbac", "scope:"]) {
      expect(lowered).not.toContain(absent);
    }
  });

  test("capture records carry their owner, so a reader knows ownership is real", () => {
    const capture = document.components.schemas.Capture as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(capture.properties)).toContain("owner_user_id");
    expect(capture.required).toContain("owner_user_id");
  });
});

describe("the synthesis ceiling is published, not discovered by refusal", () => {
  const capped: DiscoveryOptions = { ...options, quota: { operations: 500, windowSeconds: 3_600 }, maxSynthesisSeconds: 120 };

  test("/agent states the number and that the refusal is free", () => {
    const page = agentPage(capped);
    expect(page).toContain("input_too_long");
    expect(page).toContain("120s");
    expect(page).toContain("costs no quota");
    // A deployment without a ceiling must not imply one.
    expect(agentPage(options)).not.toContain("input_too_long");
  });
});
