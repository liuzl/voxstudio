import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWav, writeWav } from "@voxstudio/audio";
import type { Fetch } from "@voxstudio/clients";
import { parseConfig } from "@voxstudio/config";
import type { CliIo } from "../io";
import { runChat } from "./chat";

function output(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

describe("chat command", () => {
  test("sends system, prompt, and max_tokens", async () => {
    const fetch: Fetch = async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "gemma",
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Hello" },
        ],
        max_tokens: 32,
      });
      return Response.json({ choices: [{ message: { content: "Reply" } }] });
    };
    const captured = output();
    expect(await runChat([
      "Hello", "--system", "Be concise", "--max-tokens", "32",
    ], parseConfig(), captured.io, fetch)).toBe(0);
    expect(captured.out).toEqual(["Reply"]);
  });

  test("speak sanitizes the reply and writes a WAV", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vox-chat-"));
    const path = join(dir, "reply.wav");
    const samples = new Float32Array(3_200);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = 0.5 * Math.sin(2 * Math.PI * 220 * index / 8_000);
    }
    const fetch: Fetch = async (input, init) => {
      if (String(input).endsWith("/v1/chat/completions")) {
        return Response.json({ choices: [{ message: { content: "你好👍" } }] });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.input).toBe("你好");
      expect(body.voice).toBe("alice");
      return new Response(writeWav(samples, 8_000).buffer as ArrayBuffer);
    };
    const captured = output();
    await runChat(["Hello", "--speak", "--voice", "alice", "-o", path],
      parseConfig(), captured.io, fetch);

    expect(readWav(await readFile(path)).sampleRate).toBe(8_000);
    expect(captured.err.some((line) => line.includes("dropped 1"))).toBeTrue();
    expect(captured.err.some((line) => line.includes(`wrote ${path}`))).toBeTrue();
  });

  test("empty model content is rejected", async () => {
    const fetch: Fetch = async () => Response.json({ choices: [{ message: {} }] });
    await expect(runChat(["Hello"], parseConfig(), output().io, fetch))
      .rejects.toThrow("empty content");
  });
});
