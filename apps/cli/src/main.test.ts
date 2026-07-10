import { describe, expect, test } from "bun:test";
import { parseConfig } from "@voxstudio/config";
import type { Fetch } from "@voxstudio/clients";
import { run, runHealth, type CliIo } from "./main";

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

describe("compiled CLI foundation", () => {
  test("health output is sorted and its exit code reflects failures", async () => {
    const config = parseConfig({
      engines: {
        tts: { base_url: "https://tts.test" },
        asr: { base_url: "https://asr.test" },
        llm: { base_url: "https://llm.test" },
      },
    });
    const fetch: Fetch = async (input) => new Response(null, {
      status: String(input).includes("llm") ? 503 : 200,
    });
    const output = capture();
    expect(await runHealth(config, output.io, fetch)).toBe(1);
    expect(output.out.map((line) => line.trimStart().split(/\s+/)[1]))
      .toEqual(["asr", "llm", "tts"]);
    expect(output.out[1]).toContain("FAIL");
  });

  test("global config is passed to the adapter", async () => {
    const output = capture();
    let explicit: string | undefined;
    const loader = async (options: { explicit?: string } = {}) => {
      explicit = options.explicit;
      return parseConfig();
    };
    const fetch: Fetch = async () => new Response("ok");
    expect(await run(["--config", "custom.yaml", "health"], output.io, loader, fetch)).toBe(0);
    expect(explicit).toBe("custom.yaml");
  });

  test("help and invalid invocations do not load config", async () => {
    const output = capture();
    const loader = async (): Promise<never> => { throw new Error("must not load"); };
    expect(await run(["--help"], output.io, loader)).toBe(0);
    expect(await run(["say", "--help"], output.io, loader)).toBe(0);
    expect(output.out.at(-1)).toContain("usage: vox say");
    expect(await run([], output.io, loader)).toBe(2);
  });

  test("async command failures are rendered without escaping the entry point", async () => {
    const output = capture();
    const loader = async () => parseConfig();
    expect(await run(["transcribe", "/tmp/voxstudio-missing-audio.wav"], output.io, loader))
      .toBe(1);
    expect(output.err).toEqual(["file not found: /tmp/voxstudio-missing-audio.wav"]);
  });
});
