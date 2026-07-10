#!/usr/bin/env bun

import { probeEngine, type Fetch } from "@voxstudio/clients";
import type { HealthResult, VoxConfig } from "@voxstudio/contracts";
import { loadConfig } from "@voxstudio/platform-bun";

const usage = `usage: vox-ts [-h] [--config CONFIG] {health} ...

voxstudio: self-hosted voice I/O

commands:
  health           probe configured engines

options:
  -h, --help       show this help message and exit
  --config CONFIG  path to config yaml`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export async function runHealth(
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch = globalThis.fetch,
): Promise<number> {
  const results: HealthResult[] = [];
  for (const [name, engine] of Object.entries(config.engines).sort(([a], [b]) => a.localeCompare(b))) {
    results.push(await probeEngine(name, engine, fetch));
  }
  const width = Math.max(...results.map((result) => result.baseUrl.length));
  for (const result of results) {
    const mark = result.ok ? "ok  " : "FAIL";
    io.out(`${mark}  ${result.name.padEnd(4)} ${result.baseUrl.padEnd(width)}  ${result.model.padEnd(14)} ${result.detail}`);
  }
  return results.every((result) => result.ok) ? 0 : 1;
}

export async function run(
  argv: string[],
  io: CliIo = consoleIo,
  configLoader: typeof loadConfig = loadConfig,
  fetch: Fetch = globalThis.fetch,
): Promise<number> {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) {
    io.out(usage);
    return 0;
  }
  let explicit: string | undefined;
  if (args[0] === "--config") {
    explicit = args[1];
    if (!explicit) {
      io.err("vox-ts: --config requires a path");
      return 2;
    }
    args.splice(0, 2);
  }
  if (args.length !== 1 || args[0] !== "health") {
    io.err(usage);
    return 2;
  }
  try {
    const config = explicit === undefined ? await configLoader() : await configLoader({ explicit });
    return runHealth(config, io, fetch);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
