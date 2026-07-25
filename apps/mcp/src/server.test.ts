import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeWav, type PcmAudio } from "@voxstudio/audio";
import type { Fetch } from "@voxstudio/clients";
import { parseConfig } from "@voxstudio/config";
import type { PcmSink } from "@voxstudio/platform-bun";
import { createAgentVoiceServer, type AgentVoiceOptions } from "./server";

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    tts: { base_url: "http://tts.test" },
    llm: { base_url: "http://llm.test" },
  },
});

function engineFetch(overrides: Partial<Record<string, (request: Request) => Promise<Response>>> = {}): Fetch {
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    const path = new URL(request.url).pathname;
    const override = overrides[path];
    if (override) return override(request);
    if (path === "/v1/audio/transcriptions") return Response.json({ text: "你好" });
    if (path === "/v1/audio/speech") {
      return new Response(new Uint8Array(writeWav(new Float32Array(48_000).fill(0.1), 24_000)));
    }
    if (path === "/v1/voices") return Response.json({ voices: [{ id: "zf_001" }, { id: "zliu" }] });
    throw new Error(`unexpected engine path ${path}`);
  };
}

class CapturingSink implements PcmSink {
  seconds = 0;
  closed = false;
  constructor(private readonly events?: string[], private readonly tag?: string) {}
  async write(audio: PcmAudio): Promise<void> {
    if (this.seconds === 0) this.events?.push(`open:${this.tag}`);
    this.seconds += audio.samples.length / audio.sampleRate;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.events?.push(`close:${this.tag}`);
  }
}

