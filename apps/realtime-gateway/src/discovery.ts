/**
 * The AI-native discovery surface (docs/auth.md, "The AI-native access surface"):
 * `/agent` for a human or an agent to read once, `/llms.txt` as the compact machine
 * index, `/openapi.json` as the typed contract. All three are unauthenticated — an
 * agent must be able to learn how to get a credential before it has one — and all
 * three exist only on a hosted (accounts) deployment: a self-hosted studio has no keys
 * to mint and keeps its paths exactly as they were.
 *
 * These documents describe **only what this gateway implements**. Nothing here is
 * aspirational: if a route is not in the switch in server.ts, it is not in here.
 */

import { apiRoutes, type ApiRoute } from "./routes";

export interface DiscoveryOptions {
  /** Public origin the deployment is reached at; links and the OpenAPI server use it. */
  baseUrl: string;
  /** Whether the capture library is enabled — its routes 404 when it is not. */
  library: boolean;
  /** Demo mode makes the registry read-only; worth stating rather than surprising. */
  demo: boolean;
  /**
   * The per-account quota this deployment enforces, when it enforces one. Stated with
   * its real numbers: an agent that knows the allowance can pace itself instead of
   * discovering it by being refused (docs/auth.md phase 4).
   */
  quota?: { operations: number; windowSeconds: number } | undefined;
}

/** The chargeable operations, named once and reused by every document. */
const chargeableList = "POST /v1/audio/speech, /v1/audio/transcriptions, /v1/chat/completions, /v1/voices, /v1/design-profiles, /v1/library/{id}/promote, and starting a realtime session (session.start)";

function quotaProse(options: DiscoveryOptions): string {
  if (options.quota === undefined) {
    return `This deployment enforces no per-account quota, so 429 will not be returned for usage.
Rate limiting may still exist in front of the gateway (a proxy or tunnel), so honor
\`Retry-After\` if you ever receive one.`;
  }
  const { operations, windowSeconds } = options.quota;
  return `This deployment allows **${operations} chargeable operations per ${windowSeconds} seconds, per account**.
Chargeable: ${chargeableList}.
Free: every GET, correcting or deleting a capture, deleting a voice, \`/healthz\`, and
this page. Over the allowance you get 429 with \`Retry-After\` (seconds) and
\`code: "quota_exceeded"\`; the window is anchored at your first charged call, and a
refusal does not extend it. Sharing an account with other agents shares the allowance.`;
}

/**
 * Markdown, served as `text/plain`. A browser renders it inline in every engine (no
 * download prompt, no HTML chrome), and an agent gets the whole page as text with no
 * markup to strip — the one format both readers handle without negotiation.
 */
