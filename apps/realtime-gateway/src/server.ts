import type { Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";
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
  log?: (line: string) => void;
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
const facadeRoutes: Record<string, { slot: string; methods: string[] }> = {
  "/v1/audio/speech": { slot: "tts", methods: ["POST"] },
  "/v1/audio/transcriptions": { slot: "asr", methods: ["POST"] },
  "/v1/chat/completions": { slot: "llm", methods: ["POST"] },
  "/v1/voices": { slot: "tts", methods: ["GET", "POST"] },
};

/** Voice registry entries: /v1/voices/{id} on the TTS engine (list/create live above). */
const voiceEntryPattern = /^\/v1\/voices\/[A-Za-z0-9._-]{1,64}$/;

function facadeRoute(pathname: string): { slot: string; methods: string[] } | undefined {
  const exact = facadeRoutes[pathname];
  if (exact) return exact;
  if (voiceEntryPattern.test(pathname)) return { slot: "tts", methods: ["GET", "DELETE"] };
  return undefined;
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

  const authorized = (request: Request): boolean => {
    if (!options.token) return true;
    const url = new URL(request.url);
    // Browser WebSocket clients cannot set headers; the token may ride the query string.
    if (url.searchParams.get("token") === options.token) return true;
    return request.headers.get("authorization") === `Bearer ${options.token}`;
  };

  const proxy = async (request: Request, slot: string, path: string): Promise<Response> => {
    const target = engine(options.config, slot);
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
      if (!authorized(request)) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/v1/realtime") {
        const data: SocketData = { session: undefined, sink: undefined };
        if (server.upgrade(request, { data })) return undefined;
        return new Response("expected a WebSocket upgrade", { status: 426 });
      }
      const route = facadeRoute(url.pathname);
      if (route) {
        if (!route.methods.includes(request.method)) return new Response("method not allowed", { status: 405 });
        return proxy(request, route.slot, url.pathname);
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
