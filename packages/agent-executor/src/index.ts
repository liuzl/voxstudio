/**
 * Vox-owned agent boundary. Executor implementations (pi first) stay behind these
 * types so conversation, gateway protocols, and tests never depend on an executor SDK.
 */

export interface AgentInput {
  /** Stable across reconnect/retry; one input is steered into a run at most once. */
  inputId: string;
  text: string;
}

export interface AgentContext {
  runId: string;
  sessionId: string;
  userId: string;
}

export interface ArtifactRef {
  id: string;
  mimeType: string;
  size: number;
  description: string;
}

export type AgentRunState = "running" | "cancelling" | "completed" | "failed" | "cancelled";

export type AgentEventPayload =
  | { type: "run.started" }
  | { type: "run.steered"; inputId: string }
  | { type: "text.delta"; text: string }
  | { type: "text.final"; text: string }
  | { type: "tool.started"; invocationId: string; name: string }
  | { type: "tool.progress"; invocationId: string; summary: string }
  | { type: "tool.completed"; invocationId: string; ok: boolean }
  | { type: "artifact.created"; artifact: ArtifactRef }
  | { type: "run.completed" }
  | { type: "run.cancelled"; reason: string }
  | { type: "run.failed"; code: string; message: string };

export type AgentEvent = AgentEventPayload & {
  runId: string;
  sequence: number;
  timestampMs: number;
};

export interface AgentRun {
  readonly context: AgentContext;
  /** One ordered event stream with exactly one consumer. Fan-out belongs in the gateway. */
  readonly events: AsyncIterable<AgentEvent>;
  readonly state: AgentRunState;
  steer(input: AgentInput): Promise<void>;
  cancel(reason: string): Promise<void>;
  close(): Promise<void>;
}

export interface AgentExecutor {
  start(input: AgentInput, context: AgentContext): AgentRun;
}

export type AgentExecutionState =
  | "idle"
  | "running"
  | "steering"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";
export type AgentSpeechState = "silent" | "speaking";

/**
 * Pure Phase-A ownership model. It deliberately performs no I/O: gateway composition
 * drives real executor and player handles from these checked transitions.
 */
export class AgentLifecycle {
  private executionState: AgentExecutionState = "idle";
  private speechState: AgentSpeechState = "silent";

  get execution(): AgentExecutionState {
    return this.executionState;
  }

  get speech(): AgentSpeechState {
    return this.speechState;
  }

  startExecution(): void {
    this.moveExecution(["idle"], "running");
  }

  startSpeech(): void {
    if (this.executionState !== "running" && this.executionState !== "steering") {
      throw new TypeError(`cannot speak while execution is ${this.executionState}`);
    }
    if (this.speechState !== "silent") throw new TypeError("speech is already active");
    this.speechState = "speaking";
  }

  /** Barge-in owns only the mouth. */
  stopSpeech(): boolean {
    if (this.speechState === "silent") return false;
    this.speechState = "silent";
    return true;
  }

  beginSteering(): void {
    this.moveExecution(["running"], "steering");
  }

  finishSteering(): void {
    this.moveExecution(["steering"], "running");
  }

  requestCancel(): boolean {
    if (this.executionState === "idle" || this.isTerminal()) return false;
    this.speechState = "silent";
    this.moveExecution(["running", "steering"], "cancelling");
    return true;
  }

  finish(state: "completed" | "failed" | "cancelled"): void {
    const allowed: AgentExecutionState[] = state === "cancelled"
      ? ["cancelling"]
      : ["running", "steering"];
    this.moveExecution(allowed, state);
    this.speechState = "silent";
  }

  private isTerminal(): boolean {
    return this.executionState === "completed"
      || this.executionState === "failed"
      || this.executionState === "cancelled";
  }

  private moveExecution(from: AgentExecutionState[], to: AgentExecutionState): void {
    if (!from.includes(this.executionState)) {
      throw new TypeError(`cannot move execution from ${this.executionState} to ${to}`);
    }
    this.executionState = to;
  }
}

export type ToolEffect = "read" | "session" | "external";
export type ToolCapability = "structured" | "filesystem" | "process" | "network";
export type ToolExecutionMode = "in_process" | "brokered" | "sandbox";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export interface NetworkDestination {
  scheme: "http" | "https";
  host: string;
  port: number;
}

