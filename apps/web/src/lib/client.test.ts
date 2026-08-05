import { describe, expect, test } from "bun:test";
import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import { encodePcm16 } from "@voxstudio/audio";
import { encodeMediaV2Frame, mediaV2FlagStart } from "@voxstudio/realtime-gateway/media-v2";
import { GatewayClient, type AudioFrameDelivery, type SocketLike } from "./client";

/** A scripted WebSocket: the test plays the server. */
class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  readonly sent: (string | ArrayBufferLike)[] = [];
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  send(data: string | ArrayBufferLike): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  emit(type: string, event: unknown): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event as { data: unknown });
  }

  serverEvent(payload: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify({ v: 1, sequence: 1, sessionId: "s-1", timestampMs: 0, ...payload }) });
  }

  commands(): Record<string, unknown>[] {
    return this.sent.filter((item): item is string => typeof item === "string").map(item => JSON.parse(item) as Record<string, unknown>);
  }
}

function makeClient(overrides: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const events: GatewayEvent[] = [];
  const audio: Float32Array[] = [];
  const deliveries: AudioFrameDelivery[] = [];
  const states: string[] = [];
  let keys = 0;
  const client = new GatewayClient({
    url: "ws://gateway.test/v1/realtime",
    startOptions: { language: "zh", bargeIn: true, playbackAck: true },
    onEvent: event => events.push(event),
    onAudio: (samples, delivery) => {
      audio.push(samples);
      deliveries.push(delivery);
    },
    onConnectionChange: state => states.push(state),
    makeSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    backoffMs: 1,
    newIdempotencyKey: () => `key-${++keys}`,
    ...overrides,
  });
  return { client, sockets, events, audio, deliveries, states };
}

