import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWav, writeWav } from "@voxstudio/audio";
import type { Fetch } from "@voxstudio/clients";
import { parseConfig } from "@voxstudio/config";
import type { CliIo } from "../io";
import { runSay } from "./say";

function output(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

function config() {
  return parseConfig({
    chunking: { max_seconds: 0.4, first_max_seconds: 0.4, edge_pad_ms: 0 },
  });
}

function tone(): Uint8Array {
  const samples = new Float32Array(3_200);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.5 * Math.sin(2 * Math.PI * 220 * index / 8_000);
  }
  return writeWav(samples, 8_000);
}

describe("say command", () => {
  test("streams chunks to a valid output WAV", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vox-say-"));
    const path = join(dir, "speech.wav");
    const calls: string[] = [];
    const fetch: Fetch = async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)).input);
      return new Response(tone().buffer as ArrayBuffer);
    };
    const captured = output();
    await runSay(["甲。乙。丙。", "-o", path], config(), captured.io, fetch);

    expect(calls).toEqual(["甲。", "乙。", "丙。"]);
    const decoded = readWav(await Bun.file(path).arrayBuffer());
    expect(decoded.sampleRate).toBe(8_000);
    expect(decoded.samples.length).toBeGreaterThan(9_600);
    expect(captured.err.some((line) => line.includes("[1/3]"))).toBeTrue();
    expect(captured.err.some((line) => line === `wrote ${path}`)).toBeTrue();
  });

  test("file input wins and design selects the design voice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vox-say-file-"));
    const input = join(dir, "input.txt");
    const path = join(dir, "speech.wav");
    await writeFile(input, "文件内容");
    const calls: string[] = [];
    const fetch: Fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.input);
      expect(body.voice).toBe("design");
      return new Response(tone().buffer as ArrayBuffer);
    };
    await runSay(["ignored", "-f", input, "--design", "calm narrator", "-o", path, "-q"],
      config(), output().io, fetch);
    expect(calls).toEqual(["(calm narrator)文件", "(calm narrator)内容"]);
    expect(await Bun.file(path).exists()).toBeTrue();
  });

  test("empty text and invalid numeric options are rejected", async () => {
    await expect(runSay(["", "-o", "unused.wav"], config(), output().io))
      .rejects.toThrow("no text");
    await expect(runSay(["hello", "--cfg", "nan", "-o", "unused.wav"], config(), output().io))
      .rejects.toThrow("must be a number");
  });
});