export interface ToolResourceLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxMemoryBytes?: number;
  maxProcesses?: number;
  maxWorkspaceBytes?: number;
}

export interface ToolPolicy {
  effect: ToolEffect;
  mode: ToolExecutionMode;
  capabilities: readonly ToolCapability[];
  limits: ToolResourceLimits;
  /** Required for sandboxed filesystem/process tools; this is a logical root, not a host path supplied by the model. */
  workspace?: boolean;
  /** Exact scheme/host/port destinations resolved and enforced by the runner. */
  networkAllowlist?: readonly NetworkDestination[];
  /** Secret names resolved by the broker; secret values never enter the request or model context. */
  secretNames?: readonly string[];
  cancellable: boolean;
}

export interface ToolRunRequest {
  invocationId: string;
  runId: string;
  sessionId: string;
  userId: string;
  toolName: string;
  arguments: Record<string, JsonValue>;
  policy: ToolPolicy;
}

export type ToolRunResult =
  | { status: "completed"; output: JsonValue }
  | { status: "failed"; error: string }
  | { status: "cancelled"; reason: string }
  | { status: "outcome_unknown"; error: string };

export interface ToolRunner {
  run(request: ToolRunRequest, signal: AbortSignal): Promise<ToolRunResult>;
  close(options?: { deadlineMs?: number }): Promise<{ drained: boolean; pending: number }>;
}

export class ToolPolicyError extends Error {
  constructor(message: string) {
    super(`tool policy: ${message}`);
    this.name = "ToolPolicyError";
  }
}

function positiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new ToolPolicyError(`${name} must be a positive integer`);
  }
}

/** Fail-closed registration validation; model arguments can never widen this policy. */
export function validateToolPolicy(policy: ToolPolicy): void {
  if (policy.capabilities.length === 0) throw new ToolPolicyError("at least one capability is required");
  const capabilities = new Set(policy.capabilities);
  if (capabilities.size !== policy.capabilities.length) throw new ToolPolicyError("capabilities must be unique");
  const hostAuthority = ["filesystem", "process", "network"].some(value =>
    capabilities.has(value as ToolCapability));
  if (policy.mode !== "sandbox" && hostAuthority) {
    throw new ToolPolicyError("filesystem, process, and network capabilities require sandbox mode");
  }
  if (policy.effect === "external" && policy.mode === "in_process") {
    throw new ToolPolicyError("external effects require brokered or sandbox mode");
  }
  if ((capabilities.has("filesystem") || capabilities.has("process")) && policy.workspace !== true) {
    throw new ToolPolicyError("filesystem and process capabilities require an isolated workspace");
  }
  if (capabilities.has("network") && (policy.networkAllowlist?.length ?? 0) === 0) {
    throw new ToolPolicyError("network capability requires a non-empty destination allowlist");
  }
  if (!capabilities.has("network") && (policy.networkAllowlist?.length ?? 0) > 0) {
    throw new ToolPolicyError("network allowlist requires the network capability");
  }
  const destinations = policy.networkAllowlist ?? [];
  const destinationKeys = new Set<string>();
  for (const destination of destinations) {
    if (destination.scheme !== "http" && destination.scheme !== "https") {
      throw new ToolPolicyError(`unsupported network scheme ${String(destination.scheme)}`);
    }
    const host = normalizeNetworkHost(destination.host);
    if (!host || host.includes("*") || host.includes("/") || host.includes("@")) {
      throw new ToolPolicyError(`invalid network host ${destination.host}`);
    }
    if (isPrivateHostLiteral(host)) throw new ToolPolicyError(`private network host ${destination.host} is not allowed`);
    positiveInteger(destination.port, "network destination port");
    if (destination.port > 65_535) throw new ToolPolicyError("network destination port must be at most 65535");
    const key = `${destination.scheme}://${host}:${destination.port}`;
    if (destinationKeys.has(key)) throw new ToolPolicyError("network destinations must be unique");
    destinationKeys.add(key);
  }
  const secrets = policy.secretNames ?? [];
  if (new Set(secrets).size !== secrets.length) throw new ToolPolicyError("secret names must be unique");
  for (const name of secrets) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new ToolPolicyError(`invalid secret name ${name}`);
    }
  }
  if (policy.mode === "in_process" && secrets.length > 0) {
    throw new ToolPolicyError("scoped secrets require brokered or sandbox mode");
  }
  positiveInteger(policy.limits.timeoutMs, "timeoutMs");
  positiveInteger(policy.limits.maxOutputBytes, "maxOutputBytes");
  positiveInteger(policy.limits.maxMemoryBytes, "maxMemoryBytes");
  positiveInteger(policy.limits.maxProcesses, "maxProcesses");
  positiveInteger(policy.limits.maxWorkspaceBytes, "maxWorkspaceBytes");
}

