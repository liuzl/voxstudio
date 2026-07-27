import { QuotaLedger } from "../quota";

/**
 * Brute-force limits for the pre-authentication surface (`/v1/auth/*`).
 *
 * The first version delegated to Better Auth's own limiter, which buckets on the client
 * address — and the address comes from `x-forwarded-for`, a header the caller controls.
 * Rotating it defeated the protection entirely (measured: twelve wrong passwords, zero
 * refusals). Trusting that header would require a trusted-proxy configuration, and it
 * would still be the wrong key.
 *
 * There is no authenticated user at sign-in, but there *is* a claimed one: the email in
 * the body. Keying on it targets the actual attack — guessing one account's password —
 * cannot be spoofed, since an attacker must name the account being attacked, and does not
 * punish everyone behind one NAT.
 *
 * Signup is different: no identity at all, and varying the email *is* the attack. An
 * address key does not help there either (rotation is free), so signup gets a coarse
 * deployment-wide ceiling and nothing pretends otherwise. What actually blunts signup
 * flooding is email verification — an unverified account cannot sign in — and, if it
 * becomes a real problem, a challenge at the edge.
 *
 * Only *failed* attempts count against an account's sign-in allowance: the charge is
 * taken up front and given back when the attempt succeeds, so a person typing their own
 * password correctly is never rationed. That also bounds the lockout an attacker can
 * inflict on somebody else's account to one window, and never permanently.
 */
export interface AttemptLimits {
  /** Failed sign-ins per claimed email. */
  signIn: { window: number; max: number };
  /** Password-reset and verification-resend requests per claimed email. */
  perEmail: { window: number; max: number };
  /** Sign-ups accepted deployment-wide. Coarse by design; see the note above. */
  signUp: { window: number; max: number };
  /** A blunt ceiling across the whole auth surface. */
  overall: { window: number; max: number };
}

export const attemptLimitDefaults: AttemptLimits = {
  signIn: { window: 900, max: 10 },
  perEmail: { window: 3_600, max: 5 },
  signUp: { window: 3_600, max: 60 },
  overall: { window: 60, max: 120 },
};

export interface AttemptVerdict {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/** Which limit an auth path draws on, and whether a success gives the charge back. */
type Rule = { ledger: "signIn" | "perEmail" | "signUp"; keyed: "email" | "deployment"; refundOnSuccess: boolean };

const rules: Record<string, Rule> = {
  "/sign-in/email": { ledger: "signIn", keyed: "email", refundOnSuccess: true },
  "/forget-password": { ledger: "perEmail", keyed: "email", refundOnSuccess: false },
  "/reset-password": { ledger: "perEmail", keyed: "email", refundOnSuccess: false },
  "/send-verification-email": { ledger: "perEmail", keyed: "email", refundOnSuccess: false },
  "/sign-up/email": { ledger: "signUp", keyed: "deployment", refundOnSuccess: false },
};

export class AuthAttemptLimiter {
  private readonly ledgers: Record<Rule["ledger"], QuotaLedger>;
  private readonly overall: QuotaLedger;

  constructor(limits: AttemptLimits = attemptLimitDefaults, clock?: () => number) {
    const make = (limit: { window: number; max: number }): QuotaLedger =>
      new QuotaLedger({ operations: limit.max, windowSeconds: limit.window, ...(clock === undefined ? {} : { clock }) });
    this.ledgers = { signIn: make(limits.signIn), perEmail: make(limits.perEmail), signUp: make(limits.signUp) };
    this.overall = make(limits.overall);
  }

  /**
   * Charge an attempt before the auth library sees it. `suffix` is the path below
   * `/v1/auth`; `email` is the claimed address when the body carried one.
   */
  begin(suffix: string, email: string | undefined): AttemptVerdict {
    const ceiling = this.overall.charge("deployment");
    if (!ceiling.allowed) return { allowed: false, ...(ceiling.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: ceiling.retryAfterSeconds }) };
    const rule = rules[suffix];
    if (rule === undefined) return { allowed: true };
    const key = this.keyFor(rule, email);
    // A claimed identity we cannot read falls back to the deployment ceiling alone:
    // refusing outright would turn a malformed body into a denial-of-service lever.
    if (key === undefined) return { allowed: true };
    const verdict = this.ledgers[rule.ledger].charge(key);
    return verdict.allowed
      ? { allowed: true }
      : { allowed: false, ...(verdict.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: verdict.retryAfterSeconds }) };
  }

  /** Give the charge back when the attempt succeeded and the rule only counts failures. */
  settle(suffix: string, email: string | undefined, status: number): void {
    const rule = rules[suffix];
    if (rule === undefined || !rule.refundOnSuccess) return;
    if (status < 200 || status >= 300) return;
    const key = this.keyFor(rule, email);
    if (key !== undefined) this.ledgers[rule.ledger].refund(key);
  }

  private keyFor(rule: Rule, email: string | undefined): string | undefined {
    if (rule.keyed === "deployment") return "deployment";
    const normalized = email?.trim().toLowerCase();
    return normalized === undefined || normalized === "" ? undefined : normalized;
  }
}

/** The claimed email in an auth request body, when there is one. Never throws. */
export async function claimedEmail(request: Request): Promise<string | undefined> {
  if (request.method !== "POST") return undefined;
  try {
    const body = await request.clone().json() as { email?: unknown };
    return typeof body.email === "string" ? body.email : undefined;
  } catch {
    return undefined;
  }
}
