import type { GatewayEvent, SessionStartOptions } from "@voxstudio/realtime-gateway/protocol";
import { protocolVersion } from "@voxstudio/realtime-gateway/protocol";
import {
  AudioPresets,
  createLocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  type AudioCaptureOptions,
} from "#livekit-client";
import { issueLiveKitBootstrap, type LiveKitBootstrapResponse } from "./api";
import type { EndpointCapability } from "./audio";
import type { ConnectionState } from "./client";
import type { BrowserMediaTelemetryEvent } from "./media-telemetry";
import { WebRtcStatsSampler, type RtcStatsReportLike, type WebRtcStatsDirection, type WebRtcStatsSample } from "./webrtc-stats";

export const liveKitControlTopic = "voxstudio.control";
export const liveKitEventTopic = "voxstudio.events";

interface ParticipantLike {
  identity: string;
}

interface RemoteAudioTrackLike {
  kind: string;
  attach(): HTMLMediaElement;
  detach(element: HTMLMediaElement): unknown;
  getRTCStatsReport?(): Promise<RTCStatsReport | undefined>;
}

interface LocalAudioTrackLike {
  mediaStreamTrack: MediaStreamTrack;
  mute(): Promise<unknown>;
  unmute(): Promise<unknown>;
  stop(): void;
  getRTCStatsReport?(): Promise<RTCStatsReport | undefined>;
}

export interface LiveKitRoomLike {
  readonly localParticipant: {
    readonly audioLevel: number;
    publishTrack(track: LocalAudioTrackLike, options: Record<string, unknown>): Promise<unknown>;
    publishData(data: Uint8Array, options: { reliable: boolean; topic: string }): Promise<void>;
  };
  readonly canPlaybackAudio: boolean;
  on(event: string, listener: (...args: unknown[]) => void): LiveKitRoomLike;
  connect(serverUrl: string, token: string, options: { autoSubscribe: boolean }): Promise<void>;
  startAudio(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface BrowserLiveKitClientOptions {
  selection: SessionStartOptions;
  inputDeviceId?: string;
  onEvent(event: GatewayEvent): void;
  onConnectionChange(state: ConnectionState): void;
  onCapabilityChange(capability: EndpointCapability): void;
  onMicLevel(level: number): void;
  onMediaTelemetry?(event: BrowserMediaTelemetryEvent): void;
  onDisconnected?(): void;
  issueBootstrap?(selection: BrowserLiveKitClientOptions["selection"]): Promise<LiveKitBootstrapResponse>;
  makeRoom?(): LiveKitRoomLike;
  createAudioTrack?(options: AudioCaptureOptions): Promise<LocalAudioTrackLike>;
  appendAudioElement?(element: HTMLMediaElement): void;
  newIdempotencyKey?(): string;
  setLevelInterval?(callback: () => void, milliseconds: number): number;
  clearLevelInterval?(timer: number): void;
  setStatsInterval?(callback: () => void, milliseconds: number): number;
  clearStatsInterval?(timer: number): void;
  now?(): number;
}

function isGatewayEvent(value: unknown): value is GatewayEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.v === protocolVersion
    && typeof event.type === "string"
    && typeof event.sequence === "number"
    && typeof event.sessionId === "string"
    && typeof event.timestampMs === "number";
}

function capability(track: MediaStreamTrack): EndpointCapability {
  const settings = track.getSettings();
  const rate = settings.sampleRate ?? 48_000;
  return {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    deviceId: settings.deviceId,
    deviceLabel: track.label || undefined,
    trackMuted: track.muted,
    trackState: track.readyState,
    trackSampleRate: settings.sampleRate,
    // WebRTC owns capture/resampling rather than a page AudioContext. Reporting its
    // capture clock avoids claiming the 16 kHz Agent-side decode rate as a browser fact.
    contextSampleRate: rate,
    recoveries: 0,
  };
}

type LiveKitConnectPhase = "bootstrap" | "room connect" | "microphone capture" | "microphone publish";

export interface LiveKitConnectFailure extends Error {
  liveKitPhase: LiveKitConnectPhase;
}

function connectError(phase: LiveKitConnectPhase, error: unknown): LiveKitConnectFailure {
  const detail = error instanceof Error
    ? error.message.trim() || error.name
    : String(error).trim() || "unknown error";
  const failure = new Error(`LiveKit ${phase} failed: ${detail}`, { cause: error }) as LiveKitConnectFailure;
  failure.liveKitPhase = phase;
  return failure;
}

/**
 * Browser half of the optional LiveKit transport. Audio stays on WebRTC tracks (Opus on
 * the wire); only the existing protocol-v1 commands/events use reliable data packets.
 */
export class BrowserLiveKitClient {
  private readonly room: LiveKitRoomLike;
  private readonly options: BrowserLiveKitClientOptions;
  private bootstrap: LiveKitBootstrapResponse | undefined;
  private localTrack: LocalAudioTrackLike | undefined;
  private readonly remoteElements = new Map<RemoteAudioTrackLike, HTMLMediaElement>();
  private readonly remotePlaybackCleanup = new Map<RemoteAudioTrackLike, () => void>();
  private sessionId: string | undefined;
  private levelTimer: number | undefined;
  private statsTimer: number | undefined;
  private statsPolling = false;
  private readonly statsSamplers = new WeakMap<object, WebRtcStatsSampler>();
  private closed = false;
  private connected = false;

