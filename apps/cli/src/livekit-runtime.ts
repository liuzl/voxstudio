import {
  validateLiveKitBootstrapOptions,
  type LiveKitBootstrapOptions,
} from "@voxstudio/realtime-gateway";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { embeddedLiveKitServer } from "./generated/livekit-server";

type Environment = Readonly<Record<string, string | undefined>>;

export interface EmbeddedLiveKitRuntimeOptions {
  executable?: string;
  publicServerUrl?: string;
  tokenTtlSeconds?: number;
  signalHost?: string;
  signalPort?: number;
  rtcUdpPort?: number;
  rtcTcpPort?: number;
  nodeIp?: string;
  startupTimeoutMs?: number;
  env?: Environment;
  log?: (line: string) => void;
  fetch?: LiveKitFetch;
  spawn?: LiveKitSpawn;
}

export interface EmbeddedLiveKitRuntime {
  bootstrap: LiveKitBootstrapOptions;
  executable: string;
  exited: Promise<number>;
  stop(): Promise<void>;
}

interface LiveKitChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  kill(signal?: number | NodeJS.Signals): void;
}

interface LiveKitSpawnOptions {
  env: Record<string, string>;
  stdout: "pipe";
  stderr: "pipe";
}

export type LiveKitSpawn = (command: string[], options: LiveKitSpawnOptions) => LiveKitChild;
export type LiveKitFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const defaultSignalPort = 7880;
const defaultRtcUdpPort = 7882;
const defaultStartupTimeoutMs = 12_000;

function port(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 65_535) {
    throw new TypeError(`embedded LiveKit ${name} must be an integer between 1 and 65535`);
  }
  return resolved;
}

function signalUrl(host: string, signalPort: number): string {
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `ws://${formatted}:${signalPort}`;
}

function cacheRoot(env: Environment): string {
  if (env.VOXSTUDIO_CACHE_HOME) return resolve(env.VOXSTUDIO_CACHE_HOME);
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "voxstudio");
  if (process.platform === "win32") return join(env.LOCALAPPDATA ?? homedir(), "voxstudio", "cache");
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "voxstudio");
}

