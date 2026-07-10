import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@voxstudio/clients";
import { parseConfig } from "@voxstudio/config";
import type { CliIo } from "../io";
import { runVoices, type VoicePlatform } from "./voices";

function output(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

async function audioFile(name = "reference.wav"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vox-voices-test-"));
  const path = join(directory, name);
  await writeFile(path, new Uint8Array([1, 2, 3, 4]));
  return path;
}

const config = parseConfig();

describe("voices command", () => {
  test("add transcribes omitted text and registers the voice", async () => {
    const path = await audioFile();
    const requests: Array<{ url: string; form: FormData }> = [];
    const fetch: Fetch = async (input, init) => {
      const url = String(input);
      const form = init?.body as FormData;
      requests.push({ url, form });
      if (url.includes("transcriptions")) return Response.json({ text: " 自动识别稿 <zh-CN> " });
      return Response.json({ id: "alice" });
    };
    const captured = output();
    await runVoices(["add", "alice", "--audio", path, "--language", "zh"], config, captured.io, fetch);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.form.get("language")).toBe("zh");
    expect(requests[1]?.form.get("text")).toBe("自动识别稿");
    expect((requests[1]?.form.get("audio") as File).name).toBe("reference.wav");
    expect(captured.err).toEqual(["ASR transcript (zh): 自动识别稿"]);
    expect(captured.out).toEqual(['{"id":"alice"}']);
  });

  test("explicit text skips ASR and dry-run skips TTS", async () => {
    let calls = 0;
    const fetch: Fetch = async () => { calls += 1; return Response.json({}); };
    const captured = output();
    await runVoices(["add", "alice", "--audio", "/missing.wav", "--text", " 人工稿 ", "--dry-run"],
      config, captured.io, fetch);
    expect(calls).toBe(0);
    expect(captured.out).toEqual(["人工稿"]);
  });

  test("successful recordings are removed", async () => {
    const path = await audioFile("recording.wav");
    const removed: string[] = [];
    const platform: VoicePlatform = {
      editText: async (text) => text,
      recordAudio: async () => path,
      removeRecording: async (recording) => { removed.push(recording); },
    };
    const fetch: Fetch = async () => Response.json({ id: "alice" });
    await runVoices(["add", "alice", "--record", "5", "--text", "稿件"],
      config, output().io, fetch, platform);
    expect(removed).toEqual([path]);
  });

  test("failed recordings are retained and reported", async () => {
    const path = await audioFile("recording.wav");
    let removed = false;
    const platform: VoicePlatform = {
      editText: async (text) => text,
      recordAudio: async () => path,
      removeRecording: async () => { removed = true; },
    };
    const captured = output();
    await expect(runVoices(["add", "alice", "--record", "--text", "  "],
      config, captured.io, undefined, platform)).rejects.toThrow("transcript is empty");
    expect(removed).toBeFalse();
    expect(captured.err).toEqual([`recording kept at ${path}`]);
  });

  test("list, show, and rm use their voice endpoints", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetch: Fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/v1/voices")) {
        return Response.json({ voices: [{ id: "alice", prompt_audio_length: 2.5 }] });
      }
      return Response.json({ id: "alice" });
    };
    const captured = output();
    await runVoices(["list"], config, captured.io, fetch);
    await runVoices(["show", "alice"], config, captured.io, fetch);
    await runVoices(["rm", "alice"], config, captured.io, fetch);
    expect(calls.map(({ method }) => method)).toEqual(["GET", "GET", "DELETE"]);
    expect(captured.out[0]).toContain("alice");
    expect(captured.out.at(-1)).toBe("deleted alice");
  });

  test("validates source and device combinations", async () => {
    await expect(runVoices(["add", "alice"], config, output().io)).rejects.toThrow("exactly one");
    await expect(runVoices(["add", "alice", "--audio", "x", "--device", "2"], config, output().io))
      .rejects.toThrow("--device requires --record");
    await expect(runVoices(["add", "alice", "--record", "-1"], config, output().io))
      .rejects.toThrow("duration must be non-negative");
  });
});
