import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "../io";
import { runAgents } from "./agents";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; io: CliIo; out: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "vox-agents-cli-"));
  roots.push(root);
  const out: string[] = [];
  return { root, out, io: { out: line => out.push(line), err: () => {} } };
}

describe("Agent CLI", () => {
  test("creates, lists, publishes, shows, audits, and removes an Agent", async () => {
    const { root, io, out } = await fixture();
    expect(await runAgents(["--dir", root, "create", "support", "--name", "Support", "--instructions", "Be concise"], io)).toBe(0);
    const created = JSON.parse(out.pop() as string) as { revision: number; spec: { instructions: string } };
    expect(created).toMatchObject({ revision: 1, spec: { instructions: "Be concise" } });

    await runAgents(["--dir", root, "list"], io);
    expect(JSON.parse(out.pop() as string)).toMatchObject({ id: "support", name: "Support" });

    await runAgents(["--dir", root, "publish", "support"], io);
    expect(JSON.parse(out.pop() as string)).toMatchObject({ version: { version: 1 }, record: { revision: 2 } });

    await runAgents(["--dir", root, "show", "support", "--version", "1"], io);
    expect(JSON.parse(out.pop() as string)).toMatchObject({ id: "support", version: 1 });

    await runAgents(["--dir", root, "audit", "support"], io);
    expect(JSON.parse(out.pop() as string)).toMatchObject({ status: "current", version: 1 });

    await runAgents(["--dir", root, "rm", "support"], io);
    expect(out.pop()).toBe("deleted support");
  });

  test("imports a spec from YAML and lets explicit instructions win", async () => {
    const { root, io, out } = await fixture();
    const source = join(root, "source.yaml");
    await writeFile(source, "spec:\n  voice: laok\n  instructions: from file\n");
    await runAgents([
      "--dir", root, "create", "imported", "--name", "Imported", "--from", source,
      "--instructions", "from command",
    ], io);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      id: "imported", spec: { voice: "laok", instructions: "from command" },
    });
  });

  test("rejects stale explicit revisions", async () => {
    const { root, io } = await fixture();
    await runAgents(["--dir", root, "create", "support", "--name", "Support"], io);
    await expect(runAgents(["--dir", root, "publish", "support", "--revision", "2"], io))
      .rejects.toThrow("revision 1");
  });
});
