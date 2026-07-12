import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWav, writeWav } from "@voxstudio/audio";
import type { Fetch } from "@voxstudio/clients";
import { parseConfig } from "@voxstudio/config";
import type { CliIo } from "../io";
import { runReply } from "./reply";

test("runs one ASR to LLM to TTS voice reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vox-reply-"));
  const audioPath = join(directory, "question.wav");
  const outputPath = join(directory, "answer.wav");
  await writeFile(audioPath, writeWav(new Float32Array(4_800).fill(0.1), 48_000));
  const samples = new Float32Array(4_800).fill(0.1);
  const fetch: Fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/v1/audio/transcriptions")) {
      const form = init?.body as FormData;
      expect(form.get("language")).toBe("zh");
      return Response.json({ text: "你好，今天怎么样？", lang: "zh" });
    }
    if (endpoint.endsWith("/v1/chat/completions")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "gemma",
        messages: [
          { role: "system", content: "简短回答" },
          { role: "user", content: "你好，今天怎么样？" },
        ],
        max_tokens: 32,
      });
      return Response.json({ choices: [{ message: { content: "我很好，谢谢。" } }] });
    }
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual(expect.objectContaining({ input: "我很好，谢谢。", voice: "design-calm-clear", prosody_prompt: true }));
    return new Response(writeWav(samples, 48_000).slice().buffer);
  };
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: line => out.push(line), err: line => err.push(line) };
  try {
    expect(await runReply([
      audioPath, "--language", "zh", "--system", "简短回答", "--max-tokens", "32",
      "--voice", "design-calm-clear", "-o", outputPath,
    ], parseConfig(), io, fetch)).toBe(0);
    expect(out).toEqual(["transcript: 你好，今天怎么样？", "我很好，谢谢。"]);
    expect(readWav(await readFile(outputPath)).sampleRate).toBe(48_000);
    expect(err.some(line => line.includes(`wrote ${outputPath}`))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
