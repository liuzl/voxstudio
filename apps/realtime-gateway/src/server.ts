import type { Fetch, PcmStreamDecoder } from "@voxstudio/clients";
import { engine, engineByCapability, enginesOfKind, roleInstance } from "@voxstudio/config";
import type { EngineKind, ResolvedEngineConfig, VoxConfig } from "@voxstudio/contracts";
import type { SpeechProbabilityModel } from "@voxstudio/duplex-session";
import type { ServerWebSocket } from "bun";
import type { ConversationTool } from "@voxstudio/conversation";
import { connectMcpServers, type McpToolSource } from "@voxstudio/mcp";
import { OpenAiRealtimeConnection } from "./openai-realtime";
import { CaptureLibrary } from "./library";
import { parseCommand, ProtocolError, protocolVersion, type GatewayCommand } from "./protocol";
import { builtinToolNames, GatewaySession, type EventSink } from "./session";

export interface GatewayServerOptions {
  config: VoxConfig;
  fetch?: Fetch;
  /** Defaults to loopback: exposure to a network is a deployment decision (a tunnel), not a default. */
  hostname?: string;
  port?: number;
  /** Optional bearer token required on every request and WebSocket upgrade. */
  token?: string;
  reconnectGraceMs?: number;
  /** OpenAI-dialect connections: how long a client may take to answer a function call. */
  openAiFunctionCallTimeoutMs?: number;
  /** Demo guardrails (docs/public-demo.md): new conversations refused at this many live sessions. */
  maxSessions?: number;
  /** Every session notices and stops at this ceiling. */
  maxSessionSeconds?: number;
  /** Registry writes 403 and MCP servers stay unconnected, regardless of config. */
  demoMode?: boolean;
  /**
   * The capture library (docs/web-studio.md 素材库): every finalized utterance persists
   * here as WAV + SQLite metadata, served at /v1/library. Off by default — retention is
   * an explicit deployment decision, and demo mode keeps it off regardless: an
   * anonymous-ish demo must not retain visitor audio.
   */
  libraryDir?: string;
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
  /** Present when the connection speaks the OpenAI Realtime dialect instead of the native protocol. */
  openai?: OpenAiRealtimeConnection | undefined;
  /** The ?model= the OpenAI-dialect client asked for, captured at upgrade. */
  openaiModel?: string;
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
const voiceIdPattern = /^[A-Za-z0-9._-]{1,64}$/;

function badEngine(reason: string): Response {
  return Response.json({ error: { message: reason, code: "unknown_engine" } }, { status: 400 });
}

function rejection(sessionId: string, reason: string, command?: GatewayCommand): string {
  return JSON.stringify({
    v: protocolVersion,
    sequence: 0,
    sessionId,
    timestampMs: Date.now(),
    type: "command.rejected",
    reason,
    ...(command === undefined ? {} : { commandType: command.type, idempotencyKey: command.idempotencyKey }),
  });
}

export function startGateway(options: GatewayServerOptions): GatewayServer {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const log = options.log ?? (() => {});
  const sessions = new Map<string, GatewaySession>();

  // Demo mode wins over a configured library: hardening a deployment must never quietly
  // start retaining its visitors' audio.
  if (options.libraryDir !== undefined && options.demoMode === true) {
    log("demo mode: the capture library stays off — a demo must not retain visitor audio");
  }
  const library = options.libraryDir !== undefined && options.demoMode !== true
    ? new CaptureLibrary(options.libraryDir)
    : undefined;

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

  const authorized = (request: Request): boolean => {
    if (!options.token) return true;
    const url = new URL(request.url);
    // Browser WebSocket clients cannot set headers; the token may ride the query string.
    if (url.searchParams.get("token") === options.token) return true;
    return request.headers.get("authorization") === `Bearer ${options.token}`;
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

  const proxy = async (request: Request, target: ResolvedEngineConfig, path: string, slot: string): Promise<Response> => {
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

  /** Union voice bank: every TTS instance's registry, entries attributed to their engine. */
  const collectVoices = async (): Promise<{ id: string; engine: string; design_profile?: unknown; prompt_text?: string }[]> => {
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
          .map(entry => ({
            id: entry.id as string,
            engine: name,
            // Design-profile metadata rides along so the studio can show fingerprints
            // and audit against the runtime without a per-voice round trip.
            ...(entry.design_profile === undefined ? {} : { design_profile: entry.design_profile }),
            ...(entry.prompt_text === undefined ? {} : { prompt_text: entry.prompt_text }),
          }));
      } catch (error) {
        // One dead engine must not empty the whole bank; its absence is visible in /v1/engines.
        log(`voices: ${name} unreachable: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));
    return collected.flat();
  };

  const aggregatedVoices = async (): Promise<Response> => Response.json({ voices: await collectVoices() });

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

  const engineList = async (): Promise<Response> => Response.json({ engines: await collectEngines() });

  const sinkFor = (ws: ServerWebSocket<SocketData>): EventSink => {
    // One sink object per socket: attach/detach pair on its identity, so a stale socket's
    // close event can never detach the connection that replaced it.
    ws.data.sink ??= { send: payload => { ws.send(payload); } };
    return ws.data.sink;
  };

  // MCP servers connect once per gateway process (docs/mcp-tools.md); sessions await the
  // connection through the extraTools provider, so startup order costs nothing. Demo mode
  // leaves them unconnected regardless of config — external tools have no business there.
  const mcpSource: Promise<McpToolSource> | undefined =
    options.config.mcpServers.length > 0 && options.demoMode !== true
      ? connectMcpServers(options.config.mcpServers, { log, reservedNames: builtinToolNames })
      : undefined;

  /** Thrown by createSession at the capacity guardrail; both dialects translate it. */
  class CapacityError extends Error {
    constructor() {
      super("session_capacity");
    }
  }

  const createSession = (extraTools: ConversationTool[] = []): GatewaySession => {
    if (options.maxSessions !== undefined && sessions.size >= options.maxSessions) {
      log(`session refused: at the ${options.maxSessions}-session capacity`);
      throw new CapacityError();
    }
    const session = new GatewaySession({
      config: options.config,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.pcmDecoder === undefined ? {} : { pcmDecoder: options.pcmDecoder }),
      // The session tools see the same sanitized surfaces the facade serves.
      listVoices: async () => (await collectVoices()).map(voice => ({ id: voice.id, engine: voice.engine })),
      engineStatus: collectEngines,
      extraTools: async () => {
        // Built-ins always win; then the surface's own tools (an OpenAI client owns the
        // function names it declared — an ambient MCP tool must never absorb its calls);
        // MCP tools last. Duplicates keep their first registration.
        const taken = new Set<string>(builtinToolNames);
        const composed: ConversationTool[] = [];
        for (const tool of [...extraTools, ...(mcpSource ? (await mcpSource).tools() : [])]) {
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
            await library.ingest(wav, transcript, session.id);
          } catch (error) {
            log(`library: ingest failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }),
      loadSileroVad: options.loadSileroVad,
      ...(options.reconnectGraceMs === undefined ? {} : { reconnectGraceMs: options.reconnectGraceMs }),
      ...(options.maxSessionSeconds === undefined ? {} : { maxSessionSeconds: options.maxSessionSeconds }),
      onClosed: closed => { sessions.delete(closed.id); },
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    sessions.set(session.id, session);
    return session;
  };

  const handleFirstCommand = (ws: ServerWebSocket<SocketData>, command: GatewayCommand): void => {
    const sink = sinkFor(ws);
    if (command.type === "session.start") {
      let session: GatewaySession;
      try {
        session = createSession();
      } catch (error) {
        sink.send(rejection("", error instanceof CapacityError ? "session_capacity" : "session_unavailable", command));
        return;
      }
      ws.data.session = session;
      session.recordCommand(command);
      void session.start(command.options ?? {}, sink)
        .then(() => {
          session.accept(command);
          session.emit(session.snapshotPayload());
        })
        .catch(error => {
          session.emit({
            type: "command.rejected",
            reason: error instanceof Error ? error.message : String(error),
            commandType: command.type,
            idempotencyKey: command.idempotencyKey,
          });
          ws.data.session = undefined;
          session.stop();
        });
      return;
    }
    if (command.type === "session.attach") {
      const session = sessions.get(command.sessionId);
      if (!session) {
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
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, protocol: protocolVersion, sessions: sessions.size });
      }
      const page = serveStatic(request, url);
      if (page) return page;
      if (!authorized(request)) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/v1/realtime") {
        // Dialect detection (openai-realtime-adapter.md, decision 1): the OpenAI SDKs
        // derive this exact path from their baseURL and always carry ?model= plus a
        // `realtime` WebSocket subprotocol; native clients send neither. The choice must
        // precede the first frame — the OpenAI server speaks first (session.created),
        // the native server never does.
        const subprotocols = (request.headers.get("sec-websocket-protocol") ?? "")
          .split(",").map(entry => entry.trim());
        const openai = url.searchParams.has("model")
          || url.searchParams.get("protocol") === "openai"
          || request.headers.has("openai-beta")
          || subprotocols.includes("realtime");
        const data: SocketData = {
          session: undefined,
          sink: undefined,
          ...(openai ? { openaiModel: url.searchParams.get("model") ?? "voxstudio-realtime" } : {}),
        };
        // Clients that offer subprotocols (the OpenAI SDKs offer `realtime`) get their
        // first choice echoed back by Bun's upgrade; adding it manually here duplicates
        // the header and fails the handshake.
        if (server.upgrade(request, { data })) return undefined;
        return new Response("expected a WebSocket upgrade", { status: 426 });
      }
      if (url.pathname === "/v1/engines") {
        if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
        return engineList();
      }
      // Demo mode (docs/public-demo.md): the registry is read-only — picking voices is
      // the demo, minting or deleting them is not.
      const demoRefusal = (): Response => Response.json(
        { error: { message: "registry writes are disabled in demo mode", code: "demo_mode" } },
        { status: 403 },
      );
      if (url.pathname === "/v1/design-profiles") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        if (options.demoMode === true) return demoRefusal();
        // Zero-shot voice design is an engine capability, not a given.
        const selected = selectEngine(url, "tts", "tts", "design");
        if (selected instanceof Response) return selected;
        return proxy(request, selected[1], url.pathname, selected[0]);
      }
      if (url.pathname === "/v1/voices") {
        if (request.method === "GET") return aggregatedVoices();
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        if (options.demoMode === true) return demoRefusal();
        // Registration needs a registry: route to the clone-capable instance by default.
        const selected = selectEngine(url, "tts", "tts", "clone");
        if (selected instanceof Response) return selected;
        return proxy(request, selected[1], url.pathname, selected[0]);
      }
      if (voiceEntryPattern.test(url.pathname)) {
        if (!["GET", "DELETE"].includes(request.method)) return new Response("method not allowed", { status: 405 });
        if (request.method === "DELETE" && options.demoMode === true) return demoRefusal();
        const selected = selectEngine(url, "tts", "tts", "clone");
        if (selected instanceof Response) return selected;
        return proxy(request, selected[1], url.pathname, selected[0]);
      }
      if (url.pathname === "/v1/library" || url.pathname.startsWith("/v1/library/")) {
        // Absent library = the deployment never opted into retention; the panel reads the
        // structured code and explains instead of erroring.
        if (!library) {
          return Response.json(
            { error: { message: "the capture library is not enabled on this gateway (start with --library DIR)", code: "library_disabled" } },
            { status: 404 },
          );
        }
        // The shutdown window: close() is draining in-flight work; new work must not race it.
        if (library.isClosed) {
          return Response.json(
            { error: { message: "the capture library is shutting down", code: "library_closing" } },
            { status: 503 },
          );
        }
        const notFound = (): Response => Response.json(
          { error: { message: "no such capture", code: "unknown_capture" } },
          { status: 404 },
        );
        if (url.pathname === "/v1/library") {
          if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
          const bounded = (name: string, fallback: number, max: number): number => {
            const parsed = Number(url.searchParams.get(name) ?? fallback);
            return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
          };
          return Response.json(library.list(bounded("limit", 50, 200), bounded("offset", 0, Number.MAX_SAFE_INTEGER)));
        }
        const entry = libraryEntryPattern.exec(url.pathname);
        if (!entry) return new Response("not found", { status: 404 });
        const captureId = entry[1] as string;
        const sub = entry[2];
        if (sub === "/audio") {
          if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
          if (!library.get(captureId)) return notFound();
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
          if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
          return (async (): Promise<Response> => {
            const body = await request.json().catch(() => ({})) as { voice_id?: unknown };
            const voiceId = typeof body.voice_id === "string" ? body.voice_id.trim() : "";
            if (!voiceIdPattern.test(voiceId)) {
              return Response.json({ error: { message: "voice_id must match [A-Za-z0-9._-]{1,64}", code: "bad_voice_id" } }, { status: 400 });
            }
            // The whole flow — validate, engine round-trip, mark — holds the capture's
            // mutation lock: a concurrent delete waits its turn instead of leaving the
            // clone engine holding a voice the library no longer records.
            return library.runExclusive(captureId, async (): Promise<Response> => {
              const capture = library.get(captureId);
              if (!capture) return notFound();
              // A voice sample needs its verbatim text; the correction is the reference.
              const text = (capture.corrected ?? capture.transcript).trim();
              if (text === "") {
                return Response.json(
                  { error: { message: "the capture has no transcript; correct it before promoting", code: "empty_transcript" } },
                  { status: 400 },
                );
              }
              const selected = selectEngine(url, "tts", "tts", "clone");
              if (selected instanceof Response) return selected;
              const [engineName, target] = selected;
              const form = new FormData();
              form.set("id", voiceId);
              form.set("text", text);
              form.set("audio", new File([await Bun.file(library.audioPath(captureId)).bytes()], `${captureId}.wav`, { type: "audio/wav" }));
              const headers = new Headers();
              if (target.apiKey) headers.set("authorization", `Bearer ${target.apiKey}`);
              let upstream: Response;
              try {
                upstream = await fetchImpl(new URL("/v1/voices", target.baseUrl), { method: "POST", headers, body: form });
              } catch (error) {
                log(`library: promote to ${engineName} unreachable: ${error instanceof Error ? error.message : String(error)}`);
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
              const updated = await library.correct(captureId, body.corrected as string | null);
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
              return (await library.remove(captureId)) ? Response.json({ deleted: true }) : notFound();
            } catch (error) {
              if (error instanceof Error && error.message.includes("closed")) return closing();
              throw error;
            }
          })();
        }
        if (request.method === "GET") {
          const capture = library.get(captureId);
          return capture ? Response.json(capture) : notFound();
        }
        return new Response("method not allowed", { status: 405 });
      }
      const route = facadeRoutes[url.pathname];
      if (route) {
        if (!route.methods.includes(request.method)) return new Response("method not allowed", { status: 405 });
        const selected = selectEngine(url, route.kind, route.role);
        if (selected instanceof Response) return selected;
        return proxy(request, selected[1], url.pathname, selected[0]);
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.openaiModel === undefined) return;
        ws.data.openai = new OpenAiRealtimeConnection({
          send: text => { ws.send(text); },
          close: () => { ws.close(); },
          createSession: extraTools => createSession(extraTools),
          reservedToolNames: builtinToolNames,
          model: ws.data.openaiModel,
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
        const session = ws.data.session;
        if (session) session.handleCommand(command);
        else handleFirstCommand(ws, command);
      },
      close(ws) {
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
    },
  };
}
