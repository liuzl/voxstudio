import { describe, expect, test } from "bun:test";
import { writeWav } from "@voxstudio/audio";
import { parseConfig } from "@voxstudio/config";
import type { Fetch } from "@voxstudio/clients";
import type { PcmCapture } from "@voxstudio/platform-bun";
import { runListen, type ListenPlatform } from "./listen";

function frames(): AsyncIterable<{ samples: Float32Array; sampleRate: number; timestampMs: number }> {
  return (async function* () {
    yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 0 };
    yield { samples: new Float32Array(320), sampleRate: 16_000, timestampMs: 20 };
  })();
}

function response(): Uint8Array {
  return writeWav(new Float32Array(72_000).fill(0.1), 24_000);
}

describe("listen command", () => {
  test("runs one VAD-delimited headset turn through ASR, LLM, and streaming playback", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let captureClosed = false;
    let playerClosed = false;
    const played: number[] = [];
    const capture: PcmCapture = {
      frames: frames(),
      close: async () => { captureClosed = true; },
    };
    const platform: ListenPlatform = {
      capture: async () => capture,
      createPlayer: () => ({
        write: async audio => { played.push(audio.samples.length); },
        close: async () => { playerClosed = true; },
      }),
    };
    const fetch: Fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/audio/transcriptions") return Response.json({ text: "你好" });
      if (path === "/v1/chat/completions") {
        return Response.json({ choices: [{ message: { content: "你好，欢迎使用语音对话。" } }] });
      }
      if (path === "/v1/audio/speech") return new Response(new Uint8Array(response()));
      throw new Error(`unexpected path ${path}`);
    };
    const config = parseConfig({
      engines: {
        asr: { base_url: "http://asr.test" },
        llm: { base_url: "http://llm.test" },
        tts: { base_url: "http://tts.test" },
      },
    });

    await expect(runListen([
      "--barge-in", "--threshold", "0.1", "--min-speech-ms", "20", "--silence-ms", "20", "--voice", "demo",
    ], config, { out: line => output.push(line), err: line => errors.push(line) }, fetch, platform)).resolves.toBe(0);

    expect(output).toEqual(["transcript: 你好", "reply: 你好，欢迎使用语音对话。"]);
    expect(errors[0]).toContain("protected speaker mode");
    expect(played).toEqual([72_000]);
    expect(playerClosed).toBe(true);
    expect(captureClosed).toBe(true);
  });

  test("a brief spike during playback is recorded as a false barge-in, not an interruption", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const played: number[] = [];
    let releasePlayback = () => {};
    const playbackGate = new Promise<void>(resolve => { releasePlayback = resolve; });
    const capture: PcmCapture = {
      frames: (async function* () {
        // A real utterance: two voiced frames (40ms ≥ min-speech 40) then silence.
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 0 };
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 20 };
        yield { samples: new Float32Array(320), sampleRate: 16_000, timestampMs: 40 };
        // Wait until the reply is audibly playing, so the spike lands mid-playback.
        while (played.length === 0) await Bun.sleep(2);
        // A 20ms spike — residual echo, a keystroke — then silence: never confirmed.
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 60 };
        yield { samples: new Float32Array(320), sampleRate: 16_000, timestampMs: 80 };
        releasePlayback();
      })(),
      close: async () => {},
    };
    const platform: ListenPlatform = {
      capture: async () => capture,
      createPlayer: () => ({
        write: async audio => {
          played.push(audio.samples.length);
          await playbackGate;
        },
        close: async () => {},
      }),
    };
    const fetch: Fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/audio/transcriptions") return Response.json({ text: "你好" });
      if (path === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: "回答" } }] });
      if (path === "/v1/audio/speech") return new Response(new Uint8Array(response()));
      throw new Error(`unexpected path ${path}`);
    };
    const config = parseConfig({
      engines: {
        asr: { base_url: "http://asr.test" },
        llm: { base_url: "http://llm.test" },
        tts: { base_url: "http://tts.test" },
      },
    });

    await expect(runListen([
      "--barge-in", "--threshold", "0.1", "--min-speech-ms", "40", "--silence-ms", "20", "--voice", "demo",
    ], config, { out: line => output.push(line), err: line => errors.push(line) }, fetch, platform)).resolves.toBe(0);

    // The reply survived the spike: exactly one turn ran, and the false barge-in is visible.
    expect(output).toEqual(["transcript: 你好", "reply: 回答"]);
    expect(errors.some(line => line.includes("ignored a brief sound"))).toBe(true);
    expect(played).toEqual([72_000]);
  });

  test("validates realtime VAD and token options before opening the microphone", async () => {
    const config = parseConfig({});
    const platform: ListenPlatform = {
      capture: async () => { throw new Error("capture should not start"); },
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
    };
    const io = { out: () => {}, err: () => {} };
    await expect(runListen(["--max-tokens", "0"], config, io, globalThis.fetch, platform))
      .rejects.toThrow("positive integer");
    await expect(runListen(["--threshold", "-1"], config, io, globalThis.fetch, platform))
      .rejects.toThrow("non-negative");
  });
});