async function materializeEmbedded(path: string, env: Environment): Promise<string> {
  // In source mode the generated import resolves to the real executable. Only Bun's
  // virtual filesystem needs extraction before the OS can execute it.
  if (!path.includes("$bunfs")) return path;
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (bytes.byteLength === 0) throw new TypeError("embedded LiveKit Server asset is empty");
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const target = join(cacheRoot(env), `livekit-server-${digest}${suffix}`);
  if (await Bun.file(target).exists()) {
    const cached = new Uint8Array(await Bun.file(target).arrayBuffer());
    const cachedDigest = createHash("sha256").update(cached).digest("hex").slice(0, 16);
    if (cachedDigest === digest) {
      if (process.platform !== "win32") await chmod(target, 0o700);
      return target;
    }
    throw new TypeError(`cached embedded LiveKit Server failed its content check: ${target}`);
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const partial = `${target}.partial-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await Bun.write(partial, bytes);
    if (process.platform !== "win32") await chmod(partial, 0o700);
    try {
      await rename(partial, target);
    } catch (error) {
      // Two vox processes can materialize the same verified asset concurrently.
      if (!(await Bun.file(target).exists())) throw error;
      const winner = new Uint8Array(await Bun.file(target).arrayBuffer());
      const winnerDigest = createHash("sha256").update(winner).digest("hex").slice(0, 16);
      if (winnerDigest !== digest) {
        throw new TypeError(`concurrent embedded LiveKit Server cache write failed its content check: ${target}`);
      }
      await unlink(partial).catch(() => {});
    }
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
  return target;
}

async function resolveExecutable(requested: string | undefined, env: Environment): Promise<string> {
  const explicit = requested ?? env.VOX_LIVEKIT_SERVER_BIN;
  if (explicit) {
    const resolved = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
    if (!(await Bun.file(resolved).exists())) throw new TypeError(`embedded LiveKit Server not found: ${explicit}`);
    return resolved;
  }
  if (embeddedLiveKitServer !== undefined) return materializeEmbedded(embeddedLiveKitServer, env);

  const siblingName = process.platform === "win32" ? "livekit-server.exe" : "livekit-server";
  const sibling = join(dirname(process.execPath), siblingName);
  if (await Bun.file(sibling).exists()) return sibling;
  const found = Bun.which(siblingName);
  if (found !== null) return found;
  for (const candidate of process.platform === "darwin"
    ? ["/opt/homebrew/bin/livekit-server", "/usr/local/bin/livekit-server"]
    : []) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new TypeError(
    "embedded LiveKit Server is unavailable; use a release build that includes it or set VOX_LIVEKIT_SERVER_BIN",
  );
}

function generatedCredentials(): { apiKey: string; apiSecret: string } {
  return {
    apiKey: `vox_${randomBytes(12).toString("hex")}`,
    apiSecret: randomBytes(48).toString("base64url"),
  };
}

function childEnvironment(env: Environment, config: unknown): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const allowed = [
      "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "TZ", "SYSTEMROOT", "WINDIR", "USERPROFILE",
      "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    ].includes(upper) || upper.startsWith("LC_");
    if (!allowed) continue;
    inherited[name] = value;
  }
  inherited.LIVEKIT_CONFIG = JSON.stringify(config);
  inherited.NO_COLOR = "1";
  return inherited;
}

function defaultSpawn(command: string[], options: LiveKitSpawnOptions): LiveKitChild {
  return Bun.spawn(command, options) as unknown as LiveKitChild;
}

function pump(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
  redact: string[],
  lines: string[],
  log: ((line: string) => void) | undefined,
): void {
  if (stream === null) return;
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          pending += decoder.decode();
          break;
        }
        pending += decoder.decode(result.value, { stream: true });
        const complete = pending.split(/\r?\n/);
        pending = complete.pop() ?? "";
        for (const raw of complete) {
          const safe = redact.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), raw);
          if (safe === "") continue;
          lines.push(safe);
          if (lines.length > 20) lines.shift();
          log?.(`${prefix}${safe}`);
        }
      }
      if (pending !== "") {
        const safe = redact.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), pending);
        lines.push(safe);
        if (lines.length > 20) lines.shift();
        log?.(`${prefix}${safe}`);
      }
    } catch {
      // Process teardown can close a pipe while a read is pending.
    } finally {
      reader.releaseLock();
    }
  })();
}

async function waitUntilReady(
  url: string,
  child: LiveKitChild,
  timeoutMs: number,
  fetcher: LiveKitFetch,
  recentLines: string[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      child.exited.then(code => ({ type: "exit" as const, code })),
      fetcher(url, { signal: AbortSignal.timeout(750) })
        .then(() => ({ type: "ready" as const }))
        .catch(() => ({ type: "retry" as const })),
    ]);
    if (outcome.type === "ready") return;
    if (outcome.type === "exit") {
      const detail = recentLines.length === 0 ? "" : `: ${recentLines.slice(-3).join(" | ")}`;
      throw new Error(`embedded LiveKit Server exited during startup with status ${outcome.code}${detail}`);
    }
    await Bun.sleep(100);
  }
  child.kill();
  throw new Error(`embedded LiveKit Server did not become ready within ${timeoutMs}ms`);
}

export async function startEmbeddedLiveKitRuntime(
  options: EmbeddedLiveKitRuntimeOptions = {},
): Promise<EmbeddedLiveKitRuntime> {
  const env = options.env ?? process.env;
  const executable = await resolveExecutable(options.executable, env);
  const signalHost = options.signalHost ?? "127.0.0.1";
  if (signalHost !== "127.0.0.1" && signalHost !== "::1" && signalHost !== "localhost") {
    throw new TypeError("embedded LiveKit signaling must bind loopback; expose it through the configured tunnel or proxy");
  }
  const signalPort = port(options.signalPort, defaultSignalPort, "signal port");
  const rtcUdpPort = port(options.rtcUdpPort, defaultRtcUdpPort, "RTC UDP port");
  const rtcTcpPort = options.rtcTcpPort === undefined
    ? undefined
    : port(options.rtcTcpPort, options.rtcTcpPort, "RTC TCP port");
  const startupTimeoutMs = options.startupTimeoutMs ?? defaultStartupTimeoutMs;
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 120_000) {
    throw new TypeError("embedded LiveKit startup timeout must be an integer between 100 and 120000ms");
  }
  const { apiKey, apiSecret } = generatedCredentials();
  const localUrl = signalUrl(signalHost, signalPort);
  const bootstrap: LiveKitBootstrapOptions = {
    serverUrl: localUrl,
    apiKey,
    apiSecret,
    ...(options.publicServerUrl === undefined ? {} : { publicServerUrl: options.publicServerUrl }),
    ...(options.tokenTtlSeconds === undefined ? {} : { tokenTtlSeconds: options.tokenTtlSeconds }),
  };
  // Validate URLs and TTL before spawning so a bad deployment value cannot leave a
  // helper alive while later gateway setup fails.
  validateLiveKitBootstrapOptions(bootstrap);
  const rtc = {
    udp_port: rtcUdpPort,
    use_external_ip: false,
    ...(rtcTcpPort === undefined ? {} : { tcp_port: rtcTcpPort }),
    ...(options.nodeIp === undefined || options.nodeIp === "" ? {} : { node_ip: options.nodeIp }),
  };
  const config = {
    port: signalPort,
    // LiveKit's info-level participant logs include full SDP and ICE candidates.
    // Keep the embedded default privacy-bounded while retaining warnings/errors.
    log_level: "warn",
    rtc,
    keys: { [apiKey]: apiSecret },
  };
  const command = [executable, "--bind", signalHost];
  const child = (options.spawn ?? defaultSpawn)(command, {
    env: childEnvironment(env, config),
    stdout: "pipe",
    stderr: "pipe",
  });
  const recentLines: string[] = [];
  pump(child.stdout, "livekit: ", [apiKey, apiSecret], recentLines, options.log);
  pump(child.stderr, "livekit: ", [apiKey, apiSecret], recentLines, options.log);
  try {
    await waitUntilReady(localUrl.replace(/^ws:/, "http:"), child, startupTimeoutMs, options.fetch ?? globalThis.fetch, recentLines);
  } catch (error) {
    try { child.kill(); } catch {}
    await child.exited.catch(() => -1);
    throw error;
  }

  let stopped: Promise<void> | undefined;
  return {
    bootstrap,
    executable,
    exited: child.exited,
    stop: async () => {
      if (stopped !== undefined) return stopped;
      stopped = (async () => {
        try { child.kill(); } catch {}
        const graceful = await Promise.race([
          child.exited.then(() => true),
          Bun.sleep(5_000).then(() => false),
        ]);
        if (!graceful) {
          try { child.kill("SIGKILL"); } catch {}
          await child.exited.catch(() => -1);
        }
      })();
      return stopped;
    },
  };
}

export function embeddedLiveKitEnabled(env: Environment): boolean {
  const raw = env.VOX_LIVEKIT_EMBEDDED;
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new TypeError("studio: VOX_LIVEKIT_EMBEDDED must be 0 or 1");
}

export function embeddedLiveKitOptionsFromEnv(env: Environment): EmbeddedLiveKitRuntimeOptions {
  const number = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new TypeError(`studio: ${name} must be an integer`);
    return value;
  };
  const signalPort = number("VOX_LIVEKIT_EMBEDDED_PORT");
  const rtcUdpPort = number("VOX_LIVEKIT_EMBEDDED_RTC_UDP_PORT");
  const rtcTcpPort = number("VOX_LIVEKIT_EMBEDDED_RTC_TCP_PORT");
  const tokenTtlSeconds = number("VOX_LIVEKIT_TOKEN_TTL_SECONDS");
  return {
    env,
    ...(env.VOX_LIVEKIT_SERVER_BIN ? { executable: env.VOX_LIVEKIT_SERVER_BIN } : {}),
    ...(env.VOX_LIVEKIT_PUBLIC_URL ? { publicServerUrl: env.VOX_LIVEKIT_PUBLIC_URL } : {}),
    ...(env.VOX_LIVEKIT_EMBEDDED_NODE_IP ? { nodeIp: env.VOX_LIVEKIT_EMBEDDED_NODE_IP } : {}),
    ...(signalPort === undefined ? {} : { signalPort }),
    ...(rtcUdpPort === undefined ? {} : { rtcUdpPort }),
    ...(rtcTcpPort === undefined ? {} : { rtcTcpPort }),
    ...(tokenTtlSeconds === undefined ? {} : { tokenTtlSeconds }),
  };
}
