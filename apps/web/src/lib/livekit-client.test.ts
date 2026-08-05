import { describe, expect, test } from "bun:test";
import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import { RoomEvent } from "#livekit-client";
import {
  BrowserLiveKitClient,
  liveKitControlTopic,
  liveKitEventTopic,
  type LiveKitRoomLike,
} from "./livekit-client";

class FakeRoom implements LiveKitRoomLike {
  readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  readonly published: { data: Uint8Array; options: { reliable: boolean; topic: string } }[] = [];
  readonly trackPublishes: { track: unknown; options: Record<string, unknown> }[] = [];
  readonly localParticipant = {
    audioLevel: 0.2,
    publishTrack: async (track: unknown, options: Record<string, unknown>) => {
      this.trackPublishes.push({ track, options });
    },
    publishData: async (data: Uint8Array, options: { reliable: boolean; topic: string }) => {
      this.published.push({ data, options });
    },
  };
  canPlaybackAudio = true;
  starts = 0;
  disconnects = 0;
  connection: { serverUrl: string; token: string; autoSubscribe: boolean } | undefined;

  on(event: string, listener: (...args: unknown[]) => void): LiveKitRoomLike {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  async connect(serverUrl: string, token: string, options: { autoSubscribe: boolean }): Promise<void> {
    this.connection = { serverUrl, token, autoSubscribe: options.autoSubscribe };
  }
  async startAudio(): Promise<void> { this.starts += 1; }
  async disconnect(): Promise<void> { this.disconnects += 1; }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function fakeMediaTrack() {
  return {
    label: "iPhone Microphone",
    muted: false,
    readyState: "live",
    getSettings: () => ({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: "iphone-mic",
      sampleRate: 48_000,
    }),
  } as unknown as MediaStreamTrack;
}

function event(type: string): GatewayEvent {
  return {
    v: 1,
    type: type as GatewayEvent["type"],
    sequence: 1,
    sessionId: "session-1",
    timestampMs: 10,
  } as GatewayEvent;
}

describe("BrowserLiveKitClient", () => {
  test("primes iOS audio before bootstrap, publishes one processed Opus microphone, and bridges control/events", async () => {
    const room = new FakeRoom();
    const states: string[] = [];
    const events: GatewayEvent[] = [];
    const capabilities: unknown[] = [];
    const levels: number[] = [];
    const appended: HTMLMediaElement[] = [];
    let capturedOptions: unknown;
    let resolveBootstrap!: (value: {
      server_url: string; participant_token: string; room_name: string;
      participant_identity: string; expires_at: string;
      agent: { agentId: string; source: "draft"; revision: number };
    }) => void;
    const bootstrap = new Promise<Parameters<typeof resolveBootstrap>[0]>(resolve => { resolveBootstrap = resolve; });
    const localTrack = {
      mediaStreamTrack: fakeMediaTrack(),
      mute: async () => {},
      unmute: async () => {},
      stop: () => {},
    };
    let levelTick: (() => void) | undefined;
    const client = new BrowserLiveKitClient({
      selection: { agent: "support", agentSource: "draft", agentRevision: 7 },
      inputDeviceId: "iphone-mic",
      onEvent: value => events.push(value),
      onConnectionChange: state => states.push(state),
      onCapabilityChange: value => capabilities.push(value),
      onMicLevel: value => levels.push(value),
      issueBootstrap: async () => bootstrap,
      makeRoom: () => room,
      createAudioTrack: async options => { capturedOptions = options; return localTrack; },
      appendAudioElement: element => appended.push(element),
      newIdempotencyKey: () => "command-1",
      setLevelInterval: callback => { levelTick = callback; return 7; },
      clearLevelInterval: () => {},
    });

    const connecting = client.connect();
    expect(room.starts).toBe(1);
    expect(room.connection).toBeUndefined();
    resolveBootstrap({
      server_url: "wss://media.example",
      participant_token: "jwt",
      room_name: "vox-room",
      participant_identity: "web-user",
      expires_at: "2026-08-05T00:05:00.000Z",
      agent: { agentId: "support", source: "draft", revision: 7 },
    });
    await connecting;

    expect(room.connection).toEqual({ serverUrl: "wss://media.example", token: "jwt", autoSubscribe: true });
    expect(capturedOptions).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      deviceId: { exact: "iphone-mic" },
    });
    expect(room.trackPublishes).toHaveLength(1);
    expect(room.trackPublishes[0]?.options).toMatchObject({ dtx: true, red: true, stopMicTrackOnMute: false });
    expect(capabilities).toEqual([expect.objectContaining({ deviceLabel: "iPhone Microphone", trackSampleRate: 48_000 })]);
    expect(states).toEqual(["connecting", "connected"]);
    levelTick?.();
    expect(levels.at(-1)).toBe(0.5);

    let removed = 0;
    const attributes = new Map<string, string>();
    const audio = {
      autoplay: false,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      remove: () => { removed += 1; },
    } as unknown as HTMLMediaElement;
    let detaches = 0;
    const remoteTrack = {
      kind: "audio",
      attach: () => audio,
      detach: () => { detaches += 1; },
    };
    room.emit(RoomEvent.TrackSubscribed, remoteTrack, {}, { identity: "agent-runtime" });
    expect(appended).toEqual([audio]);
    expect(audio.autoplay).toBe(true);
    expect(attributes.get("playsinline")).toBe("true");

    const gatewayEvent = event("session.state");
    room.emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(JSON.stringify(gatewayEvent)),
      { identity: "agent-runtime" },
      undefined,
      liveKitEventTopic,
    );
    expect(events).toEqual([gatewayEvent]);
    expect(client.currentSessionId).toBe("session-1");

    client.interruptTurn("turn-1");
    await Promise.resolve();
    expect(room.published).toHaveLength(1);
    expect(room.published[0]?.options).toEqual({ reliable: true, topic: liveKitControlTopic });
    expect(JSON.parse(new TextDecoder().decode(room.published[0]?.data))).toMatchObject({
      v: 1,
      type: "turn.interrupt",
      turnId: "turn-1",
      idempotencyKey: "command-1",
    });

    room.emit(RoomEvent.TrackUnsubscribed, remoteTrack);
    expect(detaches).toBe(1);
    expect(removed).toBe(1);
    await client.stopSession();
    expect(room.disconnects).toBe(1);
    expect(states.at(-1)).toBe("disconnected");
  });

