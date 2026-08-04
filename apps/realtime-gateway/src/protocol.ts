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

export type MediaPlaybackCodec = "pcm_s16le" | "opus" | "pcm_f32le";

export interface MediaPlaybackConfiguration {
  codec: MediaPlaybackCodec;
  sampleRate: number;
  channels: 1;
  packetDurationMs: number;
}

export interface MediaV2Offer {
  version: 2;
  /** Ordered client decode capabilities; the gateway confirms one exact configuration. */
  playback: readonly MediaPlaybackConfiguration[];
}

export interface SessionStartOptions {
  /** Saved Agent id. Ordinary callers resolve its latest immutable published version. */
  agent?: string;
  /** Builder preview may explicitly select the current draft; default is published. */
  agentSource?: "draft" | "published";
  /** Expected draft revision when agentSource is draft. */
  agentRevision?: number;
  /** Exact immutable version; absent means the latest published pointer. */
  agentVersion?: number;
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
   * Register the Studio tools (docs/voice-studio-control.md) for this session. Honored
   * only when the gateway allows it — demo mode never does.
   */
  studioTools?: boolean;
  /** Spoken once at session start, before any user speech; interruptible like any reply. */
  welcome?: string;
  /** After a completed exchange, this much silence earns one spoken follow-up. */
  nudgeAfterSeconds?: number;
  /**
   * The endpoint owns the audible-playback clock: after the last piece of a reply is sent,
   * the turn stays `speaking` until the client's `playback.complete` for that turn (or a
   * duration-derived timeout). Without it the gateway completes when the last piece is
   * sent — and speech during the still-audible tail would open a fresh turn beside the
   * playing reply instead of barging in. Default false.
   */
  playbackAck?: boolean;
  /**
   * Emit metadata-only media diagnostics for this session. No audio bytes or transcript
   * content are included; protocol-v1 PCM remains unchanged on the wire.
   */
  mediaTelemetry?: boolean;
  /** Explicit opt-in to framed Media v2; absent keeps the legacy raw-f32 binary wire. */
  media?: MediaV2Offer;
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
  | (CommandBase & { type: "media.ping"; clientSentAtMs: number })
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
  | ({
      type: "media.frame";
      frameId: number;
      turnId: string;
      revision: number;
      codec: MediaPlaybackCodec;
      sampleRate: number;
      channels: 1;
      bytes: number;
      audioMs: number;
      producedAtMs: number;
      enqueuedAtMs: number;
    } & ({
      codec: "pcm_f32le";
      streamId?: never;
      mediaSequence?: never;
      timestampSamples?: never;
    } | {
      codec: "pcm_s16le" | "opus";
      streamId: string;
      mediaSequence: number;
      timestampSamples: number;
    }))
  | { type: "media.config"; version: 2; playback: MediaPlaybackConfiguration }
  | {
      type: "playback.start";
      turnId: string;
      revision: number;
      streamId: string;
      codec: MediaPlaybackCodec;
      sampleRate: number;
      channels: 1;
      packetDurationMs: number;
    }
  | { type: "playback.end"; turnId: string; revision: number; streamId: string; totalSamples: number }
  | {
      type: "media.socket";
      frameId: number;
      submittedAtMs: number;
      sendResult?: number;
      bufferedBytes?: number;
      highWaterBytes: number;
      /** Application media still waiting behind this submission, excluding Bun's buffer. */
      queuedBytes: number;
      queuedAudioMs: number;
      backpressured: boolean;
      dropped: boolean;
      discardReason?: "stale_rendition" | "network_congested" | "detached";
    }
  | {
      type: "media.socket.drain";
      startedAtMs: number;
      drainedAtMs: number;
      durationMs: number;
      highWaterBytes: number;
    }
  | {
      type: "media.rendition";
      turnId: string;
      revision: number;
      status: "completed" | "interrupted";
      frames: number;
      audioMs: number;
      staleFramesDiscarded: number;
      endedAtMs: number;
    }
  | {
      type: "media.pong";
      clientSentAtMs: number;
      serverReceivedAtMs: number;
      serverSentAtMs: number;
    }
  | { type: "session.snapshot"; state: DuplexState; currentTurnId?: string; lastSequence: number }
  | { type: "tool.call"; turnId: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool.result"; turnId: string; name: string; ok: boolean; result?: unknown }
  | { type: "tool.pending"; turnId: string; name: string; arguments: Record<string, unknown> }
  | { type: "studio.take"; text: string; voice?: string }
  | {
      type: "session.notice";
      message: string;
      /** Set when the notice is a refusal the client can act on (a spent quota). */
      code?: string;
      retryAfterSeconds?: number;
    }
  | { type: "command.accepted"; commandType: GatewayCommandType; idempotencyKey: string }
  | { type: "command.duplicate"; commandType: GatewayCommandType; idempotencyKey: string }
  | {
      type: "command.rejected";
      reason: string;
      commandType?: GatewayCommandType;
      idempotencyKey?: string;
      /** Present when the refusal is one the client can wait out (a spent quota). */
      retryAfterSeconds?: number;
      requestId?: string;
    }
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

function parseMediaOffer(value: unknown): MediaV2Offer | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ProtocolError("media must be an object");
  if (value.version !== 2) throw new ProtocolError(`unsupported media version ${String(value.version)}`);
  if (!Array.isArray(value.playback) || value.playback.length === 0 || value.playback.length > 8) {
    throw new ProtocolError("media.playback must contain between 1 and 8 configurations");
  }
  const playback = value.playback.map((entry, index): MediaPlaybackConfiguration => {
    if (!isRecord(entry)) throw new ProtocolError(`media.playback[${index}] must be an object`);
    const codec = optionalChoice(entry, "codec", ["pcm_s16le", "opus", "pcm_f32le"] as const);
    const sampleRate = optionalNumber(entry, "sampleRate");
    const packetDurationMs = optionalNumber(entry, "packetDurationMs");
    if (codec === undefined) throw new ProtocolError(`media.playback[${index}].codec is required`);
    if (sampleRate === undefined || !Number.isInteger(sampleRate) || sampleRate === 0 || sampleRate > 192_000) {
      throw new ProtocolError(`media.playback[${index}].sampleRate must be an integer between 1 and 192000`);
    }
    if (entry.channels !== 1) throw new ProtocolError(`media.playback[${index}].channels must be 1`);
    if (packetDurationMs === undefined || !Number.isInteger(packetDurationMs)
        || packetDurationMs === 0 || packetDurationMs > 240) {
      throw new ProtocolError(`media.playback[${index}].packetDurationMs must be an integer between 1 and 240`);
    }
    return { codec, sampleRate, channels: 1, packetDurationMs };
  });
  return { version: 2, playback };
}

function parseStartOptions(value: unknown): SessionStartOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ProtocolError("options must be an object");
  const bargeIn = value.bargeIn;
  if (bargeIn !== undefined && typeof bargeIn !== "boolean") throw new ProtocolError("bargeIn must be a boolean");
  const playbackAck = value.playbackAck;
  if (playbackAck !== undefined && typeof playbackAck !== "boolean") throw new ProtocolError("playbackAck must be a boolean");
  const mediaTelemetry = value.mediaTelemetry;
  if (mediaTelemetry !== undefined && typeof mediaTelemetry !== "boolean") throw new ProtocolError("mediaTelemetry must be a boolean");
  const media = parseMediaOffer(value.media);
  const studioTools = value.studioTools;
  if (studioTools !== undefined && typeof studioTools !== "boolean") throw new ProtocolError("studioTools must be a boolean");
  const maxTokens = optionalNumber(value, "maxTokens");
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens === 0)) {
    throw new ProtocolError("maxTokens must be a positive integer");
  }
  const options: SessionStartOptions = {};
  const agent = optionalString(value, "agent");
  const agentSource = optionalChoice(value, "agentSource", ["draft", "published"] as const);
  const agentRevision = optionalNumber(value, "agentRevision");
  const agentVersion = optionalNumber(value, "agentVersion");
  if (agentRevision !== undefined && (!Number.isInteger(agentRevision) || agentRevision === 0)) {
    throw new ProtocolError("agentRevision must be a positive integer");
  }
  if (agentVersion !== undefined && (!Number.isInteger(agentVersion) || agentVersion === 0)) {
    throw new ProtocolError("agentVersion must be a positive integer");
  }
  if (agent === undefined && (agentSource !== undefined || agentRevision !== undefined || agentVersion !== undefined)) {
    throw new ProtocolError("agentSource, agentRevision, and agentVersion require agent");
  }
  if (agentSource === "draft" && agentVersion !== undefined) {
    throw new ProtocolError("agentVersion cannot be used with a draft Agent");
  }
  if (agentSource === "draft" && agentRevision === undefined) {
    throw new ProtocolError("agentRevision is required with agentSource draft");
  }
  if (agentSource !== "draft" && agentRevision !== undefined) {
    throw new ProtocolError("agentRevision requires agentSource draft");
  }
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
  const welcome = optionalString(value, "welcome");
  const nudgeAfterSeconds = optionalNumber(value, "nudgeAfterSeconds");
  if (agent !== undefined) options.agent = agent;
  if (agentSource !== undefined) options.agentSource = agentSource;
  if (agentRevision !== undefined) options.agentRevision = agentRevision;
  if (agentVersion !== undefined) options.agentVersion = agentVersion;
  if (language !== undefined) options.language = language;
  if (system !== undefined) options.system = system;
  if (asrEngine !== undefined) options.asrEngine = asrEngine;
  if (llmEngine !== undefined) options.llmEngine = llmEngine;
  if (ttsEngine !== undefined) options.ttsEngine = ttsEngine;
  if (maxTokens !== undefined) options.maxTokens = maxTokens;
  if (voice !== undefined) options.voice = voice;
  if (bargeIn !== undefined) options.bargeIn = bargeIn;
  if (playbackAck !== undefined) options.playbackAck = playbackAck;
  if (mediaTelemetry !== undefined) options.mediaTelemetry = mediaTelemetry;
  if (media !== undefined) options.media = media;
  if (studioTools !== undefined) options.studioTools = studioTools;
  if (turnTaking !== undefined) options.turnTaking = turnTaking;
  if (reopenMs !== undefined) options.reopenMs = reopenMs;
  if (vad !== undefined) options.vad = vad;
  if (threshold !== undefined) options.threshold = threshold;
  if (silenceMs !== undefined) options.silenceMs = silenceMs;
  if (minSpeechMs !== undefined) options.minSpeechMs = minSpeechMs;
  if (welcome !== undefined) options.welcome = welcome;
  if (nudgeAfterSeconds !== undefined) options.nudgeAfterSeconds = nudgeAfterSeconds;
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
    case "media.ping": {
      const clientSentAtMs = value.clientSentAtMs;
      if (typeof clientSentAtMs !== "number" || !Number.isFinite(clientSentAtMs) || clientSentAtMs < 0) {
        throw new ProtocolError("clientSentAtMs must be a non-negative number");
      }
      return { v: protocolVersion, type, idempotencyKey, clientSentAtMs };
    }
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
