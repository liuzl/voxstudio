import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readFileBlob, writeBytes } from "./index";

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
});
