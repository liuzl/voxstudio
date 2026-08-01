import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, AgentRegistryError, agentSpecHash } from "./index";

let roots: string[] = [];

async function registry(): Promise<AgentRegistry> {
  const root = await mkdtemp(join(tmpdir(), "vox-agents-"));
  roots.push(root);
  return new AgentRegistry(root);
}

afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("Agent registry", () => {
  test("canonical spec hashes ignore object key order but retain behavior", () => {
    const first = agentSpecHash({
      voice: "calm",
      instructions: "Help",
      pronunciations: { VoxStudio: "vox studio", API: "A P I" },
    });
    const second = agentSpecHash({
      pronunciations: { API: "A P I", VoxStudio: "vox studio" },
      instructions: "Help",
      voice: "calm",
    });
    expect(second).toBe(first);
    expect(agentSpecHash({ voice: "other", instructions: "Help" })).not.toBe(first);
    expect(() => agentSpecHash({ maxSessionSeconds: 0 })).toThrow("must be a positive finite number");
  });

  test("persists drafts, scopes equal ids by owner, and never writes a raw user id into a path", async () => {
    const store = await registry();
    const alice = await store.create("alice@example.com", { id: "support", name: "Alice support", spec: { voice: "alice" } });
    const bob = await store.create("bob@example.com", { id: "support", name: "Bob support", spec: { voice: "bob" } });

    expect(alice.revision).toBe(1);
    expect((await store.get("alice@example.com", "support"))?.name).toBe("Alice support");
    expect((await store.get("bob@example.com", "support"))?.name).toBe("Bob support");
    expect(await store.get("mallory@example.com", "support")).toBeUndefined();

    const aliceDigest = createHash("sha256").update("alice@example.com").digest("hex");
    expect(store.ownerDirectory("alice@example.com")).toBe(join(store.root, ".owners", aliceDigest));
    expect(store.ownerDirectory("alice@example.com")).not.toContain("alice@example.com");

    await store.create("owner", { id: "flat", name: "Readable self-hosted draft" });
    expect(await Bun.file(join(store.root, "flat.yaml")).exists()).toBe(true);
    expect(bob.spec.voice).toBe("bob");
  });

  test("requires the current revision for update and delete", async () => {
    const store = await registry();
    const created = await store.create("owner", { id: "assistant", name: "Assistant" });
    const updated = await store.update("owner", "assistant", {
      revision: created.revision,
      name: "Assistant v2",
      description: "real draft",
      spec: { instructions: "Be concise", voice: "laok" },
    });
    expect(updated.revision).toBe(2);

    await expect(store.update("owner", "assistant", { revision: 1, name: "stale" }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(store.remove("owner", "assistant", 1)).rejects.toMatchObject({ code: "conflict" });
    await store.remove("owner", "assistant", updated.revision);
    expect(await store.get("owner", "assistant")).toBeUndefined();
  });

  test("publishes immutable snapshots serially and detects draft drift", async () => {
    const store = await registry();
    const draft = await store.create("owner", {
      id: "support",
      name: "Support",
      spec: { instructions: "Version one", voice: "laok", maxSessionSeconds: 300 },
    });
    const secondProcess = new AgentRegistry(store.root);
    const outcomes = await Promise.allSettled([
      store.publish("owner", "support", draft.revision),
      secondProcess.publish("owner", "support", draft.revision),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AgentRegistryError);
    expect(rejected.reason.code).toBe("conflict");

    const record = await store.get("owner", "support");
    expect(record?.published?.version).toBe(1);
    expect((await store.versions("owner", "support")).map(version => version.version)).toEqual([1]);
    expect((await store.audit("owner", "support")).status).toBe("current");

    const edited = await store.update("owner", "support", {
      revision: record?.revision as number,
      spec: { instructions: "Version two", voice: "laok", maxSessionSeconds: 120 },
    });
    expect((await store.audit("owner", "support")).status).toBe("drifted");
    const published = await store.resolve("owner", "support", { type: "published" });
    expect(published.spec.instructions).toBe("Version one");
    expect((await store.resolve("owner", "support", { type: "draft" })).spec.instructions).toBe("Version two");

    const snapshotPath = join(store.root, ".published", "support", "1.yaml");
    const immutableBefore = await readFile(snapshotPath, "utf8");
    await store.publish("owner", "support", edited.revision);
    expect(await readFile(snapshotPath, "utf8")).toBe(immutableBefore);
    expect((await store.versions("owner", "support")).map(version => version.version)).toEqual([2, 1]);
  });

  test("audit reports a missing immutable payload instead of trusting the pointer hash", async () => {
    const store = await registry();
    const draft = await store.create("owner", { id: "broken", name: "Broken", spec: { voice: "laok" } });
    await store.publish("owner", "broken", draft.revision);
    await rm(join(store.root, ".published", "broken", "1.yaml"));
    expect(await store.audit("owner", "broken")).toMatchObject({ status: "missing_snapshot", version: 1 });
  });

  test("recovers a snapshot left behind before its draft pointer was advanced", async () => {
    const store = await registry();
    const created = await store.create("owner", { id: "recover", name: "Recover", spec: { instructions: "same behavior" } });
    const draftPath = join(store.root, "recover.yaml");
    const beforePublish = await readFile(draftPath, "utf8");
    await store.publish("owner", "recover", created.revision);
    // Simulate termination between immutableYaml() and atomicYaml(record).
    await writeFile(draftPath, beforePublish);

    const recovered = await store.publish("owner", "recover", created.revision);
    expect(recovered.version.version).toBe(1);
    expect(recovered.record.published?.version).toBe(1);
    expect(recovered.record.revision).toBe(2);
    expect((await store.versions("owner", "recover")).map(version => version.version)).toEqual([1]);
  });

  test("refuses malformed persisted YAML rather than widening the schema", async () => {
    const store = await registry();
    await writeFile(join(store.root, "bad.yaml"), "id: bad\nname: Bad\nrevision: 1\ncreatedAt: now\nupdatedAt: now\nspec:\n  maxSessionSeconds: -1\n");
    await expect(store.get("owner", "bad")).rejects.toMatchObject({ code: "invalid" });
  });
});