function isPrivateHostLiteral(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match) return isPrivateIpv4(match.slice(1).map(Number), host);
  if (!host.includes(":")) return false;
  const embeddedIpv4 = /(?:^|:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (embeddedIpv4 && isPrivateIpv4(embeddedIpv4.slice(1).map(Number), host)) return true;
  const groups = parseIpv6(host);
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  const allZero = groups.every(value => value === 0);
  const loopback = groups.slice(0, 7).every(value => value === 0) && groups[7] === 1;
  const mappedIpv4 = groups.slice(0, 5).every(value => value === 0) && groups[5] === 0xffff;
  if (mappedIpv4) {
    return isPrivateIpv4([
      (groups[6]! >> 8) & 0xff, groups[6]! & 0xff,
      (groups[7]! >> 8) & 0xff, groups[7]! & 0xff,
    ], host);
  }
  return allZero || loopback || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
    || (first === 0x2001 && second === 0x0db8);
}

function normalizeNetworkHost(rawHost: string): string {
  const trimmed = rawHost.trim().toLowerCase();
  const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (!host || host.includes("*") || host.includes("/") || host.includes("@")
    || host.includes("[") || host.includes("]")) {
    throw new ToolPolicyError(`invalid network host ${rawHost}`);
  }
  if (host.includes(":")) parseIpv6(host);
  const canonicalIpv4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host);
  const ambiguousNumericHost = /^(?:0x[0-9a-f]+|0[0-7]+|\d+)(?:\.(?:0x[0-9a-f]+|0[0-7]+|\d+))*$/i.test(host);
  if (!canonicalIpv4 && ambiguousNumericHost) {
    throw new ToolPolicyError(`ambiguous numeric network host ${rawHost}`);
  }
  return host;
}

function isPrivateIpv4(octets: number[], host: string): boolean {
  if (octets.some(value => !Number.isInteger(value) || value > 255)) {
    throw new ToolPolicyError(`invalid IPv4 host ${host}`);
  }
  const [a = 0, b = 0] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function parseIpv6(host: string): number[] {
  let address = host;
  let ipv4Tail: number[] = [];
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail);
    if (!match) throw new ToolPolicyError(`invalid IPv6 host ${host}`);
    const octets = match.slice(1).map(Number);
    if (octets.some(value => value > 255)) throw new ToolPolicyError(`invalid IPv6 host ${host}`);
    ipv4Tail = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    address = `${address.slice(0, lastColon)}:v4:v4`;
  }
  if ((address.match(/::/g) ?? []).length > 1) throw new ToolPolicyError(`invalid IPv6 host ${host}`);
  const [leftText, rightText] = address.split("::");
  const parseSide = (value: string | undefined): number[] =>
    value ? value.split(":").map(part => {
      if (part === "v4") return ipv4Tail.shift()!;
      if (!/^[0-9a-f]{1,4}$/i.test(part)) throw new ToolPolicyError(`invalid IPv6 host ${host}`);
      return Number.parseInt(part, 16);
    }) : [];
  const left = parseSide(leftText);
  const right = parseSide(rightText);
  if (address.includes("::")) {
    const omitted = 8 - left.length - right.length;
    if (omitted < 1) throw new ToolPolicyError(`invalid IPv6 host ${host}`);
    return [...left, ...Array<number>(omitted).fill(0), ...right];
  }
  if (left.length !== 8) throw new ToolPolicyError(`invalid IPv6 host ${host}`);
  return left;
}

export type FakeToolHandler = (request: ToolRunRequest, signal: AbortSignal) => Promise<ToolRunResult>;

interface FakeDispatch {
  fingerprint: string;
  request: ToolRunRequest;
  controller: AbortController;
  result: Promise<ToolRunResult>;
  work: Promise<void>;
  workSettled: boolean;
}

