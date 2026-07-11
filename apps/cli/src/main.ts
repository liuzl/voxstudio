#!/usr/bin/env bun

import { probeEngine, type Fetch } from "@voxstudio/clients";
import type { HealthResult, VoxConfig } from "@voxstudio/contracts";
import { loadConfig } from "@voxstudio/platform-bun";
import { chatUsage, runChat } from "./commands/chat";
import { configUsage, runConfig } from "./commands/config";
import { profilesUsage, runProfiles } from "./commands/profiles";
import { runSay, sayUsage } from "./commands/say";
import { runTranscribe, transcribeUsage } from "./commands/transcribe";
import { runVoices, voicesUsage } from "./commands/voices";
import { consoleIo, type CliIo } from "./io";

const usage = `usage: vox [-h] [--config CONFIG] {health,say,transcribe,chat,voices,profiles,config} ...

voxstudio: self-hosted voice I/O

commands:
  health           probe configured engines
  say              synthesize speech from text
  transcribe       transcribe an audio file
  chat             one-shot LLM turn
  voices           manage named voices
  profiles         create reusable design profiles
  config           validate resolved configuration

options:
  -h, --help       show this help message and exit
  --config CONFIG  path to config yaml`;

const healthUsage = `usage: vox health

Probe every configured engine and return a non-zero exit code when any probe fails.`;

export type { CliIo } from "./io";

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
  if (args[0] === "-h" || args[0] === "--help") {
    io.out(usage);
    return 0;
  }
  let explicit: string | undefined;
  if (args[0] === "--config") {
    explicit = args[1];
    if (!explicit) {
      io.err("vox: --config requires a path");
      return 2;
    }
    args.splice(0, 2);
  }
  const command = args.shift();
  if (!command || !["health", "say", "transcribe", "chat", "voices", "profiles", "config"].includes(command)) {
    io.err(usage);
    return 2;
  }
  if (args.includes("-h") || args.includes("--help")) {
    const commandUsage: Record<string, string> = {
      health: healthUsage,
      say: sayUsage,
      transcribe: transcribeUsage,
      chat: chatUsage,
      voices: voicesUsage,
      profiles: profilesUsage,
      config: configUsage,
    };
    io.out(commandUsage[command] ?? usage);
    return 0;
  }
  try {
    const config = explicit === undefined ? await configLoader() : await configLoader({ explicit });
    if (command === "health") {
      if (args.length) throw new TypeError("health: no arguments expected");
      return runHealth(config, io, fetch);
    }
    if (command === "transcribe") return await runTranscribe(args, config, io, fetch);
    if (command === "say") return await runSay(args, config, io, fetch);
    if (command === "voices") return await runVoices(args, config, io, fetch);
    if (command === "profiles") return await runProfiles(args, config, io, fetch);
    if (command === "config") return runConfig(args, config, io);
    return await runChat(args, config, io, fetch);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
