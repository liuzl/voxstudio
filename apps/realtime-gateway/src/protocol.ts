import type { DuplexEventPayload, DuplexSessionSnapshot, DuplexState } from "@voxstudio/duplex-session";

/**
 * Version 1 of the realtime session protocol from docs/duplex-audio-architecture.md.
 *
 * Control travels as JSON text frames; media travels as binary frames, never base64 JSON.
 * Client binary frames are mono float32 PCM at 16kHz — the gateway stamps timestamps
 * server-side from the sample count, so clients send raw samples. Server binary frames are
 * mono float32 reply audio whose sample rate is announced by the preceding
 * `playback.format` event.
 *
 * Every server event carries a monotonic `sequence`, the `sessionId`, and the schema
 * version. Every client command carries an `idempotencyKey`: a replayed command is
 * acknowledged (`command.duplicate`) but never re-executed, and turn-scoped commands
 * naming a superseded turn are rejected as stale — together, the reconnect rule that a
 * client must not replay stale commands is enforced server-side rather than trusted.
 */
export const protocolVersion = 1;

export interface SessionStartOptions {
  language?: string;
  system?: string;
  maxTokens?: number;
  voice?: string;
  /** Speech may interrupt playback. Enable only on an echo-cancelled endpoint. Default false. */
  bargeIn?: boolean;
  turnTaking?: "conservative" | "speculative";
  reopenMs?: number;
  vad?: "energy" | "silero";
  threshold?: number;
  silenceMs?: number;
  minSpeechMs?: number;
  /** Engine instance overrides (see /v1/engines); unset means the configured role default. */
  asrEngine?: string;
  llmEngine?: string;
  ttsEngine?: string;
  /**
   * The endpoint owns the audible-playback clock: after the last piece of a reply is sent,
   * the turn stays `speaking` until the client's `playback.complete` for that turn (or a
   * duration-derived timeout). Without it the gateway completes when the last piece is
   * sent — and speech during the still-audible tail would open a fresh turn beside the
   * playing reply instead of barging in. Default false.
   */
  playbackAck?: boolean;
}

interface CommandBase {
  v: typeof protocolVersion;
  idempotencyKey: string;
}

export type GatewayCommand =
  | (CommandBase & { type: "session.start"; options?: SessionStartOptions })
  | (CommandBase & { type: "session.attach"; sessionId: string })
  | (CommandBase & { type: "session.snapshot.request" })
  | (CommandBase & { type: "turn.interrupt"; turnId: string })
  | (CommandBase & { type: "playback.complete"; turnId: string })
  | (CommandBase & { type: "session.stop" });

export type GatewayCommandType = GatewayCommand["type"];

export type GatewayEventPayload =
  | DuplexEventPayload
  | { type: "transcript.final"; turnId: string; revision: number; text: string }
  | { type: "response.text.delta"; turnId: string; revision: number; text: string }
  | { type: "response.text.final"; turnId: string; revision: number; text: string }
  | { type: "playback.format"; turnId: string; revision: number; sampleRate: number }
  | { type: "playback.ended"; turnId: string }
  | { type: "playback.interrupted"; turnId: string }
  | { type: "session.snapshot"; state: DuplexState; currentTurnId?: string; lastSequence: number }
  | { type: "tool.call"; turnId: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool.result"; turnId: string; name: string; ok: boolean; result?: unknown }
  | { type: "tool.pending"; turnId: string; name: string; arguments: Record<string, unknown> }
  | { type: "session.notice"; message: string }
  | { type: "command.accepted"; commandType: GatewayCommandType; idempotencyKey: string }
  | { type: "command.duplicate"; commandType: GatewayCommandType; idempotencyKey: string }
  | { type: "command.rejected"; reason: string; commandType?: GatewayCommandType; idempotencyKey?: string }
  | { type: "error"; code: string; message: string; recoverable: boolean; turnId?: string };

export type GatewayEvent = GatewayEventPayload & {
  v: typeof protocolVersion;
  sequence: number;
  sessionId: string;
  timestampMs: number;
};

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ProtocolError(`${key} must be a string`);
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProtocolError(`${key} must be a non-negative number`);
  }
  return value;
}

