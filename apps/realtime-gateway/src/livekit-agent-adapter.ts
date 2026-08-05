import type { AgentSpec } from "@voxstudio/agents";
import { encodePcm16, LinearResampler } from "@voxstudio/audio";
import type { TraceAgentIdentity } from "./trace-store";
import { issueLiveKitAgentToken, type LiveKitBootstrapOptions } from "./livekit-bootstrap";
import { parseCommand, protocolVersion, type SessionStartOptions } from "./protocol";
import type { EventSink, GatewaySession, SinkSendObservation } from "./session";

const controlFromBrowserTopic = "voxstudio.control";
const controlFromAgentTopic = "voxstudio.events";
const rtcOutputSampleRate = 24_000;
const rtcFrameSamples = rtcOutputSampleRate / 50;
const adapterBackpressureMs = 500;
const defaultConnectTimeoutMs = 10_000;
const defaultMaxRooms = 32;
const defaultMaxRoomsPerOwner = 4;

export interface LiveKitAgentBootstrap {
  roomName: string;
  participantIdentity: string;
  expiresAt: string;
  ownerUserId: string;
  start: SessionStartOptions;
  /** Present when this room is bound to a saved Agent; ordinary Studio sessions omit it. */
  spec?: AgentSpec;
  /** Immutable trace identity for Agent sessions; ordinary Studio sessions are unbound. */
  agent?: TraceAgentIdentity;
  /** Releases the gateway's pending-bootstrap reservation. Must be idempotent. */
  onClosed?: () => void;
}

export type OpenLiveKitSession = (sink: EventSink) => Promise<GatewaySession>;

export interface LiveKitRoomHandlers {
  participantReady(identity: string): void | Promise<void>;
  audio(identity: string, samples: Float32Array): void | Promise<void>;
  control(identity: string, text: string): void | Promise<void>;
  participantDisconnected(identity: string): void;
  failed(error: unknown): void;
}

/** The narrow surface the lifecycle adapter needs; rtc-node stays behind this seam. */
export interface LiveKitRoomEndpoint {
  connect(agentToken: string): Promise<void>;
  publishControl(text: string): Promise<void>;
  publishAudio(samples: Float32Array, sampleRate: number): Promise<void>;
  waitForPlayout(): Promise<void>;
  clearPlayout(): void;
  close(): Promise<void>;
}

export interface LiveKitRoomConnector {
  create(options: {
    serverUrl: string;
    roomName: string;
    browserIdentity: string;
    agentIdentity: string;
    handlers: LiveKitRoomHandlers;
  }): LiveKitRoomEndpoint;
}

export interface LiveKitAgentMediaAdapter {
  accept(bootstrap: LiveKitAgentBootstrap, openSession: OpenLiveKitSession): Promise<void>;
  close(): Promise<void>;
}

export interface LiveKitAgentMediaAdapterLimits {
  /** Bounds a native connect that never settles. */
  connectTimeoutMs?: number;
  /** Defense-in-depth ceiling over pending and active native participants. */
  maxRooms?: number;
  /** One account cannot consume the entire native-participant allowance. */
  maxRoomsPerOwner?: number;
}

export class LiveKitAdapterCapacityError extends Error {
  readonly code = "livekit_bootstrap_capacity";

  constructor() {
    super("LiveKit bootstrap capacity is exhausted");
    this.name = "LiveKitAdapterCapacityError";
  }
}

/** Carries one protocol rejection that must reach the browser before its room closes. */
export class LiveKitSessionAdmissionError extends Error {
  constructor(readonly event: string, options?: ErrorOptions) {
    super("LiveKit session admission was refused", options);
    this.name = "LiveKitSessionAdmissionError";
  }
}

interface RoomContext {
  bootstrap: LiveKitAgentBootstrap;
  endpoint: LiveKitRoomEndpoint;
  openSession: OpenLiveKitSession;
  session?: GatewaySession;
  opening?: Promise<GatewaySession>;
  closed: boolean;
  outputRate: number;
  outputGeneration: number;
  pendingAudioMs: number;
  audioTail: Promise<void>;
  backpressured: boolean;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
  sink: EventSink;
}

