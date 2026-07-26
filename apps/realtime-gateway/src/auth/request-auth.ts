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
  return null;
}

/**
 * Cross-site WebSocket guard (docs/auth.md phase 1). Browsers always send Origin on an
 * upgrade; it must be same-origin with the request, or loopback (the Vite dev server
 * fronts the gateway from another loopback port). Non-browser clients send no Origin
 * and pass. Without this, any web page can open a socket against a token-less loopback
 * gateway today — and against a cookie session (phase 3) it would be CSRF.
 */
export function upgradeOriginAllowed(request: Request): boolean {
  const raw = request.headers.get("origin");
  if (raw === null) return true;
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    return false;
  }
  if (origin.host === (request.headers.get("host") ?? new URL(request.url).host)) return true;
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
