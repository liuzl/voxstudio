import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWav } from "@voxstudio/audio";
import { parseConfig } from "@voxstudio/config";
import { parseProfileBatch, runProfiles } from "./profiles";

test("creates a design profile", async () => {
  const out: string[] = [];
  const fetch = async (_url: Request | URL | string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({ id: "calm", description: "calm voice", anchor_text: "锚点", seed: 42 });
    return Response.json({ id: "calm" });
  };
  await runProfiles(["create", "calm", "--description", "calm voice", "--anchor-text", "锚点", "--seed", "42"],
    parseConfig(), { out: line => out.push(line), err: () => {} }, fetch);
  expect(out).toEqual(["{\"id\":\"calm\"}"]);
});

test("forwards explicit design generation parameters", async () => {
  const fetch = async (_url: Request | URL | string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({
      id: "tuned", description: "warm voice", anchor_text: "锚点", seed: 43, cfg_value: 2.5, timesteps: 12,
    });
    return Response.json({ id: "tuned" });
  };
  const io = { out: () => {}, err: () => {} };
  await runProfiles([
    "create", "tuned", "--description", "warm voice", "--anchor-text", "锚点", "--seed", "43",
    "--cfg", "2.5", "--timesteps", "12",
  ], parseConfig(), io, fetch);
});

test("validates design generation parameters", async () => {
  const io = { out: () => {}, err: () => {} };
  await expect(runProfiles([
    "create", "bad", "--description", "voice", "--anchor-text", "锚点", "--seed", "1", "--cfg", "NaN",
  ], parseConfig(), io)).rejects.toThrow("profiles: --cfg must be a number");
  await expect(runProfiles([
    "create", "bad", "--description", "voice", "--anchor-text", "锚点", "--seed", "1", "--timesteps", "1.5",
  ], parseConfig(), io)).rejects.toThrow("profiles: --timesteps must be a safe integer");
});

test("parses batch manifests before making requests", () => {
  expect(parseProfileBatch([
    "# fixed anchor text; vary one parameter at a time",
    '{"id":"cfg-2","description":"calm voice","anchor_text":"锚点","seed":42,"cfg_value":2}',
    '{"id":"cfg-3","description":"calm voice","anchor_text":"锚点","seed":42,"cfg_value":3,"timesteps":12}',
  ].join("\n"))).toEqual([
    { id: "cfg-2", description: "calm voice", anchor_text: "锚点", seed: 42, cfg_value: 2 },
    { id: "cfg-3", description: "calm voice", anchor_text: "锚点", seed: 42, cfg_value: 3, timesteps: 12 },
  ]);
  expect(() => parseProfileBatch('{"id":"same","description":"voice","anchor_text":"锚","seed":1}\n{"id":"same","description":"voice","anchor_text":"锚","seed":2}'))
    .toThrow("profiles batch: duplicate id same");
});

