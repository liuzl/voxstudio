import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { getMigrations } from "better-auth/db/migration";
import type { AuthContext } from "./auth-context";
import { AuthAttemptLimiter, attemptLimitDefaults, claimedEmail, type AttemptLimits } from "./attempt-limiter";
import { openAiRealtimeApiKey } from "./request-auth";

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
  /** Overrides the brute-force limits keyed on the claimed account. Tests relax these. */
  attemptLimits?: AttemptLimits | undefined;
  /**
   * OAuth providers, credentials supplied by the deployment. A provider's address
   * arrives already verified, which is what the verification requirement stands in for,
   * and an account with no password needs no recovery flow (docs/auth.md, the human
   * door). Callbacks land on `<baseUrl>/v1/auth/callback/<provider>`.
   */
  socialProviders?: Record<string, { clientId: string; clientSecret: string }> | undefined;
  /**
   * Whether the email-and-password door is open. Default true — today's behaviour. A
   * public launch should close it and open a provider instead: an abuse floor is only as
   * high as its lowest door, and without a verification sender the password door has none.
   */
  passwordLogin?: boolean | undefined;
  log?: (line: string) => void;
}

/**
 * Better Auth's own limiter, kept enabled as a blunt ceiling and nothing more. Its
 * buckets key on the client address, which arrives in a caller-controlled header — so
 * it can be defeated by rotating one, and it is not where this deployment's brute-force
 * protection lives. That is `AuthAttemptLimiter`, which keys on the claimed account.
 *
 * Left on rather than disabled because it also covers auth routes the gateway does not
 * front, where a coarse ceiling is better than none.
 */
const authRateLimitDefaults = { window: 60, max: 120 } as const;

export interface Accounts {
  /** Which sign-in doors this deployment opens, for the app shell to render. */
  readonly doors: { password: boolean; providers: string[] };
  /** Handles /v1/auth/* — reachable without a resolved identity (login needs none). */
  handler(request: Request): Promise<Response>;
  /** Cookie session or x-api-key header → AuthContext; null means unauthorized. */
  resolve(request: Request): Promise<AuthContext | null>;
  close(): void;
}

export const MIN_SECRET_LENGTH = 32;

/**
 * The API key a request presents, or null for a cookie-only browser request. Bearer
 * and x-api-key cover HTTP; the official OpenAI SDK's subprotocol covers realtime.
 * One credential, one meaning — see resolve() for why Bearer leads.
 */
export function apiKeyFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1] as string;
  }
  const native = request.headers.get("x-api-key");
  if (native !== null && native !== "") return native;
  return openAiRealtimeApiKey(request);
}

export async function startAccounts(options: AccountsOptions): Promise<Accounts> {
  if (options.secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`accounts: the auth secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const log = options.log ?? (() => {});
  mkdirSync(options.dir, { recursive: true });
  const db = new Database(join(options.dir, "auth.db"), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  const providers = options.socialProviders !== undefined && Object.keys(options.socialProviders).length > 0
    ? options.socialProviders
    : undefined;
  const passwordLogin = options.passwordLogin ?? true;
  if (providers === undefined && !passwordLogin) {
    throw new TypeError("accounts: no way to sign in — configure a social provider or leave the password door open");
  }
  const sender = options.sendVerificationEmail;
  // The lowest door sets the floor: a provider beside an unverified password door buys
  // nothing, because the password door is still the way in (docs/auth.md, the human door).
  if (providers !== undefined && passwordLogin && sender === undefined) {
    log("accounts: a social provider is configured beside an unverified password door — the password door is the weakest way in; close it (VOX_AUTH_PASSWORD=off) or wire a verification sender");
  }
  if (sender === undefined && passwordLogin) {
    log("accounts: no verification-email sender configured — email verification is OFF (wire one before any public deployment; docs/auth.md phase 3)");
  }
  const auth = betterAuth({
    database: db,
    secret: options.secret,
    baseURL: options.baseUrl,
    basePath: "/v1/auth",
    // Always on, never inherited from NODE_ENV — but a ceiling, not the protection.
    // Better Auth ships stricter built-ins for sign-up and sign-in that a blanket `max`
    // cannot raise, so the ceiling restates them; the meaningful limits live in
    // AuthAttemptLimiter, keyed on the claimed account rather than a spoofable header.
    rateLimit: {
      enabled: true,
      ...(options.rateLimit ?? authRateLimitDefaults),
      customRules: Object.fromEntries(
        ["/sign-in/email", "/sign-up/email", "/send-verification-email", "/forget-password"]
          .map(route => [route, options.rateLimit ?? authRateLimitDefaults]),
      ),
    },
    emailAndPassword: {
      enabled: passwordLogin,
      requireEmailVerification: sender !== undefined,
    },
    ...(providers === undefined ? {} : { socialProviders: providers }),
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
  const attempts = new AuthAttemptLimiter(options.attemptLimits ?? attemptLimitDefaults);
  return {
    doors: { password: passwordLogin, providers: Object.keys(providers ?? {}) },
    handler: async request => {
      if (closed) {
        return Response.json(
          { error: { message: "the gateway is shutting down", code: "accounts_closing" } },
          { status: 503 },
        );
      }
      // Charged before the library sees it, keyed on the account being attacked; a
      // successful sign-in gives its charge back, so only failures ration anyone.
      const suffix = new URL(request.url).pathname.replace(/^\/v1\/auth/, "");
      const email = await claimedEmail(request);
      const verdict = attempts.begin(suffix, email);
      if (!verdict.allowed) {
        const retryAfterSeconds = verdict.retryAfterSeconds ?? 60;
        log(`auth: ${suffix} refused — too many attempts`);
        return Response.json(
          { error: { message: `too many attempts — retry in ${retryAfterSeconds}s`, code: "too_many_attempts", retryAfterSeconds } },
          { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
        );
      }
      const response = await auth.handler(request);
      attempts.settle(suffix, email, response.status);
      return response;
    },
    resolve: async request => {
      if (closed) return null;
      // The machine door first, and it is explicit: a presented key decides the
      // request, so an agent never silently rides an ambient browser cookie.
      // `Authorization: Bearer <key>` is the contract AI clients and CLIs already
      // speak (docs/auth.md); `x-api-key` is the plugin's native header, and the
      // OpenAI SDK's realtime subprotocol is its WebSocket transport. All verify
      // through the same Better Auth API.
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
