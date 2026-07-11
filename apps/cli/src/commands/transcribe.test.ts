import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@voxstudio/clients";
import { parseConfig } from "@voxstudio/config";
import type { CliIo } from "../io";
import { runTranscribe } from "./transcribe";

function output(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  return { io: { out: (line) => out.push(line), err: () => {} }, out };
}

describe("transcribe command", () => {
  test("uploads the audio and emits JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vox-transcribe-"));
    const path = join(dir, "sample.wav");
    await writeFile(path, "wav bytes");
    const fetch: Fetch = async (_input, init) => {
      const form = init?.body as FormData;
      expect(form.get("language")).toBe("zh");
      expect((form.get("file") as File).name).toBe("sample.wav");
      return Response.json({ text: "你好 <zh-CN>" });
    };
    const captured = output();
    await runTranscribe([path, "--language", "zh", "--json"], parseConfig(), captured.io, fetch);
    expect(JSON.parse(captured.out[0] as string)).toEqual({ text: "你好", lang: "zh" });
  });

  test("rejects missing files before the request", async () => {
    const fetch: Fetch = async () => { throw new Error("must not fetch"); };
    await expect(runTranscribe(["missing.wav"], parseConfig(), output().io, fetch))
      .rejects.toThrow("file not found");
  });

  test("longform selects its profile and requests structured output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vox-transcribe-"));
    const path = join(dir, "meeting.wav");
    await writeFile(path, "wav bytes");
    const config = parseConfig({
      engines: { asr_longform: { base_url: "https://moss.example", model: "moss" } },
    });
    const fetch: Fetch = async (input, init) => {
      expect(String(input)).toBe("https://moss.example/v1/audio/transcriptions");
      expect((init?.body as FormData).get("response_format")).toBe("verbose_json");
      return Response.json({
        text: "meeting",
        duration: 1.5,
        segments: [{ start: 0, end: 1.5, speaker: "S01", text: "meeting" }],
      });
    };
    const captured = output();
    await runTranscribe([path, "--mode", "longform", "--json"], config, captured.io, fetch);
    expect(JSON.parse(captured.out[0] as string)).toMatchObject({
      text: "meeting",
      segments: [{ speaker: "S01" }],
    });
  });
});
