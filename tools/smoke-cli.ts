/**
 * Compiled-binary smoke test: does `vox` still start?
 *
 * The source path and the compiled path are not the same program. `bun build --compile`
 * has twice emitted a binary whose module graph fails at import while `bun test` stayed
 * green — most recently by dropping the init call for zod's lazily-wrapped classic
 * module, which killed every subcommand before argument parsing (2026-07-26). Nothing in
 * the test suite runs the artifact, so this does: it costs a second and it catches the
 * whole class.
 *
 * `main.ts` imports every command module statically, and `listen` pulls in the MCP
 * client, so simply reaching argument parsing proves the entire graph evaluated.
 */
import { existsSync } from "node:fs";

/**
 * The artifact, wherever this platform put it. `bun build --compile` appends `.exe` on
 * Windows, and CI passes the matrix path through VOX.
 */
function findBinary(): string | undefined {
  const override = process.env.VOX;
  const candidates = override
    ? [override]
    : [`${import.meta.dir}/../apps/cli/dist/vox`, `${import.meta.dir}/../apps/cli/dist/vox.exe`];
  return candidates.find(candidate => existsSync(candidate));
}

/** An import-time death looks nothing like a usage error; say which one happened. */
const crashMarkers = [
  "is not a constructor",
  "is not a function",
  "Cannot find module",
  "undefined is not an object",
  "ReferenceError",
  "TypeError",
];

interface Check {
  what: string;
  args: string[];
  expectExit: number;
  expectOutput: string;
}

const checks: Check[] = [
  // Reaching the banner means every top-level import evaluated.
  { what: "vox --help", args: ["--help"], expectExit: 0, expectOutput: "voxstudio: self-hosted voice i/o" },
  // Per-command usage: the command modules resolved, not just the entrypoint.
  { what: "vox say --help", args: ["say", "--help"], expectExit: 0, expectOutput: "usage: vox say" },
  { what: "vox voices --help", args: ["voices", "--help"], expectExit: 0, expectOutput: "usage: vox voices" },
  // An unknown command must be *rejected* — usage on stderr, exit 2 — not crashed on:
  // the difference between a program that started and one that died loading.
  { what: "vox nonesuch", args: ["nonesuch"], expectExit: 2, expectOutput: "usage" },
];

async function main(): Promise<number> {
  const binary = findBinary();
  if (binary === undefined) {
    console.error("smoke-cli: no compiled binary found (apps/cli/dist/vox[.exe], or $VOX) — run `bun run build:cli` first");
    return 2;
  }
  const started = Date.now();
  let failed = 0;
  for (const check of checks) {
    const run = Bun.spawnSync([binary, ...check.args], { stdout: "pipe", stderr: "pipe" });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    const crashed = crashMarkers.find(marker => output.includes(marker));
    if (crashed !== undefined) {
      console.error(`smoke-cli: ${check.what} died loading (${crashed}):\n${output.trim().split("\n").slice(0, 8).join("\n")}`);
      failed += 1;
      continue;
    }
    if (run.exitCode !== check.expectExit) {
      console.error(`smoke-cli: ${check.what} exited ${run.exitCode}, expected ${check.expectExit}\n${output.trim().slice(0, 400)}`);
      failed += 1;
      continue;
    }
    if (!output.toLowerCase().includes(check.expectOutput)) {
      console.error(`smoke-cli: ${check.what} did not mention "${check.expectOutput}"\n${output.trim().slice(0, 400)}`);
      failed += 1;
      continue;
    }
    console.error(`smoke-cli: ${check.what} ok`);
  }
  const seconds = ((Date.now() - started) / 1_000).toFixed(1);
  if (failed > 0) {
    console.error(`smoke-cli: ${failed} of ${checks.length} checks failed in ${seconds}s — the compiled binary is broken even if the tests pass`);
    return 1;
  }
  console.error(`smoke-cli: the compiled binary starts (${checks.length} checks, ${seconds}s)`);
  return 0;
}

process.exit(await main());
