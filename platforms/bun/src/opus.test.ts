import { describe, expect, test } from "bun:test";
import { ffmpegPcmDecoder } from "./opus";

const ffmpeg = Bun.which("ffmpeg");

describe("ffmpegPcmDecoder", () => {
  test("is absent without ffmpeg so callers fall back to raw PCM", () => {
    if (ffmpeg) {
      expect(ffmpegPcmDecoder()).toBeDefined();
    } else {
      expect(ffmpegPcmDecoder()).toBeUndefined();
    }
  });

  test.skipIf(!ffmpeg)("round-trips one second of tone through Ogg/Opus", async () => {
    // Encode a known 48kHz mono second with the same ffmpeg the decoder uses.
    const seconds = 1;
    const pcm = new Float32Array(48_000 * seconds);
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = 0.4 * Math.sin((2 * Math.PI * 440 * index) / 48_000);
    }
    const encoder = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "pipe:0",
        "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "pipe:1"],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    encoder.stdin.write(new Uint8Array(pcm.buffer));
    await encoder.stdin.end();
    const ogg = new Uint8Array(await new Response(encoder.stdout).arrayBuffer());
    expect(ogg.length).toBeGreaterThan(1_000);
    expect(ogg.length).toBeLessThan(pcm.byteLength / 10); // the point: ~30x smaller

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split at an arbitrary boundary to prove mid-page reassembly.
        controller.enqueue(ogg.slice(0, 1_500));
        controller.enqueue(ogg.slice(1_500));
        controller.close();
      },
    });
    const decoder = ffmpegPcmDecoder();
    if (!decoder) throw new Error("unreachable: ffmpeg present");
    let samples = 0;
    let peak = 0;
    for await (const piece of decoder.decode(body)) {
      expect(piece.sampleRate).toBe(48_000);
      samples += piece.samples.length;
      for (const value of piece.samples) peak = Math.max(peak, Math.abs(value));
    }
    // Opus pads with codec delay; the duration must be within ~100ms of the input.
    expect(Math.abs(samples - pcm.length)).toBeLessThan(4_800);
    expect(peak).toBeGreaterThan(0.2); // decoded audio, not silence
    expect(peak).toBeLessThan(0.6);
  });
});
