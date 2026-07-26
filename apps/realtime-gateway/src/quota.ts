export interface QuotaOptions {
  /** Chargeable operations one account may spend per window. */
  operations: number;
  /** The window's length. Anchored at an account's first charge, not the wall clock. */
  windowSeconds: number;
  /** Injectable for tests; defaults to `Date.now`. */
  clock?: () => number;
}

export interface QuotaVerdict {
  allowed: boolean;
  /** Charges left in the current window, when allowed. */
  remaining?: number;
  /** Whole seconds until the window resets, when refused. Never zero. */
  retryAfterSeconds?: number;
}

/**
 * Per-account usage quota (docs/auth.md phase 4): a fixed window of chargeable
 * operations, counted per `AuthContext.userId`, held in memory.
 *
 * Deliberately not a rate-limiting framework (docs/auth.md non-goals): no buckets, no
 * storage, no billing, no per-route policy. One counter per account, swept when its
 * window passes. State is process-local, so it resets on restart and does not span
 * replicas — honest for a single-process gateway, and the thing to revisit before this
 * runs behind more than one.
 *
 * Only expensive work is charged, and only under hosted accounts; the caller decides
 * what counts (see `chargeable` in server.ts).
 */
export class QuotaLedger {
  readonly operations: number;
  readonly windowSeconds: number;
  private readonly clock: () => number;
  /** userId -> spent count and the epoch millisecond its window ends. */
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(options: QuotaOptions) {
    if (!Number.isInteger(options.operations) || options.operations <= 0) {
      throw new TypeError("quota: the operation allowance must be a positive integer");
    }
    if (!Number.isFinite(options.windowSeconds) || options.windowSeconds <= 0) {
      throw new TypeError("quota: the window must be a positive number of seconds");
    }
    this.operations = options.operations;
    this.windowSeconds = options.windowSeconds;
    this.clock = options.clock ?? Date.now;
  }

  /** Accounts currently holding a window — the sweep's observable effect. */
  get size(): number {
    return this.windows.size;
  }

  /**
   * Charge one operation to `userId`. A refusal is not a charge: being over quota must
   * never push the reset further away.
   */
  charge(userId: string): QuotaVerdict {
    const now = this.clock();
    this.sweep(now);
    const window = this.windows.get(userId);
    if (window === undefined || now >= window.resetAt) {
      this.windows.set(userId, { count: 1, resetAt: now + this.windowSeconds * 1_000 });
      return { allowed: true, remaining: this.operations - 1 };
    }
    if (window.count >= this.operations) {
      // Ceil, floored at 1: a client told to wait zero seconds retries immediately.
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1_000)) };
    }
    window.count += 1;
    return { allowed: true, remaining: this.operations - window.count };
  }

  /** Drop windows that have passed, so an idle account costs nothing to remember. */
  private sweep(now: number): void {
    for (const [userId, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(userId);
    }
  }
}