async function connect(options: Partial<AgentVoiceOptions> & { fetch?: Fetch } = {}, sinks: CapturingSink[] = []) {
  const server = createAgentVoiceServer(config, {
    fetch: options.fetch ?? engineFetch(),
    createSink: options.createSink ?? (() => {
      const sink = new CapturingSink();
      sinks.push(sink);
      return sink;
    }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("agent voice server", () => {
  test("lists the seven tools with honest annotations and schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    expect([...byName.keys()].sort()).toEqual([
      "audit_profile", "delete_voice", "generate", "list_voices", "register_voice", "speak", "transcribe",
    ]);
    // Curation writes carry no readOnlyHint: a host's confirmation machinery applies.
    expect(byName.get("audit_profile")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("register_voice")?.annotations?.readOnlyHint).toBeUndefined();
    expect(byName.get("delete_voice")?.annotations?.readOnlyHint).toBeUndefined();
    expect(byName.get("generate")?.annotations?.readOnlyHint).toBeUndefined();
    // speak makes sound: not read-only, so a cautious client treats it as an action.
    expect(byName.get("speak")?.annotations?.readOnlyHint).toBeUndefined();
    expect(byName.get("transcribe")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("list_voices")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("speak")?.inputSchema).toMatchObject({
      type: "object",
      required: ["text"],
    });
    await client.close();
  });

  test("speak synthesizes into the sink and reports duration after playback", async () => {
    const sinks: CapturingSink[] = [];
    const client = await connect({}, sinks);
    const result = await client.callTool({ name: "speak", arguments: { text: "任务完成了。" } });
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(body.voice).toBe(config.ttsDefaults.voice);
    expect(body.duration_s).toBeCloseTo(2, 1);
    expect(sinks.length).toBe(1);
    expect(sinks[0]?.seconds).toBeCloseTo(2, 1);
    expect(sinks[0]?.closed).toBe(true);
    await client.close();
  });

  test("concurrent speaks serialize: one utterance owns the speakers at a time", async () => {
    const events: string[] = [];
    let tag = 0;
    const client = await connect({
      createSink: () => {
        tag += 1;
        return new CapturingSink(events, String(tag));
      },
    });
    const [first, second] = await Promise.all([
      client.callTool({ name: "speak", arguments: { text: "第一条。" } }),
      client.callTool({ name: "speak", arguments: { text: "第二条。" } }),
    ]);
    expect(payload(first).ok).toBe(true);
    expect(payload(second).ok).toBe(true);
    expect(events).toEqual(["open:1", "close:1", "open:2", "close:2"]);
    await client.close();
  });

  test("transcribe round-trips a wav file and passes the language hint", async () => {
    let heardLanguage = "";
    const client = await connect({
      fetch: engineFetch({
        "/v1/audio/transcriptions": async request => {
          heardLanguage = String((await request.formData()).get("language"));
          return Response.json({ text: "你好" });
        },
      }),
    });
    const path = `${process.env.TMPDIR ?? "/tmp"}/agent-voice-test-${Date.now()}.wav`;
    await Bun.write(path, writeWav(new Float32Array(16_000).fill(0.1), 16_000));
    const result = await client.callTool({ name: "transcribe", arguments: { path, language: "zh" } });
    // `lang` comes from engine-side tags the client parses, not the JSON field; text is the contract.
    expect(payload(result)).toMatchObject({ text: "你好" });
    expect(heardLanguage).toBe("zh");
    await client.close();
  });

  test("failures are structured refusals and the server keeps answering", async () => {
    const client = await connect({
      fetch: engineFetch({
        "/v1/audio/speech": async () => { throw new Error("tts down"); },
      }),
    });
    const missing = await client.callTool({ name: "transcribe", arguments: { path: "/no/such/file.wav" } });
    expect(missing.isError).toBe(true);

    const broken = await client.callTool({ name: "speak", arguments: { text: "喂喂。" } });
    expect(broken.isError).toBe(true);

    const voices = await client.callTool({ name: "list_voices", arguments: {} });
    expect(payload(voices)).toEqual({ voices: ["zf_001", "zliu"], default: config.ttsDefaults.voice });
    await client.close();
  });
});

describe("curation tools", () => {
  test("generate writes a wav where asked and reports it", async () => {
    const client = await connect();
    const path = `${process.env.TMPDIR ?? "/tmp"}/agent-voice-take-test-${Date.now()}.wav`;
    const result = payload(await client.callTool({ name: "generate", arguments: { text: "你好。", output_path: path } }));
    expect(result).toMatchObject({ ok: true, path });
    expect(await Bun.file(path).exists()).toBe(true);
    expect((result.bytes as number)).toBeGreaterThan(44);
    await Bun.file(path).delete();
    await client.close();
  });

  test("register_voice transcribes when no text is given and posts the clone", async () => {
    const registered: { id: string; text: string }[] = [];
    const client = await connect({
      fetch: engineFetch({
        "/v1/voices": async request => {
          if (request.method === "POST") {
            const form = await request.formData();
            registered.push({ id: String(form.get("id")), text: String(form.get("text")) });
            return Response.json({ id: String(form.get("id")) });
          }
          return Response.json({ voices: [{ id: "zf_001" }] });
        },
      }),
    });
    const path = `${process.env.TMPDIR ?? "/tmp"}/agent-voice-clone-test-${Date.now()}.wav`;
    await Bun.write(path, writeWav(new Float32Array(16_000).fill(0.1), 16_000));
    const result = payload(await client.callTool({ name: "register_voice", arguments: { id: "clone-x", audio_path: path } }));
    expect(result).toMatchObject({ ok: true, id: "clone-x", transcript: "你好" });
    expect(registered).toEqual([{ id: "clone-x", text: "你好" }]);
    const bad = await client.callTool({ name: "register_voice", arguments: { id: "坏 id", audio_path: path } });
    expect(bad.isError).toBe(true);
    await Bun.file(path).delete();
    await client.close();
  });

  test("audit_profile maps clone/design/runtime through the shared verdict", async () => {
    const client = await connect({
      fetch: engineFetch({
        "/v1/voices/design-x": async () => Response.json({
          id: "design-x", design_profile: { description: "d", seed: 1, cfg_value: 2, timesteps: 10, model: "m1", model_manifest_sha256: "aaa", audio_sha256: "bbb" },
        }),
        "/health": async () => Response.json({ status: "ok", model: "m1", model_manifest_sha256: "aaa" }),
      }),
    });
    const verdict = payload(await client.callTool({ name: "audit_profile", arguments: { profile: "design-x" } }));
    expect(verdict).toMatchObject({ status: "ok", model: "m1" });
    await client.close();
  });

  test("delete_voice forwards and refuses bad ids", async () => {
    const deleted: string[] = [];
    const client = await connect({
      fetch: engineFetch({
        "/v1/voices/old-voice": async request => {
          if (request.method === "DELETE") { deleted.push("old-voice"); return Response.json({ id: "old-voice", deleted: true }); }
          return Response.json({ id: "old-voice" });
        },
      }),
    });
    const result = payload(await client.callTool({ name: "delete_voice", arguments: { id: "old-voice" } }));
    expect(result).toMatchObject({ ok: true, deleted: true });
    expect(deleted).toEqual(["old-voice"]);
    const bad = await client.callTool({ name: "delete_voice", arguments: { id: "bad id" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