export function agentPage(options: DiscoveryOptions): string {
  const base = options.baseUrl.replace(/\/$/, "");
  return `# voxstudio — agent access

A self-hosted voice stack: speech synthesis, transcription, chat, and a live duplex
conversation, behind one OpenAI-compatible contract. This page is the whole onboarding
path for an agent, a CLI, or any automation. Humans: it is also just a page.

Machine index: ${base}/llms.txt
Typed contract: ${base}/openapi.json   (OpenAPI 3.1)

## 1. Get a credential

API keys are minted by a signed-in human, in the Studio: open ${base}/settings,
find **API 密钥 / API keys**, name a key, and copy it. The key is shown exactly once.
There is no signup-by-API and no device flow: a key belongs to the person who created
it, and an agent acts as that person.

## 2. Authenticate

Send the key on every request. Two accepted headers, one meaning:

    Authorization: Bearer <key>     # preferred — what OpenAI-compatible clients,
                                    # agent frameworks, and CLIs already send
    x-api-key: <key>                # also accepted

A presented key decides the request. If it is invalid you get 401 even when a browser
cookie is also present — an agent's credential is never silently replaced by an ambient
session. Cookies belong to browsers; do not try to obtain or send one.

## 3. Call

Base URL: ${base}/v1 — point any OpenAI-compatible client at it.

    curl -s ${base}/v1/audio/speech \\
      -H "Authorization: Bearer $VOX_API_KEY" \\
      -H "content-type: application/json" \\
      -d '{"input":"你好，世界","voice":"my-voice"}' \\
      -o reply.wav

    curl -s ${base}/v1/voices -H "Authorization: Bearer $VOX_API_KEY"

Implemented routes (and nothing else): \`/v1/audio/speech\`,
\`/v1/audio/transcriptions\`, \`/v1/chat/completions\`, \`/v1/engines\`, \`/v1/voices\`
(list, create, get, delete), \`/v1/design-profiles\`${options.library ? ", `/v1/library` (list, get, audio, correct, promote, delete)" : ""},
and the realtime WebSocket \`/v1/realtime\`. \`GET /healthz\` needs no credential.
${options.library ? "" : "\nThe capture library is not enabled on this deployment: `/v1/library` answers 404 with `library_disabled`.\n"}${options.demo ? "\nThis deployment runs in demo mode: registry writes answer 403 with `demo_mode`.\n" : ""}
The realtime socket is not an OpenAPI shape; it speaks the session protocol documented
in the repository (docs/duplex-audio-architecture.md) and also accepts the OpenAI
Realtime dialect. Authenticate the upgrade with the same header.

## 4. Handle errors

- **401** — missing, malformed, revoked, or expired key. Do not retry the same key;
  a human must mint a new one.
- **429** — you are over this deployment's per-account quota (see "Quota" below), or a
  proxy in front of it refused you. The body carries \`code: "quota_exceeded"\`,
  \`retryAfterSeconds\`, and a \`requestId\` worth quoting in a report; the same values
  are in the \`Retry-After\` and \`x-request-id\` headers. Honor \`Retry-After\`
  (seconds) exactly; do not retry sooner, and do not parallelize around it.
- **403** — the action is refused rather than unauthenticated: demo mode
  (\`demo_mode\`), or a resource you may not write.
- **404 with \`library_disabled\`** — the feature is off on this deployment, not a
  missing item. Stop asking.
- **400 with \`bad_voice_id\`** — the voice name is malformed, too long, or a raw
  internal id. Use the names \`GET /v1/voices\` returned.
- **502/503** — an engine is unreachable or the gateway is shutting down. Retry with
  backoff; a 503 during shutdown will not clear on this connection.

Errors are JSON: \`{"error":{"message":"...","code":"..."}}\`. Read \`code\`, not prose.

## 5. Quota

${quotaProse(options)}

## 6. Etiquette

- Poll no faster than once every 60 seconds. Nothing here is a stream you must tail;
  the realtime socket exists for anything that needs to be live.
- Synthesis runs on a GPU that serializes. Issue requests serially and expect seconds,
  not milliseconds. Concurrency does not make it faster.
- This is a self-hosted deployment, not a metered cloud: there is no SLA. Cache what
  you fetched, back off on failure, and degrade rather than hammer.

## 7. Ownership and privacy — the part that constrains you

- Every voice, design profile, and capture belongs to the account that made it. Your
  key sees exactly its owner's resources. There is no shared pool and no admin scope.
- The voice names you see are **display names within your owner's namespace**. Internal
  engine ids are not part of the contract; sending one back is refused (\`bad_voice_id\`).
- Captures are recordings of humans. Retention is the deployment's decision, not yours.
  Do not build a copy of the library elsewhere.
- Registering a voice from someone's recording is a consent decision that belongs to a
  person. Do not clone a voice you were not explicitly asked to clone.
- Your key carries your owner's full authority. Do not log it, embed it in generated
  artifacts, or pass it to another service.
`;
}

