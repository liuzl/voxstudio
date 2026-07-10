import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWav } from "@voxstudio/audio";
import { loadConfig, readFileBlob, WavFileSink, writeBytes } from "./index";

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "voxstudio-config-"));
}

describe("Bun config adapter", () => {
  test("loads the working-directory YAML and expands environment", async () => {
    const cwd = await directory();
    await writeFile(join(cwd, "voxstudio.yaml"), `
engines:
  tts:
    base_url: http://example.test
    api_key: \${TEST_KEY}
`);
    const config = await loadConfig({ cwd, home: cwd, env: { TEST_KEY: "secret" } });
    expect(config.engines.tts).toMatchObject({ baseUrl: "http://example.test", apiKey: "secret" });
  });

  test("falls back to the home config and honors an explicit path", async () => {
    const cwd = await directory();
    const home = await directory();
    const homeConfig = join(home, ".config", "voxstudio", "config.yaml");
    await mkdir(join(home, ".config", "voxstudio"), { recursive: true });
    await writeFile(homeConfig, "engines:\n  llm:\n    model: from-home\n");
    expect((await loadConfig({ cwd, home, env: {} })).engines.llm?.model).toBe("from-home");

    const explicit = join(cwd, "custom.yaml");
    await writeFile(explicit, "engines:\n  llm:\n    model: explicit\n");
    expect((await loadConfig({ explicit, cwd, home, env: {} })).engines.llm?.model).toBe("explicit");
  });

  test("missing explicit files fail while no config uses defaults", async () => {
    const cwd = await directory();
    await expect(loadConfig({ explicit: "missing.yaml", cwd, home: cwd, env: {} }))
      .rejects.toThrow("config not found: missing.yaml");
    expect((await loadConfig({ cwd, home: cwd, env: {} })).engines.tts?.model).toBe("voxcpm2");
  });

  test("reads files as blobs and writes binary output", async () => {
    const cwd = await directory();
    const path = join(cwd, "audio.bin");
    await writeBytes(path, new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await (await readFileBlob(path)).arrayBuffer()))
      .toEqual(new Uint8Array([1, 2, 3]));
    await expect(readFileBlob(join(cwd, "missing.bin"))).rejects.toThrow("file not found");
  });

  test("streams PCM pieces and fixes the WAV header on close", async () => {
    const cwd = await directory();
    const path = join(cwd, "stream.wav");
    const sink = new WavFileSink(path);
    await sink.write({ samples: Float32Array.from([0, 0.5]), sampleRate: 8_000 });
    await sink.write({ samples: Float32Array.from([-0.5]), sampleRate: 8_000 });
    await sink.close();
    const decoded = readWav(await Bun.file(path).arrayBuffer());
    expect(decoded.sampleRate).toBe(8_000);
    expect(decoded.samples.length).toBe(3);
    expect(decoded.samples[1] as number).toBeCloseTo(0.5, 4);
    await expect(sink.write({ samples: new Float32Array(1), sampleRate: 8_000 }))
      .rejects.toThrow("closed");
  });

  test("streaming WAV rejects a sample-rate change", async () => {
    const cwd = await directory();
    const sink = new WavFileSink(join(cwd, "bad.wav"));
    await sink.write({ samples: new Float32Array(1), sampleRate: 8_000 });
    await expect(sink.write({ samples: new Float32Array(1), sampleRate: 16_000 }))
      .rejects.toThrow("sample rate");
    await sink.close();
  });
});
