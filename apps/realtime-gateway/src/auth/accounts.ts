import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { getMigrations } from "better-auth/db/migration";
import type { AuthContext } from "./auth-context";

/**
 * Hosted accounts (docs/auth.md phase 3): Better Auth mounted behind the gateway's
 * one identity seam. This module is the only file that imports better-auth, and the
 * server loads it dynamically — a self-hosted deployment without accounts never
 * pays for or ships through this code path.
 *
 * Boundaries that stay configurable, never fabricated: the signing secret arrives
 * from the deployment (env), the public origin likewise, and the verification email
 * leaves through an injected sender. Without a sender, email verification is OFF and
 * said out loud — a public deployment must wire one before launch.
 */
export interface AccountsOptions {
  /** Where auth.db lives. Created if absent; separate from any library dir by design. */
  dir: string;
  /** Better Auth signing secret, >= 32 chars. Comes from the deployment, never a default. */
  secret: string;
  /** The public origin (scheme + host) links are minted against. */
  baseUrl: string;
  /**
   * Delivers the verification email (docs/auth.md phase 3 boundary: no invented email
   * service). Absent: verification is disabled and loudly logged.
   */
  sendVerificationEmail?: ((email: string, url: string) => Promise<void>) | undefined;
  /**
   * Overrides the shipped brute-force limits. Set only to relax them deliberately (a
   * test suite that signs up repeatedly); a deployment should keep the defaults.
   */
  rateLimit?: { window: number; max: number } | undefined;
  log?: (line: string) => void;
}

/**
 * Brute-force protection, stated here rather than inherited from the environment.
 * Better Auth enables its limiter only when NODE_ENV is "production", which made the
 * only unauthenticated write surface — sign-up and sign-in — unprotected everywhere
 * else (adversarial review 2026-07-26). These limits are per client address, applied
 * whatever the environment says.
 *
 * Buckets are keyed on the client address, which behind a tunnel means the forwarded
 * one: a deployment that does not pass the real client IP through puts every visitor in
 * one bucket, and the limits below would then apply to the whole world at once.
 */
const authRateLimitDefaults = {
  /** The blanket allowance across /v1/auth/*. */
  window: 60,
  max: 60,
  customRules: {
    // Password guessing: a human needs a handful of tries, an attacker needs thousands.
    "/sign-in/email": { window: 60, max: 5 },
    // Account creation on a public entrance, bounded without blocking a real signup.
    "/sign-up/email": { window: 3_600, max: 5 },
    "/send-verification-email": { window: 3_600, max: 5 },
    "/forget-password": { window: 3_600, max: 5 },
  },
} as const;

export interface Accounts {
  /** Handles /v1/auth/* — reachable without a resolved identity (login needs none). */
  handler(request: Request): Promise<Response>;
  /** Cookie session or x-api-key header → AuthContext; null means unauthorized. */
  resolve(request: Request): Promise<AuthContext | null>;
  close(): void;
}

export const MIN_SECRET_LENGTH = 32;

/**
 * The API key a request presents, or null for a cookie-only (browser) request. Two
 * accepted forms, one meaning — see the resolve() comment for why Bearer leads.
 */
export function apiKeyFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1] as string;
  }
  const native = request.headers.get("x-api-key");
  return native === null || native === "" ? null : native;
}

export async function startAccounts(options: AccountsOptions): Promise<Accounts> {
  if (options.secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`accounts: the auth secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const log = options.log ?? (() => {});
  mkdirSync(options.dir, { recursive: true });
  const db = new Database(join(options.dir, "auth.db"), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  const sender = options.sendVerificationEmail;
  if (sender === undefined) {
    log("accounts: no verification-email sender configured — email verification is OFF (wire one before any public deployment; docs/auth.md phase 3)");
  }
  const auth = betterAuth({
    database: db,
    secret: options.secret,
    baseURL: options.baseUrl,
    basePath: "/v1/auth",
    // Always on, never inherited from NODE_ENV. An override applies to the sensitive
    // routes too: Better Auth ships its own stricter built-ins for sign-up and sign-in
    // that a blanket `max` cannot raise, so a "relaxed" limiter that did not restate
    // them would silently stay strict.
    rateLimit: options.rateLimit === undefined
      ? { enabled: true, ...authRateLimitDefaults }
      : {
          enabled: true,
          ...options.rateLimit,
          customRules: Object.fromEntries(
            Object.keys(authRateLimitDefaults.customRules).map(route => [route, options.rateLimit as { window: number; max: number }]),
          ),
        },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: sender !== undefined,
    },
    ...(sender === undefined ? {} : {
      emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
          await sender(user.email, url);
        },
      },
    }),
    plugins: [
      // The plugin's own per-key rate limit (10/day) would strangle an agent; usage
      // quotas are product logic (docs/auth.md phase 4), not key-layer defaults.
      apiKey({ rateLimit: { enabled: false } }),
    ],
  });
  // Better Auth owns auth.db's schema end to end; its migrations run on every open
  // and are no-ops once current.
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();

  // Shutdown guard: the gateway stops accepting before closing this, but a request
  // already inside the handler — or one that arrives while a non-settling stop drains —
  // must be refused rather than land on a closed SQLite handle (adversarial review
  // 2026-07-26).
  let closed = false;
  return {
    handler: async request => {
      if (closed) {
        return Response.json(
          { error: { message: "the gateway is shutting down", code: "accounts_closing" } },
          { status: 503 },
        );
      }
      return auth.handler(request);
    },
    resolve: async request => {
      if (closed) return null;
      // The machine door first, and it is explicit: a presented key decides the
      // request, so an agent never silently rides an ambient browser cookie.
      // `Authorization: Bearer <key>` is the contract AI clients and CLIs already
      // speak (docs/auth.md); `x-api-key` is the plugin's native header, kept for
      // clients that prefer it. Both verify the same way.
      const presented = apiKeyFrom(request);
      if (presented !== null) {
        const verified = await auth.api.verifyApiKey({ body: { key: presented } });
        return verified.valid && verified.key !== null
          ? { userId: verified.key.referenceId, via: "apiKey" }
          : null;
      }
      const session = await auth.api.getSession({ headers: request.headers });
      return session === null ? null : { userId: session.user.id, via: "session" };
    },
    close: () => {
      // Idempotent: the drain may race the server stop.
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
