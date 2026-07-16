import { describe, expect, test } from "bun:test";
import type { SpeechInput, SpeechRequest } from "@voxstudio/contracts";
import { writeWav } from "@voxstudio/audio";
import { AsrClient, EngineHttpError, LlmClient, TtsClient, type Fetch } from "./index";

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
}

describe("engine HTTP clients", () => {
  test("ASR sends multipart fields and parses leaked language tags", async () => {
    const fetch: Fetch = async (input, init) => {
      expect(String(input)).toBe("https://voice.example/v1/audio/transcriptions");
      expect(init?.method).toBe("POST");
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("nemotron-asr");
      expect(form.get("language")).toBe("zh");
      expect((form.get("file") as File).name).toBe("sample.wav");
      return json({ text: "你好 <zh-CN>" });
    };
    const client = new AsrClient({
      baseUrl: "https://voice.example/proxy",
      model: "nemotron-asr",
    }, fetch);

    await expect(client.transcribe(new Blob(["wav"]), "sample.wav", "zh"))
      .resolves.toEqual({ text: "你好", lang: "zh" });
  });

  test("ASR preserves structured long-form segments", async () => {
    const fetch: Fetch = async (_input, init) => {
      const form = init?.body as FormData;
      expect(form.get("response_format")).toBe("verbose_json");
      expect(form.get("max_new_tokens")).toBe("8192");
      return json({
        text: "你好 Hello",
        duration: 2.3,
        segments: [
          { id: 0, start: 0.2, end: 1.1, speaker: "S01", text: "你好" },
          { id: 1, start: 1.2, end: 2.3, speaker: "S02", text: "Hello" },
        ],
      });
    };
    const client = new AsrClient({ baseUrl: "https://voice.example", model: "moss" }, fetch);

    await expect(client.transcribe(new Blob(["wav"]), "sample.wav", "auto", {
      responseFormat: "verbose_json",
      maxNewTokens: 8192,
    })).resolves.toEqual({
      text: "你好 Hello",
      lang: null,
      duration: 2.3,
      segments: [
        { id: 0, start: 0.2, end: 1.1, speaker: "S01", text: "你好" },
        { id: 1, start: 1.2, end: 2.3, speaker: "S02", text: "Hello" },
      ],
    });
  });

  test("LLM preserves wire names and authorization", async () => {
    const fetch: Fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer secret");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "gemma",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32,
        temperature: 0.7,
      });
      return json({ choices: [{ message: { content: "reply" } }] });
    };
    const client = new LlmClient({
      baseUrl: "https://voice.example/",
      model: "gemma",
      apiKey: "secret",
    }, fetch);

    await expect(client.chat([{ role: "user", content: "hello" }], 32, 0.7))
      .resolves.toBe("reply");
  });

  test("TTS returns binary audio", async () => {
    const input: SpeechInput = {
      input: "hello",
      voice: "alice",
      response_format: "wav",
      cfg_value: 2,
      timesteps: 10,
    };
    const body: SpeechRequest = { ...input, model: "voxcpm2" };
    const fetch: Fetch = async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return new Response(new Uint8Array([1, 2, 3]));
    };
    const client = new TtsClient({ baseUrl: "https://voice.example", model: "voxcpm2" }, fetch);

    expect(new Uint8Array(await client.speech(input))).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("forwards caller cancellation signals to realtime-capable requests", async () => {
    const controller = new AbortController();
    const fetch: Fetch = async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return json({ choices: [{ message: { content: "reply" } }] });
    };
    const client = new LlmClient({ baseUrl: "https://voice.example", model: "gemma" }, fetch);
    await expect(client.chat([{ role: "user", content: "hello" }], undefined, undefined, controller.signal))
      .resolves.toBe("reply");
  });

  test("chatStream yields SSE deltas even when events split across network chunks", async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\ndata: {"choices":[{"delta":{"content":"。"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const bytes = new TextEncoder().encode(events);
    const fetch: Fetch = async (_input, init) => {
      expect((JSON.parse(String(init?.body)) as { stream?: boolean }).stream).toBe(true);
      // Split mid-event to prove reassembly.
      const cut = Math.floor(bytes.length / 3) + 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut));
          controller.enqueue(bytes.slice(cut));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    };
    const client = new LlmClient({ baseUrl: "https://voice.example", model: "gemma" }, fetch);
    const deltas: string[] = [];
    for await (const delta of client.chatStream([{ role: "user", content: "hi" }])) deltas.push(delta);
    expect(deltas).toEqual(["你好", "，世界", "。"]);
  });

  test("chatStream falls back to the whole reply when the engine answers with plain JSON", async () => {
    const fetch: Fetch = async () => json({ choices: [{ message: { content: "整段回复" } }] });
    const client = new LlmClient({ baseUrl: "https://voice.example", model: "gemma" }, fetch);
    const deltas: string[] = [];
    for await (const delta of client.chatStream([{ role: "user", content: "hi" }])) deltas.push(delta);
    expect(deltas).toEqual(["整段回复"]);
  });

  test("speechStream yields PCM pieces from a chunked audio/pcm response", async () => {
    // Two pieces whose byte boundary deliberately splits a float in half.
    const samples = Float32Array.from([0.1, -0.2, 0.3, -0.4, 0.5]);
    const bytes = new Uint8Array(samples.buffer.slice(0));
    const fetch: Fetch = async (_input, init) => {
      expect((JSON.parse(String(init?.body)) as { stream?: boolean }).stream).toBe(true);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 6));
          controller.enqueue(bytes.slice(6));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "audio/pcm", "x-sample-rate": "48000" },
      });
    };
    const client = new TtsClient({ baseUrl: "https://voice.example", model: "voxcpm2" }, fetch);
    const pieces: number[][] = [];
    for await (const piece of client.speechStream({
      input: "你好", voice: "laok", response_format: "wav", cfg_value: 2, timesteps: 10,
    })) {
      expect(piece.sampleRate).toBe(48_000);
      pieces.push([...piece.samples].map(value => Number(value.toFixed(1))));
    }
    expect(pieces.flat()).toEqual([0.1, -0.2, 0.3, -0.4, 0.5]);
    expect(pieces.length).toBeGreaterThan(1);
  });

  test("speechStream negotiates opus only when configured and a decoder is present", async () => {
    const bodies: string[] = [];
    const fetch: Fetch = async (_input, init) => {
      bodies.push(String(init?.body));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "audio/ogg" } });
    };
    const decoder = {
      async *decode(): AsyncIterable<{ samples: Float32Array; sampleRate: number }> {
        yield { samples: Float32Array.from([0.5]), sampleRate: 48_000 };
      },
    };
    const client = new TtsClient(
      { baseUrl: "https://voice.example", model: "voxcpm2", streamFormat: "opus" }, fetch, decoder);
    const pieces = [];
    for await (const piece of client.speechStream({
      input: "你好", voice: "laok", response_format: "wav", cfg_value: 2, timesteps: 10,
    })) pieces.push(piece);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.sampleRate).toBe(48_000);
    // The request asked for opus (overriding the batch response_format)...
    expect((JSON.parse(bodies[0] ?? "") as { response_format?: string }).response_format).toBe("opus");

    // ...but the same config WITHOUT a decoder must not: raw PCM, never a broken stream.
    const undecoded = new TtsClient(
      { baseUrl: "https://voice.example", model: "voxcpm2", streamFormat: "opus" },
      async (_input, init) => {
        bodies.push(String(init?.body));
        return new Response(new Uint8Array(writeWav(Float32Array.from([0.5]), 48_000)));
      });
    for await (const piece of undecoded.speechStream({
      input: "你好", voice: "laok", response_format: "wav", cfg_value: 2, timesteps: 10,
    })) pieces.push(piece);
    expect((JSON.parse(bodies[1] ?? "") as { response_format?: string }).response_format).toBe("wav");
  });

  test("speechStream degrades to one piece when the engine answers a whole WAV", async () => {
    const wav = writeWav(Float32Array.from([0.5, 0.5]), 48_000);
    const fetch: Fetch = async () => new Response(new Uint8Array(wav));
    const client = new TtsClient({ baseUrl: "https://voice.example", model: "voxcpm2" }, fetch);
    const pieces = [];
    for await (const piece of client.speechStream({
      input: "你好", voice: "laok", response_format: "wav", cfg_value: 2, timesteps: 10,
    })) pieces.push(piece);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.samples.length).toBe(2);
  });

  test("non-success responses throw normalized errors", async () => {
    const fetch: Fetch = async () => json({
      detail: { error: { code: "busy", message: "Try later", type: "capacity" } },
    }, { status: 429 });
    const client = new LlmClient({ baseUrl: "https://voice.example", model: "gemma" }, fetch);

    try {
      await client.chat([]);
      throw new Error("expected chat to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EngineHttpError);
      expect(error).toMatchObject({ status: 429, code: "busy", type: "capacity" });
    }
  });

  test("missing list endpoint is compatible with the C++ TTS server", async () => {
    const fetch: Fetch = async () => new Response(null, { status: 404 });
    const client = new TtsClient({ baseUrl: "https://voice.example", model: "voxcpm2" }, fetch);

    await expect(client.listVoices()).resolves.toEqual([]);
  });
});
