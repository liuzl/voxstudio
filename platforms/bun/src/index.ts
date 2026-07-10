import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ConfigError, parseConfig } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";

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

export async function loadConfig(options: ConfigLoadOptions = {}): Promise<VoxConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const requested = options.explicit ?? env.VOXSTUDIO_CONFIG;
  let path: string | undefined;

  if (requested) {
    path = isAbsolute(requested) ? requested : resolve(cwd, requested);
    if (!(await Bun.file(path).exists())) throw new ConfigError(`config not found: ${requested}`);
  } else {
    path = await existing([
      join(cwd, "voxstudio.yaml"),
      join(home, ".config", "voxstudio", "config.yaml"),
    ]);
  }

  const raw = path ? Bun.YAML.parse(await Bun.file(path).text()) : {};
  return parseConfig(raw, env);
}

export async function readStdinText(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

export async function readFileBlob(path: string): Promise<Blob> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new TypeError(`file not found: ${path}`);
  return new File([file], basename(path), { type: file.type });
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await Bun.write(path === "-" ? Bun.stdout : path, bytes);
}