function optionalChoice<T extends string>(record: Record<string, unknown>, key: string, choices: readonly T[]): T | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new ProtocolError(`${key} must be one of ${choices.join(", ")}`);
  }
  return value as T;
}

function parseStartOptions(value: unknown): SessionStartOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ProtocolError("options must be an object");
  const bargeIn = value.bargeIn;
  if (bargeIn !== undefined && typeof bargeIn !== "boolean") throw new ProtocolError("bargeIn must be a boolean");
  const playbackAck = value.playbackAck;
  if (playbackAck !== undefined && typeof playbackAck !== "boolean") throw new ProtocolError("playbackAck must be a boolean");
  const maxTokens = optionalNumber(value, "maxTokens");
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens === 0)) {
    throw new ProtocolError("maxTokens must be a positive integer");
  }
  const options: SessionStartOptions = {};
  const language = optionalString(value, "language");
  const system = optionalString(value, "system");
  const voice = optionalString(value, "voice");
  const asrEngine = optionalString(value, "asrEngine");
  const llmEngine = optionalString(value, "llmEngine");
  const ttsEngine = optionalString(value, "ttsEngine");
  const turnTaking = optionalChoice(value, "turnTaking", ["conservative", "speculative"] as const);
  const vad = optionalChoice(value, "vad", ["energy", "silero"] as const);
  const reopenMs = optionalNumber(value, "reopenMs");
  const threshold = optionalNumber(value, "threshold");
  const silenceMs = optionalNumber(value, "silenceMs");
  const minSpeechMs = optionalNumber(value, "minSpeechMs");
  if (language !== undefined) options.language = language;
  if (system !== undefined) options.system = system;
  if (asrEngine !== undefined) options.asrEngine = asrEngine;
  if (llmEngine !== undefined) options.llmEngine = llmEngine;
  if (ttsEngine !== undefined) options.ttsEngine = ttsEngine;
  if (maxTokens !== undefined) options.maxTokens = maxTokens;
  if (voice !== undefined) options.voice = voice;
  if (bargeIn !== undefined) options.bargeIn = bargeIn;
  if (playbackAck !== undefined) options.playbackAck = playbackAck;
  if (turnTaking !== undefined) options.turnTaking = turnTaking;
  if (reopenMs !== undefined) options.reopenMs = reopenMs;
  if (vad !== undefined) options.vad = vad;
  if (threshold !== undefined) options.threshold = threshold;
  if (silenceMs !== undefined) options.silenceMs = silenceMs;
  if (minSpeechMs !== undefined) options.minSpeechMs = minSpeechMs;
  return options;
}

export function parseCommand(text: string): GatewayCommand {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("command is not valid JSON");
  }
  if (!isRecord(value)) throw new ProtocolError("command must be a JSON object");
  if (value.v !== protocolVersion) throw new ProtocolError(`unsupported protocol version ${String(value.v)}`);
  const idempotencyKey = value.idempotencyKey;
  if (typeof idempotencyKey !== "string" || !idempotencyKey) {
    throw new ProtocolError("idempotencyKey must be a non-empty string");
  }
  const type = value.type;
  switch (type) {
    case "session.start":
      return { v: protocolVersion, type, idempotencyKey, options: parseStartOptions(value.options) };
    case "session.attach": {
      const sessionId = value.sessionId;
      if (typeof sessionId !== "string" || !sessionId) throw new ProtocolError("sessionId must be a non-empty string");
      return { v: protocolVersion, type, idempotencyKey, sessionId };
    }
    case "session.snapshot.request":
    case "session.stop":
      return { v: protocolVersion, type, idempotencyKey };
    case "turn.interrupt":
    case "playback.complete": {
      const turnId = value.turnId;
      if (typeof turnId !== "string" || !turnId) throw new ProtocolError("turnId must be a non-empty string");
      return { v: protocolVersion, type, idempotencyKey, turnId };
    }
    default:
      throw new ProtocolError(`unknown command type ${String(type)}`);
  }
}

export function snapshotEvent(snapshot: DuplexSessionSnapshot, lastSequence: number): GatewayEventPayload {
  return {
    type: "session.snapshot",
    state: snapshot.state,
    lastSequence,
    ...(snapshot.currentTurnId === undefined ? {} : { currentTurnId: snapshot.currentTurnId }),
  };
}