/**
 * Deterministic runner seam. It models the broker guarantees a gateway integration
 * depends on: scoped idempotency, timeout/output policy, cancellation, and bounded drain.
 */
export class FakeToolRunner implements ToolRunner {
  private readonly dispatched = new Map<string, FakeDispatch>();
  private closed = false;
  /** Test observation only. Requests may contain sensitive arguments and must never be logged. */
  readonly requests: ToolRunRequest[] = [];

  constructor(
    private readonly handler: FakeToolHandler = async () => ({ status: "completed", output: { ok: true } }),
  ) {}

  run(request: ToolRunRequest, signal: AbortSignal): Promise<ToolRunResult> {
    validateToolPolicy(request.policy);
    const key = invocationKey(request);
    const fingerprint = stableSerialize(request);
    const existing = this.dispatched.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve({ status: "failed", error: "invocation identity reused with a different request" });
      }
      return existing.result;
    }
    if (this.closed) return Promise.resolve({ status: "failed", error: "tool runner is closed" });

    const controller = new AbortController();
    const forwardAbort = (): void => {
      if (request.policy.cancellable && !controller.signal.aborted) controller.abort(signal.reason ?? "cancelled");
    };
    signal.addEventListener("abort", forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();

    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort("tool_timeout");
    }, request.policy.limits.timeoutMs);

    const raw = controller.signal.aborted
      ? Promise.resolve(normalizeToolResult(
          abortToolResult(request.policy, controller.signal.reason),
          request.policy.limits.maxOutputBytes,
        ))
      : Promise.resolve()
          .then(() => this.handler(request, controller.signal))
          .catch(() => ({ status: "failed", error: "handler failure" } as ToolRunResult))
          .then(result => normalizeToolResult(result, request.policy.limits.maxOutputBytes));

    let settleResult!: (result: ToolRunResult) => void;
    let resultSettled = false;
    const result = new Promise<ToolRunResult>(resolve => { settleResult = resolve; });
    const settle = (value: ToolRunResult): void => {
      if (resultSettled) return;
      resultSettled = true;
      settleResult(value);
    };
    const onInternalAbort = (): void => settle(normalizeToolResult(
      abortToolResult(request.policy, controller.signal.reason),
      request.policy.limits.maxOutputBytes,
    ));
    controller.signal.addEventListener("abort", onInternalAbort, { once: true });
    if (controller.signal.aborted) onInternalAbort();
    void raw.then(settle);

    const dispatch: FakeDispatch = {
      fingerprint,
      request,
      controller,
      result,
      work: Promise.resolve(),
      workSettled: false,
    };
    dispatch.work = raw.then(() => {}).finally(() => {
      dispatch.workSettled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", forwardAbort);
      controller.signal.removeEventListener("abort", onInternalAbort);
    });
    this.dispatched.set(key, dispatch);
    this.requests.push(request);
    return result;
  }

  async close(options: { deadlineMs?: number } = {}): Promise<{ drained: boolean; pending: number }> {
    this.closed = true;
    const deadlineMs = options.deadlineMs ?? 1_000;
    positiveInteger(deadlineMs, "close deadlineMs");
    const active = [...this.dispatched.values()].filter(dispatch => !dispatch.workSettled);
    for (const dispatch of active) {
      if (!dispatch.controller.signal.aborted) dispatch.controller.abort("runner_closed");
    }
    if (active.length === 0) return { drained: true, pending: 0 };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(active.map(dispatch => dispatch.work)).then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), deadlineMs); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const pending = active.filter(dispatch => !dispatch.workSettled).length;
    return { drained, pending };
  }
}

function abortToolResult(policy: ToolPolicy, reason: unknown): ToolRunResult {
  const message = String(reason ?? "cancelled");
  if (message === "tool_timeout") {
    return policy.effect === "external"
      ? { status: "outcome_unknown", error: "tool timed out; external outcome is unknown" }
      : { status: "failed", error: "tool timed out" };
  }
  if (message === "runner_closed" && policy.effect === "external") {
    return { status: "outcome_unknown", error: "runner closed; external outcome is unknown" };
  }
  return { status: "cancelled", reason: message };
}

