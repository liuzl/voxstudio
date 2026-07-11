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

  test("longform emits speaker-labelled SRT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vox-transcribe-"));
    const path = join(dir, "meeting.wav");
    await writeFile(path, "wav bytes");
    const config = parseConfig({
      engines: { asr_longform: { base_url: "https://moss.example", model: "moss" } },
    });
    const fetch: Fetch = async () => Response.json({
      text: "meeting",
      segments: [{ start: 1.2, end: 2.345, speaker: "S01", text: "meeting" }],
    });
    const captured = output();
    await runTranscribe([path, "--mode", "longform", "--format", "srt"], config, captured.io, fetch);
    expect(captured.out).toEqual(["1\n00:00:01,200 --> 00:00:02,345\n[S01] meeting"]);
  });

  test("rejects SRT outside longform mode", async () => {
    await expect(runTranscribe(["sample.wav", "--format", "srt"], parseConfig(), output().io))
      .rejects.toThrow("requires --mode longform");
  });

  test("longform emits ASS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vox-transcribe-"));
    const path = join(dir, "meeting.wav");
    await writeFile(path, "wav bytes");
    const config = parseConfig({
      engines: { asr_longform: { base_url: "https://moss.example", model: "moss" } },
    });
    const fetch: Fetch = async () => Response.json({
      text: "meeting",
      segments: [{ start: 1.2, end: 2.345, speaker: "S01", text: "one\ntwo" }],
    });
    const captured = output();
    await runTranscribe([path, "--mode", "longform", "--format", "ass"], config, captured.io, fetch);
    expect(captured.out[0]).toContain("Dialogue: 0,0:00:01.20,0:00:02.35,Default,,0,0,0,,[S01] one\\Ntwo");
  });

  test("longform forwards an explicit generation budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vox-transcribe-"));
    const path = join(dir, "meeting.wav");
    await writeFile(path, "wav bytes");
    const config = parseConfig({
      engines: { asr_longform: { base_url: "https://moss.example", model: "moss" } },
    });
    const fetch: Fetch = async (_input, init) => {
      expect((init?.body as FormData).get("max_new_tokens")).toBe("65536");
      return Response.json({ text: "meeting", segments: [] });
    };
    await runTranscribe(
      [path, "--mode", "longform", "--max-new-tokens", "65536"],
      config,
      output().io,
      fetch,
    );
  });

  test("rejects generation budgets outside longform mode", async () => {
    await expect(runTranscribe(["sample.wav", "--max-new-tokens", "0"], parseConfig(), output().io))
      .rejects.toThrow("must be a positive integer");
    await expect(runTranscribe(["sample.wav", "--max-new-tokens", "100"], parseConfig(), output().io))
      .rejects.toThrow("requires --mode longform");
  });
});