/** The compact machine index: what exists, where, and the one rule that matters. */
export function llmsTxt(options: DiscoveryOptions): string {
  const base = options.baseUrl.replace(/\/$/, "");
  return `# voxstudio

> Self-hosted voice stack — synthesis, transcription, chat, and live duplex
> conversation behind one OpenAI-compatible contract. Per-account ownership of
> voices and captures; API keys minted by a signed-in human.

- Onboarding: ${base}/agent
- OpenAPI 3.1: ${base}/openapi.json
- Health (no credential): ${base}/healthz
- API base: ${base}/v1

## Auth

- \`Authorization: Bearer <key>\` (preferred) or \`x-api-key: <key>\`.
- Keys are created in the Studio settings page by their owner; no signup API.
- A presented key decides the request; cookies are for browsers only.

## Endpoints

- POST /v1/audio/speech — text to WAV (or streamed PCM with \`stream: true\`)
- POST /v1/audio/transcriptions — multipart audio to text
- POST /v1/chat/completions — OpenAI-compatible chat
- GET /v1/engines — engine names, kinds, capabilities, health
- GET|POST /v1/voices, GET|DELETE /v1/voices/{id} — the caller's voice bank
- POST /v1/design-profiles — reproducible designed voice
${options.library ? "- GET /v1/library, GET|PATCH|DELETE /v1/library/{id}, GET /v1/library/{id}/audio, POST /v1/library/{id}/promote — captures\n" : "- /v1/library — not enabled on this deployment (404 library_disabled)\n"}- WS /v1/realtime — live session protocol; same auth header

## Quota

${options.quota === undefined
    ? "- No per-account quota on this deployment; a fronting proxy may still return 429."
    : `- ${options.quota.operations} chargeable operations per ${options.quota.windowSeconds}s, per account.
- Chargeable: ${chargeableList}. Everything else (GETs, corrections, deletes, health) is free.
- Over the allowance: 429, \`code: "quota_exceeded"\`, \`Retry-After\` in seconds, \`x-request-id\`.`}

## Rules

- Poll at most once per 60s; honor \`Retry-After\` on 429.
- Synthesis is GPU-serialized: serial requests, seconds per call, no SLA.
- Resources belong to the key's owner. Use the display names /v1/voices returns.
- Captures are human recordings; do not mirror them elsewhere. Cloning a voice is a
  consent decision belonging to a person.
`;
}

/**
 * OpenAPI 3.1 for the implemented, stable surface. Deliberately excludes: the realtime
 * WebSocket (not an OpenAPI shape), and `/v1/auth/*` (Better Auth's own surface, not a
 * contract this project stabilizes). Library paths appear only when the library is on.
 */