function normalizeToolResult(result: ToolRunResult, limit: number): ToolRunResult {
  if (result.status !== "completed") {
    const publicMessage = result.status === "failed" ? "tool_failed"
      : result.status === "cancelled" ? "tool_cancelled" : "tool_outcome_unknown";
    const message = fitUtf8(publicMessage, limit);
    return result.status === "failed" ? { status: "failed", error: message }
      : result.status === "cancelled" ? { status: "cancelled", reason: message }
      : { status: "outcome_unknown", error: message };
  }

  let encoded: string;
  try {
    encoded = stableSerialize(result.output);
  } catch {
    return { status: "failed", error: fitUtf8("tool_output_invalid", limit) };
  }
  if (new TextEncoder().encode(encoded).byteLength > limit) {
    return { status: "failed", error: fitUtf8("tool_output_too_large", limit) };
  }
  return result;
}

function fitUtf8(message: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(message).byteLength <= limit) return message;
  let output = "";
  for (const character of message) {
    if (encoder.encode(output + character).byteLength > limit) break;
    output += character;
  }
  return output;
}

function stableSerialize(value: unknown): string {
  const active = new Set<object>();
  const serialize = (current: unknown): string => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("request must contain only JSON-safe values");
      return JSON.stringify(current);
    }
    if (typeof current !== "object") throw new TypeError("request must contain only JSON-safe values");
    if (active.has(current)) throw new TypeError("request must not contain cyclic values");
    active.add(current);
    try {
      if (Array.isArray(current)) return `[${current.map(serialize).join(",")}]`;
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("request must contain only plain JSON objects");
      }
      const record = current as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
    } finally {
      active.delete(current);
    }
  };
  return serialize(value);
}

export interface InvocationIdentity {
  invocationId: string;
  runId: string;
  sessionId: string;
  userId: string;
}

export type InvocationState =
  | "prepared"
  | "waiting_confirmation"
  | "running"
  | "committed"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

const invocationTerminal = new Set<InvocationState>(["completed", "failed", "cancelled", "outcome_unknown"]);

/**
 * In-memory Phase-B ledger. A durable backend may replace it later, but must preserve
 * these transitions and stable-ID semantics.
 */
export class InvocationLedger {
  private readonly entries = new Map<string, {
    identity: InvocationIdentity;
    effect: ToolEffect;
    requestFingerprint?: string;
    state: InvocationState;
  }>();

  prepare(identity: InvocationIdentity, effect: ToolEffect, requestFingerprint?: string): boolean {
    const key = invocationKey(identity);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.effect !== effect || existing.requestFingerprint !== requestFingerprint) {
        throw new TypeError(`invocation ${identity.invocationId}: identity reused with different policy or request`);
      }
      return false;
    }
    this.entries.set(key, {
      identity,
      effect,
      ...(requestFingerprint === undefined ? {} : { requestFingerprint }),
      state: "prepared",
    });
    return true;
  }

  state(identity: InvocationIdentity): InvocationState | undefined {
    return this.entries.get(invocationKey(identity))?.state;
  }

  waitForConfirmation(identity: InvocationIdentity): void {
    this.transition(identity, ["prepared"], "waiting_confirmation");
  }

  start(identity: InvocationIdentity): void {
    this.transition(identity, ["prepared", "waiting_confirmation"], "running");
  }

  commit(identity: InvocationIdentity): void {
    this.transition(identity, ["running"], "committed");
  }

  cancel(identity: InvocationIdentity): boolean {
    const entry = this.required(identity);
    if (entry.state === "committed" || invocationTerminal.has(entry.state)) return false;
    entry.state = "cancelled";
    return true;
  }

  finish(identity: InvocationIdentity, state: "completed" | "failed" | "outcome_unknown"): void {
    const entry = this.required(identity);
    const allowed: InvocationState[] = entry.effect === "external"
      ? state === "failed" ? ["running", "committed"] : ["committed"]
      : state === "outcome_unknown" ? [] : ["running"];
    this.transition(identity, allowed, state);
  }

  private required(identity: InvocationIdentity): {
    identity: InvocationIdentity;
    effect: ToolEffect;
    requestFingerprint?: string;
    state: InvocationState;
  } {
    const entry = this.entries.get(invocationKey(identity));
    if (!entry) throw new TypeError(`unknown invocation ${identity.invocationId}`);
    return entry;
  }

  private transition(identity: InvocationIdentity, from: InvocationState[], to: InvocationState): void {
    const entry = this.required(identity);
    if (!from.includes(entry.state)) {
      throw new TypeError(`invocation ${identity.invocationId}: cannot move from ${entry.state} to ${to}`);
    }
    entry.state = to;
  }
}

