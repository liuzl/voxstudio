import type {
  ChunkConfig,
  EngineConfig,
  ResolvedEngineConfig,
  TtsDefaults,
  VoxConfig,
} from "@voxstudio/contracts";

type Environment = Readonly<Record<string, string | undefined>>;
type UnknownRecord = Record<string, unknown>;

export const sentenceEnders = "。！？；!?;.;।॥؟۔។៕။";

const defaultEngines: Record<string, ResolvedEngineConfig> = {
  tts: { baseUrl: "http://127.0.0.1:8880", model: "voxcpm2", apiKey: "", healthPath: "/health", maxTokens: 4096 },
  asr: { baseUrl: "http://127.0.0.1:18086", model: "nemotron-asr", apiKey: "", healthPath: "/health", maxTokens: 4096 },
  llm: { baseUrl: "http://127.0.0.1:8080", model: "gemma", apiKey: "", healthPath: "/health", maxTokens: 4096 },
};

const defaultTts: TtsDefaults = {
  voice: "clone",
  cfgValue: 2,
  timesteps: 10,
  responseFormat: "wav",
};

const defaultChunking: ChunkConfig = {
  maxSeconds: 15,
  firstMaxSeconds: 4.5,
  growth: 2,
  sentenceEnders,
  joinPauseMs: 210,
  trimFloorDb: 25,
  edgePadMs: 40,
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(`config: ${message}`);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function expand(value: unknown, env: Environment): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\$(?:\{([^}]*)}|([A-Za-z_][A-Za-z0-9_]*))/g,
      (match, braced: string | undefined, bare: string | undefined) => {
        const value = env[braced ?? bare ?? ""];
        if (value !== undefined) return value;
        return braced !== undefined ? "" : match;
      },
    );
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, env)]));
  }
  return value;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["inf", "+inf", "infinity", "+infinity"].includes(normalized)) return Infinity;
  if (["-inf", "-infinity"].includes(normalized)) return -Infinity;
  if (normalized === "nan" || normalized === "+nan" || normalized === "-nan") return NaN;
  const parsed = Number(normalized);
  if (Number.isNaN(parsed)) throw new ConfigError(`expected a number, not ${value}`);
  return parsed;
}

function integerValue(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number(value);
  throw new ConfigError(`expected an integer, not ${String(value ?? fallback)}`);
}

function staleBudget(oldKey: string, newKey: string): never {
  throw new ConfigError(
    `\`${oldKey}\` was replaced by \`${newKey}\`. The budget is now estimated speech `
    + "duration, not characters: ~85 Chinese characters or ~275 English ones fit in 15 seconds.",
  );
}

function engineFromRaw(base: EngineConfig | undefined, value: unknown): ResolvedEngineConfig {
  const raw = record(value);
  if (!base && typeof raw.base_url !== "string") {
    throw new ConfigError("custom engine requires `base_url`");
  }
  return {
    baseUrl: stringValue(raw.base_url, base?.baseUrl ?? ""),
    model: stringValue(raw.model, base?.model ?? ""),
    apiKey: stringValue(raw.api_key, base?.apiKey ?? ""),
    healthPath: stringValue(raw.health_path, base?.healthPath ?? "/health"),
    maxTokens: integerValue(raw.max_tokens, base?.maxTokens ?? 4096),
  };
}

function applyEngineEnvironment(
  name: string,
  engine: ResolvedEngineConfig,
  env: Environment,
): ResolvedEngineConfig {
  const prefix = `VOXSTUDIO_${name.toUpperCase()}_`;
  return {
    baseUrl: env[`${prefix}BASE_URL`] ?? engine.baseUrl,
    model: env[`${prefix}MODEL`] ?? engine.model,
    apiKey: env[`${prefix}API_KEY`] ?? engine.apiKey,
    healthPath: env[`${prefix}HEALTH_PATH`] ?? engine.healthPath,
    maxTokens: env[`${prefix}MAX_TOKENS`] === undefined
      ? engine.maxTokens
      : integerValue(env[`${prefix}MAX_TOKENS`], engine.maxTokens ?? 4096),
  };
}

