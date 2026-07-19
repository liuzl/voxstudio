import { afterEach, describe, expect, test } from "bun:test";
import { decodePcm16, encodePcm16, writeWav } from "@voxstudio/audio";
import { parseConfig } from "@voxstudio/config";
import type { Fetch } from "@voxstudio/clients";
import { startGateway, type GatewayServer } from "./server";

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    llm: { base_url: "http://llm.test" },
    tts: { base_url: "http://tts.test" },
  },
});

function engineFetch(overrides: Partial<Record<string, (request: Request) => Promise<Response>>> = {}): Fetch {
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    const path = new URL(request.url).pathname;
    const override = overrides[path];
    if (override) return override(request);
    if (path === "/v1/audio/transcriptions") return Response.json({ text: "你好" });
    if (path === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: "回答完毕。" } }] });
    if (path === "/v1/audio/speech") {
      return new Response(new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000)));
    }
    if (path === "/v1/voices") return Response.json({ voices: [] });
    throw new Error(`unexpected engine path ${path}`);
  };
}

type OaiEvent = Record<string, unknown> & { type: string };

/** A client speaking the OpenAI Realtime wire shape: JSON only, audio as base64 PCM16@24k. */
class OaiClient {
  readonly events: OaiEvent[] = [];
  private readonly socket: WebSocket;
  private wake: (() => void) | undefined;
  private readonly opened: Promise<void>;
  readonly closed: Promise<void>;

