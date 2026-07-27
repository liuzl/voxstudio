/**
 * A concurrency gate for synthesis, sized from measurement rather than intuition.
 *
 * Measured against the live TTS engine (2026-07-27, 8 requests per level):
 *
 * ```text
 *   concurrency 1 → 0.64 req/s, median 1607ms, slowest 1702ms
 *   concurrency 2 → 0.71 req/s, median 2631ms, slowest 3017ms
 *   concurrency 4 → 0.72 req/s, median 4107ms, slowest 5560ms
 *   concurrency 8 → 0.71 req/s, median 7409ms, slowest 11283ms
 * ```
 *
 * Throughput is flat from two onward while latency grows linearly: the GPU serializes,
 * and extra concurrency buys queueing, not work. Two conclusions follow, and they are the
 * whole design:
 *
 * 1. **Admit few.** Past a small number in flight, every additional request makes
 *    everyone slower and finishes nothing sooner.
 * 2. **Queue shallowly, then refuse.** A request tenth in line waits past most clients'
 *    timeouts; holding its socket helps nobody. A 429 with an honest delay lets a caller
 *    decide, and lets an agent honour `Retry-After` as the contract already tells it to.
 *
 * The delay is not invented: it comes from how long recent syntheses actually took.
 */

export interface SynthesisGateOptions {
  /** Requests allowed to reach the engine at once. */
  maxInFlight: number;
  /** Requests allowed to wait for a slot. Beyond this, callers are refused. */
  maxQueued: number;
  /** Seconds assumed per request before anything has completed. */
  initialSeconds?: number;
}

/** Thrown when the queue is full; carries the wait the caller should honour. */
export class SynthesisBusyError extends Error {
  readonly code = "synthesis_busy";
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`synthesis is saturated — retry in ${retryAfterSeconds}s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class SynthesisGate {
  readonly maxInFlight: number;
  readonly maxQueued: number;
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];
  /** Exponentially weighted mean of recent durations, in seconds. */
  private meanSeconds: number;

  constructor(options: SynthesisGateOptions) {
    if (!Number.isInteger(options.maxInFlight) || options.maxInFlight <= 0) {
      throw new TypeError("synthesis gate: maxInFlight must be a positive integer");
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new TypeError("synthesis gate: maxQueued must be a non-negative integer");
    }
    this.maxInFlight = options.maxInFlight;
    this.maxQueued = options.maxQueued;
    this.meanSeconds = options.initialSeconds ?? 2;
  }

  /** What a caller arriving now would wait for, in whole seconds, at least one. */
  private estimatedWaitSeconds(): number {
    const ahead = Math.max(0, this.inFlight - this.maxInFlight) + this.waiting.length + 1;
    return Math.max(1, Math.ceil(ahead / this.maxInFlight * this.meanSeconds));
  }

  /**
   * Run `work` inside a slot. Waits for one when the queue has room; refuses with
   * `SynthesisBusyError` when it does not. The slot is released however `work` ends, so a
   * failing engine cannot leak capacity.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxInFlight) {
      if (this.waiting.length >= this.maxQueued) throw new SynthesisBusyError(this.estimatedWaitSeconds());
      await new Promise<void>(resolve => { this.waiting.push(resolve); });
    }
    this.inFlight += 1;
    const started = Date.now();
    try {
      return await work();
    } finally {
      const seconds = (Date.now() - started) / 1_000;
      // Recent behaviour dominates, so the delay tracks the engine as it is now.
      this.meanSeconds = this.meanSeconds * 0.7 + seconds * 0.3;
      this.inFlight -= 1;
      this.waiting.shift()?.();
    }
  }

  /** Observable state, for tests and for a health surface that may want it later. */
  get depth(): { inFlight: number; queued: number; meanSeconds: number } {
    return { inFlight: this.inFlight, queued: this.waiting.length, meanSeconds: Number(this.meanSeconds.toFixed(2)) };
  }
}
