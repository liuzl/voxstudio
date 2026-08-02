import { auditDesignProfile, TtsClient, type Fetch, type PcmStreamDecoder } from "@voxstudio/clients";
import { AgentRegistry, AgentRegistryError, type AgentSpec, type CreateAgentInput, type UpdateAgentInput } from "@voxstudio/agents";
import { engine, engineByCapability, enginesOfKind, roleInstance } from "@voxstudio/config";
import type { EngineKind, ResolvedEngineConfig, VoxConfig } from "@voxstudio/contracts";
import type { SpeechProbabilityModel } from "@voxstudio/duplex-session";
import type { ServerWebSocket } from "bun";
import type { ConversationTool } from "@voxstudio/conversation";
import { connectMcpServers, type McpToolSource } from "@voxstudio/mcp";
import { OpenAiRealtimeConnection } from "./openai-realtime";
import { OWNER_USER_ID, type AuthContext } from "./auth/auth-context";
import { isLoopbackHost, resolveAuthContext, upgradeOriginAllowed } from "./auth/request-auth";
// Type-only: the accounts module (and better-auth with it) loads dynamically, and
// only when a deployment configured accounts (docs/auth.md phase 3).
import type { Accounts } from "./auth/accounts";
import type { AttemptLimits } from "./auth/attempt-limiter";
import { fromEngineVoiceId, toEngineVoiceId } from "./voice-namespace";
import { agentPage, llmsTxt, openApiDocument, type DiscoveryOptions } from "./discovery";
import { QuotaLedger } from "./quota";
import { SynthesisBusyError, SynthesisGate } from "./synthesis-gate";
import { discoveryPaths, isCharged, routeFor } from "./routes";
import { CaptureLibrary } from "./library";
import { parseCommand, ProtocolError, protocolVersion, type GatewayCommand, type SessionStartOptions } from "./protocol";
import { studioToolNames } from "@voxstudio/conversation";
import { estSeconds } from "@voxstudio/text";
import { builtinToolNames, GatewaySession, type EventSink } from "./session";

export interface GatewayServerOptions {
  config: VoxConfig;
  fetch?: Fetch;
  /** Defaults to loopback: exposure to a network is a deployment decision (a tunnel), not a default. */
  hostname?: string;
  port?: number;
  /** Optional bearer token required on every request and WebSocket upgrade. */
  token?: string;
  /**
   * Overrides how a request becomes an identity — the seam hosted accounts
   * (docs/auth.md phase 3) plug into, and how tests simulate account holders.
   * Absent, the self-hosted rule applies: the optional shared token, owner identity.
   */
  authResolver?: (request: Request) => AuthContext | null;
  /**
   * Hosted accounts (docs/auth.md phase 3): Better Auth behind the identity seam,
   * auth.db in `dir`. Mutually exclusive with `token` — hosted is session or API key,
   * nothing else. The secret and any verification-email sender come from the
   * deployment; nothing here invents either.
   */
  accounts?: {
    dir: string;
    secret: string;
    /** Public origin for links and origin checks; defaults to the gateway's own URL. */
    baseUrl?: string;
    sendVerificationEmail?: (email: string, url: string) => Promise<void>;
    /**
     * Relaxes the shipped brute-force limits on /v1/auth/*. A deployment should not set
     * this; a test suite that signs up repeatedly must.
     */
    rateLimit?: { window: number; max: number };
    /**
     * Overrides the brute-force limits keyed on the claimed account. A deployment should
     * keep the defaults; a test suite that signs in repeatedly must relax them.
     */
    attemptLimits?: AttemptLimits;
    /** OAuth providers; credentials come from the deployment, never from this repo. */
    socialProviders?: Record<string, { clientId: string; clientSecret: string }>;
    /** Whether the email-and-password door is open. Default true. */
    passwordLogin?: boolean;
  };
  /**
   * Per-account usage quota (docs/auth.md phase 4): `operations` chargeable calls per
   * `windowSeconds`, counted per account. Only expensive work is charged — synthesis,
   * transcription, chat, voice/profile creation, promote, and starting a realtime
   * conversation — never reads, deletes, health, or the discovery surface.
   *
   * Enforced only under hosted accounts: a self-hosted studio has one owner and nothing
   * to meter. Absent, no quota applies (the default everywhere).
   */
  quota?: { operations: number; windowSeconds: number };
  /**
   * Ceiling on one synthesis request, in estimated seconds of speech — the same
   * script-aware estimate the Studio shows before generating.
   *
   * The quota counts requests, and a request is not a fixed amount of work: measured on a
   * live engine, one unit bought 29 seconds of audio and 10 seconds of GPU where a short
   * sentence costs about one. Without this, no quota number predicts load. Absent, nothing
   * is bounded — hardening stays a deployment decision, as with the demo guardrails.
   */
  maxSynthesisSeconds?: number;
  /**
   * Concurrency gate over `/v1/audio/speech`. Measured on a live engine, throughput is
   * flat past two in flight while latency grows linearly — the GPU serializes, so extra
   * concurrency buys queueing, not work (see synthesis-gate.ts for the numbers). Requests
   * past `maxInFlight` wait; past `maxQueued` they get 429 with a delay drawn from how
   * long recent syntheses actually took. Absent, nothing is bounded.
   */
  synthesisConcurrency?: { maxInFlight: number; maxQueued: number };
  reconnectGraceMs?: number;
  /** OpenAI-dialect connections: how long a client may take to answer a function call. */
  openAiFunctionCallTimeoutMs?: number;
  /** Demo guardrails (docs/public-demo.md): new conversations refused at this many live sessions. */
  maxSessions?: number;
  /** Every session notices and stops at this ceiling. */
  maxSessionSeconds?: number;
  /** Registry writes 403 and MCP servers stay unconnected, regardless of config. */
  demoMode?: boolean;
  /** Published Agent version fixed by the operator for this demo deployment. */
  demoAgent?: { id: string; version: number };
  /**
   * Writes session-added pronunciations to the host's config file. Injected by the
   * entrypoint (which knows the resolved path and owns filesystem concerns); absent,
   * the persist tool answers a structured refusal.
   */
  persistPronunciations?: (entries: Record<string, string>) => Promise<void>;
  /**
   * The capture library (docs/web-studio.md 素材库): every finalized utterance persists
   * here as WAV + SQLite metadata, served at /v1/library. Off by default — retention is
   * an explicit deployment decision, and demo mode keeps it off regardless: an
   * anonymous-ish demo must not retain visitor audio.
   */
  libraryDir?: string;
  /**
   * Retention quota over the library's audio bytes: oldest unpinned captures are
   * evicted to stay under it; corrected/promoted captures are never auto-deleted
   * (docs/web-studio.md Phase 4). Unbounded when absent — fine for an operator's
   * own machine, wrong for anything long-running or shared.
   */
  libraryMaxBytes?: number;
  /** Agent drafts and immutable published snapshots. Off when absent. */
  agentsDir?: string;
  loadSileroVad?: () => Promise<SpeechProbabilityModel>;
  /** Decodes compressed (Opus) TTS streams from engines configured with stream_format. */
  pcmDecoder?: PcmStreamDecoder;
  log?: (line: string) => void;
  /**
   * Web Studio app shell: URL path -> file path (a real file, or a Bun embedded-file
   * path inside a compiled binary). GET/HEAD only; unknown non-API paths fall back to
   * /index.html (client-side routing). Served before the bearer gate — a browser's
   * initial page load cannot carry a header, and the shell holds no secrets; every
   * /v1 route stays guarded.
   */
  staticAssets?: Record<string, string>;
}

export interface GatewayServer {
  url: string;
  port: number;
  sessionCount(): number;
  stop(): Promise<void>;
}

interface SocketData {
  session: GatewaySession | undefined;
  sink: EventSink | undefined;
  /** Native Agent resolution is asynchronous; this closes the pre-session race window. */
  pendingStart?: string | undefined;
  /** Audio arriving behind session.start is ordered here until the session is ready. */
  pendingAudio?: Uint8Array[] | undefined;
  /** Prevents an async start from creating a session after its socket has gone away. */
  closed?: boolean | undefined;
  /** Resolved once at upgrade (docs/auth.md phase 1); no per-frame credential work. */
  ctx: AuthContext;
  /** Present when the connection speaks the OpenAI Realtime dialect instead of the native protocol. */
  openai?: OpenAiRealtimeConnection | undefined;
  /** The ?model= the OpenAI-dialect client asked for, captured at upgrade. */
  openaiModel?: string;
  /** Published Agent defaults resolved before the OpenAI socket is accepted. */
  openaiStart?: SessionStartOptions;
  openaiAgentSpec?: AgentSpec;
}

