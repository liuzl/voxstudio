import { describe, expect, test } from "bun:test";
import type { GatewayCommand } from "./protocol";
import type { EventSink, GatewaySession } from "./session";
import {
  DefaultLiveKitAgentMediaAdapter,
  LiveKitAdapterCapacityError,
  LiveKitSessionAdmissionError,
  type LiveKitAgentBootstrap,
  type LiveKitRoomConnector,
  type LiveKitRoomEndpoint,
  type LiveKitRoomHandlers,
} from "./livekit-agent-adapter";

const livekit = {
  serverUrl: "ws://127.0.0.1:7880",
  apiKey: "devkey",
  apiSecret: "secret",
};

const bootstrap: LiveKitAgentBootstrap = {
  roomName: "vox-0123456789abcdef0123456789abcdef",
  participantIdentity: "web-0123456789abcdef0123456789abcdef",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ownerUserId: "owner",
  start: { system: "help", voice: "voice" },
  spec: { instructions: "help", voice: "voice" },
  agent: { agentId: "support", source: "published", version: 1, hash: "hash" },
};

class FakeEndpoint implements LiveKitRoomEndpoint {
  connectedToken?: string;
  controls: string[] = [];
  audio: { samples: Float32Array; sampleRate: number }[] = [];
  clearCount = 0;
  waitCount = 0;
  closeCount = 0;

  constructor(readonly handlers: LiveKitRoomHandlers) {}
  async connect(token: string): Promise<void> { this.connectedToken = token; }
  async publishControl(text: string): Promise<void> { this.controls.push(text); }
  async publishAudio(samples: Float32Array, sampleRate: number): Promise<void> {
    this.audio.push({ samples, sampleRate });
  }
  async waitForPlayout(): Promise<void> { this.waitCount += 1; }
  clearPlayout(): void { this.clearCount += 1; }
  async close(): Promise<void> { this.closeCount += 1; }
}

class FakeConnector implements LiveKitRoomConnector {
  endpoint?: FakeEndpoint;
  create(options: Parameters<LiveKitRoomConnector["create"]>[0]): LiveKitRoomEndpoint {
    this.endpoint = new FakeEndpoint(options.handlers);
    return this.endpoint;
  }
}

function fakeSession(): {
  session: GatewaySession;
  audio: Float32Array[];
  commands: GatewayCommand[];
  drains: EventSink[];
  stops: { count: number };
  failures: string[];
} {
  const audio: Float32Array[] = [];
  const commands: GatewayCommand[] = [];
  const drains: EventSink[] = [];
  const stops = { count: 0 };
  const failures: string[] = [];
  const done = new Promise<void>(() => {});
  return {
    audio,
    commands,
    drains,
    stops,
    failures,
    session: {
      done,
      pushAudioSamples: (samples: Float32Array) => audio.push(samples),
      handleCommand: (command: GatewayCommand) => commands.push(command),
      socketDrained: (sink: EventSink) => drains.push(sink),
      stop: () => { stops.count += 1; },
      markFailed: (code: string) => failures.push(code),
    } as unknown as GatewaySession,
  };
}

