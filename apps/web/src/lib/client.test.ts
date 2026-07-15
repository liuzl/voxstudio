import { describe, expect, test } from "bun:test";
import type { GatewayEvent } from "@voxstudio/realtime-gateway/protocol";
import { GatewayClient, type SocketLike } from "./client";

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
  const states: string[] = [];
  let keys = 0;
  const client = new GatewayClient({
    url: "ws://gateway.test/v1/realtime",
    startOptions: { language: "zh", bargeIn: true, playbackAck: true },
    onEvent: event => events.push(event),
    onAudio: samples => audio.push(samples),
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
  return { client, sockets, events, audio, states };
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

  test("every command carries a distinct idempotency key", () => {
    const { client, sockets } = makeClient();
    client.connect();
    const socket = sockets[0] as FakeSocket;
    socket.emit("open", {});
    client.interruptTurn("t-1");
    client.playbackComplete("t-1");
    const keys = socket.commands().map(command => command.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