export function openApiDocument(options: DiscoveryOptions): Record<string, unknown> {
  const base = options.baseUrl.replace(/\/$/, "");
  const error = {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: { message: { type: "string" }, code: { type: "string" } },
        required: ["message"],
      },
    },
    required: ["error"],
  };
  const errorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  });
  const secured = [{ bearerAuth: [] }, { apiKeyHeader: [] }];
  /**
   * What every authenticated operation can answer regardless of what it does, derived
   * from the catalog rather than repeated per operation (adversarial review 2026-07-26:
   * 401 was missing from seven of them and 405 from all of them).
   */
  const commonResponses = (route: ApiRoute, method: string): Record<string, unknown> => ({
    "401": errorResponse("Missing or invalid key (`unauthorized`)."),
    "405": errorResponse(`Method not allowed on this route (\`method_not_allowed\`); it serves ${route.methods.join(", ")}.`),
    ...(route.engineParam === true
      ? { "400": errorResponse("A named `?engine=` that does not exist or is the wrong kind (`unknown_engine`), or a malformed request (`bad_request`).") }
      : {}),
    ...(route.demoRefusable?.includes(method) === true
      ? { "403": errorResponse("Demo mode refuses registry writes (`demo_mode`).") }
      : {}),
    ...(route.library === true
      ? {
          "404": errorResponse("The library is not enabled on this deployment (`library_disabled`), or no such capture (`unknown_capture`)."),
          "503": errorResponse("The library is shutting down (`library_closing`)."),
        }
      : {}),
    ...(route.charged?.includes(method) === true ? { "429": quota429 } : {}),
  });
  /** `?engine=` wherever the router reads it — one declaration, not five. */
  const engineParameter = {
    name: "engine",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "Target a named engine instance instead of the role default.",
  };
  /** The quota refusal, described once: same body and headers on every charged route. */
  const quota429 = {
    description: options.quota === undefined
      ? "Refused by a limiter in front of the gateway (this deployment enforces no per-account quota). Honor `Retry-After`."
      : `The account's quota is spent (${options.quota.operations} chargeable operations per ${options.quota.windowSeconds}s). Retry after the stated delay.`,
    headers: {
      "Retry-After": { description: "Whole seconds to wait before retrying.", schema: { type: "integer", minimum: 1 } },
      "x-request-id": { description: "Identifier for this refusal, worth quoting in a report.", schema: { type: "string" } },
    },
    content: { "application/json": { schema: { $ref: "#/components/schemas/QuotaError" } } },
  };

  const capture = {
    type: "object",
    properties: {
      id: { type: "string", description: "Gateway-minted UUID." },
      created_at: { type: "integer", description: "Unix epoch milliseconds." },
      session_id: { type: "string" },
      owner_user_id: { type: "string", description: "The account this capture belongs to." },
      transcript: { type: "string", description: "Raw ASR text; never rewritten." },
      corrected: { type: ["string", "null"], description: "Human reference transcript, beside the raw one." },
      duration_ms: { type: "integer" },
      sample_rate: { type: "integer" },
      promoted_voice_id: { type: ["string", "null"] },
      bytes: { type: "integer" },
    },
    required: ["id", "created_at", "session_id", "owner_user_id", "transcript", "duration_ms", "sample_rate", "bytes"],
  };

  const libraryPaths = {
    "/v1/library": {
      get: {
        summary: "List the caller's captures, newest first",
        security: secured,
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "Captures owned by the caller. `bytes`/`max_bytes` describe the whole store's retention quota, not the caller's share.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    captures: { type: "array", items: { $ref: "#/components/schemas/Capture" } },
                    total: { type: "integer" },
                    bytes: { type: "integer" },
                    max_bytes: { type: ["integer", "null"] },
                  },
                  required: ["captures", "total", "bytes", "max_bytes"],
                },
              },
            },
          },
          "401": errorResponse("Missing or invalid key."),
          "404": errorResponse("The library is not enabled (`library_disabled`)."),
        },
      },
    },
    "/v1/library/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        summary: "One capture",
        security: secured,
        responses: {
          "200": { description: "The capture.", content: { "application/json": { schema: { $ref: "#/components/schemas/Capture" } } } },
          "404": errorResponse("No such capture, or not the caller's (`unknown_capture`)."),
        },
      },
      patch: {
        summary: "Set or clear the human reference transcript",
        security: secured,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { corrected: { type: ["string", "null"], description: "Null or blank clears the correction." } },
                required: ["corrected"],
              },
            },
          },
        },
        responses: {
          "200": { description: "The updated capture.", content: { "application/json": { schema: { $ref: "#/components/schemas/Capture" } } } },
          "400": errorResponse("`bad_correction`."),
          "404": errorResponse("No such capture (`unknown_capture`)."),
          "503": errorResponse("The library is shutting down (`library_closing`)."),
        },
      },
      delete: {
        summary: "Delete a capture and its audio",
        security: secured,
        responses: {
          "200": { description: "Deleted.", content: { "application/json": { schema: { type: "object", properties: { deleted: { type: "boolean" } }, required: ["deleted"] } } } },
          "404": errorResponse("No such capture (`unknown_capture`)."),
        },
      },
    },
    "/v1/library/{id}/audio": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        summary: "The capture's audio",
        security: secured,
        responses: {
          "200": { description: "WAV audio.", content: { "audio/wav": { schema: { type: "string", format: "binary" } } } },
          "404": errorResponse("No such capture (`unknown_capture`)."),
        },
      },
    },
    "/v1/library/{id}/promote": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      post: {
        summary: "Register the capture as a clone voice",
        description: "Uses the corrected transcript when present, the raw one otherwise. `voice_id` is a display name in the caller's namespace.",
        security: secured,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { voice_id: { type: "string", pattern: "^(?!u[0-9a-f]{12}\\.)[A-Za-z0-9._-]{1,64}$" } }, required: ["voice_id"] },
            },
          },
        },
        responses: {
          "200": {
            description: "The updated capture and the engine that registered the voice.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { capture: { $ref: "#/components/schemas/Capture" }, engine: { type: "string" } },
                  required: ["capture", "engine"],
                },
              },
            },
          },
          "400": errorResponse("`bad_voice_id` or `empty_transcript`."),
          "404": errorResponse("No such capture (`unknown_capture`)."),
          "429": quota429,
          "502": errorResponse("The clone engine is unreachable (`engine_unreachable`)."),
        },
      },
    },
  };

  /**
   * The catalog completes what the hand-written detail leaves out: security, the shared
   * responses, and `?engine=` land on every operation the router actually serves, and a
   * documented path that no longer exists is dropped rather than published. Specific
   * detail always wins — this fills gaps, it does not overwrite.
   */
  const reconcile = (paths: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> => {
    const reconciled: Record<string, Record<string, unknown>> = {};
    for (const route of apiRoutes) {
      if (route.library === true && !options.library) continue;
      const documented = paths[route.path];
      if (documented === undefined) continue;
      const entry: Record<string, unknown> = {};
      if (documented.parameters !== undefined) entry.parameters = documented.parameters;
      for (const method of route.methods) {
        const verb = method.toLowerCase();
        const operation = documented[verb] as Record<string, unknown> | undefined;
        if (operation === undefined) continue;
        const parameters = (operation.parameters ?? []) as { name?: string }[];
        entry[verb] = {
          ...operation,
          ...(route.public === true ? { security: [] } : { security: secured }),
          ...(route.engineParam === true && !parameters.some(parameter => parameter.name === "engine")
            ? { parameters: [...parameters, engineParameter] }
            : {}),
          responses: {
            ...(route.public === true ? {} : commonResponses(route, method)),
            ...(operation.responses as Record<string, unknown>),
          },
        };
      }
      reconciled[route.path] = entry;
    }
    return reconciled;
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "voxstudio gateway",
      version: "1.0.0",
      summary: "Self-hosted voice I/O behind an OpenAI-compatible contract.",
      description: [
        "Every route below is implemented by this deployment. Authenticate with an API key",
        "as `Authorization: Bearer <key>` (preferred) or `x-api-key: <key>`; keys are minted",
        "by their owner in the Studio settings page. Resources belong to the key's owner —",
        "voice names are display names inside that namespace, and internal engine ids are",
        "not part of this contract.",
        "",
        "Not described here: the realtime WebSocket at `/v1/realtime` (not an OpenAPI shape;",
        "same auth header, protocol in docs/duplex-audio-architecture.md), and `/v1/auth/*`,",
        "which is the authentication library's own browser surface.",
        "",
        "Etiquette: poll at most once per 60s, honor `Retry-After` on 429, and issue",
        "synthesis serially — it runs on a GPU that serializes. There is no SLA.",
        "",
        options.quota === undefined
          ? "This deployment enforces no per-account quota; a proxy in front of it may still return 429."
          : `Quota: ${options.quota.operations} chargeable operations per ${options.quota.windowSeconds}s per account. Chargeable: ${chargeableList}. Everything else is free. A 429 carries code "quota_exceeded", retryAfterSeconds, and a requestId, mirrored in the Retry-After and x-request-id headers.`,
      ].join("\n"),
    },
    servers: [{ url: base }],
    security: secured,
    paths: reconcile({
      "/healthz": {
        get: {
          summary: "Liveness and which door this deployment serves",
          security: [],
          responses: {
            "200": {
              description: "Always available, no credential.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      protocol: { type: "integer", description: "Realtime session protocol version." },
                      sessions: { type: "integer" },
                      auth: { type: "string", enum: ["self", "accounts"] },
                    },
                    required: ["ok", "protocol", "auth"],
                  },
                },
              },
            },
          },
        },
      },
      "/v1/audio/speech": {
        post: {
          summary: "Synthesize speech",
          security: secured,
          parameters: [{ name: "engine", in: "query", required: false, schema: { type: "string" }, description: "Target a named TTS instance instead of the role default." }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    input: { type: "string", description: "The text to speak." },
                    voice: { type: "string", description: "A display name from GET /v1/voices. Omit for the engine default." },
                    response_format: { type: "string", description: "Engine-dependent; `wav` unless the deployment says otherwise." },
                    cfg_value: { type: "number" },
                    timesteps: { type: "integer" },
                    seed: { type: "integer" },
                    speed: { type: "number", description: "Playback-rate multiplier; ignored by engines without rate control." },
                    prosody_prompt: { type: "boolean" },
                    stream: { type: "boolean", description: "Chunked f32le PCM as generation proceeds instead of one WAV at the end." },
                  },
                  required: ["input"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Audio. WAV by default; raw little-endian float32 PCM when `stream` is true (sample rate in `x-sample-rate`).",
              content: {
                "audio/wav": { schema: { type: "string", format: "binary" } },
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
              },
            },
            "400": errorResponse("`bad_voice_id`, or a malformed body."),
            "401": errorResponse("Missing or invalid key."),
            "429": quota429,
            "502": errorResponse("The TTS engine is unreachable (`engine_unreachable`)."),
          },
        },
      },
      "/v1/audio/transcriptions": {
        post: {
          summary: "Transcribe audio",
          security: secured,
          parameters: [{ name: "engine", in: "query", required: false, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary", description: "The audio file." },
                    language: { type: "string", description: "`auto` unless you know better." },
                    response_format: { type: "string", default: "json" },
                    max_new_tokens: { type: "integer" },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "The transcript.",
              content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
            },
            "401": errorResponse("Missing or invalid key."),
            "429": quota429,
            "502": errorResponse("The ASR engine is unreachable (`engine_unreachable`)."),
          },
        },
      },
      "/v1/chat/completions": {
        post: {
          summary: "Chat completion (OpenAI-compatible)",
          description: "Proxied to the configured LLM instance with its credential injected at the gateway. The request and response are the OpenAI shapes the engine implements.",
          security: secured,
          parameters: [{ name: "engine", in: "query", required: false, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    messages: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { role: { type: "string", enum: ["system", "user", "assistant", "tool"] }, content: { type: "string" } },
                        required: ["role", "content"],
                      },
                    },
                    stream: { type: "boolean" },
                    max_tokens: { type: "integer" },
                    tools: { type: "array", items: { type: "object" } },
                  },
                  required: ["messages"],
                },
              },
            },
          },
          responses: {
            "200": { description: "An OpenAI-shaped completion, or an SSE stream when `stream` is true.", content: { "application/json": { schema: { type: "object" } }, "text/event-stream": { schema: { type: "string" } } } },
            "401": errorResponse("Missing or invalid key."),
            "429": quota429,
            "502": errorResponse("The LLM engine is unreachable (`engine_unreachable`)."),
          },
        },
      },
      "/v1/engines": {
        get: {
          summary: "The engine registry, sanitized",
          description: "Names, kinds, capabilities, roles, live health, and each engine's self-reported model identity. Addresses and credentials are never included.",
          security: secured,
          responses: {
            "200": {
              description: "The registry.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      engines: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            kind: { type: ["string", "null"], enum: ["asr", "llm", "tts", null] },
                            model: { type: "string" },
                            capabilities: { type: "array", items: { type: "string" } },
                            roles: { type: "array", items: { type: "string" } },
                            healthy: { type: "boolean" },
                            runtime: {
                              type: ["object", "null"],
                              properties: { model: { type: "string" }, manifestSha256: { type: ["string", "null"] } },
                            },
                          },
                          required: ["name", "capabilities", "roles", "healthy"],
                        },
                      },
                    },
                    required: ["engines"],
                  },
                },
              },
            },
            "401": errorResponse("Missing or invalid key."),
          },
        },
      },
      "/v1/voices": {
        get: {
          summary: "The caller's voice bank across every TTS instance",
          description: "Display names within the caller's namespace, each attributed to the engine holding it.",
          security: secured,
          responses: {
            "200": {
              description: "The bank.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { voices: { type: "array", items: { $ref: "#/components/schemas/Voice" } } },
                    required: ["voices"],
                  },
                },
              },
            },
            "401": errorResponse("Missing or invalid key."),
          },
        },
        post: {
          summary: "Register a clone voice from a reference recording",
          security: secured,
          parameters: [{ name: "engine", in: "query", required: false, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string", pattern: "^(?!u[0-9a-f]{12}\\.)[A-Za-z0-9._-]{1,64}$", description: "Your display name for the voice." },
                    text: { type: "string", description: "Verbatim transcript of the reference audio." },
                    audio: { type: "string", format: "binary" },
                  },
                  required: ["id", "text", "audio"],
                },
              },
            },
          },
          responses: {
            "201": { description: "Registered.", content: { "application/json": { schema: { $ref: "#/components/schemas/Voice" } } } },
            "400": errorResponse("`bad_voice_id`."),
            "401": errorResponse("Missing or invalid key."),
            "403": errorResponse("Demo mode refuses registry writes (`demo_mode`)."),
            "429": quota429,
            "502": errorResponse("The clone engine is unreachable (`engine_unreachable`)."),
          },
        },
      },
      "/v1/voices/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^(?!u[0-9a-f]{12}\\.)[A-Za-z0-9._-]{1,64}$" }, description: "A display name in the caller's namespace. Names shaped like an internal engine id are refused, and under a hosted account the prefix leaves 50 usable characters." }],
        get: {
          summary: "One voice",
          security: secured,
          responses: {
            "200": { description: "The voice.", content: { "application/json": { schema: { $ref: "#/components/schemas/Voice" } } } },
            "400": errorResponse("`bad_voice_id`."),
            "404": { description: "No such voice in the caller's namespace." },
          },
        },
        delete: {
          summary: "Delete a voice",
          security: secured,
          responses: {
            "200": { description: "Deleted." },
            "400": errorResponse("`bad_voice_id`."),
            "403": errorResponse("Demo mode refuses registry writes (`demo_mode`)."),
            "404": { description: "No such voice in the caller's namespace." },
          },
        },
      },
      "/v1/design-profiles": {
        post: {
          summary: "Create a reproducible designed voice",
          description: "A design profile records its description, seed, sampler settings, model identity, and audio SHA-256, so the voice can be re-derived instead of trusted.",
          security: secured,
          parameters: [{ name: "engine", in: "query", required: false, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string", pattern: "^(?!u[0-9a-f]{12}\\.)[A-Za-z0-9._-]{1,64}$" },
                    description: { type: "string", description: "The voice being asked for, in words." },
                    anchor_text: { type: "string" },
                    seed: { type: "integer" },
                    cfg_value: { type: "number" },
                    timesteps: { type: "integer" },
                  },
                  required: ["id", "description"],
                },
              },
            },
          },
          responses: {
            "200": { description: "The created profile.", content: { "application/json": { schema: { $ref: "#/components/schemas/Voice" } } } },
            "400": errorResponse("`bad_voice_id`, or an engine validation failure."),
            "403": errorResponse("Demo mode refuses registry writes (`demo_mode`)."),
            "409": { description: "The id already exists — profiles are never silently overwritten." },
            "429": quota429,
            "502": errorResponse("The design-capable engine is unreachable (`engine_unreachable`)."),
          },
        },
      },
      ...libraryPaths,
    }),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "An API key minted by its owner in the Studio settings page. Preferred for agents and CLIs.",
        },
        apiKeyHeader: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "The same key, in the authentication plugin's native header.",
        },
      },
      schemas: {
        Error: error,
        QuotaError: {
          type: "object",
          description: "A quota refusal: the standard envelope plus the wait and an id.",
          properties: {
            error: {
              type: "object",
              properties: {
                message: { type: "string" },
                code: { type: "string", const: "quota_exceeded" },
                requestId: { type: "string" },
                retryAfterSeconds: { type: "integer", minimum: 1 },
              },
              required: ["message", "code", "requestId", "retryAfterSeconds"],
            },
          },
          required: ["error"],
        },
        Voice: {
          type: "object",
          properties: {
            id: { type: "string", description: "Display name in the caller's namespace." },
            engine: { type: "string", description: "Which TTS instance holds it." },
            design_profile: { type: "object", description: "Present when the voice is a reproducible design profile.", additionalProperties: true },
            prompt_text: { type: "string", description: "Reference transcript, for clone voices." },
          },
          required: ["id"],
        },
        Capture: capture,
      },
    },
  };
}