test("dry-runs and creates a validated profile batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vox-profiles-"));
  const manifest = join(directory, "candidates.jsonl");
  await writeFile(manifest, '{"id":"candidate-a","description":"calm voice","anchor_text":"锚点","seed":42}\n');
  try {
    const dryOut: string[] = [];
    const noFetch = async (): Promise<Response> => { throw new Error("must not request"); };
    await runProfiles(["batch", manifest, "--dry-run"], parseConfig(), { out: line => dryOut.push(line), err: () => {} }, noFetch);
    expect(dryOut).toEqual(['{"id":"candidate-a","description":"calm voice","anchor_text":"锚点","seed":42}']);

    const created: unknown[] = [];
    const fetch = async (_url: Request | URL | string, init?: RequestInit) => {
      created.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "candidate-a" });
    };
    const out: string[] = [];
    await runProfiles(["batch", manifest], parseConfig(), { out: line => out.push(line), err: () => {} }, fetch);
    expect(created).toEqual([{ id: "candidate-a", description: "calm voice", anchor_text: "锚点", seed: 42 }]);
    expect(out).toEqual(['{"id":"candidate-a"}']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rolls back only profiles created by a failed batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vox-profiles-"));
  const manifest = join(directory, "candidates.jsonl");
  await writeFile(manifest, [
    '{"id":"candidate-a","description":"calm voice","anchor_text":"锚点","seed":42}',
    '{"id":"candidate-b","description":"calm voice","anchor_text":"锚点","seed":42}',
  ].join("\n"));
  const deleted: string[] = [];
  let requests = 0;
  const fetch = async (url: Request | URL | string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      deleted.push(String(url).split("/").at(-1) as string);
      return Response.json({});
    }
    requests += 1;
    if (requests === 1) return Response.json({ id: "candidate-a" });
    throw new Error("generation failed");
  };
  try {
    const io = { out: () => {}, err: () => {} };
    await expect(runProfiles(["batch", manifest, "--rollback-on-error"], parseConfig(), io, fetch))
      .rejects.toThrow("generation failed");
    expect(deleted).toEqual(["candidate-a"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writes controlled audition WAVs and a manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vox-audition-"));
  const outputDir = join(directory, "out");
  const profile = (id: string) => ({
    id, prompt_text: "锚点",
    design_profile: {
      description: "calm voice", seed: 42, cfg_value: 2, timesteps: 10, model: "test",
      model_manifest_sha256: "c".repeat(64), audio_sha256: "a".repeat(64),
    },
  });
  const requests: unknown[] = [];
  const fetch = async (url: Request | URL | string, init?: RequestInit) => {
    if (String(url).includes("/v1/voices/")) return Response.json(profile(String(url).split("/").at(-1) as string));
    requests.push(JSON.parse(String(init?.body)));
    return new Response(writeWav(new Float32Array(4_800).fill(0.1), 48_000).slice().buffer);
  };
  try {
    const out: string[] = [];
    await runProfiles([
      "audition", outputDir, "--text", "固定评测文本。", "--seed", "99", "candidate-a", "candidate-b",
    ], parseConfig(), { out: line => out.push(line), err: () => {} }, fetch);
    expect(requests).toEqual([
      expect.objectContaining({ input: "固定评测文本。", voice: "candidate-a", seed: 99 }),
      expect.objectContaining({ input: "固定评测文本。", voice: "candidate-b", seed: 99 }),
    ]);
    expect(await Bun.file(join(outputDir, "candidate-a.wav")).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, "candidate-b.wav")).exists()).toBe(true);
    const manifest = await Bun.file(join(outputDir, "manifest.json")).json() as { seed: number; candidates: Array<{ id: string; wav_sha256: string }> };
    expect(manifest.seed).toBe(99);
    expect(manifest.candidates.map(candidate => candidate.id)).toEqual(["candidate-a", "candidate-b"]);
    expect(manifest.candidates.every(candidate => candidate.wav_sha256.length === 64)).toBe(true);
    expect(out.at(-1)).toContain("manifest.json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("records a human selection bound to an audition manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vox-selection-"));
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    candidates: [
      { id: "candidate-a", wav_sha256: "a".repeat(64) },
      { id: "candidate-b", wav_sha256: "b".repeat(64) },
    ],
  }));
  try {
    const out: string[] = [];
    await runProfiles([
      "select", manifestPath, "candidate-b", "--note", "More natural",
    ], parseConfig(), { out: line => out.push(line), err: () => {} });
    const selection = await Bun.file(join(directory, "selection.json")).json() as {
      audition_manifest_sha256: string; winner: { id: string }; note: string;
    };
    expect(selection.audition_manifest_sha256.length).toBe(64);
    expect(selection.winner.id).toBe("candidate-b");
    expect(selection.note).toBe("More natural");
    expect(out.at(-1)).toContain("candidate-b");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reproduces a profile from its recorded generation settings", async () => {
  const fetch = async (url: Request | URL | string, init?: RequestInit) => {
    if (!init?.method) {
      expect(String(url)).toEndWith("/v1/voices/source");
      return Response.json({
        id: "source", prompt_text: "锚点",
        design_profile: { description: "warm voice", seed: 43, cfg_value: 2.5, timesteps: 12, model: "test" },
      });
    }
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      id: "copy", description: "warm voice", anchor_text: "锚点", seed: 43, cfg_value: 2.5, timesteps: 12,
    });
    return Response.json({ id: "copy" });
  };
  const out: string[] = [];
  await runProfiles(["reproduce", "source", "copy"], parseConfig(), { out: line => out.push(line), err: () => {} }, fetch);
  expect(out).toEqual(["{\"id\":\"copy\"}"]);
});

