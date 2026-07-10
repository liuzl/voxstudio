import { describe, expect, test } from "bun:test";
import type {
  ChatCompletionRequest,
  NormalizedEngineError,
  SpeechRequest,
  Transcription,
} from "./index";

describe("engine contracts", () => {
  test("retain the wire names used by OpenAI-compatible engines", () => {
    const speech: SpeechRequest = {
      input: "你好",
      model: "voxcpm2",
      voice: "alice",
      response_format: "wav",
      cfg_value: 2,
      timesteps: 10,
    };
    const chat: ChatCompletionRequest = {
      model: "gemma",
      messages: [{ role: "user", content: "你好" }],
      max_tokens: 4096,
    };

    expect(speech.response_format).toBe("wav");
    expect(chat.max_tokens).toBe(4096);
  });

  test("represent nullable language and normalized errors explicitly", () => {
    const transcription: Transcription = { text: "bare text", lang: null };
    const error: NormalizedEngineError = {
      status: 502,
      code: "engine_error",
      message: "bad gateway",
    };

    expect(transcription.lang).toBeNull();
    expect(error.status).toBe(502);
  });
});
