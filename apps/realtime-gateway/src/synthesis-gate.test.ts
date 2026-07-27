import { describe, expect, test } from "bun:test";
import { SynthesisBusyError, SynthesisGate } from "./synthesis-gate";

/** A job that finishes when the test says so. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("SynthesisGate", () => {
  test("admits up to the limit and queues the rest", async () => {
    const gate = new SynthesisGate({ maxInFlight: 2, maxQueued: 2 });
    const jobs = [deferred(), deferred(), deferred()];
    const runs = jobs.map(job => gate.run(() => job.promise));
    await Bun.sleep(5);

    // Two reached the engine; the third is waiting, not refused.
    expect(gate.depth.inFlight).toBe(2);
    expect(gate.depth.queued).toBe(1);

    jobs[0]?.resolve();
    await Bun.sleep(5);
    // The waiter took the freed slot.
    expect(gate.depth).toMatchObject({ inFlight: 2, queued: 0 });

    jobs[1]?.resolve();
    jobs[2]?.resolve();
    await Promise.all(runs);
    expect(gate.depth).toMatchObject({ inFlight: 0, queued: 0 });
  });

  test("refuses past the queue with a delay drawn from real durations", async () => {
    const gate = new SynthesisGate({ maxInFlight: 1, maxQueued: 1, initialSeconds: 4 });
    const held = deferred();
    const queued = deferred();
    const running = gate.run(() => held.promise);
    const waiting = gate.run(() => queued.promise);
    await Bun.sleep(5);

    const refused = await gate.run(async () => "never").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SynthesisBusyError);
    expect((refused as SynthesisBusyError).code).toBe("synthesis_busy");
    // One running plus one queued plus this caller, at 4s each.
    expect((refused as SynthesisBusyError).retryAfterSeconds).toBeGreaterThanOrEqual(3);

    held.resolve();
    queued.resolve();
    await Promise.all([running, waiting]);
  });

  test("a failing job releases its slot — a broken engine must not leak capacity", async () => {
    const gate = new SynthesisGate({ maxInFlight: 1, maxQueued: 0 });
    await expect(gate.run(async () => { throw new Error("engine unreachable"); })).rejects.toThrow("unreachable");
    expect(gate.depth.inFlight).toBe(0);
    // The next caller is admitted, not refused by a stuck counter.
    expect(await gate.run(async () => "ok")).toBe("ok");
  });

  test("the estimate follows the engine as it actually behaves", async () => {
    const gate = new SynthesisGate({ maxInFlight: 1, maxQueued: 0, initialSeconds: 10 });
    for (let run = 0; run < 8; run += 1) await gate.run(() => Bun.sleep(20));
    // Started assuming ten seconds; after eight fast jobs it knows better.
    expect(gate.depth.meanSeconds).toBeLessThan(2);
  });

  test("a zero-length queue means refuse immediately rather than wait", async () => {
    const gate = new SynthesisGate({ maxInFlight: 1, maxQueued: 0 });
    const held = deferred();
    const running = gate.run(() => held.promise);
    await Bun.sleep(5);
    await expect(gate.run(async () => "x")).rejects.toBeInstanceOf(SynthesisBusyError);
    held.resolve();
    await running;
  });

  test("nonsense limits are a configuration error", () => {
    expect(() => new SynthesisGate({ maxInFlight: 0, maxQueued: 1 })).toThrow("positive integer");
    expect(() => new SynthesisGate({ maxInFlight: 1, maxQueued: -1 })).toThrow("non-negative");
  });
});