test("does not reproduce profiles without a recorded anchor text", async () => {
  const fetch = async () => Response.json({
    id: "source", design_profile: { description: "warm voice", seed: 43, cfg_value: 2.5, timesteps: 12, model: "test" },
  });
  const io = { out: () => {}, err: () => {} };
  await expect(runProfiles(["reproduce", "source", "copy"], parseConfig(), io, fetch))
    .rejects.toThrow("profiles reproduce: source has no anchor text");
});

test("verifies complete reproducibility metadata and audio fingerprint", async () => {
  const fetch = async (url: Request | URL | string) => Response.json({
    id: String(url).endsWith("/source") ? "source" : "target",
    prompt_text: "锚点",
    design_profile: {
      description: "warm voice", seed: 43, cfg_value: 2.5, timesteps: 12, model: "test",
      model_manifest_sha256: "c".repeat(64),
      audio_sha256: "a".repeat(64),
    },
  });
  const out: string[] = [];
  await runProfiles(["verify", "source", "target"], parseConfig(), { out: line => out.push(line), err: () => {} }, fetch);
  expect(out).toEqual([`verified source target ${"a".repeat(64)}`]);
});

test("reports reproducibility mismatches", async () => {
  const fetch = async (url: Request | URL | string) => Response.json({
    id: String(url).endsWith("/source") ? "source" : "target",
    prompt_text: "锚点",
    design_profile: {
      description: "warm voice", seed: 43, cfg_value: 2.5, timesteps: 12, model: "test",
      model_manifest_sha256: "c".repeat(64),
      audio_sha256: String(url).endsWith("/source") ? "a".repeat(64) : "b".repeat(64),
    },
  });
  const io = { out: () => {}, err: () => {} };
  await expect(runProfiles(["verify", "source", "target"], parseConfig(), io, fetch))
    .rejects.toThrow("profiles verify: mismatch in audio_sha256");
});

test("lists and removes only profile voices", async () => {
  const out: string[] = [];
  const fetch = async (url: Request | URL | string, init?: RequestInit) => {
    if (String(url).endsWith("/v1/voices") && !init?.method) {
      return Response.json({ voices: [{ id: "profile", design_profile: { description: "calm", seed: 42, cfg_value: 2, timesteps: 10, model: "test" } }, { id: "plain" }] });
    }
    if (String(url).endsWith("/v1/voices/profile") && !init?.method) {
      return Response.json({ id: "profile", design_profile: { description: "calm", seed: 42, cfg_value: 2, timesteps: 10, model: "test" } });
    }
    expect(init?.method).toBe("DELETE");
    return Response.json({ id: "profile", deleted: true });
  };
  const io = { out: (line: string) => out.push(line), err: () => {} };
  await runProfiles(["list"], parseConfig(), io, fetch);
  await runProfiles(["rm", "profile"], parseConfig(), io, fetch);
  expect(out).toEqual(["{\"id\":\"profile\",\"design_profile\":{\"description\":\"calm\",\"seed\":42,\"cfg_value\":2,\"timesteps\":10,\"model\":\"test\"}}", "deleted profile"]);
});

test("refuses to show or remove a non-profile voice", async () => {
  let deletes = 0;
  const fetch = async (_url: Request | URL | string, init?: RequestInit) => {
    if (init?.method === "DELETE") deletes += 1;
    return Response.json({ id: "plain" });
  };
  const io = { out: () => {}, err: () => {} };
  await expect(runProfiles(["show", "plain"], parseConfig(), io, fetch))
    .rejects.toThrow("profiles: plain is not a design profile");
  await expect(runProfiles(["rm", "plain"], parseConfig(), io, fetch))
    .rejects.toThrow("profiles: plain is not a design profile");
  expect(deletes).toBe(0);
});
