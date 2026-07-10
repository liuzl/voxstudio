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
});
