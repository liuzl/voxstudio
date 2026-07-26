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
  log?: (line: string) => void;
}

export interface Accounts {
  /** Handles /v1/auth/* — reachable without a resolved identity (login needs none). */
  handler(request: Request): Promise<Response>;
  /** Cookie session or x-api-key header → AuthContext; null means unauthorized. */
  resolve(request: Request): Promise<AuthContext | null>;
  close(): void;
}

export const MIN_SECRET_LENGTH = 32;

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

  return {
    handler: request => auth.handler(request),
    resolve: async request => {
      // The explicit machine door first: an agent sending a key never depends on
      // cookie state. verifyApiKey also stamps lastRequest/usage bookkeeping.
      const key = request.headers.get("x-api-key");
      if (key !== null) {
        const verified = await auth.api.verifyApiKey({ body: { key } });
        return verified.valid && verified.key !== null
          ? { userId: verified.key.referenceId, via: "apiKey" }
          : null;
      }
      const session = await auth.api.getSession({ headers: request.headers });
      return session === null ? null : { userId: session.user.id, via: "session" };
    },
    close: () => { db.close(); },
  };
}