function decodedEvent(text: string): { type?: unknown; turnId?: unknown; sampleRate?: unknown } | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as { type?: unknown; turnId?: unknown; sampleRate?: unknown }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Owns one programmatic participant per browser bootstrap. The expensive VoxStudio
 * session is created only after the expected browser has joined with a microphone;
 * abandoned five-minute grants therefore consume no engine quota or session slot.
 */
export class DefaultLiveKitAgentMediaAdapter implements LiveKitAgentMediaAdapter {
  private readonly rooms = new Map<string, RoomContext>();
  private readonly reservations = new Map<string, string>();
  private closing = false;

  constructor(
    private readonly options: LiveKitBootstrapOptions,
    private readonly connector: LiveKitRoomConnector = new RtcNodeRoomConnector(),
    private readonly log: (line: string) => void = () => {},
    private readonly limits: LiveKitAgentMediaAdapterLimits = {},
  ) {}

  async accept(bootstrap: LiveKitAgentBootstrap, openSession: OpenLiveKitSession): Promise<void> {
    if (this.closing) throw new Error("LiveKit media adapter is closing");
    if (this.rooms.has(bootstrap.roomName) || this.reservations.has(bootstrap.roomName)) {
      throw new Error("LiveKit room is already registered");
    }
    const maxRooms = this.limits.maxRooms ?? defaultMaxRooms;
    const maxRoomsPerOwner = this.limits.maxRoomsPerOwner ?? defaultMaxRoomsPerOwner;
    const owned = [...this.rooms.values()].filter(context => context.bootstrap.ownerUserId === bootstrap.ownerUserId).length
      + [...this.reservations.values()].filter(owner => owner === bootstrap.ownerUserId).length;
    if (this.rooms.size + this.reservations.size >= maxRooms || owned >= maxRoomsPerOwner) {
      throw new LiveKitAdapterCapacityError();
    }
    // Reserve synchronously before token signing yields, otherwise a burst of concurrent
    // requests can all pass the limits and create native participants together.
    this.reservations.set(bootstrap.roomName, bootstrap.ownerUserId);
    let agent: Awaited<ReturnType<typeof issueLiveKitAgentToken>>;
    try {
      agent = await issueLiveKitAgentToken(this.options, bootstrap.roomName);
      if (this.closing) throw new Error("LiveKit media adapter is closing");
    } catch (error) {
      this.reservations.delete(bootstrap.roomName);
      throw error;
    }
    let context!: RoomContext;
    const fail = (error: unknown): void => {
      this.log(`livekit room ${bootstrap.roomName.slice(0, 12)} failed: ${error instanceof Error ? error.message : String(error)}`);
      void this.closeContext(context, error);
    };
    const endpoint = this.connector.create({
      serverUrl: this.options.serverUrl,
      roomName: bootstrap.roomName,
      browserIdentity: bootstrap.participantIdentity,
      agentIdentity: agent.participantIdentity,
      handlers: {
        participantReady: identity => this.participantReady(context, identity),
        audio: (identity, samples) => this.receiveAudio(context, identity, samples),
        control: (identity, text) => this.receiveControl(context, identity, text),
        participantDisconnected: identity => {
          if (identity === bootstrap.participantIdentity) void this.closeContext(context);
        },
        failed: fail,
      },
    });
    const sink: EventSink = {
      send: data => this.send(context, data),
      terminate: () => fail(new Error("LiveKit media endpoint was terminated")),
    };
    context = {
      bootstrap,
      endpoint,
      openSession,
      closed: false,
      outputRate: rtcOutputSampleRate,
      outputGeneration: 0,
      pendingAudioMs: 0,
      audioTail: Promise.resolve(),
      backpressured: false,
      expiryTimer: undefined,
      sink,
    };
    this.reservations.delete(bootstrap.roomName);
    this.rooms.set(bootstrap.roomName, context);
    try {
      const timeoutMs = this.limits.connectTimeoutMs ?? defaultConnectTimeoutMs;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        endpoint.connect(agent.participantToken),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`LiveKit Agent connect timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    } catch (error) {
      await this.closeContext(context);
      throw error;
    }
    if (context.session === undefined) {
      const expiresInMs = Date.parse(bootstrap.expiresAt) - Date.now();
      context.expiryTimer = setTimeout(() => {
        if (context.session === undefined) void this.closeContext(context);
      }, Math.max(0, expiresInMs));
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.reservations.clear();
    await Promise.allSettled([...this.rooms.values()].map(context => this.closeContext(context)));
  }

  private async participantReady(context: RoomContext, identity: string): Promise<void> {
    if (identity !== context.bootstrap.participantIdentity || context.closed) return;
    await this.sessionFor(context);
  }

  private async receiveAudio(context: RoomContext, identity: string, samples: Float32Array): Promise<void> {
    if (identity !== context.bootstrap.participantIdentity || context.closed || samples.length === 0) return;
    const session = await this.sessionFor(context);
    session.pushAudioSamples(samples);
  }

  private async receiveControl(context: RoomContext, identity: string, text: string): Promise<void> {
    if (identity !== context.bootstrap.participantIdentity || context.closed) return;
    const session = context.session;
    if (session === undefined) return;
    try {
      const command = parseCommand(text);
      if (command.type === "session.start" || command.type === "session.attach") return;
      session.handleCommand(command);
    } catch {
      // Browser data is untrusted. Invalid control packets do not terminate healthy media.
    }
  }

  private sessionFor(context: RoomContext): Promise<GatewaySession> {
    if (context.session !== undefined) return Promise.resolve(context.session);
    if (context.opening !== undefined) return context.opening;
    context.opening = context.openSession(context.sink)
      .then(session => {
        if (context.closed) {
          session.stop();
          throw new Error("LiveKit room closed while its Agent session was starting");
        }
        context.session = session;
        void session.done.then(
          () => { void this.closeContext(context); },
          () => { void this.closeContext(context); },
        );
        if (context.expiryTimer !== undefined) clearTimeout(context.expiryTimer);
        context.expiryTimer = undefined;
        return session;
      })
      .catch(async error => {
        if (error instanceof LiveKitSessionAdmissionError) {
          await context.endpoint.publishControl(error.event).catch(publishError => {
            this.log(`livekit room ${context.bootstrap.roomName.slice(0, 12)} could not publish admission refusal: ${publishError instanceof Error ? publishError.message : String(publishError)}`);
          });
        }
        await this.closeContext(context, error instanceof LiveKitSessionAdmissionError ? undefined : error);
        throw error;
      });
    return context.opening;
  }

  private send(context: RoomContext, data: string | Uint8Array): SinkSendObservation {
    if (context.closed) return { sendResult: 0, bufferedBytes: 0 };
    if (typeof data === "string") {
      const event = decodedEvent(data);
      if (event?.type === "playback.format" && typeof event.sampleRate === "number") {
        context.outputRate = event.sampleRate;
      } else if (event?.type === "playback.interrupted") {
        context.outputGeneration += 1;
        context.endpoint.clearPlayout();
      } else if (event?.type === "playback.ended" && typeof event.turnId === "string") {
        const turnId = event.turnId;
        const generation = context.outputGeneration;
        void context.audioTail
          .then(() => generation === context.outputGeneration ? context.endpoint.waitForPlayout() : undefined)
          .then(() => {
            if (generation !== context.outputGeneration) return;
            context.session?.handleCommand({
              v: protocolVersion,
              type: "playback.complete",
              turnId,
              idempotencyKey: `livekit-playout-${turnId}`,
            });
          })
          .catch(error => { void this.closeContext(context, error); });
      }
      void context.endpoint.publishControl(data).catch(error => { void this.closeContext(context, error); });
      return { sendResult: new TextEncoder().encode(data).byteLength, bufferedBytes: 0 };
    }
    if (data.byteLength === 0 || data.byteLength % 4 !== 0) return { sendResult: 0, bufferedBytes: 0 };
    const copied = new Float32Array(data.byteLength / 4);
    new Uint8Array(copied.buffer).set(data);
    const sampleRate = context.outputRate;
    const generation = context.outputGeneration;
    const audioMs = copied.length * 1_000 / sampleRate;
    context.pendingAudioMs += audioMs;
    context.audioTail = context.audioTail
      .then(() => generation === context.outputGeneration
        ? context.endpoint.publishAudio(copied, sampleRate)
        : undefined)
      .catch(error => { void this.closeContext(context, error); })
      .finally(() => {
        context.pendingAudioMs = Math.max(0, context.pendingAudioMs - audioMs);
        if (context.backpressured && context.pendingAudioMs < adapterBackpressureMs / 2) {
          context.backpressured = false;
          context.session?.socketDrained(context.sink);
        }
      });
    const bufferedBytes = Math.ceil(context.pendingAudioMs * context.outputRate / 1_000) * 4;
    if (context.pendingAudioMs >= adapterBackpressureMs) {
      context.backpressured = true;
      return { sendResult: -1, bufferedBytes };
    }
    return { sendResult: data.byteLength, bufferedBytes };
  }

  private async closeContext(context: RoomContext, error?: unknown): Promise<void> {
    if (context.closed) return;
    context.closed = true;
    this.rooms.delete(context.bootstrap.roomName);
    context.bootstrap.onClosed?.();
    if (context.expiryTimer !== undefined) clearTimeout(context.expiryTimer);
    if (error !== undefined) {
      this.log(`livekit room ${context.bootstrap.roomName.slice(0, 12)} closing: ${error instanceof Error ? error.message : String(error)}`);
      context.session?.markFailed("livekit_media_failed");
    }
    context.session?.stop();
    await context.endpoint.close().catch(() => {});
  }
}

/** Production connector; all native rtc-node objects and resource rules live here. */
export class RtcNodeRoomConnector implements LiveKitRoomConnector {
  create(options: Parameters<LiveKitRoomConnector["create"]>[0]): LiveKitRoomEndpoint {
    return new RtcNodeRoomEndpoint(options);
  }
}

class RtcNodeRoomEndpoint implements LiveKitRoomEndpoint {
  private rtc?: typeof import("@livekit/rtc-node");
  private room?: import("@livekit/rtc-node").Room;
  private source?: import("@livekit/rtc-node").AudioSource;
  private track?: import("@livekit/rtc-node").LocalAudioTrack;
  private stream?: import("@livekit/rtc-node").AudioStream;
  private streamTask?: Promise<void>;
  private closed = false;
  private sourceRate?: number;
  private resampler: LinearResampler | undefined;
  private carry = new Float32Array(0);
  private playoutGeneration = 0;

  constructor(private readonly options: Parameters<LiveKitRoomConnector["create"]>[0]) {}

  async connect(agentToken: string): Promise<void> {
    const rtc = await import("@livekit/rtc-node");
    if (this.closed) throw new Error("LiveKit room closed during connect");
    this.rtc = rtc;
    const room = new rtc.Room();
    this.room = room;
    room
      .on(rtc.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (participant.identity !== this.options.browserIdentity
            || track.kind !== rtc.TrackKind.KIND_AUDIO
            || publication.source !== rtc.TrackSource.SOURCE_MICROPHONE
            || this.stream !== undefined) return;
        const stream = new rtc.AudioStream(track, { sampleRate: 16_000, numChannels: 1, frameSizeMs: 20 });
        this.stream = stream;
        void Promise.resolve(this.options.handlers.participantReady(participant.identity))
          .catch(error => this.options.handlers.failed(error));
        this.streamTask = (async () => {
          for await (const frame of stream) {
            if (this.closed) break;
            const samples = new Float32Array(frame.data.length);
            for (let index = 0; index < frame.data.length; index += 1) samples[index] = (frame.data[index] as number) / 32_768;
            await this.options.handlers.audio(participant.identity, samples);
          }
        })().catch(error => this.options.handlers.failed(error));
      })
      .on(rtc.RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (participant?.identity !== this.options.browserIdentity || topic !== controlFromBrowserTopic) return;
        void Promise.resolve(this.options.handlers.control(participant.identity, new TextDecoder().decode(payload)))
          .catch(error => this.options.handlers.failed(error));
      })
      .on(rtc.RoomEvent.ParticipantDisconnected, participant => {
        this.options.handlers.participantDisconnected(participant.identity);
      })
      .on(rtc.RoomEvent.Disconnected, () => {
        if (!this.closed) this.options.handlers.failed(new Error("LiveKit room disconnected"));
      });
    await room.connect(this.options.serverUrl, agentToken, { autoSubscribe: true, dynacast: false });
    if (this.closed) {
      await room.disconnect().catch(() => {});
      throw new Error("LiveKit room closed during connect");
    }
    const source = new rtc.AudioSource(rtcOutputSampleRate, 1, 1_000);
    const track = rtc.LocalAudioTrack.createAudioTrack("voxstudio-agent", source);
    const publish = new rtc.TrackPublishOptions();
    publish.source = rtc.TrackSource.SOURCE_MICROPHONE;
    if (room.localParticipant === undefined) throw new Error("LiveKit connected without a local participant");
    await room.localParticipant.publishTrack(track, publish);
    this.source = source;
    this.track = track;
  }

  async publishControl(text: string): Promise<void> {
    const participant = this.room?.localParticipant;
    if (participant === undefined || this.closed) throw new Error("LiveKit room is not connected");
    await participant.publishData(new TextEncoder().encode(text), {
      reliable: true,
      topic: controlFromAgentTopic,
      destination_identities: [this.options.browserIdentity],
    });
  }

  async publishAudio(samples: Float32Array, sampleRate: number): Promise<void> {
    const source = this.source;
    const rtc = this.rtc;
    if (source === undefined || rtc === undefined || this.closed) throw new Error("LiveKit audio source is not connected");
    const generation = this.playoutGeneration;
    if (this.sourceRate !== sampleRate) {
      this.sourceRate = sampleRate;
      this.resampler = sampleRate === rtcOutputSampleRate ? undefined : new LinearResampler(sampleRate, rtcOutputSampleRate);
      this.carry = new Float32Array(0);
    }
    const converted = this.resampler?.push(samples) ?? samples;
    if (converted.length === 0) return;
    const joined = new Float32Array(this.carry.length + converted.length);
    joined.set(this.carry);
    joined.set(converted, this.carry.length);
    let offset = 0;
    while (joined.length - offset >= rtcFrameSamples) {
      if (generation !== this.playoutGeneration) return;
      const frame = joined.slice(offset, offset + rtcFrameSamples);
      const bytes = encodePcm16(frame);
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      await source.captureFrame(new rtc.AudioFrame(pcm, rtcOutputSampleRate, 1, pcm.length));
      offset += rtcFrameSamples;
    }
    this.carry = joined.slice(offset);
  }

  async waitForPlayout(): Promise<void> {
    const source = this.source;
    const rtc = this.rtc;
    if (source === undefined || rtc === undefined) return;
    if (this.carry.length > 0) {
      const padded = new Float32Array(rtcFrameSamples);
      padded.set(this.carry);
      this.carry = new Float32Array(0);
      const bytes = encodePcm16(padded);
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      await source.captureFrame(new rtc.AudioFrame(pcm, rtcOutputSampleRate, 1, pcm.length));
    }
    await source.waitForPlayout();
  }

  clearPlayout(): void {
    this.playoutGeneration += 1;
    this.carry = new Float32Array(0);
    this.resampler = this.sourceRate === undefined || this.sourceRate === rtcOutputSampleRate
      ? undefined
      : new LinearResampler(this.sourceRate, rtcOutputSampleRate);
    this.source?.clearQueue();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stream?.cancel().catch(() => {});
    // cancel() tears down the FFI stream. Its consumer may still be finishing an
    // asynchronous session-start callback, so room shutdown must not wait on it.
    void this.streamTask?.catch(() => {});
    await this.track?.close(false).catch(() => {});
    await this.source?.close().catch(() => {});
    await this.room?.disconnect().catch(() => {});
  }
}
