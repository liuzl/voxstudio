import { createHash, timingSafeEqual } from "node:crypto";
import { OWNER_USER_ID, type AuthContext } from "./auth-context";

export interface RequestAuthOptions {
  /** The shared bearer token, when the deployment configured one. */
  token?: string | undefined;
}

/**
 * Constant-time equality: both sides are hashed to a fixed length first, so neither
 * content nor length differences shape the comparison's timing.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

const openAiApiKeyProtocol = "openai-insecure-api-key.";

/**
 * The official OpenAI realtime SDK cannot set an Authorization header on a
 * WebSocket. It carries its API key in an offered subprotocol instead. Read that
 * credential only on the realtime endpoint and only in the SDK's safe ordering:
 * plain `realtime` first, secret-bearing offer later. Bun negotiates the first
 * protocol, so this also keeps the credential out of the response header.
 */
export function openAiRealtimeApiKey(request: Request): string | null {
  if (new URL(request.url).pathname !== "/v1/realtime") return null;
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map(protocol => protocol.trim());
  const offeredIndex = protocols.findIndex(protocol => protocol.startsWith(openAiApiKeyProtocol));
  const realtimeIndex = protocols.indexOf("realtime");
  if (offeredIndex < 0 || realtimeIndex < 0 || realtimeIndex > offeredIndex) return null;
  const offered = protocols[offeredIndex] as string;
  const key = offered.slice(openAiApiKeyProtocol.length);
  return key === "" ? null : key;
}

/**
 * The single place a credential becomes an identity (docs/auth.md phase 1). Without a
 * configured token every caller is the owner; with one, the token may ride the
 * Authorization header or — because browser WebSocket clients cannot set headers —
 * the query string. Null means unauthorized.
 */
export function resolveAuthContext(request: Request, options: RequestAuthOptions): AuthContext | null {
  if (options.token === undefined || options.token === "") {
    return { userId: OWNER_USER_ID, via: "none" };
  }
  const query = new URL(request.url).searchParams.get("token");
  if (query !== null && tokenMatches(query, options.token)) {
    return { userId: OWNER_USER_ID, via: "token" };
  }
  const header = request.headers.get("authorization");
  if (header !== null && tokenMatches(header, `Bearer ${options.token}`)) {
    return { userId: OWNER_USER_ID, via: "token" };
  }
  const openAiKey = openAiRealtimeApiKey(request);
  if (openAiKey !== null && tokenMatches(openAiKey, options.token)) {
    return { userId: OWNER_USER_ID, via: "token" };
  }
  return null;
}

export interface UpgradeOriginOptions {
  /**
   * The exact origins a hosted deployment accepts (scheme + host + port). When present,
   * nothing else passes: no host-only match, no loopback exception.
   */
  allowedOrigins?: readonly string[] | undefined;
  /**
   * Whether the local-development exception applies — a loopback origin (the Vite dev
   * server on another port) may open the socket. True only for a genuinely local
   * deployment: never with hosted accounts, and never on a non-loopback bind
   * (adversarial review 2026-07-26).
   */
  allowLoopback?: boolean;
}

/**
 * Cross-site WebSocket guard (docs/auth.md phase 1). Browsers always send Origin on an
 * upgrade; non-browser clients send none and pass. A hosted deployment matches the full
 * origin against its configured public origin — the scheme is part of identity, and the
 * dev-server convenience below must never travel with a cookie session. A self-hosted
 * gateway keeps the looser host comparison (a tunnel terminates TLS in front, so the
 * browser's scheme legitimately differs from ours) plus the loopback exception.
 */
export function upgradeOriginAllowed(request: Request, options: UpgradeOriginOptions = {}): boolean {
  const raw = request.headers.get("origin");
  if (raw === null) return true;
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    return false;
  }
  if (options.allowedOrigins !== undefined) {
    return options.allowedOrigins.includes(origin.origin);
  }
  if (origin.host === (request.headers.get("host") ?? new URL(request.url).host)) return true;
  if (options.allowLoopback !== true) return false;
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** Whether a bind address is loopback — the precondition for the dev-server exception. */
export function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}
