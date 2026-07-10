import { describe, expect, test } from "bun:test";
import type { SpeechRequest } from "@voxstudio/contracts";
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
    const body: SpeechRequest = {
      input: "hello",
      model: "voxcpm2",
      voice: "alice",
      response_format: "wav",
      cfg_value: 2,
      timesteps: 10,
    };
    const fetch: Fetch = async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(body);
      return new Response(new Uint8Array([1, 2, 3]));
    };
    const client = new TtsClient({ baseUrl: "https://voice.example", model: "voxcpm2" }, fetch);

    expect(new Uint8Array(await client.speech(body))).toEqual(new Uint8Array([1, 2, 3]));
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
