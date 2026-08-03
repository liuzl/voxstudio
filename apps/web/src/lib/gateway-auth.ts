/**
 * Browser-side transport for the optional self-hosted shared token.
 *
 * The token arrives once in the Studio URL, is removed immediately, and lives only for
 * this browser tab. REST can use the normal Authorization header; the browser WebSocket
 * API cannot, so realtime and direct resource URLs use the gateway's query-token door.
 */

const storageKey = "voxstudio.gateway.token";

type GatewayMode = "self" | "accounts" | "unavailable";

interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface GatewayTokenBootstrapOptions {
  href?: string;
  replaceUrl?(url: string): void;
  storage?: TokenStorage;
}

let token: string | undefined;
let mode: GatewayMode | undefined;
let tokenRequired = false;
let storage: TokenStorage | undefined;

function browserStorage(): TokenStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    // Privacy settings may deny storage. The in-memory token still works for this load.
    return undefined;
  }
}

function storedToken(target: TokenStorage | undefined): string | undefined {
  try {
    const value = target?.getItem(storageKey);
    return value === null || value === undefined || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function persistToken(target: TokenStorage | undefined, value: string | undefined): void {
  try {
    if (value === undefined) target?.removeItem(storageKey);
    else target?.setItem(storageKey, value);
  } catch {
    // Storage is an optimization for reloads, not a prerequisite for this page load.
  }
}

/**
 * Capture `token` from either the query string (backward compatible) or fragment (the
 * preferred link because fragments do not reach HTTP logs), then redact it from the
 * address bar before the application starts making requests.
 */
export function bootstrapGatewayToken(options: GatewayTokenBootstrapOptions = {}): void {
  const href = options.href ?? window.location.href;
  storage = options.storage ?? browserStorage();
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const fragmentToken = fragment.get("token");
  const presented = fragmentToken ?? url.searchParams.get("token");

  if (presented !== null) {
    token = presented === "" ? undefined : presented;
    persistToken(storage, token);
    url.searchParams.delete("token");
    if (fragmentToken !== null) {
      fragment.delete("token");
      url.hash = fragment.size > 0 ? `#${fragment.toString()}` : "";
    }
    const clean = `${url.pathname}${url.search}${url.hash}`;
    const replace = options.replaceUrl ?? (next => window.history.replaceState(window.history.state, "", next));
    replace(clean);
    return;
  }

  token = storedToken(storage);
}

/** Auth discovery runs before the Studio mounts, so a hosted cookie is never mixed with a shared token. */
export function configureGatewayAuth(nextMode: GatewayMode, requiresToken = false): void {
  mode = nextMode;
  tokenRequired = nextMode === "self" && requiresToken;
  if (nextMode !== "unavailable" && !tokenRequired) {
    token = undefined;
    persistToken(storage, undefined);
  }
}

function activeToken(): string | undefined {
  return mode === "self" && tokenRequired ? token : undefined;
}

/** Whether the current tab already holds the credential a protected self-host needs. */
export function hasGatewayToken(): boolean {
  return activeToken() !== undefined;
}

/** Replace the protected self-host credential and retain it only in this browser tab. */
export function setGatewayToken(value: string): void {
  token = value === "" ? undefined : value;
  persistToken(storage, token);
}

/** Forget a rejected credential so reload cannot silently retry it forever. */
export function clearGatewayToken(): void {
  token = undefined;
  persistToken(storage, undefined);
}

function isGatewayRequest(input: RequestInfo | URL): boolean {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (raw.startsWith("/v1/")) return true;
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(raw, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith("/v1/");
  } catch {
    return false;
  }
}

/** Fetch a gateway resource, adding the shared token only to same-origin `/v1/*` calls. */
export function gatewayFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const shared = activeToken();
  if (shared === undefined || !isGatewayRequest(input)) return fetch(input, init);

  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${shared}`);
  return fetch(input, { ...init, headers });
}

/** Direct browser resources such as `<audio src>` cannot attach headers. */
export function gatewayResourceUrl(path: string, href = window.location.href): string {
  const shared = activeToken();
  if (shared === undefined) return path;
  const base = new URL(href);
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith("/v1/")) return path;
  url.searchParams.set("token", shared);
  return path.startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

/** Same-origin realtime URL, using query auth because native browser WebSockets have no header API. */
export function gatewayRealtimeUrl(href = window.location.href): string {
  const url = new URL("/v1/realtime", href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const shared = activeToken();
  if (shared !== undefined) url.searchParams.set("token", shared);
  return url.toString();
}
