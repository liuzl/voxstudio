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
      "--timing",
    ], config, { out: line => output.push(line), err: line => errors.push(line) }, fetch, platform)).resolves.toBe(0);

    expect(output).toEqual(["transcript: 你好", "reply: 你好，欢迎使用语音对话。"]);
    // This platform offers no silero loader, so the certified default degrades loudly.
    expect(errors[0]).toContain("using the energy detector");
    expect(errors.some(line => line.includes("protected speaker mode"))).toBe(true);
    const timing = errors.find(line => line.startsWith("timing:"));
    expect(timing).toContain("vad_end");
    expect(timing).toContain("asr_done");
    expect(timing).toContain("playback_first");
    expect(timing).toContain("(completed)");
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

  test("speech while the reply is still audibly playing barges in and stops the player", async () => {
    const output: string[] = [];
    const played: number[] = [];
    let firstPlayerAborted = false;
    let players = 0;
    let releaseTail = () => {};
    const tailGate = new Promise<void>(resolve => { releaseTail = resolve; });
    const capture: PcmCapture = {
      frames: (async function* () {
        // First utterance → first reply starts playing.
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 0 };
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 20 };
        yield { samples: new Float32Array(320), sampleRate: 16_000, timestampMs: 40 };
        while (played.length === 0) await Bun.sleep(2);
        // All bytes are written but the tail is still audible (close is pending). Speaking
        // now must interrupt the reply, not open a turn beside it.
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 60 };
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 80 };
        yield { samples: new Float32Array(320), sampleRate: 16_000, timestampMs: 100 };
      })(),
      close: async () => {},
    };
    const platform: ListenPlatform = {
      capture: async () => capture,
      createPlayer: () => {
        const isFirst = ++players === 1;
        return {
          write: async audio => { played.push(audio.samples.length); },
          // The first reply's audible tail: close resolves only when playback would end.
          close: async () => { if (isFirst) await tailGate; },
          abort: async () => {
            if (isFirst) {
              firstPlayerAborted = true;
              releaseTail();
            }
          },
        };
      },
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
    ], config, { out: line => output.push(line), err: () => {} }, fetch, platform)).resolves.toBe(0);

    expect(firstPlayerAborted).toBe(true);
    // Both utterances were answered; the second one killed the first reply's tail.
    expect(output).toEqual(["transcript: 你好", "reply: 回答", "transcript: 你好", "reply: 回答"]);
  });

  test("runs a turn through the silero VAD when selected", async () => {
    const output: string[] = [];
    const windows: number[] = [];
    const capture: PcmCapture = {
      frames: (async function* () {
        // 512-sample windows: 4 voiced frames (1280 samples → 2 voiced windows), then
        // enough silence for the third window and the 64ms end-of-speech run.
        for (let index = 0; index < 4; index += 1) {
          yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: index * 20 };
        }
        for (let index = 4; index < 12; index += 1) {
          yield { samples: new Float32Array(320), sampleRate: 16_000, timestampMs: index * 20 };
        }
      })(),
      close: async () => {},
    };
    const platform: ListenPlatform = {
      capture: async () => capture,
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
      loadSileroVad: async () => ({
        windowSamples: 512,
        // A stand-in scorer: voiced when the window carries energy. The real model is
        // exercised by the platform loader against actual audio, not here.
        process: (window: Float32Array) => {
          windows.push(window.length);
          return window.some(sample => sample !== 0) ? 0.9 : 0.05;
        },
        reset: () => {},
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
      "--barge-in", "--vad", "silero", "--min-speech-ms", "64", "--silence-ms", "64", "--voice", "demo",
    ], config, { out: line => output.push(line), err: () => {} }, fetch, platform)).resolves.toBe(0);

    expect(windows.every(length => length === 512)).toBe(true);
    expect(output).toEqual(["transcript: 你好", "reply: 回答"]);
  });

  test("speculative turn-taking reopens a soft-ended turn and answers the merged utterance", async () => {
    const output: string[] = [];
    const asrBytes: number[] = [];
    let releaseFirstAsr = () => {};
    const firstAsrGate = new Promise<void>(resolve => { releaseFirstAsr = resolve; });
    const capture: PcmCapture = {
      frames: (async function* () {
        const voiced = () => new Float32Array(320).fill(0.2);
        const quiet = () => new Float32Array(320);
        // First clause: 60ms of speech, then 60ms of silence → soft end, dispatch.
        for (let index = 0; index < 3; index += 1) yield { samples: voiced(), sampleRate: 16_000, timestampMs: index * 20 };
        for (let index = 3; index < 6; index += 1) yield { samples: quiet(), sampleRate: 16_000, timestampMs: index * 20 };
        // The user keeps talking: this must reopen, not start a new turn.
        for (let index = 6; index < 9; index += 1) yield { samples: voiced(), sampleRate: 16_000, timestampMs: index * 20 };
        for (let index = 9; index < 12; index += 1) yield { samples: quiet(), sampleRate: 16_000, timestampMs: index * 20 };
        releaseFirstAsr();
      })(),
      close: async () => {},
    };
    const platform: ListenPlatform = {
      capture: async () => capture,
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
    };
    const fetch: Fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/audio/transcriptions") {
        const file = (init?.body as FormData).get("file") as File;
        asrBytes.push(file.size);
        // The first dispatch resolves only after the session moved on, proving the
        // superseded revision's result is discarded rather than spoken.
        if (asrBytes.length === 1) await firstAsrGate;
        return Response.json({ text: "你好" });
      }
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
      "--turn-taking", "speculative", "--reopen-ms", "2000",
      "--threshold", "0.1", "--min-speech-ms", "40", "--silence-ms", "60", "--voice", "demo",
    ], config, { out: line => output.push(line), err: () => {} }, fetch, platform)).resolves.toBe(0);

    // One reply, answering the complete utterance: the merged second dispatch carries
    // strictly more audio than the superseded first one.
    expect(output).toEqual(["transcript: 你好", "reply: 回答"]);
    expect(asrBytes).toHaveLength(2);
    expect(asrBytes[1] as number).toBeGreaterThan(asrBytes[0] as number);
  });

  test("resumed speech outside the reopen window starts a new turn instead", async () => {
    const asrBytes: number[] = [];
    const capture: PcmCapture = {
      frames: (async function* () {
        const voiced = () => new Float32Array(320).fill(0.2);
        const quiet = () => new Float32Array(320);
        for (let index = 0; index < 3; index += 1) yield { samples: voiced(), sampleRate: 16_000, timestampMs: index * 20 };
        for (let index = 3; index < 6; index += 1) yield { samples: quiet(), sampleRate: 16_000, timestampMs: index * 20 };
        for (let index = 6; index < 9; index += 1) yield { samples: voiced(), sampleRate: 16_000, timestampMs: index * 20 };
        for (let index = 9; index < 12; index += 1) yield { samples: quiet(), sampleRate: 16_000, timestampMs: index * 20 };
      })(),
      close: async () => {},
    };
    const platform: ListenPlatform = {
      capture: async () => capture,
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
    };
    const fetch: Fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/audio/transcriptions") {
        const file = (init?.body as FormData).get("file") as File;
        asrBytes.push(file.size);
        return Response.json({ text: "你好" });
      }
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
      "--turn-taking", "speculative", "--reopen-ms", "1",
      "--threshold", "0.1", "--min-speech-ms", "40", "--silence-ms", "60", "--voice", "demo",
    ], config, { out: () => {}, err: () => {} }, fetch, platform)).resolves.toBe(0);

    // Two independent dispatches of similar size: nothing was merged.
    expect(asrBytes).toHaveLength(2);
    expect(asrBytes[1] as number).toBeLessThan((asrBytes[0] as number) * 1.5);
  });

  test("pipelines a streaming reply: first sentence synthesizes before the model finishes", async () => {
    const output: string[] = [];
    const speechInputs: string[] = [];
    let releaseRest = () => {};
    const restGate = new Promise<void>(resolve => { releaseRest = resolve; });
    const capture: PcmCapture = {
      frames: (async function* () {
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 0 };
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 20 };
        yield { samples: new Float32Array(320), sampleRate: 16_000, timestampMs: 40 };
      })(),
      close: async () => {},
    };
    const platform: ListenPlatform = {
      capture: async () => capture,
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
    };
    const encoder = new TextEncoder();
    const event = (content: string) =>
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    const fetch: Fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/audio/transcriptions") return Response.json({ text: "你好" });
      if (path === "/v1/chat/completions") {
        // Sentence one and a partial of sentence two arrive, then the stream stalls until
        // sentence one has been synthesized — proving TTS did not wait for the completion.
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(event("第一句话说完了。第二句"));
            await restGate;
            controller.enqueue(event("话也说完了。"));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (path === "/v1/audio/speech") return new Response(new Uint8Array(response()));
      throw new Error(`unexpected path ${path}`);
    };
    const trackingFetch: Fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/audio/speech") {
        speechInputs.push((JSON.parse(String(init?.body)) as { input: string }).input);
        if (speechInputs.length === 1) releaseRest();
      }
      return fetch(input, init);
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
    ], config, { out: line => output.push(line), err: () => {} }, trackingFetch, platform)).resolves.toBe(0);

    // The gate only opens after speech request #1, so the pipeline must have synthesized
    // sentence one while the model still held sentence two.
    expect(speechInputs[0]).toBe("第一句话说完了。");
    expect(speechInputs.length).toBe(2);
    expect(output).toEqual(["transcript: 你好", "reply: 第一句话说完了。第二句话也说完了。"]);
  });

  test("synthesizes a tight first chunk so the reply starts speaking early", async () => {
    const speechInputs: string[] = [];
    const longReply = "第一句话说完了。第二句话也说完了。第三句话比较长，需要更多的时间来讲完整个内容。"
      + "第四句继续补充一些说明。第五句把剩下的内容全部讲完，保证总长度超过一个完整的合成块。";
    const capture: PcmCapture = {
      frames: (async function* () {
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 0 };
        yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: 20 };
        yield { samples: new Float32Array(320), sampleRate: 16_000, timestampMs: 40 };
      })(),
      close: async () => {},
    };
    const platform: ListenPlatform = {
      capture: async () => capture,
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
    };
    const fetch: Fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/audio/transcriptions") return Response.json({ text: "你好" });
      if (path === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: longReply } }] });
      if (path === "/v1/audio/speech") {
        speechInputs.push((JSON.parse(String(init?.body)) as { input: string }).input);
        return new Response(new Uint8Array(response()));
      }
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
    ], config, { out: () => {}, err: () => {} }, fetch, platform)).resolves.toBe(0);

    // ~2.5s of Mandarin is roughly 14 characters. The first chunk must be small — it is
    // the reply's time-to-first-audio — while later chunks grow back to full size.
    expect(speechInputs.length).toBeGreaterThanOrEqual(2);
    const first = Array.from(speechInputs[0] as string).length;
    const second = Array.from(speechInputs[1] as string).length;
    expect(first).toBeLessThanOrEqual(20);
    expect(second).toBeGreaterThan(first);
  });

  test("carries the conversation history into later turns", async () => {
    const requests: { role: string; content: string }[][] = [];
    const capture: PcmCapture = {
      frames: (async function* () {
        for (const base of [0, 100]) {
          yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: base };
          yield { samples: new Float32Array(320).fill(0.2), sampleRate: 16_000, timestampMs: base + 20 };
          yield { samples: new Float32Array(320), sampleRate: 16_000, timestampMs: base + 40 };
          // Let the first turn finish completely before the second utterance begins.
          while (requests.length < (base === 0 ? 1 : 2)) await Bun.sleep(2);
        }
      })(),
      close: async () => {},
    };
    const platform: ListenPlatform = {
      capture: async () => capture,
      createPlayer: () => ({ write: async () => {}, close: async () => {} }),
    };
    const fetch: Fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/audio/transcriptions") return Response.json({ text: "新加坡有多少华人？" });
      if (path === "/v1/chat/completions") {
        requests.push((JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }).messages);
        return Response.json({ choices: [{ message: { content: "大约三百万。" } }] });
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
      "--barge-in", "--threshold", "0.1", "--min-speech-ms", "40", "--silence-ms", "20", "--voice", "demo",
    ], config, { out: () => {}, err: () => {} }, fetch, platform)).resolves.toBe(0);

    expect(requests).toHaveLength(2);
    // The session tools ride every request, so the measured prompt rules lead as system.
    expect(requests[0]?.map(message => message.role)).toEqual(["system", "user"]);
    // The second turn sees the first exchange.
    expect(requests[1]?.map(message => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(requests[1]?.[2]?.content).toBe("大约三百万。");
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
    await expect(runListen(["--vad", "cnn"], config, io, globalThis.fetch, platform))
      .rejects.toThrow("energy or silero");
  });
});