describe("LiveKit Agent media adapter", () => {
  test("claims the room before returning and opens exactly one session for the expected microphone participant", async () => {
    const connector = new FakeConnector();
    const adapter = new DefaultLiveKitAgentMediaAdapter(livekit, connector);
    const fake = fakeSession();
    let opens = 0;
    await adapter.accept(bootstrap, async () => { opens += 1; return fake.session; });
    const endpoint = connector.endpoint as FakeEndpoint;
    expect(endpoint.connectedToken?.split(".")).toHaveLength(3);

    await endpoint.handlers.participantReady("somebody-else");
    expect(opens).toBe(0);
    await Promise.all([
      Promise.resolve(endpoint.handlers.participantReady(bootstrap.participantIdentity)),
      Promise.resolve(endpoint.handlers.participantReady(bootstrap.participantIdentity)),
    ]);
    expect(opens).toBe(1);

    const microphone = new Float32Array([0.1, -0.2]);
    await endpoint.handlers.audio(bootstrap.participantIdentity, microphone);
    await endpoint.handlers.audio("somebody-else", new Float32Array([1]));
    expect(fake.audio).toEqual([microphone]);
    await adapter.close();
    expect(fake.stops.count).toBe(1);
    expect(endpoint.closeCount).toBe(1);
  });

  test("bridges control, PCM, interruption, and the adapter-owned playout acknowledgement", async () => {
    const connector = new FakeConnector();
    const adapter = new DefaultLiveKitAgentMediaAdapter(livekit, connector);
    const fake = fakeSession();
    let sink: EventSink | undefined;
    await adapter.accept(bootstrap, async acceptedSink => {
      sink = acceptedSink;
      return fake.session;
    });
    const endpoint = connector.endpoint as FakeEndpoint;
    await endpoint.handlers.participantReady(bootstrap.participantIdentity);
    const route = sink as EventSink;

    route.send(JSON.stringify({ type: "playback.format", sampleRate: 16_000 }));
    const pcm = new Float32Array(800);
    route.send(new Uint8Array(pcm.buffer));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(endpoint.audio).toHaveLength(1);
    expect(endpoint.audio[0]?.sampleRate).toBe(16_000);
    route.send(new Uint8Array(pcm.buffer));
    route.send(JSON.stringify({ type: "playback.interrupted", turnId: "old" }));
    route.send(JSON.stringify({ type: "playback.ended", turnId: "turn-1" }));
    await new Promise(resolve => setTimeout(resolve, 0));
    // The interruption raced ahead of the asynchronous RTC writer, so the already
    // accepted stale frame is discarded instead of being reintroduced after clearQueue.
    expect(endpoint.audio).toHaveLength(1);
    expect(endpoint.clearCount).toBe(1);
    expect(endpoint.waitCount).toBe(1);
    expect(fake.commands).toContainEqual(expect.objectContaining({ type: "playback.complete", turnId: "turn-1" }));
    expect(endpoint.controls.map(text => JSON.parse(text).type)).toEqual([
      "playback.format",
      "playback.interrupted",
      "playback.ended",
    ]);

    await endpoint.handlers.control(bootstrap.participantIdentity, JSON.stringify({
      v: 1,
      type: "session.stop",
      idempotencyKey: "stop-1",
    }));
    await endpoint.handlers.control(bootstrap.participantIdentity, "not-json");
    expect(fake.commands).toContainEqual(expect.objectContaining({ type: "session.stop" }));
    await adapter.close();
  });

  test("closes a room whose expected browser participant leaves", async () => {
    const connector = new FakeConnector();
    const adapter = new DefaultLiveKitAgentMediaAdapter(livekit, connector);
    const fake = fakeSession();
    await adapter.accept(bootstrap, async () => fake.session);
    const endpoint = connector.endpoint as FakeEndpoint;
    await endpoint.handlers.participantReady(bootstrap.participantIdentity);
    endpoint.handlers.participantDisconnected("somebody-else");
    expect(endpoint.closeCount).toBe(0);
    endpoint.handlers.participantDisconnected(bootstrap.participantIdentity);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fake.stops.count).toBe(1);
    expect(endpoint.closeCount).toBe(1);
  });

  test("turns an RTC failure into a traceable session failure and closes resources", async () => {
    const connector = new FakeConnector();
    const adapter = new DefaultLiveKitAgentMediaAdapter(livekit, connector);
    const fake = fakeSession();
    await adapter.accept(bootstrap, async () => fake.session);
    const endpoint = connector.endpoint as FakeEndpoint;
    await endpoint.handlers.participantReady(bootstrap.participantIdentity);
    endpoint.handlers.failed(new Error("transport lost"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fake.failures).toEqual(["livekit_media_failed"]);
    expect(fake.stops.count).toBe(1);
    expect(endpoint.closeCount).toBe(1);
  });

  test("bounds native participants per owner before asynchronous token work can fan out", async () => {
    const connector = new FakeConnector();
    const adapter = new DefaultLiveKitAgentMediaAdapter(livekit, connector, undefined, {
      maxRooms: 2,
      maxRoomsPerOwner: 1,
    });
    const fake = fakeSession();
    await adapter.accept(bootstrap, async () => fake.session);
    await expect(adapter.accept({
      ...bootstrap,
      roomName: "vox-1123456789abcdef0123456789abcdef",
      participantIdentity: "web-1123456789abcdef0123456789abcdef",
    }, async () => fake.session)).rejects.toBeInstanceOf(LiveKitAdapterCapacityError);
    await adapter.close();
  });

  test("times out a native connect and releases the claimed endpoint", async () => {
    class HangingEndpoint extends FakeEndpoint {
      override async connect(_token: string): Promise<void> {
        await new Promise<void>(() => {});
      }
    }
    let endpoint: HangingEndpoint | undefined;
    const connector: LiveKitRoomConnector = {
      create: options => {
        endpoint = new HangingEndpoint(options.handlers);
        return endpoint;
      },
    };
    const adapter = new DefaultLiveKitAgentMediaAdapter(livekit, connector, undefined, { connectTimeoutMs: 5 });
    await expect(adapter.accept(bootstrap, async () => fakeSession().session)).rejects.toThrow("timed out");
    expect(endpoint?.closeCount).toBe(1);
    await adapter.close();
  });

  test("publishes a structured admission refusal before closing the browser room", async () => {
    const connector = new FakeConnector();
    const adapter = new DefaultLiveKitAgentMediaAdapter(livekit, connector);
    const refusal = JSON.stringify({
      v: 1,
      sequence: 0,
      sessionId: "",
      timestampMs: 1,
      type: "command.rejected",
      reason: "session_capacity",
      commandType: "session.start",
      idempotencyKey: "start-1",
    });
    await adapter.accept(bootstrap, async () => {
      throw new LiveKitSessionAdmissionError(refusal);
    });
    const endpoint = connector.endpoint as FakeEndpoint;
    await expect(Promise.resolve(endpoint.handlers.participantReady(bootstrap.participantIdentity))).rejects
      .toBeInstanceOf(LiveKitSessionAdmissionError);
    expect(endpoint.controls).toEqual([refusal]);
    expect(endpoint.closeCount).toBe(1);
    await adapter.close();
  });
});
