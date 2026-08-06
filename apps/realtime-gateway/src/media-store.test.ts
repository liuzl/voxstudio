import { afterEach, describe, expect, test } from "bun:test";
import { readWav, writeWav } from "@voxstudio/audio";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationMediaStore } from "./media-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vox-media-"));
  roots.push(dir);
  return dir;
}

describe("ConversationMediaStore", () => {
  test("atomically retains owner-scoped input WAVs", async () => {
    const store = new ConversationMediaStore(await root());
    const wav = writeWav(new Float32Array(1_600).fill(0.25), 16_000);
    store.retainInput("alice", {
      sessionId: "session", turnId: "turn", revision: 2, wav,
      sampleRate: 16_000, channels: 1,
    });
    await store.flush();
    const descriptor = store.list("alice", "session")[0];
    expect(descriptor).toMatchObject({ direction: "input", state: "ready", revision: 2, sampleRate: 16_000 });
    expect(descriptor?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.list("bob", "session")).toHaveLength(0);
    const retained = store.file("alice", "session", descriptor!.id);
    expect(retained).toBeDefined();
    expect(readWav(await readFile(retained!.path)).samples).toHaveLength(1_600);
    expect(store.file("bob", "session", descriptor!.id)).toBeUndefined();
    await store.close();
  });

  test("records only output samples submitted before interruption", async () => {
    const store = new ConversationMediaStore(await root());
    const recorder = store.createOutputRecorder("owner", "session", "turn", 0);
    recorder.write(new Float32Array(800).fill(0.1), 16_000);
    recorder.write(new Float32Array(400).fill(-0.1), 16_000);
    recorder.finalize("interrupted");
    await store.flush();
    const descriptor = store.list("owner", "session")[0];
    expect(descriptor).toMatchObject({
      direction: "output", state: "ready", delivery: "interrupted",
      sampleCount: 1_200, durationMs: 75,
    });
    expect(descriptor?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const retained = store.file("owner", "session", descriptor!.id);
    expect(readWav(await readFile(retained!.path)).samples).toHaveLength(1_200);
    await store.close();
  });

  test("fails closed at the byte ceiling and cascades session deletion", async () => {
    const store = new ConversationMediaStore(await root(), { maxBytes: 100 });
    store.retainInput("owner", {
      sessionId: "session", turnId: "turn", revision: 0,
      wav: writeWav(new Float32Array(100), 16_000), sampleRate: 16_000, channels: 1,
    });
    await store.flush();
    expect(store.list("owner", "session")[0]).toMatchObject({ state: "missing", errorCode: "quota_or_backpressure" });

    const small = store.createOutputRecorder("owner", "other", "turn", 0);
    small.write(new Float32Array(10), 16_000);
    small.finalize("sent");
    await store.flush();
    expect(store.list("owner", "other")[0]?.state).toBe("ready");
    await store.removeSession("owner", "other");
    expect(store.list("owner", "other")).toHaveLength(0);
    await store.close();
  });

  test("does not acknowledge deletion until retained bytes were actually removed", async () => {
    let failDeletion = true;
    const store = new ConversationMediaStore(await root(), {
      removeFile: async path => {
        if (failDeletion) throw new Error("read-only filesystem");
        await rm(path, { force: true });
      },
    });
    store.retainInput("owner", {
      sessionId: "session", turnId: "turn", revision: 0,
      wav: writeWav(new Float32Array(100), 16_000), sampleRate: 16_000, channels: 1,
    });
    await store.flush();
    const retained = store.file("owner", "session", store.list("owner", "session")[0]!.id)!;

    await expect(store.removeSession("owner", "session")).rejects.toThrow("read-only filesystem");
    expect(store.list("owner", "session")).toHaveLength(1);
    expect((await stat(retained.path)).isFile()).toBe(true);

    failDeletion = false;
    await store.removeSession("owner", "session");
    expect(store.list("owner", "session")).toHaveLength(0);
    await expect(stat(retained.path)).rejects.toThrow();
    await store.close();
  });
});
