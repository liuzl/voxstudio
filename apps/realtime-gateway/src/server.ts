import type { Fetch, PcmStreamDecoder } from "@voxstudio/clients";
import { engine, engineByCapability, enginesOfKind, roleInstance } from "@voxstudio/config";
import type { EngineKind, ResolvedEngineConfig, VoxConfig } from "@voxstudio/contracts";
import type { SpeechProbabilityModel } from "@voxstudio/duplex-session";
import type { ServerWebSocket } from "bun";
import { parseCommand, ProtocolError, protocolVersion, type GatewayCommand } from "./protocol";
import { GatewaySession, type EventSink } from "./session";

export interface GatewayServerOptions {
  config: VoxConfig;
  fetch?: Fetch;
  /** Defaults to loopback: exposure to a network is a deployment decision (a tunnel), not a default. */
  hostname?: string;
  port?: number;
  /** Optional bearer token required on every request and WebSocket upgrade. */
  token?: string;
  reconnectGraceMs?: number;
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
}

/** Engine endpoints the facade forwards, keyed by public path. The browser sees only these. */
const facadeRoutes: Record<string, { kind: EngineKind; role: string; methods: string[] }> = {
  "/v1/audio/speech": { kind: "tts", role: "tts", methods: ["POST"] },
  "/v1/audio/transcriptions": { kind: "asr", role: "asr", methods: ["POST"] },
  "/v1/chat/completions": { kind: "llm", role: "llm", methods: ["POST"] },
};

/** Voice registry entries: /v1/voices/{id} on the TTS engine (list/create live above). */
const voiceEntryPattern = /^\/v1\/voices\/[A-Za-z0-9._-]{1,64}$/;

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
  const aggregatedVoices = async (): Promise<Response> => {
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
    return Response.json({ voices: collected.flat() });
  };

  /** The registry, sanitized: names, kinds, capabilities, roles, live health — never addresses. */
  const engineList = async (): Promise<Response> => {
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
    return Response.json({ engines });
  };

  const sinkFor = (ws: ServerWebSocket<SocketData>): EventSink => {
    // One sink object per socket: attach/detach pair on its identity, so a stale socket's
    // close event can never detach the connection that replaced it.
    ws.data.sink ??= { send: payload => { ws.send(payload); } };
    return ws.data.sink;
  };

  const handleFirstCommand = (ws: ServerWebSocket<SocketData>, command: GatewayCommand): void => {
    const sink = sinkFor(ws);
    if (command.type === "session.start") {
      const session = new GatewaySession({
        config: options.config,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.pcmDecoder === undefined ? {} : { pcmDecoder: options.pcmDecoder }),
        loadSileroVad: options.loadSileroVad,
        ...(options.reconnectGraceMs === undefined ? {} : { reconnectGraceMs: options.reconnectGraceMs }),
        onClosed: closed => { sessions.delete(closed.id); },
        ...(options.log === undefined ? {} : { log: options.log }),
      });
      sessions.set(session.id, session);
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
        const data: SocketData = { session: undefined, sink: undefined };
        if (server.upgrade(request, { data })) return undefined;
        return new Response("expected a WebSocket upgrade", { status: 426 });
      }
      if (url.pathname === "/v1/engines") {
        if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
        return engineList();
      }
      if (url.pathname === "/v1/design-profiles") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        // Zero-shot voice design is an engine capability, not a given.
        const selected = selectEngine(url, "tts", "tts", "design");
        if (selected instanceof Response) return selected;
        return proxy(request, selected[1], url.pathname, selected[0]);
      }
      if (url.pathname === "/v1/voices") {
        if (request.method === "GET") return aggregatedVoices();
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        // Registration needs a registry: route to the clone-capable instance by default.
        const selected = selectEngine(url, "tts", "tts", "clone");
        if (selected instanceof Response) return selected;
        return proxy(request, selected[1], url.pathname, selected[0]);
      }
      if (voiceEntryPattern.test(url.pathname)) {
        if (!["GET", "DELETE"].includes(request.method)) return new Response("method not allowed", { status: 405 });
        const selected = selectEngine(url, "tts", "tts", "clone");
        if (selected instanceof Response) return selected;
        return proxy(request, selected[1], url.pathname, selected[0]);
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
      message(ws, data) {
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
      await server.stop(true);
    },
  };
}