function invocationKey(identity: InvocationIdentity): string {
  for (const [name, value] of Object.entries(identity)) {
    if (!value) throw new TypeError(`${name} is required`);
  }
  return JSON.stringify([identity.userId, identity.sessionId, identity.runId, identity.invocationId]);
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;
  private consumerClaimed = false;

  push(value: T): boolean {
    if (this.ended) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffered.push(value);
    return true;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumerClaimed) throw new TypeError("agent event stream already has a consumer");
    this.consumerClaimed = true;
    return {
      next: async () => {
        const value = this.buffered.shift();
        if (value !== undefined) return { value, done: false };
        if (this.ended) return { value: undefined, done: true };
        return await new Promise<IteratorResult<T>>(resolve => this.waiters.push(resolve));
      },
    };
  }
}

export type ScriptedAgentEventPayload = Exclude<
  AgentEventPayload,
  { type: "run.started" | "run.steered" | "run.completed" | "run.cancelled" | "run.failed" }
>;

/** Deterministic Phase-B test backend; production code may use it for gateway contract tests. */
export class FakeAgentRun implements AgentRun {
  private readonly queue = new AsyncEventQueue<AgentEvent>();
  private readonly seenInputs = new Set<string>();
  private sequence = 0;
  private currentState: AgentRunState = "running";
  readonly steering: AgentInput[] = [];
  readonly events: AsyncIterable<AgentEvent> = this.queue;

  constructor(
    readonly context: AgentContext,
    initial: AgentInput,
    private readonly now: () => number = Date.now,
  ) {
    this.seenInputs.add(initial.inputId);
    this.publish({ type: "run.started" });
  }

  get state(): AgentRunState {
    return this.currentState;
  }

  async steer(input: AgentInput): Promise<void> {
    if (this.currentState !== "running") throw new TypeError(`cannot steer a ${this.currentState} run`);
    if (this.seenInputs.has(input.inputId)) return;
    this.seenInputs.add(input.inputId);
    this.steering.push(input);
    this.publish({ type: "run.steered", inputId: input.inputId });
  }

  async cancel(reason: string): Promise<void> {
    if (this.isTerminal()) return;
    this.currentState = "cancelling";
    this.publish({ type: "run.cancelled", reason });
    this.finish("cancelled");
  }

  async close(): Promise<void> {
    await this.cancel("session_closed");
  }

  /** Script one executor event. Returns false after the run reached a terminal state. */
  emit(payload: ScriptedAgentEventPayload): boolean {
    const type: string = payload.type;
    if (type === "run.started" || type === "run.steered" || type === "run.completed"
      || type === "run.cancelled" || type === "run.failed") {
      throw new TypeError(`terminal/control event ${type} must use the dedicated FakeAgentRun method`);
    }
    return this.publish(payload);
  }

  private publish(payload: AgentEventPayload): boolean {
    if (this.isTerminal()) return false;
    return this.queue.push({
      ...payload,
      runId: this.context.runId,
      sequence: ++this.sequence,
      timestampMs: this.now(),
    });
  }

  complete(): void {
    if (!this.publish({ type: "run.completed" })) return;
    this.finish("completed");
  }

  fail(code: string, message: string): void {
    if (!this.publish({ type: "run.failed", code, message })) return;
    this.finish("failed");
  }

  private finish(state: Extract<AgentRunState, "completed" | "failed" | "cancelled">): void {
    this.currentState = state;
    this.queue.end();
  }

  private isTerminal(): boolean {
    return this.currentState === "completed"
      || this.currentState === "failed"
      || this.currentState === "cancelled";
  }
}

export class FakeAgentExecutor implements AgentExecutor {
  readonly runs: FakeAgentRun[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  start(input: AgentInput, context: AgentContext): FakeAgentRun {
    if (this.runs.some(run => run.context.runId === context.runId)) {
      throw new TypeError(`duplicate run id ${context.runId}`);
    }
    const run = new FakeAgentRun(context, input, this.now);
    this.runs.push(run);
    return run;
  }
}
