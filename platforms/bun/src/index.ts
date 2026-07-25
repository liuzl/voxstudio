import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ConfigError, parseConfig, updatePronunciationsYaml } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";

export { FfplaySink, TeeSink, WavFileSink, type PcmSink } from "./audio-sinks";
export { startMacosAudioHost, type MacosAudioHost } from "./macos-audio";
export { loadSileroVadModel } from "./silero";
export { ffmpegPcmDecoder } from "./opus";
export {
  editText,
  captureCommand,
  capturePcm,
  decodePcm16le,
  listInputDevices,
  parseAvfoundationAudioDevices,
  recordAudio,
  recordCommand,
  removeRecording,
  splitCommand,
  type HostSystem,
  type CapturedAudioFrame,
  type AudioInputDevice,
  type PcmCapture,
} from "./voice-tools";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ConfigLoadOptions {
  explicit?: string;
  env?: Environment;
  cwd?: string;
  home?: string;
}

async function existing(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await Bun.file(path).exists()) return path;
  }
  return undefined;
}

/** The path loadConfig would read, resolved but not parsed. Undefined when no file exists. */
export async function resolveConfigPath(options: ConfigLoadOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const requested = options.explicit ?? env.VOXSTUDIO_CONFIG;
  if (requested) {
    const path = isAbsolute(requested) ? requested : resolve(cwd, requested);
    if (!(await Bun.file(path).exists())) throw new ConfigError(`config not found: ${requested}`);
    return path;
  }
  return existing([
    join(cwd, "voxstudio.yaml"),
    join(home, ".config", "voxstudio", "config.yaml"),
  ]);
}

export async function loadConfig(options: ConfigLoadOptions = {}): Promise<VoxConfig> {
  const env = options.env ?? process.env;
  const path = await resolveConfigPath(options);
  const raw = path ? Bun.YAML.parse(await Bun.file(path).text()) : {};
  return parseConfig(raw, env);
}

/**
 * Persist pronunciation entries into a config file via targeted line surgery
 * (`updatePronunciationsYaml`), then re-parse and verify every entry landed before the
 * write is considered done — a config file the loader can no longer read, or that lost
 * an entry to a surgery edge case, must fail the tool call, not the next startup.
 */
export async function persistPronunciationsFile(path: string, entries: Record<string, string>): Promise<void> {
  const original = await Bun.file(path).text();
  const updated = updatePronunciationsYaml(original, entries);
  const parsed = Bun.YAML.parse(updated) as { pronunciations?: Record<string, unknown> } | null;
  for (const [term, reading] of Object.entries(entries)) {
    if (parsed?.pronunciations?.[term] !== reading) {
      throw new ConfigError(`pronunciations update failed to land for ${term}`);
    }
  }
  parseConfig(parsed, {});
  await Bun.write(path, updated);
}

export async function readStdinText(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

export async function readTextFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new TypeError(`file not found: ${path}`);
  return file.text();
}

export async function readFileBlob(path: string): Promise<Blob> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new TypeError(`file not found: ${path}`);
  return new File([file], basename(path), { type: file.type });
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await Bun.write(path === "-" ? Bun.stdout : path, bytes);
}