/** Engine endpoints the facade forwards, keyed by public path. The browser sees only these. */
const facadeRoutes: Record<string, { kind: EngineKind; role: string; methods: string[] }> = {
  "/v1/audio/speech": { kind: "tts", role: "tts", methods: ["POST"] },
  "/v1/audio/transcriptions": { kind: "asr", role: "asr", methods: ["POST"] },
  "/v1/chat/completions": { kind: "llm", role: "llm", methods: ["POST"] },
};

/** Voice registry entries: /v1/voices/{id} on the TTS engine (list/create live above). */
const voiceEntryPattern = /^\/v1\/voices\/[A-Za-z0-9._-]{1,64}$/;

/** Library entries: gateway-minted UUIDs, plus the audio and promote sub-resources. */
const libraryEntryPattern = /^\/v1\/library\/([A-Za-z0-9-]{1,64})(\/audio|\/promote)?$/;
const agentEntryPattern = /^\/v1\/agents\/([A-Za-z0-9._-]{1,64})(?:\/(publish|audit|versions))?$/;
const voiceIdPattern = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Every API error is `{"error":{"message","code"}}` — the contract `/agent` and the
 * OpenAPI document state, and the one agents are told to branch on. Bare-string
 * responses used to escape it (adversarial review 2026-07-26); this is the only way an
 * API error leaves the gateway now. The app shell is unaffected: it is a page, not an API.
 */
function problem(status: number, code: string, message: string): Response {
  return Response.json({ error: { message, code } }, { status });
}

/** Every 400 for an unusable voice name reads the same, whichever path refused it. */
function badVoiceId(): Response {
  return Response.json(
    { error: { message: "voice id must match [A-Za-z0-9._-], fit the engine id limit with the account prefix, and not be a raw engine id", code: "bad_voice_id" } },
    { status: 400 },
  );
}

function badEngine(reason: string): Response {
  return Response.json({ error: { message: reason, code: "unknown_engine" } }, { status: 400 });
}

function rejection(
  sessionId: string,
  reason: string,
  command?: GatewayCommand,
  /** Retry guidance, when the refusal is one the client can wait out (a spent quota). */
  retry?: { retryAfterSeconds: number; requestId: string },
): string {
  return JSON.stringify({
    v: protocolVersion,
    sequence: 0,
    sessionId,
    timestampMs: Date.now(),
    type: "command.rejected",
    reason,
    ...(command === undefined ? {} : { commandType: command.type, idempotencyKey: command.idempotencyKey }),
    ...(retry === undefined ? {} : retry),
  });
}

