import { describe, expect, test } from "bun:test";
import { QuotaLedger } from "./quota";

describe("quota ledger (docs/auth.md phase 4)", () => {
  test("counts a user's expensive operations and refuses past the allowance", () => {
    let now = 1_000_000;
    const ledger = new QuotaLedger({ operations: 3, windowSeconds: 60, clock: () => now });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(ledger.charge("alice")).toEqual({ allowed: true, remaining: 2 - attempt });
    }
    const refused = ledger.charge("alice");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(60);
    // A refusal is not a charge: being over quota must not extend the wait.
    expect(ledger.charge("alice").retryAfterSeconds).toBe(60);
  });

  test("two users never touch each other's allowance", () => {
    let now = 0;
    const ledger = new QuotaLedger({ operations: 1, windowSeconds: 60, clock: () => now });
    expect(ledger.charge("alice").allowed).toBe(true);
    expect(ledger.charge("alice").allowed).toBe(false);
    // Bob's first call is his own first call.
    expect(ledger.charge("bob")).toEqual({ allowed: true, remaining: 0 });
    expect(ledger.charge("bob").allowed).toBe(false);
  });

  test("the window recovers, and Retry-After counts down inside it", () => {
    let now = 0;
    const ledger = new QuotaLedger({ operations: 2, windowSeconds: 60, clock: () => now });
    expect(ledger.charge("alice").allowed).toBe(true);
    now = 20_000;
    expect(ledger.charge("alice").allowed).toBe(true);
    now = 30_000;
    // The window is anchored at the first charge, so 30s in, 30s remain.
    expect(ledger.charge("alice").retryAfterSeconds).toBe(30);
    now = 59_999;
    // Never zero: a client told to wait 0 seconds retries immediately.
    expect(ledger.charge("alice").retryAfterSeconds).toBe(1);
    now = 60_000;
    expect(ledger.charge("alice")).toEqual({ allowed: true, remaining: 1 });
  });

  test("an exhausted user's entry is reclaimed once its window passes", () => {
    let now = 0;
    const ledger = new QuotaLedger({ operations: 1, windowSeconds: 10, clock: () => now });
    for (let user = 0; user < 50; user += 1) ledger.charge(`user-${user}`);
    expect(ledger.size).toBe(50);
    now = 11_000;
    // The next charge sweeps what expired instead of growing forever.
    ledger.charge("late");
    expect(ledger.size).toBe(1);
  });

  test("a zero or negative allowance is a configuration error, not a silent block", () => {
    expect(() => new QuotaLedger({ operations: 0, windowSeconds: 60 })).toThrow("positive");
    expect(() => new QuotaLedger({ operations: 5, windowSeconds: 0 })).toThrow("positive");
  });
});