  constructor(options: BrowserLiveKitClientOptions) {
    this.options = options;
    this.room = options.makeRoom?.() ?? new Room({ adaptiveStream: true }) as unknown as LiveKitRoomLike;
    this.bindRoom();
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("client is closed");
    this.options.onConnectionChange("connecting");

    // Called before the first await, while the Start button's transient activation is
    // still live. Safari/iOS otherwise may receive the Agent track but refuse to play it.
    void this.room.startAudio().catch(() => {});
    let phase: LiveKitConnectPhase = "bootstrap";
    try {
      const bootstrap = await (this.options.issueBootstrap ?? issueLiveKitBootstrap)(this.options.selection);
      if (this.closed) throw new Error("conversation start cancelled");
      this.bootstrap = bootstrap;
      phase = "room connect";
      await this.room.connect(bootstrap.server_url, bootstrap.participant_token, { autoSubscribe: true });
      if (this.closed) throw new Error("conversation start cancelled");

      phase = "microphone capture";
      const createTrack = this.options.createAudioTrack
        ?? (audioOptions => createLocalAudioTrack(audioOptions) as unknown as Promise<LocalAudioTrackLike>);
      const track = await createTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        ...(this.options.inputDeviceId ? { deviceId: { exact: this.options.inputDeviceId } } : {}),
      });
      if (this.closed) {
        track.stop();
        throw new Error("conversation start cancelled");
      }
      this.localTrack = track;
      this.options.onCapabilityChange(capability(track.mediaStreamTrack));
      phase = "microphone publish";
      await this.room.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
        audioPreset: AudioPresets.speech,
        dtx: true,
        red: true,
        stopMicTrackOnMute: false,
      });
      if (this.closed) throw new Error("conversation start cancelled");
      this.connected = true;
      this.options.onConnectionChange("connected");
      const set = this.options.setLevelInterval ?? ((callback, milliseconds) => window.setInterval(callback, milliseconds));
      this.levelTimer = set(() => this.options.onMicLevel(Math.min(1, this.room.localParticipant.audioLevel * 2.5)), 120);
      if (this.options.onMediaTelemetry !== undefined) {
        const setStats = this.options.setStatsInterval ?? ((callback, milliseconds) => window.setInterval(callback, milliseconds));
        this.statsTimer = setStats(() => { void this.pollWebRtcStats(); }, 2_000);
        void this.pollWebRtcStats();
      }
    } catch (error) {
      await this.close();
      if (error instanceof Error && error.message === "conversation start cancelled") throw error;
      throw connectError(phase, error);
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    // This control is also a fresh user gesture and can recover an autoplay refusal.
    void this.room.startAudio().catch(() => {});
    const track = this.localTrack;
    if (track === undefined || this.closed) throw new Error("LiveKit microphone is not active");
    await (muted ? track.mute() : track.unmute());
    if (muted) this.options.onMicLevel(0);
  }

  interruptTurn(turnId: string): void {
    void this.command({ type: "turn.interrupt", turnId });
  }

  /** The rtc-node AudioSource owns the audible clock and sends this acknowledgement. */
  playbackComplete(_turnId: string): void {}

  requestSnapshot(): void {
    void this.command({ type: "session.snapshot.request" });
  }

  async stopSession(): Promise<void> {
    // Privacy comes before protocol courtesy: a reliable data packet may stall while
    // signaling reconnects, but End test must stop capture in the initiating task.
    this.stopLocalTrack();
    const notification = this.command({ type: "session.stop" }).catch(() => {});
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      notification,
      new Promise<void>(resolve => { timeout = setTimeout(resolve, 250); }),
    ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    if (this.levelTimer !== undefined) {
      (this.options.clearLevelInterval ?? (timer => window.clearInterval(timer)))(this.levelTimer);
      this.levelTimer = undefined;
    }
    if (this.statsTimer !== undefined) {
      (this.options.clearStatsInterval ?? (timer => window.clearInterval(timer)))(this.statsTimer);
      this.statsTimer = undefined;
    }
    this.options.onMicLevel(0);
    this.stopLocalTrack();
    for (const [track, element] of this.remoteElements) {
      this.remotePlaybackCleanup.get(track)?.();
      track.detach(element);
      element.remove();
    }
    this.remoteElements.clear();
    this.remotePlaybackCleanup.clear();
    await this.room.disconnect().catch(() => {});
    this.options.onConnectionChange("disconnected");
  }

  private async pollWebRtcStats(): Promise<void> {
    if (!this.connected || this.closed || this.statsPolling || this.options.onMediaTelemetry === undefined) return;
    this.statsPolling = true;
    const atMs = this.options.now?.() ?? performance.timeOrigin + performance.now();
    const collect = async (track: LocalAudioTrackLike | RemoteAudioTrackLike, direction: WebRtcStatsDirection): Promise<WebRtcStatsSample | undefined> => {
      const report = await track.getRTCStatsReport?.();
      if (report === undefined || this.closed) return undefined;
      let sampler = this.statsSamplers.get(track);
      if (sampler === undefined) {
        sampler = new WebRtcStatsSampler();
        this.statsSamplers.set(track, sampler);
      }
      return sampler.sample(report as unknown as RtcStatsReportLike, direction, atMs);
    };
    try {
      const results = await Promise.allSettled([
        ...(this.localTrack === undefined ? [] : [collect(this.localTrack, "uplink")]),
        ...[...this.remoteElements.keys()].map(track => collect(track, "downlink")),
      ]);
      const samples = results.flatMap(result => result.status === "fulfilled" && result.value !== undefined ? [result.value] : []);
      for (const sample of samples) this.options.onMediaTelemetry?.({ stage: "browser.webrtc", ...sample });
      const downlinkRates = samples.flatMap(sample => sample.direction === "downlink" && sample.rtpBitrateKbps !== undefined
        ? [sample.rtpBitrateKbps] : []);
      if (downlinkRates.length > 0) {
        this.options.onMediaTelemetry?.({
          stage: "browser.webrtc.aggregate",
          atMs,
          direction: "downlink",
          rtpBitrateKbps: downlinkRates.reduce((total, value) => total + value, 0),
          streamCount: downlinkRates.length,
        });
      }
    } finally {
      this.statsPolling = false;
    }
  }

  private stopLocalTrack(): void {
    const track = this.localTrack;
    this.localTrack = undefined;
    track?.stop();
  }

  private bindRoom(): void {
    this.room
      .on(RoomEvent.Reconnecting, () => {
        if (!this.closed) this.options.onConnectionChange("reconnecting");
      })
      .on(RoomEvent.SignalReconnecting, () => {
        if (!this.closed) this.options.onConnectionChange("reconnecting");
      })
      .on(RoomEvent.Reconnected, () => {
        if (!this.closed) this.options.onConnectionChange("connected");
      })
      .on(RoomEvent.Disconnected, () => {
        this.finishRemoteDisconnect();
      })
      .on(RoomEvent.ParticipantDisconnected, (...args) => {
        const participant = args[0] as ParticipantLike | undefined;
        // The programmatic Agent participant owns the VoxStudio session. If it leaves,
        // the room can remain alive with only the browser participant, which would keep
        // an iPhone microphone publishing indefinitely unless the browser tears itself
        // down. Foreign participants never own this lifecycle.
        if (participant?.identity.startsWith("agent-")) this.finishRemoteDisconnect();
      })
      .on(RoomEvent.TrackSubscribed, (...args) => {
        const track = args[0] as RemoteAudioTrackLike;
        const participant = args[2] as ParticipantLike | undefined;
        if (track.kind !== Track.Kind.Audio || !participant?.identity.startsWith("agent-") || this.remoteElements.has(track)) return;
        const element = track.attach();
        element.autoplay = true;
        element.setAttribute("playsinline", "true");
        this.observeRemotePlayback(track, element);
        (this.options.appendAudioElement ?? (audio => document.body.append(audio)))(element);
        this.remoteElements.set(track, element);
        void this.pollWebRtcStats();
      })
      .on(RoomEvent.TrackUnsubscribed, (...args) => {
        const track = args[0] as RemoteAudioTrackLike;
        const element = this.remoteElements.get(track);
        if (element === undefined) return;
        this.remotePlaybackCleanup.get(track)?.();
        this.remotePlaybackCleanup.delete(track);
        track.detach(element);
        element.remove();
        this.remoteElements.delete(track);
      })
      .on(RoomEvent.DataReceived, (...args) => {
        const payload = args[0] as Uint8Array;
        const participant = args[1] as ParticipantLike | undefined;
        const topic = args[3];
        if (topic !== liveKitEventTopic || !participant?.identity.startsWith("agent-")) return;
        try {
          const event = JSON.parse(new TextDecoder().decode(payload)) as unknown;
          if (!isGatewayEvent(event)) return;
          this.sessionId = event.sessionId || this.sessionId;
          this.options.onEvent(event);
        } catch {
          // Data packets are untrusted transport input. Ignore malformed events.
        }
      });
  }

  private observeRemotePlayback(track: RemoteAudioTrackLike, element: HTMLMediaElement): void {
    if (this.options.onMediaTelemetry === undefined) return;
    let played = false;
    let stalledAtMs: number | undefined;
    const now = (): number => this.options.now?.() ?? performance.timeOrigin + performance.now();
    const onWaiting = (): void => {
      if (played && stalledAtMs === undefined) stalledAtMs = now();
    };
    const onPlaying = (): void => {
      const atMs = now();
      if (played && stalledAtMs !== undefined) {
        this.options.onMediaTelemetry?.({
          stage: "browser.underrun",
          atMs,
          durationMs: Math.max(0, atMs - stalledAtMs),
        });
      }
      played = true;
      stalledAtMs = undefined;
      this.options.onMediaTelemetry?.({ stage: "browser.playback", atMs, state: "playing" });
    };
    element.addEventListener?.("waiting", onWaiting);
    element.addEventListener?.("stalled", onWaiting);
    element.addEventListener?.("playing", onPlaying);
    this.remotePlaybackCleanup.set(track, () => {
      element.removeEventListener?.("waiting", onWaiting);
      element.removeEventListener?.("stalled", onWaiting);
      element.removeEventListener?.("playing", onPlaying);
    });
  }

  private async command(payload: Record<string, unknown>): Promise<void> {
    if (!this.connected || this.bootstrap === undefined || this.closed) return;
    const key = this.options.newIdempotencyKey?.() ?? crypto.randomUUID();
    await this.room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ v: protocolVersion, idempotencyKey: key, ...payload })),
      { reliable: true, topic: liveKitControlTopic },
    );
  }

  private finishRemoteDisconnect(): void {
    if (this.closed) return;
    this.connected = false;
    void this.close().finally(() => this.options.onDisconnected?.());
  }
}