describe("GatewayClient", () => {
  test("starts a session on first connect and dispatches events and audio", () => {
    const { client, sockets, events, audio } = makeClient();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.emit("open", {});

    const commands = socket.commands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      v: 1,
      type: "session.start",
      idempotencyKey: "key-1",
      options: { language: "zh", bargeIn: true, playbackAck: true },
    });

    socket.serverEvent({ type: "session.state", state: "listening", previous: "idle" });
    expect(events).toHaveLength(1);
    expect(client.currentSessionId).toBe("s-1");

    const pcm = new Float32Array([0.1, 0.2]);
    socket.emit("message", { data: pcm.buffer });
    expect(audio).toHaveLength(1);
    expect(audio[0]).toEqual(pcm);

    client.sendAudio(new Float32Array(320));
    expect(socket.sent.some(item => typeof item !== "string" && (item as ArrayBuffer).byteLength === 1280)).toBe(true);
  });

  test("reattaches with the stored sessionId after a drop, with a fresh idempotency key", async () => {
    const { client, sockets, states } = makeClient();
    client.connect();
    const first = sockets[0] as FakeSocket;
    first.emit("open", {});
    first.serverEvent({ type: "session.state", state: "listening", previous: "idle" });

    first.emit("close", {});
    expect(states.at(-1)).toBe("reconnecting");
    await Bun.sleep(5);

    const second = sockets[1] as FakeSocket;
    expect(second).toBeDefined();
    second.emit("open", {});
    const commands = second.commands();
    expect(commands[0]).toMatchObject({ type: "session.attach", sessionId: "s-1", idempotencyKey: "key-2" });
    expect(states.at(-1)).toBe("connected");
  });

  test("correlates an announced media frame with binary PCM and starts RTT pings", () => {
    const { client, sockets, deliveries } = makeClient({
      startOptions: { language: "zh", mediaTelemetry: true },
    });
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.emit("open", {});
    socket.serverEvent({ type: "command.accepted", commandType: "session.start", idempotencyKey: "key-1" });
    socket.serverEvent({
      type: "media.frame",
      frameId: 7,
      turnId: "t-1",
      revision: 0,
      codec: "pcm_f32le",
      sampleRate: 24_000,
      channels: 1,
      bytes: 8,
      audioMs: 1,
      producedAtMs: 10,
      enqueuedAtMs: 11,
    });
    socket.emit("message", { data: new Float32Array([0.1, 0.2]).buffer });

    socket.serverEvent({
      type: "media.frame", frameId: 8, turnId: "t-1", revision: 0, codec: "pcm_f32le",
      sampleRate: 24_000, channels: 1, bytes: 8, audioMs: 1, producedAtMs: 12, enqueuedAtMs: 13,
    });
    socket.serverEvent({
      type: "media.socket", frameId: 8, submittedAtMs: 14, sendResult: 0,
      highWaterBytes: 0, queuedBytes: 0, queuedAudioMs: 0, backpressured: false, dropped: true,
    });
    socket.serverEvent({
      type: "media.frame", frameId: 9, turnId: "t-1", revision: 0, codec: "pcm_f32le",
      sampleRate: 24_000, channels: 1, bytes: 8, audioMs: 1, producedAtMs: 15, enqueuedAtMs: 16,
    });
    socket.emit("message", { data: new Float32Array([0.3, 0.4]).buffer });

    expect(deliveries[0]?.frame?.frameId).toBe(7);
    expect(deliveries[1]?.frame?.frameId).toBe(9);
    expect(deliveries[0]?.decodedAtMs).toBeGreaterThanOrEqual(deliveries[0]?.receivedAtMs ?? Infinity);
    expect(socket.commands().some(command => command.type === "media.ping")).toBe(true);
    client.close();
  });

  test("waits for session acceptance before starting media pings", () => {
    const { client, sockets } = makeClient({
      startOptions: {
        language: "zh",
        mediaTelemetry: true,
        media: {
          version: 2,
          playback: [{ codec: "pcm_s16le", sampleRate: 24_000, channels: 1, packetDurationMs: 20 }],
        },
      },
    });
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.emit("open", {});
    // Media negotiation can finish before asynchronous VAD/session initialization. A
    // ping in this window used to produce the visible session_starting rejection.
    socket.serverEvent({
      type: "media.config",
      version: 2,
      playback: { codec: "pcm_s16le", sampleRate: 24_000, channels: 1, packetDurationMs: 20 },
    });
    expect(socket.commands().some(command => command.type === "media.ping")).toBe(false);
    socket.serverEvent({ type: "command.accepted", commandType: "session.start", idempotencyKey: "key-1" });
    expect(socket.commands().some(command => command.type === "media.ping")).toBe(true);
    client.close();
  });

  test("decodes negotiated Media v2 PCM16 and discards a superseded stream", () => {
    const offer = {
      version: 2,
      playback: [{ codec: "pcm_s16le", sampleRate: 24_000, channels: 1, packetDurationMs: 20 }],
    } as const;
    const { client, sockets, audio, deliveries } = makeClient({
      startOptions: { language: "zh", mediaTelemetry: true, media: offer },
    });
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.emit("open", {});
    const streamId = "00112233-4455-6677-8899-aabbccddeeff";
    socket.serverEvent({ type: "media.config", version: 2, playback: offer.playback[0] });
    socket.serverEvent({
      type: "playback.start",
      turnId: "turn-v2",
      revision: 0,
      streamId,
      ...offer.playback[0],
    });
    socket.serverEvent({
      type: "media.frame",
      frameId: 20,
      turnId: "turn-v2",
      revision: 0,
      codec: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1,
      bytes: 60,
      audioMs: 2 / 24,
      producedAtMs: 10,
      enqueuedAtMs: 11,
      streamId,
      mediaSequence: 0,
      timestampSamples: 0,
    });
    const expected = new Float32Array([0.25, -0.5]);
    const encoded = encodeMediaV2Frame({
      kind: "playback",
      codec: "pcm_s16le",
      flags: mediaV2FlagStart,
      streamId,
      sequence: 0,
      timestampSamples: 0n,
      durationSamples: expected.length,
      sampleRate: 24_000,
      channels: 1,
      payload: encodePcm16(expected),
    });
    socket.emit("message", { data: encoded.buffer });

    expect(audio).toHaveLength(1);
    expect(audio[0]?.[0]).toBeCloseTo(0.25, 4);
    expect(audio[0]?.[1]).toBeCloseTo(-0.5, 4);
    expect(deliveries[0]?.frame?.frameId).toBe(20);
    expect(deliveries[0]?.media).toEqual({
      streamId,
      sequence: 0,
      timestampSamples: 0,
      durationSamples: 2,
    });

    socket.serverEvent({
      type: "playback.start",
      turnId: "turn-new",
      revision: 0,
      streamId: "11112233-4455-6677-8899-aabbccddeeff",
      ...offer.playback[0],
    });
    socket.emit("message", { data: encoded.buffer });
    expect(audio).toHaveLength(1);
    client.close();
  });

  test("an expired session on reattach falls back to a fresh start", async () => {
    const { client, sockets } = makeClient();
    client.connect();
    const first = sockets[0] as FakeSocket;
    first.emit("open", {});
    first.serverEvent({ type: "session.state", state: "listening", previous: "idle" });
    first.emit("close", {});
    await Bun.sleep(5);

    const second = sockets[1] as FakeSocket;
    second.emit("open", {});
    second.serverEvent({ type: "command.rejected", reason: "unknown_session", commandType: "session.attach" });
    const commands = second.commands();
    expect(commands.map(command => command.type)).toEqual(["session.attach", "session.start"]);
  });

  test("intentional close stops reconnecting", async () => {
    const { client, sockets, states } = makeClient();
    client.connect();
    (sockets[0] as FakeSocket).emit("open", {});
    client.close();
    await Bun.sleep(10);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe("disconnected");
  });

  test("every command carries a distinct idempotency key", async () => {
    const { client, sockets } = makeClient();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.emit("open", {});
    const sending = client.sendText("typed hello");
    client.interruptTurn("t-1");
    client.playbackComplete("t-1");
    expect(socket.commands()).toContainEqual(expect.objectContaining({ type: "turn.text", text: "typed hello" }));
    const keys = socket.commands().map(command => command.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    const textKey = socket.commands().find(command => command.type === "turn.text")?.idempotencyKey;
    socket.serverEvent({ type: "command.accepted", commandType: "turn.text", idempotencyKey: textKey });
    await sending;
    client.close();
  });

  test("text submission waits for acceptance and rejects on refusal or disconnect", async () => {
    const { client, sockets } = makeClient();
    await expect(client.sendText("offline")).rejects.toThrow("conversation is not connected");

    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.emit("open", {});
    const rejected = client.sendText("keep this draft");
    const rejectedKey = socket.commands().find(command => command.type === "turn.text")?.idempotencyKey;
    socket.serverEvent({
      type: "command.rejected",
      commandType: "turn.text",
      idempotencyKey: rejectedKey,
      reason: "session_starting",
    });
    await expect(rejected).rejects.toThrow("command rejected: session_starting");

    const disconnected = client.sendText("also keep this draft");
    socket.emit("close", {});
    await expect(disconnected).rejects.toThrow("connection closed before the command was accepted");
    client.close();
  });
});
