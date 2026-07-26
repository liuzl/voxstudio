/**
 * The Studio's account client: a thin typed shell over the gateway's own `/v1/auth/*`
 * endpoints (docs/auth.md phase 3). It holds no auth logic — no token parsing, no
 * password handling, no session bookkeeping. The cookie is set and read by the browser;
 * this module only names endpoints and shapes their answers.
 *
 * Machine clients never come through here: they carry `Authorization: Bearer <key>`.
 * A browser cookie is a browser's business.
 */

/** Which door this deployment serves, from the unauthenticated /healthz probe. */
export type AuthMode = "self" | "accounts";

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  /** The key's visible prefix — enough to recognize it, never enough to use it. */
  start: string;
  createdAt: string;
  lastRequest: string | null;
}

/** Raised with the server's own message so panels can show what actually went wrong. */
export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function refuse(response: Response): Promise<never> {
  let code = "";
  let message = "";
  try {
    const body = await response.json() as { code?: string; message?: string };
    code = body.code ?? "";
    message = body.message ?? "";
  } catch {
    // Non-JSON body: the status carries the whole story.
  }
  throw new AuthError(response.status, code, message || `HTTP ${response.status}`);
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/v1/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Same-origin by construction; the browser attaches the session cookie and the
    // Origin header Better Auth checks on every mutation.
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) await refuse(response);
  return await response.json() as T;
}

/**
 * The deployment's door. Any failure reads as "self": a studio that cannot reach its
 * gateway must not present a login form it has no way to satisfy.
 */
export async function fetchAuthMode(): Promise<AuthMode> {
  try {
    const response = await fetch("/healthz");
    if (!response.ok) return "self";
    const body = await response.json() as { auth?: string };
    return body.auth === "accounts" ? "accounts" : "self";
  } catch {
    return "self";
  }
}

/** The signed-in user, or null when there is no session. Never throws for "no session". */
export async function fetchSession(): Promise<AccountUser | null> {
  const response = await fetch("/v1/auth/get-session");
  if (response.status === 401) return null;
  if (!response.ok) await refuse(response);
  const body = await response.json().catch(() => null) as
    | { user?: { id?: string; email?: string; name?: string; emailVerified?: boolean } }
    | null;
  const user = body?.user;
  if (!user?.id || !user.email) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? "",
    emailVerified: user.emailVerified === true,
  };
}

export async function signUp(email: string, password: string, name?: string): Promise<void> {
  await post("/sign-up/email", { email, password, name: name?.trim() || email.split("@")[0] });
}

export async function signIn(email: string, password: string): Promise<void> {
  await post("/sign-in/email", { email, password });
}

export async function signOut(): Promise<void> {
  await post("/sign-out");
}

/** Ask for another verification link. Only meaningful when a sender is configured. */
export async function resendVerification(email: string): Promise<void> {
  await post("/send-verification-email", { email });
}

export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const response = await fetch("/v1/auth/api-key/list");
  if (!response.ok) await refuse(response);
  const body = await response.json() as {
    apiKeys?: { id?: string; name?: string | null; start?: string | null; createdAt?: string; lastRequest?: string | null }[];
  };
  return (body.apiKeys ?? [])
    .filter(entry => entry.id)
    .map(entry => ({
      id: entry.id as string,
      name: entry.name ?? "",
      start: entry.start ?? "",
      createdAt: entry.createdAt ?? "",
      lastRequest: entry.lastRequest ?? null,
    }));
}

/**
 * Creates a key and returns it. This is the only moment the full key exists outside the
 * database — the caller must show it once and never store it.
 */
export async function createApiKey(name: string): Promise<string> {
  const created = await post<{ key?: string }>("/api-key/create", { name });
  if (!created.key) throw new AuthError(500, "no_key", "the gateway returned no key");
  return created.key;
}

export async function revokeApiKey(keyId: string): Promise<void> {
  await post("/api-key/delete", { keyId });
}
