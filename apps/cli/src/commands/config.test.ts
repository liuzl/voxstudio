import { describe, expect, test } from "bun:test";
import { parseConfig } from "@voxstudio/config";
import { runConfig } from "./config";

describe("config command", () => {
  test("prints resolved engines and chunking", () => {
    const out: string[] = [];
    runConfig(["validate"], parseConfig({ engines: { tts: { base_url: "http://tts", model: "model" } } }),
      { out: line => out.push(line), err: () => {} });
    expect(out).toContain("tts\thttp://tts\tmodel");
    expect(out.at(-1)).toContain("chunking\tmax=15s");
  });

  test("rejects unknown operations", () => {
    expect(() => runConfig([], parseConfig(), { out: () => {}, err: () => {} })).toThrow("expected validate");
  });
});