  constructor(url: string, query = "?model=gpt-realtime") {
    this.socket = new WebSocket(new URL(`/v1/realtime${query}`, url).toString().replace(/^http/, "ws"));
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error("websocket error")));
    });
    this.closed = new Promise(resolve => {
      this.socket.addEventListener("close", () => {
        resolve();
        this.wake?.();
      });
    });
    this.socket.addEventListener("message", event => {
      this.events.push(JSON.parse(event.data as string) as OaiEvent);
      this.wake?.();
    });
  }

  async ready(): Promise<void> {
    await this.opened;
  }

  send(payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(payload));
  }

  /** `count` chunks of 20ms PCM16@24kHz at the given amplitude, as append events. */
  speak(count: number, amplitude: number): void {
    for (let index = 0; index < count; index += 1) {
      const pcm = encodePcm16(new Float32Array(480).fill(amplitude));
      this.send({ type: "input_audio_buffer.append", audio: Buffer.from(pcm).toString("base64") });
    }
  }

  ofType(type: string): OaiEvent[] {
    return this.events.filter(event => event.type === type);
  }

  async until(predicate: (events: OaiEvent[]) => boolean, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; saw: ${this.events.map(event => event.type).join(", ")}`);
      }
      await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, 50); });
      this.wake = undefined;
    }
  }

  close(): void {
    this.socket.close();
  }
}

/** The audio-turn choreography every test starts with: configure, speak, go silent. */
async function runTurn(client: OaiClient, session: Record<string, unknown> = {}): Promise<void> {
  await client.ready();
  await client.until(events => events.some(event => event.type === "session.created"), "session.created");
  client.send({
    type: "session.update",
    session: { turn_detection: { type: "server_vad", silence_duration_ms: 30 }, ...session },
  });
  await client.until(events => events.some(event => event.type === "session.updated"), "session.updated");
  client.speak(25, 0.2);
  client.speak(15, 0);
  await client.until(events => events.some(event => event.type === "response.done"), "response.done", 10_000);
}

let gateway: GatewayServer | undefined;

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
});

describe("openai realtime adapter", () => {
  test("an audio turn speaks the GA wire shape end to end", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const client = new OaiClient(gateway.url);
    await runTurn(client, { instructions: "你是助理", voice: "demo" });

    // The server speaks first, and every event is enveloped with an event_id.
    expect(client.events[0]?.type).toBe("session.created");
    for (const event of client.events) expect(typeof event.event_id).toBe("string");
    const created = client.events[0] as { session?: { id?: string; audio?: { input?: { turn_detection?: { type?: string } } } } };
    expect(created.session?.id).toStartWith("sess_");
    expect(created.session?.audio?.input?.turn_detection?.type).toBe("server_vad");

    const types = client.events.map(event => event.type);
    for (const expected of [
      "input_audio_buffer.speech_started",
      "input_audio_buffer.speech_stopped",
      "input_audio_buffer.committed",
      "conversation.item.added",
      "conversation.item.input_audio_transcription.completed",
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_audio_transcript.delta",
      "response.output_audio.delta",
      "response.output_audio_transcript.done",
      "response.output_audio.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.done",
    ]) expect(types).toContain(expected);

    // The user item threads through: speech_started names the item transcription lands on.
    const started = client.ofType("input_audio_buffer.speech_started")[0] as { item_id?: string };
    const transcription = client.ofType("conversation.item.input_audio_transcription.completed")[0] as { item_id?: string; transcript?: string };
    expect(transcription.item_id).toBe(started.item_id as string);
    expect(transcription.transcript).toBe("你好");

    const transcriptDone = client.ofType("response.output_audio_transcript.done")[0] as { transcript?: string };
    expect(transcriptDone.transcript).toBe("回答完毕。");

    // Audio deltas decode back to the fake engine's 0.1-amplitude PCM at the wire rate.
    const deltas = client.ofType("response.output_audio.delta") as { delta?: string }[];
    const samples = deltas.flatMap(event => [...decodePcm16(new Uint8Array(Buffer.from(event.delta as string, "base64")))]);
    expect(samples.length).toBeGreaterThan(24_000);
    expect(Math.abs((samples[1_000] as number) - 0.1)).toBeLessThan(0.01);

    const done = client.ofType("response.done")[0] as { response?: { status?: string; output?: { type?: string }[] } };
    expect(done.response?.status).toBe("completed");
    expect(done.response?.output?.[0]?.type).toBe("message");

    client.close();
  });

  test("a declared function tool round-trips: call out, output in, spoken continuation", async () => {
    let chatRound = 0;
    const chatBodies: { messages: { role: string; content?: string }[] }[] = [];
    gateway = startGateway({
      config,
      port: 0,
      fetch: engineFetch({
        "/v1/chat/completions": async request => {
          chatRound += 1;
          chatBodies.push(await request.json() as typeof chatBodies[number]);
          if (chatRound === 1) {
            return Response.json({ choices: [{ message: { content: "", tool_calls: [
              { id: "c1", type: "function", function: { name: "get_time", arguments: "{\"zone\":\"utc\"}" } },
            ] } }] });
          }
          return Response.json({ choices: [{ message: { content: "现在是中午。" } }] });
        },
      }),
    });
    const client = new OaiClient(gateway.url);
    await client.ready();
    client.send({
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad", silence_duration_ms: 30 },
        tools: [{ type: "function", name: "get_time", description: "当前时间", parameters: { type: "object", properties: {} } }],
      },
    });
    await client.until(events => events.some(event => event.type === "session.updated"), "session.updated");
    client.speak(25, 0.2);
    client.speak(15, 0);

    // The model's function call arrives as a completed response carrying the call.
    await client.until(events => events.some(event => event.type === "response.function_call_arguments.done")
      && events.some(event => event.type === "response.done"), "function call");
    const call = client.ofType("response.function_call_arguments.done")[0] as { call_id?: string; name?: string; arguments?: string };
    expect(call.name).toBe("get_time");
    expect(JSON.parse(call.arguments as string)).toEqual({ zone: "utc" });
    const callDone = client.ofType("response.done")[0] as { response?: { output?: { type?: string; call_id?: string }[] } };
    expect(callDone.response?.output?.[0]?.type).toBe("function_call");

    // The client answers and triggers the continuation, OpenAI-flow style.
    client.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.call_id, output: "{\"time\":\"12:00\"}" },
    });
    client.send({ type: "response.create" });
    await client.until(events => events.filter(event => event.type === "response.done").length >= 2, "continuation", 10_000);

    // The loop refed the client's output verbatim into round two.
    const toolMessage = chatBodies[1]?.messages.find(message => message.role === "tool");
    expect(toolMessage?.content).toBe("{\"time\":\"12:00\"}");
    const transcriptDone = client.ofType("response.output_audio_transcript.done")[0] as { transcript?: string };
    expect(transcriptDone.transcript).toBe("现在是中午。");
    expect(client.ofType("conversation.item.done").length).toBe(1);
    expect(client.ofType("error").length).toBe(0);

    client.close();
  });

  test("a client that never answers a function call gets a structured timeout, not a wedged turn", async () => {
    let chatRound = 0;
    const chatBodies: { messages: { role: string; content?: string }[] }[] = [];
    gateway = startGateway({
      config,
      port: 0,
      openAiFunctionCallTimeoutMs: 200,
      fetch: engineFetch({
        "/v1/chat/completions": async request => {
          chatRound += 1;
          chatBodies.push(await request.json() as typeof chatBodies[number]);
          if (chatRound === 1) {
            return Response.json({ choices: [{ message: { content: "", tool_calls: [
              { id: "c1", type: "function", function: { name: "get_time", arguments: "{}" } },
            ] } }] });
          }
          return Response.json({ choices: [{ message: { content: "我没拿到时间。" } }] });
        },
      }),
    });
    const client = new OaiClient(gateway.url);
    await client.ready();
    client.send({
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad", silence_duration_ms: 30 },
        tools: [{ name: "get_time", parameters: { type: "object", properties: {} } }],
      },
    });
    await client.until(events => events.some(event => event.type === "session.updated"), "session.updated");
    client.speak(25, 0.2);
    client.speak(15, 0);

    await client.until(events => events.filter(event => event.type === "response.done").length >= 2, "timeout continuation", 10_000);
    const toolMessage = chatBodies[1]?.messages.find(message => message.role === "tool");
    expect(toolMessage?.content).toContain("did not return a function_call_output");
    const transcriptDone = client.ofType("response.output_audio_transcript.done")[0] as { transcript?: string };
    expect(transcriptDone.transcript).toBe("我没拿到时间。");

    client.close();
  });

  test("subset boundaries answer with typed errors, not silence or crashes", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const client = new OaiClient(gateway.url);
    await client.ready();
    await client.until(events => events.some(event => event.type === "session.created"), "session.created");

    client.send({ type: "session.update", session: { turn_detection: { type: "semantic_vad" } } });
    client.send({ type: "input_audio_buffer.commit" });
    client.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } });
    client.send({ type: "response.create" });
    client.send({ type: "session.update", session: { tools: [{ name: "set_voice", parameters: {} }] } });
    await client.until(events => events.filter(event => event.type === "error").length >= 5
      && events.filter(event => event.type === "session.updated").length >= 2, "errors and acknowledgements");

    const codes = (client.ofType("error") as { error?: { code?: string } }[]).map(event => event.error?.code);
    expect(codes).toContain("invalid_session_update");
    expect(codes).toContain("unsupported_commit");
    expect(codes).toContain("unsupported_item");
    expect(codes).toContain("unsupported_response_create");
    // The reserved built-in tool name was refused; session.updated still answered each update.
    expect(codes.filter(code => code === "invalid_session_update").length).toBe(2);
    expect(client.ofType("session.updated").length).toBe(2);

    client.close();
  });

  test("dialect detection: no ?model= stays native, ?protocol=openai opts in explicitly", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0 });
    const explicit = new OaiClient(gateway.url, "?protocol=openai");
    await explicit.ready();
    await explicit.until(events => events.some(event => event.type === "session.created"), "session.created");
    explicit.close();

    // A native connection gets no unsolicited frames — its server never speaks first.
    const native = new OaiClient(gateway.url, "");
    await native.ready();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(native.events.length).toBe(0);
    native.close();
  });
});

describe("openai adapter beside MCP tools", () => {
  test("a client-declared function shadows a same-named MCP tool: the call routes to the client", async () => {
    let chatRound = 0;
    const mcpConfig = parseConfig({
      engines: {
        asr: { base_url: "http://asr.test" },
        llm: { base_url: "http://llm.test" },
        tts: { base_url: "http://tts.test" },
      },
      mcp_servers: { memo: { command: "bun", args: ["packages/mcp/tools/memo-server.ts"] } },
    });
    gateway = startGateway({
      config: mcpConfig,
      port: 0,
      fetch: engineFetch({
        "/v1/chat/completions": async () => {
          chatRound += 1;
          if (chatRound === 1) {
            return Response.json({ choices: [{ message: { content: "", tool_calls: [
              { id: "c1", type: "function", function: { name: "add_memo", arguments: "{\"content\":\"买牛奶\"}" } },
            ] } }] });
          }
          return Response.json({ choices: [{ message: { content: "已记下。" } }] });
        },
      }),
    });
    const client = new OaiClient(gateway.url);
    await client.ready();
    client.send({
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad", silence_duration_ms: 30 },
        tools: [{ type: "function", name: "add_memo", description: "客户端自己的备忘工具", parameters: { type: "object", properties: { content: { type: "string" } } } }],
      },
    });
    await client.until(events => events.some(event => event.type === "session.updated"), "session.updated");
    client.speak(25, 0.2);
    client.speak(15, 0);

    // The client's declaration wins: the call comes out as a function_call round-trip,
    // never a silent server-side MCP execution.
    await client.until(events => events.some(event => event.type === "response.function_call_arguments.done")
      && events.some(event => event.type === "response.done"), "function call routed to the client", 15_000);
    const call = client.ofType("response.function_call_arguments.done")[0] as { call_id?: string; name?: string };
    expect(call.name).toBe("add_memo");
    client.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.call_id, output: "{\"ok\":true}" },
    });
    client.send({ type: "response.create" });
    await client.until(events => events.filter(event => event.type === "response.done").length >= 2, "continuation", 15_000);
    expect(client.ofType("error").length).toBe(0);
    // Settle the close handshake before afterEach stops the gateway: stopping while the
    // close is in flight trips the Bun force-stop hang the server now bounds.
    client.close();
    await client.closed;
  }, 15_000);
});

describe("openai adapter capacity guardrail", () => {
  test("a start over capacity answers a structured error and closes", async () => {
    gateway = startGateway({ config, fetch: engineFetch(), port: 0, maxSessions: 0 });
    const client = new OaiClient(gateway.url);
    await client.ready();
    client.speak(1, 0.2);
    await client.until(events => events.some(event => event.type === "error"), "capacity error");
    const error = client.ofType("error")[0] as { error?: { code?: string } };
    expect(error.error?.code).toBe("session_capacity");
    await client.closed;
  });
});