export function startGateway(options: GatewayServerOptions): GatewayServer {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const log = options.log ?? (() => {});
  const sessions = new Map<string, GatewaySession>();

  // Hosted accounts and the shared token are different products (docs/auth.md
  // decision 1); a deployment that configures both is a mistake, said at startup.
  if (options.accounts !== undefined && options.token !== undefined && options.token !== "") {
    throw new TypeError("accounts and --token are mutually exclusive: hosted deployments take a session or an API key, nothing else");
  }
  // The resolver seam exists for tests and future identity sources; standing beside
  // hosted accounts it would silently outrank Better Auth on every request — an
  // authentication bypass assembled from two valid options (adversarial review
  // 2026-07-26). Fail closed at startup rather than resolve one of them at runtime.
  if (options.accounts !== undefined && options.authResolver !== undefined) {
    throw new TypeError("accounts and authResolver are mutually exclusive: a custom resolver would bypass hosted authentication");
  }
  if (options.demoAgent !== undefined && options.demoMode !== true) {
    throw new TypeError("demoAgent requires demoMode");
  }
  if (options.demoAgent !== undefined && options.agentsDir === undefined) {
    throw new TypeError("demoAgent requires an Agent registry");
  }
  if (options.demoAgent !== undefined && options.accounts !== undefined) {
    throw new TypeError("demoAgent and accounts cannot be combined until the Portal has an operator-owned Agent namespace");
  }
  // Fail at startup, not on the first request: a hosted deployment with a weak or
  // missing secret must never come up. 32 is Better Auth's own floor.
  if (options.accounts !== undefined && options.accounts.secret.length < 32) {
    throw new TypeError("accounts: the auth secret must be at least 32 characters (set VOX_AUTH_SECRET)");
  }
  // A deployment with every door shut would boot and accept nobody. Caught here rather
  // than inside the dynamically loaded module, so it fails at startup like the rest.
  if (options.accounts !== undefined
    && options.accounts.passwordLogin === false
    && Object.keys(options.accounts.socialProviders ?? {}).length === 0) {
    throw new TypeError("accounts: no way to sign in — configure a social provider or leave the password door open");
  }
  /**
   * The upgrade's Origin policy. Hosted: exactly the configured public origin (and the
   * gateway's own, which is that origin when no tunnel fronts it). Self-hosted: host
   * comparison, with the dev-server loopback exception only when we ourselves bind
   * loopback (adversarial review 2026-07-26).
   */
  const originPolicy = (): { allowedOrigins?: readonly string[]; allowLoopback?: boolean } => {
    if (options.accounts === undefined) {
      return { allowLoopback: isLoopbackHost(options.hostname ?? "127.0.0.1") };
    }
    const configured = options.accounts.baseUrl;
    const origins = new Set<string>([new URL(server.url.toString()).origin]);
    if (configured !== undefined && configured !== "") {
      try {
        origins.add(new URL(configured).origin);
      } catch {
        // A malformed baseUrl leaves only our own origin allowed; startAccounts logs it.
      }
    }
    return { allowedOrigins: [...origins] };
  };
  /**
   * The discovery documents, built per request so they always describe this deployment
   * as it is now (library on or off, demo or not) rather than a snapshot of startup.
   * Cache-Control is short: they are small, and a stale contract is worse than a fetch.
   */
  /**
   * The origin to publish in the discovery documents. The configured public origin wins;
   * without one we describe the origin the request actually arrived on (a tunnel's
   * forwarded host and scheme), and only fall back to our own bind address when nothing
   * forwarded anything — which is the truth for a local run and a leak for a tunnelled
   * one (adversarial review 2026-07-26).
   */
  const publicOrigin = (request: Request): string => {
    const configured = options.accounts?.baseUrl;
    if (configured !== undefined && configured !== "") return configured;
    const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (forwardedHost !== null && forwardedHost !== "") {
      const scheme = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
      // A Host header is caller-supplied, so keep it to a host[:port] shape.
      if (/^[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(forwardedHost)) return `${scheme.split(",")[0]}://${forwardedHost}`;
    }
    return server.url.toString();
  };
  const discoveryOptions = (request: Request): DiscoveryOptions => ({
    baseUrl: publicOrigin(request),
    library: library !== undefined,
    demo: options.demoMode === true,
    // The real allowance, so an agent can pace itself instead of learning it by refusal.
    ...(quota === undefined ? {} : { quota: { operations: quota.operations, windowSeconds: quota.windowSeconds } }),
    ...(options.maxSynthesisSeconds === undefined ? {} : { maxSynthesisSeconds: options.maxSynthesisSeconds }),
  });
  const text = (body: string, contentType: string): Response => new Response(body, {
    headers: { "content-type": contentType, "cache-control": "public, max-age=300" },
  });
  const discoveryRoutes: Record<string, (request: Request) => Response> = {
    // Markdown as text/plain: renders inline in every browser, and an agent gets the
    // page with no markup to strip.
    "/agent": request => text(agentPage(discoveryOptions(request)), "text/plain; charset=utf-8"),
    "/llms.txt": request => text(llmsTxt(discoveryOptions(request)), "text/plain; charset=utf-8"),
    "/openapi.json": request => text(JSON.stringify(openApiDocument(discoveryOptions(request)), null, 2), "application/json; charset=utf-8"),
  };
  /**
   * The quota is an accounts feature: a self-hosted studio has one owner, so metering
   * it would only limit the person who runs it. Constructed only when both are set, and
   * the entrypoints refuse the flag without --accounts (docs/auth.md phase 4).
   */
  const quota = options.quota !== undefined && options.accounts !== undefined
    ? new QuotaLedger(options.quota)
    : undefined;
  if (options.quota !== undefined && options.accounts === undefined) {
    throw new TypeError("quota requires accounts: a self-hosted studio has one account to meter, its operator's");
  }

  /**
   * Which operations cost engine time. Reads, corrections, deletes, health, and the
   * discovery surface are free; everything here occupies a GPU or an upstream model.
   * Starting a realtime conversation is charged once at `session.start` — never per
   * frame, which would both mis-price a conversation and put work on the audio path.
   */
  const chargeable = (method: string, pathname: string): boolean => isCharged(pathname, method);

  /** One shape for every quota refusal, REST or realtime, with an id to quote in a report. */
  const quotaRefusal = (retryAfterSeconds: number): Response => {
    const requestId = crypto.randomUUID();
    return Response.json(
      {
        error: {
          message: `quota exhausted: ${options.quota?.operations} operations per ${options.quota?.windowSeconds}s — retry in ${retryAfterSeconds}s`,
          code: "quota_exceeded",
          requestId,
          retryAfterSeconds,
        },
      },
      {
        status: 429,
        headers: {
          "retry-after": String(retryAfterSeconds),
          "x-request-id": requestId,
        },
      },
    );
  };
  if (options.accounts !== undefined && (options.accounts.baseUrl === undefined || options.accounts.baseUrl === "")) {
    log("accounts: no public origin configured — set VOX_AUTH_BASE_URL before putting this behind a tunnel, or the authentication library's own origin check refuses API-key creation");
  }
  // A quota bounds how many requests an account makes, not how much work each one is.
  // An operator who set one and stopped there has not bounded load (see maxSynthesisSeconds).
  if (options.quota !== undefined && options.maxSynthesisSeconds === undefined) {
    log("quota: set without --max-synthesis-seconds — the quota counts requests, not engine time, so one unit can buy an arbitrarily long synthesis");
  }
  const synthesisGate = options.synthesisConcurrency === undefined
    ? undefined
    : new SynthesisGate(options.synthesisConcurrency);
  let accountsInstance: Promise<Accounts> | undefined;
  const accountsFor = (): Promise<Accounts> => {
    const configured = options.accounts as NonNullable<GatewayServerOptions["accounts"]>;
    accountsInstance ??= import("./auth/accounts").then(module => module.startAccounts({
      dir: configured.dir,
      secret: configured.secret,
      baseUrl: configured.baseUrl ?? server.url.toString().replace(/\/$/, ""),
      sendVerificationEmail: configured.sendVerificationEmail,
      rateLimit: configured.rateLimit,
      attemptLimits: configured.attemptLimits,
      socialProviders: configured.socialProviders,
      passwordLogin: configured.passwordLogin,
      log,
    }));
    return accountsInstance;
  };

  // Demo mode wins over a configured library: hardening a deployment must never quietly
  // start retaining its visitors' audio.
  if (options.libraryDir !== undefined && options.demoMode === true) {
    log("demo mode: the capture library stays off — a demo must not retain visitor audio");
  }
  const library = options.libraryDir !== undefined && options.demoMode !== true
    ? new CaptureLibrary(options.libraryDir, {
        ...(options.libraryMaxBytes === undefined ? {} : { maxBytes: options.libraryMaxBytes }),
        log,
      })
    : undefined;
  const agents = options.agentsDir === undefined ? undefined : new AgentRegistry(options.agentsDir);

  const assets = options.staticAssets && Object.keys(options.staticAssets).length > 0
    ? options.staticAssets
    : undefined;
  const serveStatic = (request: Request, url: URL): Response | undefined => {
    if (!assets) return undefined;
    if (request.method !== "GET" && request.method !== "HEAD") return undefined;
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return undefined;
    const exact = assets[url.pathname === "/" ? "/index.html" : url.pathname];
    const file = exact ?? assets["/index.html"];
    if (!file) return undefined;
    // Hashed bundle files never change under their name; the SPA entry must revalidate.
    const immutable = exact !== undefined && url.pathname.startsWith("/assets/");
    return new Response(Bun.file(file), {
      headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  };

  /**
   * Explicit-first, capability-second, role-default-last (engine-registry doc). Returns
   * a 400 Response for a named instance that does not exist or is the wrong kind.
   */
  const selectEngine = (
    url: URL,
    kind: EngineKind,
    role: string,
    capability?: string,
  ): [string, ResolvedEngineConfig] | Response => {
    const requested = url.searchParams.get("engine");
    if (requested) {
      const found = enginesOfKind(options.config, kind).find(([name]) => name === requested);
      return found ?? badEngine(`no ${kind} engine named ${requested}; see /v1/engines`);
    }
    if (capability) {
      const capable = engineByCapability(options.config, kind, capability);
      if (capable) return capable;
    }
    try {
      return [roleInstance(options.config, role), engine(options.config, role)];
    } catch (error) {
      return badEngine(error instanceof Error ? error.message : String(error));
    }
  };

  const proxy = async (
    request: Request,
    target: ResolvedEngineConfig,
    path: string,
    slot: string,
    /** Called when the engine could not be reached at all, so a charge can be undone. */
    onUnreachable?: () => void,
  ): Promise<Response> => {
    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    // The engine credential is injected here and only here; the client's own authorization
    // header (the gateway token) never reaches an engine.
    if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`);
    let upstream: Response;
    try {
      upstream = await fetchImpl(new URL(path, target.baseUrl), {
        method: request.method,
        headers,
        ...(request.body === null ? {} : { body: request.body }),
      });
    } catch (error) {
      log(`facade: ${slot} unreachable: ${error instanceof Error ? error.message : String(error)}`);
      onUnreachable?.();
      return Response.json({ error: { message: `${slot} engine unreachable`, code: "engine_unreachable" } }, { status: 502 });
    }
    // Status and body pass through; engine-identifying headers do not.
    const passthrough = new Headers();
    for (const name of ["content-type", "x-sample-rate"]) {
      const value = upstream.headers.get(name);
      if (value) passthrough.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: passthrough });
  };

  /**
   * Union voice bank: every TTS instance's registry, entries attributed to their engine
   * and translated into the viewer's namespace (docs/auth.md phase 2) — an account
   * holder sees their own display names, the owner sees the bare bank, nobody sees
   * anyone else's.
   */
  const collectVoices = async (viewer: string): Promise<{ id: string; engine: string; design_profile?: unknown; prompt_text?: string }[]> => {
    const instances = enginesOfKind(options.config, "tts");
    const collected = await Promise.all(instances.map(async ([name, target]) => {
      try {
        const headers = new Headers();
        if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`);
        const upstream = await fetchImpl(new URL("/v1/voices", target.baseUrl), {
          headers,
          signal: AbortSignal.timeout(3_000),
        });
        if (!upstream.ok) return [];
        const payload = await upstream.json() as {
          voices?: ({ id?: string; prompt_text?: string; design_profile?: unknown } | string)[];
        };
        return (payload.voices ?? [])
          .map(entry => typeof entry === "string" ? { id: entry } : entry)
          .filter(entry => entry.id)
          .flatMap(entry => {
            const display = fromEngineVoiceId(viewer, entry.id as string);
            if (display === null) return [];
            return [{
              id: display,
              engine: name,
              // Design-profile metadata rides along so the studio can show fingerprints
              // and audit against the runtime without a per-voice round trip.
              ...(entry.design_profile === undefined ? {} : { design_profile: entry.design_profile }),
              ...(entry.prompt_text === undefined ? {} : { prompt_text: entry.prompt_text }),
            }];
          });
      } catch (error) {
        // One dead engine must not empty the whole bank; its absence is visible in /v1/engines.
        log(`voices: ${name} unreachable: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));
    return collected.flat();
  };

  const aggregatedVoices = async (viewer: string): Promise<Response> => Response.json({ voices: await collectVoices(viewer) });

  /** The registry, sanitized: names, kinds, capabilities, roles, live health — never addresses. */
  const collectEngines = async () => {
    const roleEntries = Object.entries(options.config.roles);
    const legacyRoles = ["tts", "asr", "llm", "asr_longform"]
      .filter(role => options.config.roles[role] === undefined && options.config.engines[role]?.baseUrl);
    const instances = Object.entries(options.config.engines).filter(([, target]) => target.baseUrl);
    const engines = await Promise.all(instances.map(async ([name, target]) => {
      let healthy = false;
      // The engine's self-reported model identity: what design-profile audits compare
      // against. Identity is not topology — addresses stay server-side.
      let runtime: { model: string; manifestSha256: string | null } | null = null;
      try {
        const headers = new Headers();
        if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`);
        const upstream = await fetchImpl(new URL(target.healthPath, target.baseUrl), {
          headers,
          signal: AbortSignal.timeout(2_000),
        });
        healthy = upstream.ok;
        if (upstream.ok) {
          const payload = await upstream.json() as { model?: unknown; model_manifest_sha256?: unknown };
          if (typeof payload.model === "string") {
            runtime = {
              model: payload.model,
              manifestSha256: typeof payload.model_manifest_sha256 === "string" ? payload.model_manifest_sha256 : null,
            };
          }
        }
      } catch {
        healthy = false;
      }
      return {
        name,
        kind: target.kind ?? null,
        model: target.model,
        capabilities: target.capabilities,
        roles: [
          ...roleEntries.filter(([, instance]) => instance === name).map(([role]) => role),
          ...(legacyRoles.includes(name) ? [name] : []),
        ],
        healthy,
        runtime,
      };
    }));
    return engines;
  };

  // MCP servers connect once per gateway process (docs/mcp-tools.md); sessions await the
  // connection through the extraTools provider, so startup order costs nothing. Demo mode
  // leaves them unconnected regardless of config — external tools have no business there.
  const mcpSource: Promise<McpToolSource> | undefined =
    options.config.mcpServers.length > 0 && options.demoMode !== true
      ? connectMcpServers(options.config.mcpServers, { log, reservedNames: builtinToolNames })
      : undefined;

  const engineList = async (): Promise<Response> => Response.json({
    engines: await collectEngines(),
    // Agent Builder needs the live allowlist without learning how a server is
    // reached. Commands, URLs, credentials, environment, and trust policy stay
    // gateway-only, and failed/auth-rejected servers are omitted.
    mcpServers: mcpSource ? (await mcpSource).connectedServers() : [],
  });

  const sinkFor = (ws: ServerWebSocket<SocketData>): EventSink => {
    // One sink object per socket: attach/detach pair on its identity, so a stale socket's
    // close event can never detach the connection that replaced it.
    ws.data.sink ??= { send: payload => { ws.send(payload); } };
    return ws.data.sink;
  };

  /** Thrown by createSession at the capacity guardrail; both dialects translate it. */
  class CapacityError extends Error {
    readonly code = "session_capacity";

    constructor() {
      super("session_capacity");
    }
  }

  /** Thrown by createSession when the owner's allowance is spent; translated the same way. */
  class QuotaError extends Error {
    readonly code = "quota_exceeded";
    readonly retryAfterSeconds: number;

    constructor(retryAfterSeconds: number) {
      super(`quota exhausted: retry in ${retryAfterSeconds}s`);
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }

  const createSession = (
    extraTools: ConversationTool[] = [],
    owner: string = OWNER_USER_ID,
    agentSpec?: AgentSpec,
  ): GatewaySession => {
    if (options.maxSessions !== undefined && sessions.size >= options.maxSessions) {
      log(`session refused: at the ${options.maxSessions}-session capacity`);
      throw new CapacityError();
    }
    // A conversation is the most expensive thing here: charged once, at its start.
    if (quota !== undefined) {
      const verdict = quota.charge(owner);
      if (!verdict.allowed) {
        log("session refused: the account's quota allowance is spent");
        throw new QuotaError(verdict.retryAfterSeconds as number);
      }
    }
    // Namespacing lives in the gateway; the session just applies it at the TTS boundary.
    const ownerVoice = (displayName: string): string | null => toEngineVoiceId(owner, displayName);
    const session = new GatewaySession({
      config: options.config,
      owner,
      mapVoiceId: ownerVoice,
      // A deployment default such as `laok` is shared engine configuration, not a
      // user-created voice. Keep that exact registered voice for account holders instead
      // of rewriting it to `u<owner>.laok`; omission would put VoxCPM in design mode.
      ...(owner === OWNER_USER_ID ? {} : { deploymentDefaultVoice: options.config.ttsDefaults.voice }),
      ...(agentSpec === undefined ? {} : { agentSpec }),
      // A conversation is metered per turn: one charge at start bought the session, and
      // each turn's model work costs one more (adversarial review 2026-07-26 — a single
      // charge used to buy unbounded engine work).
      ...(quota === undefined ? {} : { chargeTurn: () => quota.charge(owner) }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.pcmDecoder === undefined ? {} : { pcmDecoder: options.pcmDecoder }),
      // The session tools see the same sanitized surfaces the facade serves.
      listVoices: async () => (await collectVoices(owner)).map(voice => ({ id: voice.id, engine: voice.engine })),
      engineStatus: collectEngines,
      // The Studio tools (docs/voice-studio-control.md): demo mode never allows them —
      // an anonymous visitor must not write the voice bank by talking at it.
      allowStudioTools: options.demoMode !== true,
      ...(options.persistPronunciations === undefined ? {} : { persistPronunciations: options.persistPronunciations }),
      // An audit names a profile, so it is an ownership path too: the caller's display
      // name is namespaced before the engine is asked about it (adversarial review
      // 2026-07-26), which also keeps a self-audit working under accounts.
      auditProfile: (id: string) => {
        const engineId = ownerVoice(id);
        if (engineId === null) throw new Error(`unknown profile ${id}`);
        return auditDesignProfile(new TtsClient(engine(options.config, "tts"), fetchImpl), engineId);
      },
      registerVoice: async (id, wav, transcript) => {
        // The session speaks its owner's namespace; the engine hears the mapped id.
        const engineId = ownerVoice(id);
        if (engineId === null) throw new Error(`voice id ${id} cannot be used in this account's namespace`);
        // Registering by voice reaches the same engine as POST /v1/voices, so it costs
        // the same (adversarial review 2026-07-26: this path used to be free).
        if (quota !== undefined) {
          const verdict = quota.charge(owner);
          if (!verdict.allowed) {
            throw new Error(`quota exhausted: retry in ${verdict.retryAfterSeconds ?? 0}s`);
          }
        }
        const selected = engineByCapability(options.config, "tts", "clone")
          ?? ([roleInstance(options.config, "tts"), engine(options.config, "tts")] as const);
        const [engineName, target] = selected;
        const form = new FormData();
        form.set("id", engineId);
        form.set("text", transcript);
        form.set("audio", new File([wav as BlobPart], `${id}.wav`, { type: "audio/wav" }));
        const headers = new Headers();
        if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`);
        let upstream: Response;
        try {
          upstream = await fetchImpl(new URL("/v1/voices", target.baseUrl), { method: "POST", headers, body: form });
        } catch (error) {
          // An engine we never reached did no work, so the charge goes back — the same
          // rule the REST paths follow (adversarial review 2026-07-27).
          quota?.refund(owner);
          throw error;
        }
        if (!upstream.ok) throw new Error(`${engineName} refused the voice registration (HTTP ${upstream.status})`);
        return { engine: engineName };
      },
      extraTools: async () => {
        // Built-ins always win; then the surface's own tools (an OpenAI client owns the
        // function names it declared — an ambient MCP tool must never absorb its calls);
        // MCP tools last. Duplicates keep their first registration. Studio names are
        // reserved even when the tools are off, so enabling them never changes whose
        // call an ambient tool had been absorbing.
        const taken = new Set<string>([...builtinToolNames, ...studioToolNames]);
        const composed: ConversationTool[] = [];
        const agentMcp = agentSpec === undefined ? undefined : agentSpec.mcpServers ?? [];
        for (const tool of [...extraTools, ...(mcpSource ? (await mcpSource).tools(agentMcp) : [])]) {
          if (taken.has(tool.name)) continue;
          taken.add(tool.name);
          composed.push(tool);
        }
        return composed;
      },
      ...(library === undefined ? {} : {
        // A failed ingest must never cost the turn — capture is an observer, not a stage.
        onUtterance: async (wav: Uint8Array, transcript: string) => {
          try {
            await library.ingest(wav, transcript, session.id, owner);
          } catch (error) {
            log(`library: ingest failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }),
      loadSileroVad: options.loadSileroVad,
      ...(options.reconnectGraceMs === undefined ? {} : { reconnectGraceMs: options.reconnectGraceMs }),
      ...((options.maxSessionSeconds === undefined && agentSpec?.maxSessionSeconds === undefined) ? {} : {
        maxSessionSeconds: Math.min(options.maxSessionSeconds ?? Number.POSITIVE_INFINITY, agentSpec?.maxSessionSeconds ?? Number.POSITIVE_INFINITY),
      }),
      onClosed: closed => { sessions.delete(closed.id); },
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    sessions.set(session.id, session);
    return session;
  };

  const resolveAgentStart = async (
    owner: string,
    start: SessionStartOptions,
  ): Promise<{ start: SessionStartOptions; spec?: AgentSpec }> => {
    if (start.agent === undefined) return { start };
    if (agents === undefined) throw new AgentRegistryError("not_found", "this deployment has no Agent registry configured");
    const source = start.agentSource === "draft"
      ? { type: "draft" as const, ...(start.agentRevision === undefined ? {} : { revision: start.agentRevision }) }
      : { type: "published" as const, ...(start.agentVersion === undefined ? {} : { version: start.agentVersion }) };
    const resolved = await agents.resolve(owner, start.agent, source);
    const spec = resolved.spec;
    const {
      agent: _agent,
      agentSource: _agentSource,
      agentRevision: _agentRevision,
      agentVersion: _agentVersion,
      ...explicit
    } = start;
    const defaults: SessionStartOptions = {
      ...(spec.instructions === undefined ? {} : { system: spec.instructions }),
      ...(spec.voice === undefined ? {} : { voice: spec.voice }),
      ...(spec.language === undefined ? {} : { language: spec.language }),
      ...(spec.welcome === undefined ? {} : { welcome: spec.welcome }),
      ...(spec.nudgeAfterSeconds === undefined ? {} : { nudgeAfterSeconds: spec.nudgeAfterSeconds }),
      ...(spec.asrEngine === undefined ? {} : { asrEngine: spec.asrEngine }),
      ...(spec.llmEngine === undefined ? {} : { llmEngine: spec.llmEngine }),
      ...(spec.ttsEngine === undefined ? {} : { ttsEngine: spec.ttsEngine }),
      ...(spec.turnTaking === undefined ? {} : { turnTaking: spec.turnTaking }),
      ...(spec.reopenMs === undefined ? {} : { reopenMs: spec.reopenMs }),
      ...(spec.vad === undefined ? {} : { vad: spec.vad }),
      ...(spec.threshold === undefined ? {} : { threshold: spec.threshold }),
      ...(spec.silenceMs === undefined ? {} : { silenceMs: spec.silenceMs }),
      ...(spec.minSpeechMs === undefined ? {} : { minSpeechMs: spec.minSpeechMs }),
    };
    const merged: SessionStartOptions = { ...defaults, ...explicit };
    // Tool policy is a ceiling: the caller may turn an allowed capability off, never
    // turn one on that the saved Agent did not grant.
    merged.studioTools = spec.studioTools === true && explicit.studioTools !== false;
    return { start: merged, spec };
  };

  const resolveDeploymentStart = async (
    owner: string,
    requested: SessionStartOptions,
  ): Promise<{ start: SessionStartOptions; spec?: AgentSpec }> => {
    let start = requested;
    if (options.demoAgent !== undefined) {
      if (start.agent !== undefined && start.agent !== options.demoAgent.id) {
        throw new AgentRegistryError("invalid", `demo deployment is pinned to agent ${options.demoAgent.id}`);
      }
      if (start.agentVersion !== undefined && start.agentVersion !== options.demoAgent.version) {
        throw new AgentRegistryError("invalid", `demo deployment is pinned to agent ${options.demoAgent.id} version ${options.demoAgent.version}`);
      }
      start = {
        ...start,
        agent: options.demoAgent.id,
        agentSource: "published",
        agentVersion: options.demoAgent.version,
      };
    }
    return resolveAgentStart(owner, start);
  };

  const handleFirstCommand = (ws: ServerWebSocket<SocketData>, command: GatewayCommand): void => {
    const sink = sinkFor(ws);
    if (command.type === "session.start") {
      if (ws.data.pendingStart !== undefined) {
        sink.send(rejection("", "session_starting", command));
        return;
      }
      const pendingKey = command.idempotencyKey;
      ws.data.pendingStart = pendingKey;
      ws.data.pendingAudio = [];
      void (async (): Promise<void> => {
        let session: GatewaySession;
        let resolved: Awaited<ReturnType<typeof resolveAgentStart>>;
        try {
          // Resolution precedes charging and engine admission: an unknown, unpublished,
          // cross-owner, or stale draft Agent costs no quota and starts no session.
          resolved = await resolveDeploymentStart(ws.data.ctx.userId, command.options ?? {});
          if (ws.data.closed === true || ws.data.pendingStart !== pendingKey) return;
          session = createSession([], ws.data.ctx.userId, resolved.spec);
        } catch (error) {
          if (ws.data.pendingStart === pendingKey) {
            ws.data.pendingStart = undefined;
            ws.data.pendingAudio = undefined;
          }
          if (ws.data.closed === true) return;
          if (error instanceof QuotaError) {
            sink.send(rejection("", "quota_exceeded", command, {
              retryAfterSeconds: error.retryAfterSeconds,
              requestId: crypto.randomUUID(),
            }));
            return;
          }
          const reason = error instanceof CapacityError ? "session_capacity"
            : error instanceof AgentRegistryError
              ? error.code === "not_published" ? "agent_not_published"
                : error.code === "conflict" ? "agent_revision_conflict" : "unknown_agent"
              : "session_unavailable";
          sink.send(rejection("", reason, command));
          return;
        }
        ws.data.session = session;
        session.recordCommand(command);
        try {
          await session.start(resolved.start, sink);
          // The close callback can mutate socket data while session.start awaits; keep
          // this read opaque to TypeScript's pre-await control-flow narrowing.
          if (Boolean(ws.data.closed)) {
            ws.data.session = undefined;
            session.stop();
            return;
          }
          const pendingAudio = ws.data.pendingStart === pendingKey ? ws.data.pendingAudio ?? [] : [];
          ws.data.pendingStart = undefined;
          ws.data.pendingAudio = undefined;
          session.accept(command);
          session.emit(session.snapshotPayload());
          for (const bytes of pendingAudio) session.pushAudio(bytes);
        } catch (error) {
          ws.data.pendingStart = undefined;
          ws.data.pendingAudio = undefined;
          session.emit({
            type: "command.rejected",
            reason: error instanceof Error ? error.message : String(error),
            commandType: command.type,
            idempotencyKey: command.idempotencyKey,
          });
          ws.data.session = undefined;
          session.stop();
        }
      })();
      return;
    }
    if (command.type === "session.attach") {
      const session = sessions.get(command.sessionId);
      // A cross-owner attach reads as unknown (docs/auth.md phase 2): whether a
      // session id exists is nobody else's business either.
      if (!session || session.owner !== ws.data.ctx.userId) {
        sink.send(rejection(command.sessionId, "unknown_session", command));
        return;
      }
      ws.data.session = session;
      session.recordCommand(command);
      session.accept(command);
      session.attach(sink);
      return;
    }
    sink.send(rejection("", "no_session", command));
  };

  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 8790,
    async fetch(request, server) {
      const url = new URL(request.url);
      // The catalog decides which methods exist, so the document and the router cannot
      // disagree about it (adversarial review 2026-07-26: /healthz answered anything).
      const known = routeFor(url.pathname);
      if (known !== undefined && !known.methods.includes(request.method)) {
        return problem(405, "method_not_allowed", `${request.method} is not allowed on ${known.path}`);
      }
      if (url.pathname === "/healthz") {
        const deployment = {
          demo: options.demoMode === true,
          ...(options.demoAgent === undefined ? {} : { demoAgent: options.demoAgent }),
          ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
          ...(options.maxSessionSeconds === undefined ? {} : { maxSessionSeconds: options.maxSessionSeconds }),
        };
        if (options.accounts !== undefined) {
          return (async (): Promise<Response> => Response.json({
            ok: true,
            protocol: protocolVersion,
            auth: "accounts",
            deployment,
            // Which sign-in doors to render. Not a secret: the login card shows them.
            login: (await accountsFor()).doors,
          }))();
        }
        // `auth` tells the app shell which door it is standing at — the one thing it
        // cannot discover without a credential (docs/auth.md phase 3). "accounts" means
        // sign in; "self" means the self-hosted studio, unchanged.
        return Response.json({
          ok: true,
          protocol: protocolVersion,
          // Only the owner's own studio gets the live-session count; a public entrance
          // does not disclose its traffic (adversarial review 2026-07-26, L-3).
          ...(options.accounts === undefined ? { sessions: sessions.size } : {}),
          auth: options.accounts === undefined ? "self" : "accounts",
          deployment,
        });
      }
      // The discovery surface (docs/auth.md): unauthenticated by necessity — an agent
      // reads it to learn how to get a credential — and hosted-only, since a
      // self-hosted studio mints no keys and its paths must stay as they were.
      if (options.accounts !== undefined && (discoveryPaths as readonly string[]).includes(url.pathname)) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return problem(405, "method_not_allowed", `${request.method} is not allowed on this route`);
        }
        return (discoveryRoutes[url.pathname] as (request: Request) => Response)(request);
      }
      // Without accounts these paths do not exist. Falling through to the SPA gave a
      // machine a 200 and a web page, which reads as success (adversarial review
      // 2026-07-26, L-1); ordinary deep links still get the shell.
      if (options.accounts === undefined && (discoveryPaths as readonly string[]).includes(url.pathname)) {
        return problem(
          404,
          "discovery_disabled",
          "this deployment serves no discovery surface — it exists on gateways started with accounts",
        );
      }
      const page = serveStatic(request, url);
      if (page) return page;
      // Better Auth's own routes sit before the identity gate — logging in requires
      // no identity, and the module handles its own CSRF/origin discipline.
      if (options.accounts !== undefined && (url.pathname === "/v1/auth" || url.pathname.startsWith("/v1/auth/"))) {
        return (await accountsFor()).handler(request);
      }
      // The one place a credential becomes an identity; every /v1 handler below sees
      // only the resolved context (docs/auth.md phase 1).
      const ctx = options.authResolver !== undefined
        ? options.authResolver(request)
        : options.accounts !== undefined
          ? await (await accountsFor()).resolve(request)
          : resolveAuthContext(request, options);
      if (ctx === null) return problem(401, "unauthorized", "a valid credential is required");
      // Charged after identity, before the work: the account is known, and nothing
      // upstream has been touched yet.
      let charged = false;
      if (quota !== undefined && chargeable(request.method, url.pathname)) {
        const verdict = quota.charge(ctx.userId);
        if (!verdict.allowed) {
          log(`quota: ${request.method} ${url.pathname} refused — allowance spent`);
          return quotaRefusal(verdict.retryAfterSeconds as number);
        }
        charged = true;
      }
      /**
       * A refusal this gateway makes itself, or an engine it could not reach, spent no
       * model time — so it must spend no allowance either (adversarial review
       * 2026-07-26). Wraps only the gateway's own pre-engine refusals; an error the
       * engine itself returned is work that happened and stays charged.
       */
      const refund = (): void => {
        if (charged && quota !== undefined) quota.refund(ctx.userId);
      };
      const refunded = (response: Response): Response => {
        refund();
        return response;
      };
      const agentMatch = agentEntryPattern.exec(url.pathname);
      if (url.pathname === "/v1/agents" || agentMatch !== null) {
        if (agents === undefined) {
          return problem(404, "agents_disabled", "this deployment has no Agent registry configured");
        }
        const mutating = request.method === "PATCH" || request.method === "DELETE"
          || (request.method === "POST" && agentMatch?.[2] !== "audit");
        if (mutating && options.demoMode === true) {
          return problem(403, "demo_mode", "Agent registry writes are disabled in demo mode");
        }
        // Better Auth protects its own mutations only. Product writes made with an
        // ambient browser session receive the same exact hosted-Origin check as the
        // realtime upgrade; API keys remain explicit non-browser credentials.
        if (mutating && (ctx.via === "session" || ctx.via === "none") && !upgradeOriginAllowed(request, originPolicy())) {
          return problem(403, "forbidden_origin", "this origin may not modify Agents");
        }
        const body = async (): Promise<Record<string, unknown> | null> => {
          const parsed = await request.json().catch(() => null) as unknown;
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown> : null;
        };
        const revision = (value: unknown): number => {
          if (!Number.isInteger(value) || (value as number) < 1) {
            throw new AgentRegistryError("invalid", "revision must be a positive integer");
          }
          return value as number;
        };
        const recordResponse = (record: { revision: number }, status = 200): Response => Response.json(record, {
          status,
          headers: { etag: `\"${record.revision}\"` },
        });
        try {
          if (url.pathname === "/v1/agents") {
            if (request.method === "GET") return Response.json({ agents: await agents.list(ctx.userId) });
            const parsed = await body();
            if (parsed === null) throw new AgentRegistryError("invalid", "expected a JSON object");
            return recordResponse(await agents.create(ctx.userId, parsed as unknown as CreateAgentInput), 201);
          }
          const id = agentMatch?.[1] as string;
          const action = agentMatch?.[2];
          if (action === "publish") {
            const parsed = await body();
            if (parsed === null) throw new AgentRegistryError("invalid", "expected a JSON object");
            const result = await agents.publish(ctx.userId, id, revision(parsed.revision));
            return recordResponse({ ...result, revision: result.record.revision });
          }
          if (action === "audit") return Response.json(await agents.audit(ctx.userId, id));
          if (action === "versions") return Response.json({ versions: await agents.versions(ctx.userId, id) });
          if (request.method === "GET") {
            const record = await agents.get(ctx.userId, id);
            return record === undefined ? problem(404, "agent_not_found", `agent ${id} was not found`) : recordResponse(record);
          }
          const parsed = await body();
          if (parsed === null) throw new AgentRegistryError("invalid", "expected a JSON object");
          if (request.method === "PATCH") {
            return recordResponse(await agents.update(ctx.userId, id, {
              ...parsed as unknown as UpdateAgentInput,
              revision: revision(parsed.revision),
            }));
          }
          await agents.remove(ctx.userId, id, revision(parsed.revision));
          return Response.json({ deleted: true });
        } catch (error) {
          if (!(error instanceof AgentRegistryError)) throw error;
          const status = error.code === "invalid" ? 400
            : error.code === "not_found" ? 404
              : 409;
          const code = error.code === "not_found" ? "agent_not_found" : `agent_${error.code}`;
          return problem(status, code, error.message);
        }
      }
      if (url.pathname === "/v1/realtime") {
        // Browsers always send Origin on an upgrade; a cross-site one is refused before
        // the socket exists (CSWSH under a token, CSRF under a cookie session). Hosted
        // deployments match the full public origin and get no loopback exception.
        if (!upgradeOriginAllowed(request, originPolicy())) return problem(403, "forbidden_origin", "this origin may not open a realtime socket");
        // Dialect detection (openai-realtime-adapter.md, decision 1): the OpenAI SDKs
        // derive this exact path from their baseURL and always carry ?model= plus a
        // `realtime` WebSocket subprotocol; native clients send neither. The choice must
        // precede the first frame — the OpenAI server speaks first (session.created),
        // the native server never does.
        const subprotocols = (request.headers.get("sec-websocket-protocol") ?? "")
          .split(",").map(entry => entry.trim());
        const openai = url.searchParams.has("model")
          || url.searchParams.has("agent")
          || url.searchParams.get("protocol") === "openai"
          || request.headers.has("openai-beta")
          || subprotocols.includes("realtime");
        let openaiStart: SessionStartOptions | undefined;
        let openaiAgentSpec: AgentSpec | undefined;
        if (openai) {
          const selectedAgent = url.searchParams.get("agent") ?? undefined;
          const rawVersion = url.searchParams.get("agent_version") ?? undefined;
          let agentVersion: number | undefined;
          if (rawVersion !== undefined) {
            if (selectedAgent === undefined) {
              return problem(400, "invalid_agent_version", "agent_version requires agent");
            }
            agentVersion = Number(rawVersion);
            if (!Number.isInteger(agentVersion) || agentVersion < 1) {
              return problem(400, "invalid_agent_version", "agent_version must be a positive integer");
            }
          }
          try {
            const resolved = await resolveDeploymentStart(ctx.userId, {
              ...(selectedAgent === undefined ? {} : { agent: selectedAgent }),
              ...(agentVersion === undefined ? {} : { agentVersion }),
            });
            openaiStart = resolved.start;
            openaiAgentSpec = resolved.spec;
          } catch (error) {
            if (!(error instanceof AgentRegistryError)) throw error;
            const status = error.code === "invalid" ? 400
              : error.code === "not_found" ? 404
                : 409;
            return problem(status, `agent_${error.code}`, error.message);
          }
        }
        const data: SocketData = {
          session: undefined,
          sink: undefined,
          ctx,
          closed: false,
          ...(openai ? { openaiModel: url.searchParams.get("model") ?? "voxstudio-realtime" } : {}),
          ...(openaiStart === undefined ? {} : { openaiStart }),
          ...(openaiAgentSpec === undefined ? {} : { openaiAgentSpec }),
        };
        // Clients that offer subprotocols (the OpenAI SDKs offer `realtime`) get their
        // first choice echoed back by Bun's upgrade; adding it manually here duplicates
        // the header and fails the handshake.
        if (server.upgrade(request, { data })) return undefined;
        return problem(426, "upgrade_required", "/v1/realtime speaks WebSocket; upgrade the connection");
      }
      if (url.pathname === "/v1/engines") {
        return engineList();
      }
      // Demo mode (docs/public-demo.md): the registry is read-only — picking voices is
      // the demo, minting or deleting them is not.
      const demoRefusal = (): Response => Response.json(
        { error: { message: "registry writes are disabled in demo mode", code: "demo_mode" } },
        { status: 403 },
      );
      // One mapper for every path that names a voice — registry, design profiles,
      // promote, and synthesis alike. Null is always the same 400: a display name that
      // is malformed, unfittable, or a raw engine id (adversarial review 2026-07-26).
      const engineVoice = (displayName: string): string | null => toEngineVoiceId(ctx.userId, displayName);
      if (url.pathname === "/v1/design-profiles") {
        if (options.demoMode === true) return refunded(demoRefusal());
        // Zero-shot voice design is an engine capability, not a given.
        const selected = selectEngine(url, "tts", "tts", "design");
        if (selected instanceof Response) return selected;
        // Profiles are created into the caller's namespace: the JSON id is mapped, the
        // rest of the body rides through untouched.
        return (async (): Promise<Response> => {
          const body = await request.json().catch(() => null) as { id?: unknown } | null;
          if (body === null || typeof body.id !== "string") return refunded(badVoiceId());
          const engineId = engineVoice(body.id);
          if (engineId === null) return refunded(badVoiceId());
          const rewritten = new Request(request.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...body, id: engineId }),
          });
          return proxy(rewritten, selected[1], url.pathname, selected[0], refund);
        })();
      }
      if (url.pathname === "/v1/voices") {
        if (request.method === "GET") return aggregatedVoices(ctx.userId);
        if (options.demoMode === true) return refunded(demoRefusal());
        // Registration needs a registry: route to the clone-capable instance by default.
        const selected = selectEngine(url, "tts", "tts", "clone");
        if (selected instanceof Response) return selected;
        return (async (): Promise<Response> => {
          const form = await request.formData().catch(() => null);
          const id = form?.get("id");
          if (form === null || typeof id !== "string") return refunded(badVoiceId());
          const engineId = engineVoice(id);
          if (engineId === null) return refunded(badVoiceId());
          form.set("id", engineId);
          return proxy(new Request(request.url, { method: "POST", body: form }), selected[1], url.pathname, selected[0], refund);
        })();
      }
      if (voiceEntryPattern.test(url.pathname)) {
        if (!["GET", "DELETE"].includes(request.method)) return problem(405, "method_not_allowed", `${request.method} is not allowed on this route`);
        if (request.method === "DELETE" && options.demoMode === true) return demoRefusal();
        const selected = selectEngine(url, "tts", "tts", "clone");
        if (selected instanceof Response) return selected;
        const engineId = engineVoice(url.pathname.slice("/v1/voices/".length));
        if (engineId === null) return badVoiceId();
        return proxy(request, selected[1], `/v1/voices/${engineId}`, selected[0]);
      }
      if (url.pathname === "/v1/library" || url.pathname.startsWith("/v1/library/")) {
        // Absent library = the deployment never opted into retention; the panel reads the
        // structured code and explains instead of erroring.
        if (!library) {
          return refunded(Response.json(
            { error: { message: "the capture library is not enabled on this gateway (start with --library DIR)", code: "library_disabled" } },
            { status: 404 },
          ));
        }
        // The shutdown window: close() is draining in-flight work; new work must not race it.
        if (library.isClosed) {
          return refunded(Response.json(
            { error: { message: "the capture library is shutting down", code: "library_closing" } },
            { status: 503 },
          ));
        }
        const notFound = (): Response => Response.json(
          { error: { message: "no such capture", code: "unknown_capture" } },
          { status: 404 },
        );
        if (url.pathname === "/v1/library") {
          const bounded = (name: string, fallback: number, max: number): number => {
            const parsed = Number(url.searchParams.get(name) ?? fallback);
            return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
          };
          return Response.json(library.list(bounded("limit", 50, 200), bounded("offset", 0, Number.MAX_SAFE_INTEGER), ctx.userId));
        }
        const entry = libraryEntryPattern.exec(url.pathname);
        if (!entry) return problem(404, "not_found", "no such route");
        const captureId = entry[1] as string;
        const sub = entry[2];
        if (sub === "/audio") {
          if (!library.get(captureId, ctx.userId)) return notFound();
          return new Response(Bun.file(library.audioPath(captureId)), {
            headers: { "content-type": "audio/wav", "cache-control": "no-cache" },
          });
        }
        // A mutation queued when close() flips rejects; that is the shutdown window again.
        const closing = (): Response => Response.json(
          { error: { message: "the capture library is shutting down", code: "library_closing" } },
          { status: 503 },
        );
        if (sub === "/promote") {
          return (async (): Promise<Response> => {
            const body = await request.json().catch(() => ({})) as { voice_id?: unknown };
            const voiceId = typeof body.voice_id === "string" ? body.voice_id.trim() : "";
            if (!voiceIdPattern.test(voiceId)) {
              return refunded(problem(400, "bad_voice_id", "voice_id must match [A-Za-z0-9._-]{1,64}"));
            }
            // The record keeps the display name; the engine hears the namespaced id.
            const engineVoiceId = engineVoice(voiceId);
            if (engineVoiceId === null) return refunded(badVoiceId());
            // The whole flow — validate, engine round-trip, mark — holds the capture's
            // mutation lock: a concurrent delete waits its turn instead of leaving the
            // clone engine holding a voice the library no longer records.
            return library.runExclusive(captureId, async (): Promise<Response> => {
              const capture = library.get(captureId, ctx.userId);
              if (!capture) return refunded(notFound());
              // A voice sample needs its verbatim text; the correction is the reference.
              const text = (capture.corrected ?? capture.transcript).trim();
              if (text === "") {
                return refunded(problem(400, "empty_transcript", "the capture has no transcript; correct it before promoting"));
              }
              const selected = selectEngine(url, "tts", "tts", "clone");
              if (selected instanceof Response) return selected;
              const [engineName, target] = selected;
              const form = new FormData();
              form.set("id", engineVoiceId);
              form.set("text", text);
              form.set("audio", new File([await Bun.file(library.audioPath(captureId)).bytes()], `${captureId}.wav`, { type: "audio/wav" }));
              const headers = new Headers();
              if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`);
              let upstream: Response;
              try {
                upstream = await fetchImpl(new URL("/v1/voices", target.baseUrl), { method: "POST", headers, body: form });
              } catch (error) {
                log(`library: promote to ${engineName} unreachable: ${error instanceof Error ? error.message : String(error)}`);
                refund();
                return Response.json({ error: { message: `${engineName} engine unreachable`, code: "engine_unreachable" } }, { status: 502 });
              }
              if (!upstream.ok) {
                return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
              }
              await upstream.body?.cancel().catch(() => {});
              const updated = library.markPromoted(captureId, voiceId);
              return Response.json({ capture: updated, engine: engineName });
            }).catch((error: unknown) => {
              if (error instanceof Error && error.message.includes("closed")) return closing();
              throw error;
            });
          })();
        }
        if (request.method === "PATCH") {
          return (async (): Promise<Response> => {
            const body = await request.json().catch(() => ({})) as { corrected?: unknown };
            if (body.corrected !== null && typeof body.corrected !== "string") {
              return Response.json({ error: { message: "corrected must be a string or null", code: "bad_correction" } }, { status: 400 });
            }
            try {
              const updated = await library.correct(captureId, body.corrected as string | null, ctx.userId);
              return updated ? Response.json(updated) : notFound();
            } catch (error) {
              if (error instanceof Error && error.message.includes("closed")) return closing();
              throw error;
            }
          })();
        }
        if (request.method === "DELETE") {
          return (async (): Promise<Response> => {
            try {
              return (await library.remove(captureId, ctx.userId)) ? Response.json({ deleted: true }) : notFound();
            } catch (error) {
              if (error instanceof Error && error.message.includes("closed")) return closing();
              throw error;
            }
          })();
        }
        if (request.method === "GET") {
          const capture = library.get(captureId, ctx.userId);
          return capture ? Response.json(capture) : notFound();
        }
        return problem(405, "method_not_allowed", `${request.method} is not allowed on this route`);
      }
      const route = facadeRoutes[url.pathname];
      if (route) {
        const selected = selectEngine(url, route.kind, route.role);
        if (selected instanceof Response) return selected;
        // Synthesis names a voice, so it is an ownership path too: hiding a voice from
        // the bank listing means nothing if the engine will still speak it for whoever
        // guesses its id (adversarial review 2026-07-26). A voice-less request keeps
        // the engine's own voice-less semantics (VoxCPM uses design mode).
        if (url.pathname === "/v1/audio/speech") {
          return (async (): Promise<Response> => {
            const body = await request.json().catch(() => null) as Record<string, unknown> | null;
            if (body === null) return refunded(problem(400, "bad_request", "expected a JSON body"));
            if (body.voice !== undefined) {
              if (typeof body.voice !== "string") return refunded(badVoiceId());
              const engineId = engineVoice(body.voice);
              if (engineId === null) return refunded(badVoiceId());
              body.voice = engineId;
            }
            // Refused before the engine is touched, so it costs no quota and no GPU. The
            // estimate is the one the Studio displays, so a caller sees the same number.
            if (options.maxSynthesisSeconds !== undefined && typeof body.input === "string") {
              const seconds = Math.round(estSeconds(body.input));
              if (seconds > options.maxSynthesisSeconds) {
                return refunded(problem(
                  400,
                  "input_too_long",
                  `this text is about ${seconds}s of speech; this deployment synthesizes at most ${options.maxSynthesisSeconds}s per request — split it and send the parts`,
                ));
              }
            }
            const rewritten = new Request(request.url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            const send = (): Promise<Response> => proxy(rewritten, selected[1], url.pathname, selected[0], refund);
            if (synthesisGate === undefined) return send();
            // Saturation is a wait, not a failure, until the queue is full — then say so
            // with a delay the caller can honour instead of holding a socket nobody serves.
            try {
              return await synthesisGate.run(send);
            } catch (error) {
              if (!(error instanceof SynthesisBusyError)) throw error;
              log(`synthesis: refused — ${synthesisGate.depth.inFlight} in flight, ${synthesisGate.depth.queued} queued`);
              return refunded(Response.json(
                { error: { message: error.message, code: error.code, retryAfterSeconds: error.retryAfterSeconds } },
                { status: 429, headers: { "retry-after": String(error.retryAfterSeconds) } },
              ));
            }
          })();
        }
        return proxy(request, selected[1], url.pathname, selected[0], refund);
      }
      return problem(404, "not_found", "no such route");
    },
    websocket: {
      open(ws) {
        if (ws.data.openaiModel === undefined) return;
        ws.data.openai = new OpenAiRealtimeConnection({
          send: text => { ws.send(text); },
          close: () => { ws.close(); },
          createSession: extraTools => createSession(extraTools, ws.data.ctx.userId, ws.data.openaiAgentSpec),
          reservedToolNames: builtinToolNames,
          model: ws.data.openaiModel,
          ...(ws.data.openaiStart === undefined ? {} : { startOptions: ws.data.openaiStart }),
          ...(options.openAiFunctionCallTimeoutMs === undefined ? {} : { functionCallTimeoutMs: options.openAiFunctionCallTimeoutMs }),
          ...(options.log === undefined ? {} : { log: options.log }),
        });
      },
      message(ws, data) {
        if (ws.data.openai) {
          if (typeof data === "string") ws.data.openai.handleMessage(data);
          // The OpenAI dialect is JSON-only; binary frames have no meaning on this wire.
          return;
        }
        if (typeof data !== "string") {
          const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          if (ws.data.pendingStart !== undefined) {
            const buffered = ws.data.pendingAudio ?? [];
            // One second of 16 kHz float32 audio is enough to preserve speech begun on
            // the start gesture without letting an unresolved session grow unbounded.
            const retained = buffered.reduce((sum, entry) => sum + entry.byteLength, 0);
            if (retained + bytes.byteLength <= 64_000) buffered.push(bytes.slice());
            ws.data.pendingAudio = buffered;
            return;
          }
          ws.data.session?.pushAudio(bytes);
          return;
        }
        let command: GatewayCommand;
        try {
          command = parseCommand(data);
        } catch (error) {
          const reason = error instanceof ProtocolError ? error.message : "invalid command";
          sinkFor(ws).send(rejection(ws.data.session?.id ?? "", reason));
          return;
        }
        if (ws.data.pendingStart !== undefined) {
          sinkFor(ws).send(rejection("", "session_starting", command));
          return;
        }
        const session = ws.data.session;
        if (session) session.handleCommand(command);
        else handleFirstCommand(ws, command);
      },
      close(ws) {
        ws.data.closed = true;
        ws.data.pendingStart = undefined;
        ws.data.pendingAudio = undefined;
        if (ws.data.openai) {
          // No reattach in this dialect: the socket's end is the session's end.
          ws.data.openai.handleClose();
          ws.data.openai = undefined;
          return;
        }
        const session = ws.data.session;
        if (!session) return;
        ws.data.session = undefined;
        session.detach(sinkFor(ws));
      },
    },
  });

  log(`realtime gateway listening on ${server.url.toString()}`);
  return {
    url: server.url.toString(),
    port: server.port ?? 0,
    sessionCount: () => sessions.size,
    stop: async () => {
      for (const session of sessions.values()) session.stop();
      await Promise.allSettled([...sessions.values()].map(session => session.done));
      if (mcpSource) await (await mcpSource).close().catch(() => {});
      // Draining: in-flight library work (a promote awaiting its engine) finishes
      // against an open database; only then does the store close.
      if (library) await library.close();
      // Bounded: Bun's force-stop has been observed to never resolve when a client's
      // WebSocket close handshake is still in flight at stop time (reproduced 2026-07-19
      // with an MCP-configured gateway). The sockets are already torn down above; a stop
      // that will not say so must not wedge shutdown.
      const finished = await Promise.race([
        server.stop(true).then(() => true),
        new Promise<false>(resolve => { setTimeout(() => { resolve(false); }, 2_000); }),
      ]);
      if (!finished) log("gateway stop: server.stop did not settle within 2s; proceeding with shutdown");
      // Last: the auth database outlives request admission. Closing it before the
      // listener stops would let a login or a session lookup land on a closed handle
      // (adversarial review 2026-07-26); the module's own closed-guard covers the
      // remainder of the window when the stop above did not settle.
      if (accountsInstance) (await accountsInstance).close();
    },
  };
}