  test("ignores foreign and malformed data and surfaces LiveKit reconnect states", async () => {
    const room = new FakeRoom();
    const states: string[] = [];
    const events: GatewayEvent[] = [];
    let disconnected = 0;
    const client = new BrowserLiveKitClient({
      selection: { agent: "support" },
      onEvent: value => events.push(value),
      onConnectionChange: state => states.push(state),
      onCapabilityChange: () => {},
      onMicLevel: () => {},
      onDisconnected: () => { disconnected += 1; },
      issueBootstrap: async () => ({
        server_url: "wss://media.example", participant_token: "jwt", room_name: "room",
        participant_identity: "web", expires_at: "2026-08-05T00:05:00.000Z",
        agent: { agentId: "support", source: "published", version: 1 },
      }),
      makeRoom: () => room,
      createAudioTrack: async () => ({ mediaStreamTrack: fakeMediaTrack(), mute: async () => {}, unmute: async () => {}, stop: () => {} }),
      appendAudioElement: () => {},
      setLevelInterval: () => 1,
      clearLevelInterval: () => {},
    });
    await client.connect();
    room.emit(RoomEvent.DataReceived, new TextEncoder().encode("not-json"), { identity: "agent-runtime" }, undefined, liveKitEventTopic);
    room.emit(RoomEvent.DataReceived, new TextEncoder().encode(JSON.stringify(event("session.state"))), { identity: "stranger" }, undefined, liveKitEventTopic);
    expect(events).toEqual([]);
    room.emit(RoomEvent.Reconnecting);
    room.emit(RoomEvent.Reconnected);
    expect(states.slice(-2)).toEqual(["reconnecting", "connected"]);
    room.emit(RoomEvent.Disconnected);
    await Bun.sleep(0);
    expect(disconnected).toBe(1);
    expect(room.disconnects).toBe(1);
  });