function chunkingFromRaw(value: unknown, env: Environment): ChunkConfig {
  const raw = record(value);
  if ("max_chars" in raw) staleBudget("chunking.max_chars", "chunking.max_seconds");
  if ("first_max_chars" in raw) {
    staleBudget("chunking.first_max_chars", "chunking.first_max_seconds");
  }
  if (env.VOXSTUDIO_CHUNK_MAX_CHARS !== undefined) {
    staleBudget("VOXSTUDIO_CHUNK_MAX_CHARS", "VOXSTUDIO_CHUNK_MAX_SECONDS");
  }
  if (env.VOXSTUDIO_CHUNK_FIRST_MAX_CHARS !== undefined) {
    staleBudget("VOXSTUDIO_CHUNK_FIRST_MAX_CHARS", "VOXSTUDIO_CHUNK_FIRST_MAX_SECONDS");
  }

  const number = (key: string, envKey: string, fallback: number): number =>
    numberValue(env[envKey] ?? raw[key], fallback);
  const integer = (key: string, envKey: string, fallback: number): number =>
    env[envKey] === undefined
      ? numberValue(raw[key], fallback)
      : integerValue(env[envKey], fallback);
  const chunking: ChunkConfig = {
    maxSeconds: number("max_seconds", "VOXSTUDIO_CHUNK_MAX_SECONDS", defaultChunking.maxSeconds),
    firstMaxSeconds: number("first_max_seconds", "VOXSTUDIO_CHUNK_FIRST_MAX_SECONDS", defaultChunking.firstMaxSeconds),
    growth: number("growth", "VOXSTUDIO_CHUNK_GROWTH", defaultChunking.growth),
    sentenceEnders: env.VOXSTUDIO_CHUNK_SENTENCE_ENDERS
      ?? stringValue(raw.sentence_enders, defaultChunking.sentenceEnders),
    joinPauseMs: integer("join_pause_ms", "VOXSTUDIO_CHUNK_JOIN_PAUSE_MS", defaultChunking.joinPauseMs),
    trimFloorDb: number("trim_floor_db", "VOXSTUDIO_CHUNK_TRIM_FLOOR_DB", defaultChunking.trimFloorDb),
    edgePadMs: integer("edge_pad_ms", "VOXSTUDIO_CHUNK_EDGE_PAD_MS", defaultChunking.edgePadMs),
  };

  for (const [name, value] of [
    ["max_seconds", chunking.maxSeconds],
    ["first_max_seconds", chunking.firstMaxSeconds],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`\`chunking.${name}\` must be a positive number of seconds, not ${String(value)}`);
    }
  }
  if (!Number.isFinite(chunking.growth)) {
    throw new ConfigError(`\`chunking.growth\` must be finite, not ${String(chunking.growth)}`);
  }
  return chunking;
}

export function parseConfig(input: unknown = {}, env: Environment = {}): VoxConfig {
  const raw = record(expand(input, env));
  const rawEngines = record(raw.engines);
  const engines: Record<string, ResolvedEngineConfig> = {};
  for (const name of new Set([...Object.keys(defaultEngines), ...Object.keys(rawEngines)])) {
    engines[name] = applyEngineEnvironment(
      name,
      engineFromRaw(defaultEngines[name], rawEngines[name]),
      env,
    );
  }

  const rawTts = record(raw.tts_defaults);
  const ttsDefaults: TtsDefaults = {
    voice: stringValue(rawTts.voice, defaultTts.voice),
    cfgValue: numberValue(rawTts.cfg_value, defaultTts.cfgValue),
    timesteps: integerValue(rawTts.timesteps, defaultTts.timesteps),
    responseFormat: stringValue(rawTts.response_format, defaultTts.responseFormat),
  };

  return { engines, ttsDefaults, chunking: chunkingFromRaw(raw.chunking, env) };
}

export function engine(config: VoxConfig, name: string): ResolvedEngineConfig {
  const value = config.engines[name];
  if (!value) throw new ConfigError(`no \`engines.${name}\` in config; see config.example.yaml`);
  return value;
}