  test("annotates the failing startup phase and still releases the room", async () => {
    const room = new FakeRoom();
    room.localParticipant.publishTrack = async () => { throw new Error(""); };
    const client = new BrowserLiveKitClient({
      selection: { agent: "support" },
      onEvent: () => {},
      onConnectionChange: () => {},
      onCapabilityChange: () => {},
      onMicLevel: () => {},
      issueBootstrap: async () => ({
        server_url: "wss://media.example", participant_token: "jwt", room_name: "room",
        participant_identity: "web", expires_at: "2026-08-05T00:05:00.000Z",
        agent: { agentId: "support", source: "published", version: 1 },
      }),
      makeRoom: () => room,
      createAudioTrack: async () => ({ mediaStreamTrack: fakeMediaTrack(), mute: async () => {}, unmute: async () => {}, stop: () => {} }),
    });

    await expect(client.connect()).rejects.toThrow("LiveKit microphone publish failed: Error");
    expect(room.disconnects).toBe(1);
  });

  test("stops the microphone before a reliable session-stop packet can settle", async () => {
    const room = new FakeRoom();
    let releasePublish!: () => void;
    room.localParticipant.publishData = async () => new Promise<void>(resolve => { releasePublish = resolve; });
    let stops = 0;
    const client = new BrowserLiveKitClient({
      selection: { agent: "support" },
      onEvent: () => {},
      onConnectionChange: () => {},
      onCapabilityChange: () => {},
      onMicLevel: () => {},
      issueBootstrap: async () => ({
        server_url: "wss://media.example", participant_token: "jwt", room_name: "room",
        participant_identity: "web", expires_at: "2026-08-05T00:05:00.000Z",
        agent: { agentId: "support", source: "published", version: 1 },
      }),
      makeRoom: () => room,
      createAudioTrack: async () => ({
        mediaStreamTrack: fakeMediaTrack(),
        mute: async () => {},
        unmute: async () => {},
        stop: () => { stops += 1; },
      }),
      setLevelInterval: () => 1,
      clearLevelInterval: () => {},
    });
    await client.connect();
    const stopping = client.stopSession();
    expect(stops).toBe(1);
    expect(room.disconnects).toBe(0);
    releasePublish();
    await stopping;
    expect(room.disconnects).toBe(1);
  });

  test("surfaces a failed mute instead of claiming that capture is muted", async () => {
    const room = new FakeRoom();
    const levels: number[] = [];
    const client = new BrowserLiveKitClient({
      selection: { agent: "support" },
      onEvent: () => {},
      onConnectionChange: () => {},
      onCapabilityChange: () => {},
      onMicLevel: level => levels.push(level),
      issueBootstrap: async () => ({
        server_url: "wss://media.example", participant_token: "jwt", room_name: "room",
        participant_identity: "web", expires_at: "2026-08-05T00:05:00.000Z",
        agent: { agentId: "support", source: "published", version: 1 },
      }),
      makeRoom: () => room,
      createAudioTrack: async () => ({
        mediaStreamTrack: fakeMediaTrack(),
        mute: async () => { throw new Error("track refused mute"); },
        unmute: async () => {},
        stop: () => {},
      }),
      setLevelInterval: () => 1,
      clearLevelInterval: () => {},
    });
    await client.connect();
    await expect(client.setMuted(true)).rejects.toThrow("track refused mute");
    expect(levels).toEqual([]);
    await client.close();
  });
});
