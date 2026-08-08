import type { VoxConfig } from "@voxstudio/contracts";
import { AgentRegistry } from "@voxstudio/agents";
import { homedir } from "node:os";
import { join } from "node:path";
import { ffmpegPcmDecoder, loadSileroVadModel, persistPronunciationsFile, resolveConfigPath } from "@voxstudio/platform-bun";
import {
  assertGatewayToken,
  DefaultLiveKitAgentMediaAdapter,
  liveKitBootstrapFromEnv,
  parseByteSize,
  startGateway,
  type GatewayServer,
  type GatewayServerOptions,
} from "@voxstudio/realtime-gateway";
import { webAssets } from "../generated/web-assets";
import type { CliIo } from "../io";
import {
  embeddedLiveKitEnabled,
  embeddedLiveKitOptionsFromEnv,
  startEmbeddedLiveKitRuntime,
  type EmbeddedLiveKitRuntime,
  type EmbeddedLiveKitRuntimeOptions,
} from "../livekit-runtime";

export const studioUsage = `usage: vox studio [--host HOST] [--port PORT] [--token TOKEN] [--livekit embedded]
                 [--agents DIR] [--library DIR] [--library-max-bytes SIZE] [--accounts DIR]
                 [--traces DIR] [--trace-content] [--trace-retention-days N]
                 [--trace-max-conversations N] [--trace-audio input|output|both]
                 [--trace-max-bytes SIZE]
                 [--quota N] [--quota-window SECONDS] [--max-synthesis-seconds N]
                 [--max-concurrent-synthesis N] [--max-queued-synthesis Q]
                 [--max-sessions N] [--max-session-seconds N] [--demo] [--demo-agent ID]

Serve the Web Studio: the browser app, the realtime WebSocket (/v1/realtime), and the
credential-hiding REST facade in one process. Binds loopback by default; reaching it
from another machine is a deployment decision (a tunnel, Access at the door). TOKEN,
when set, guards every /v1 request and the WebSocket upgrade; the app shell itself is
served without it. Open the Studio once with #token=<TOKEN>; it redacts and retains the
token for that browser tab. Barge-in detection runs the certified Silero VAD everywhere: the
WASM SIMD backend is the cross-platform default in source and compiled builds (same
model, same numbers); set VOXSTUDIO_ONNX_BACKEND=native to opt into the optional
native runtime for high-concurrency measurement. Install onnxruntime-node separately
before opting in; a native request never silently substitutes WASM.

options:
  --host HOST    bind address (default 127.0.0.1)
  --port PORT    listen port (default 8790)
  --token TOKEN  bearer token required on /v1 requests and the realtime socket
                 (VOX_GATEWAY_TOKEN); use URL/WebSocket-safe token characters only
  --agents DIR   Agent drafts and immutable published versions
                 (default ~/.config/voxstudio/agents; VOX_GATEWAY_AGENTS)
  --library DIR  retain every finalized utterance (WAV + transcript) in DIR and serve
                 the 素材库 panel at /v1/library; off by default (an explicit retention
                 opt-in; VOX_GATEWAY_LIBRARY), and demo mode keeps it off regardless
  --library-max-bytes SIZE
                 retention quota over the library's audio (plain bytes or K/M/G, e.g.
                 512M; VOX_GATEWAY_LIBRARY_MAX_BYTES). Oldest uncorrected, unpromoted
                 captures are evicted to stay under it; corrected or promoted captures
                 are curated work and are never auto-deleted — once they alone fill
                 the quota, new captures are refused instead. Unbounded when unset
  --traces DIR   retain Agent conversation metadata and protocol events in DIR
                 (VOX_GATEWAY_TRACES). Off by default
  --trace-content
                 additionally retain transcripts, replies, and tool payloads
                 (VOX_GATEWAY_TRACE_CONTENT=1). Demo mode always forces content off
  --trace-retention-days N
                 remove completed traces older than N days
                 (VOX_GATEWAY_TRACE_RETENTION_DAYS)
  --trace-max-conversations N
                 keep at most N completed traces deployment-wide
                 (VOX_GATEWAY_TRACE_MAX_CONVERSATIONS)
  --trace-audio input|output|both
                 retain canonical finalized user WAVs, Agent WAVs successfully handed
                 to the media transport, or both (VOX_GATEWAY_TRACE_AUDIO). Independent
                 from content; off by default and always off in demo mode
  --trace-max-bytes SIZE
                 deployment-wide retained conversation audio ceiling (plain bytes or
                 K/M/G; VOX_GATEWAY_TRACE_MAX_BYTES). Requires --traces
  --accounts DIR hosted accounts (docs/auth.md): auth.db in DIR, signup/login at
                 /v1/auth, cookie sessions and API keys instead of the shared token
                 (mutually exclusive with --token). Requires VOX_AUTH_SECRET (>= 32
                 chars); VOX_AUTH_BASE_URL sets the public origin behind a tunnel;
                 VOX_GATEWAY_ACCOUNTS is the environment fallback.
                 Social login: VOX_AUTH_GITHUB_ID/_SECRET or VOX_AUTH_GOOGLE_ID/_SECRET
                 (credentials come from the environment, never argv). VOX_AUTH_PASSWORD=off
                 closes the email-and-password door — a public launch should open one door,
                 not two (docs/auth.md)
  --livekit embedded
                 start and supervise the bundled/installed LiveKit Server helper
                 (VOX_LIVEKIT_EMBEDDED=1). Local WebSocket mode remains the default.
                 VOX_LIVEKIT_SERVER_BIN overrides helper discovery; optional embedded
                 ports are VOX_LIVEKIT_EMBEDDED_PORT (7880),
                 VOX_LIVEKIT_EMBEDDED_RTC_UDP_PORT (7882), and
                 VOX_LIVEKIT_EMBEDDED_RTC_TCP_PORT. VOX_LIVEKIT_EMBEDDED_NODE_IP sets
                 the ICE-advertised address. The generated API secret is passed only
                 through the child environment and never appears in process arguments.
  External LiveKit bootstrap (environment only; secrets never enter argv):
                 VOX_LIVEKIT_URL=wss://..., VOX_LIVEKIT_API_KEY, and
                 VOX_LIVEKIT_API_SECRET must be set together. They configure the signer
                 and the isolated rtc-node Agent media adapter. Tokens last 300 seconds;
                 VOX_LIVEKIT_TOKEN_TTL_SECONDS may set 30–600. When LiveKit is
                 loopback-only behind a tunnel, set VOX_LIVEKIT_PUBLIC_URL=wss://...
                 to the browser-reachable signal endpoint; the browser receives it while
                 the local adapter keeps VOX_LIVEKIT_URL
  --quota N      bound each account to N chargeable operations per window: synthesis,
                 transcription, chat, voice/profile creation, promote, and starting a
                 realtime conversation. Reads, deletes, health and the discovery
                 surface are free. Requires --accounts; off by default
                 (VOX_GATEWAY_QUOTA)
  --quota-window SECONDS
                 the quota window, default 3600 (VOX_GATEWAY_QUOTA_WINDOW)
  --max-synthesis-seconds N
                 refuse a single /v1/audio/speech longer than N estimated seconds of
                 speech (VOX_GATEWAY_MAX_SYNTHESIS_SECONDS). A quota counts requests,
                 not engine time, so without this one unit buys an unbounded synthesis.
                 Off by default
  --max-concurrent-synthesis N
                 admit N syntheses at once, queue Q more (--max-queued-synthesis,
                 default N), refuse the rest with 429 + Retry-After. Measured:
                 throughput is flat past two in flight while latency grows linearly,
                 so admitting more finishes nothing sooner. Off by default
                 (VOX_GATEWAY_MAX_CONCURRENT_SYNTHESIS / _MAX_QUEUED_SYNTHESIS)

Demo guardrails (docs/public-demo.md), all off by default; environment fallbacks
VOX_GATEWAY_MAX_SESSIONS, VOX_GATEWAY_MAX_SESSION_SECONDS, VOX_GATEWAY_DEMO=1:
  --max-sessions N          refuse new conversations at N live sessions
  --max-session-seconds N   every session notices and stops at this ceiling
  --demo                    registry writes 403; MCP servers stay unconnected
  --demo-agent ID           pin every conversation to the Agent's current published
                            version at startup (VOX_GATEWAY_DEMO_AGENT; requires --demo)`;

function positiveNumber(raw: string, option: string, integer = false): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new TypeError(`studio: ${option} must be a positive ${integer ? "integer" : "number"}`);
  }
  return value;
}

function traceAudioValue(raw: string | undefined, option: string): "input" | "output" | "both" | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "input" || raw === "output" || raw === "both") return raw;
  throw new TypeError(`studio: ${option} must be input, output, or both`);
}

/** A guardrail typo must fail closed, not silently run unguarded (adversarial review 2026-07-19). */
function positiveEnv(name: string, integer = false): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return positiveNumber(raw, name, integer);
}

/**
 * OAuth providers from the environment. Credentials never travel in argv, where a
 * process listing would show them, and never enter the repository.
 */
function socialProvidersFromEnv(): Record<string, { clientId: string; clientSecret: string }> | undefined {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const name of ["github", "google"]) {
    const clientId = process.env[`VOX_AUTH_${name.toUpperCase()}_ID`];
    const clientSecret = process.env[`VOX_AUTH_${name.toUpperCase()}_SECRET`];
    if (clientId && clientSecret) providers[name] = { clientId, clientSecret };
    else if (clientId || clientSecret) {
      throw new TypeError(`${name} login needs both VOX_AUTH_${name.toUpperCase()}_ID and VOX_AUTH_${name.toUpperCase()}_SECRET`);
    }
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

/** The password door, closed with VOX_AUTH_PASSWORD=off. Open unless said otherwise. */
function passwordLoginFromEnv(): boolean {
  return (process.env.VOX_AUTH_PASSWORD ?? "on").toLowerCase() !== "off";
}

export async function runStudio(
  args: string[],
  config: VoxConfig,
  io: CliIo,
  start: (options: GatewayServerOptions) => GatewayServer = startGateway,
  waitForever = true,
  /** The --config the process was started with; persist_pronunciations resolves through it. */
  explicitConfigPath?: string,
  startEmbedded: (options: EmbeddedLiveKitRuntimeOptions) => Promise<EmbeddedLiveKitRuntime> = startEmbeddedLiveKitRuntime,
): Promise<number> {
  let host: string | undefined;
  let port: number | undefined;
  // The same environment contract as vox-gateway (docs/auth.md phase 1): the two
  // entrypoints must not drift on where a token may come from.
  let token: string | undefined = process.env.VOX_GATEWAY_TOKEN;
  let maxSessions = positiveEnv("VOX_GATEWAY_MAX_SESSIONS", true);
  let maxSessionSeconds = positiveEnv("VOX_GATEWAY_MAX_SESSION_SECONDS");
  let demoMode = process.env.VOX_GATEWAY_DEMO === "1";
  let demoAgentId = process.env.VOX_GATEWAY_DEMO_AGENT;
  let libraryDir = process.env.VOX_GATEWAY_LIBRARY;
  let traceDir = process.env.VOX_GATEWAY_TRACES;
  let traceContent = process.env.VOX_GATEWAY_TRACE_CONTENT === "1";
  let traceRetentionDays = positiveEnv("VOX_GATEWAY_TRACE_RETENTION_DAYS", true);
  let traceMaxConversations = positiveEnv("VOX_GATEWAY_TRACE_MAX_CONVERSATIONS", true);
  let traceAudio = traceAudioValue(process.env.VOX_GATEWAY_TRACE_AUDIO, "VOX_GATEWAY_TRACE_AUDIO");
  const traceMaxBytesEnv = process.env.VOX_GATEWAY_TRACE_MAX_BYTES;
  let traceMaxBytes = traceMaxBytesEnv === undefined || traceMaxBytesEnv === ""
    ? undefined
    : parseByteSize(traceMaxBytesEnv, "studio: VOX_GATEWAY_TRACE_MAX_BYTES");
  let agentsDir = process.env.VOX_GATEWAY_AGENTS ?? join(homedir(), ".config", "voxstudio", "agents");
  let accountsDir = process.env.VOX_GATEWAY_ACCOUNTS;
  // A quota typo fails closed, exactly like the guardrail envs above.
  let quotaOperations = positiveEnv("VOX_GATEWAY_QUOTA", true);
  let quotaWindow = positiveEnv("VOX_GATEWAY_QUOTA_WINDOW");
  let maxSynthesisSeconds = positiveEnv("VOX_GATEWAY_MAX_SYNTHESIS_SECONDS");
  let maxConcurrentSynthesis = positiveEnv("VOX_GATEWAY_MAX_CONCURRENT_SYNTHESIS", true);
  let maxQueuedSynthesis = positiveEnv("VOX_GATEWAY_MAX_QUEUED_SYNTHESIS", true);
  let useEmbeddedLiveKit = embeddedLiveKitEnabled(process.env);
  const quotaEnv = process.env.VOX_GATEWAY_LIBRARY_MAX_BYTES;
  // A quota typo must fail closed too, exactly like the guardrail envs above.
  let libraryMaxBytes = quotaEnv === undefined || quotaEnv === ""
    ? undefined
    : parseByteSize(quotaEnv, "studio: VOX_GATEWAY_LIBRARY_MAX_BYTES");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const value = (): string => {
      const next = args[++index];
      if (!next) throw new TypeError(`studio: ${arg} requires a value`);
      return next;
    };
    if (arg === "--host") host = value();
    else if (arg === "--port") {
      const parsed = Number(value());
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
        throw new TypeError("studio: --port must be an integer between 0 and 65535");
      }
      port = parsed;
    } else if (arg === "--token") token = value();
    else if (arg === "--livekit") {
      const mode = value();
      if (mode !== "embedded") throw new TypeError("studio: --livekit currently supports only embedded");
      useEmbeddedLiveKit = true;
    }
    else if (arg === "--agents") agentsDir = value();
    else if (arg === "--max-sessions") maxSessions = positiveNumber(value(), arg, true);
    else if (arg === "--max-session-seconds") maxSessionSeconds = positiveNumber(value(), arg);
    else if (arg === "--demo") demoMode = true;
    else if (arg === "--demo-agent") demoAgentId = value();
    else if (arg === "--library") libraryDir = value();
    else if (arg === "--library-max-bytes") libraryMaxBytes = parseByteSize(value(), `studio: ${arg}`);
    else if (arg === "--traces") traceDir = value();
    else if (arg === "--trace-content") traceContent = true;
    else if (arg === "--trace-retention-days") traceRetentionDays = positiveNumber(value(), arg, true);
    else if (arg === "--trace-max-conversations") traceMaxConversations = positiveNumber(value(), arg, true);
    else if (arg === "--trace-audio") traceAudio = traceAudioValue(value(), arg);
    else if (arg === "--trace-max-bytes") traceMaxBytes = parseByteSize(value(), `studio: ${arg}`);
    else if (arg === "--accounts") accountsDir = value();
    else if (arg === "--quota") quotaOperations = positiveNumber(value(), arg, true);
    else if (arg === "--quota-window") quotaWindow = positiveNumber(value(), arg);
    else if (arg === "--max-synthesis-seconds") maxSynthesisSeconds = positiveNumber(value(), arg);
    else if (arg === "--max-concurrent-synthesis") maxConcurrentSynthesis = positiveNumber(value(), arg, true);
    else if (arg === "--max-queued-synthesis") maxQueuedSynthesis = positiveNumber(value(), arg, true);
    else throw new TypeError(`studio: unknown option ${arg}`);
  }
  // A quota with no library is a config mistake; failing closed beats silently ignoring it.
  if (libraryMaxBytes !== undefined && (libraryDir === undefined || libraryDir === "")) {
    throw new TypeError("studio: --library-max-bytes requires --library");
  }
  const hasTraces = traceDir !== undefined && traceDir !== "";
  if (!hasTraces && (traceContent || traceRetentionDays !== undefined || traceMaxConversations !== undefined
      || traceAudio !== undefined || traceMaxBytes !== undefined)) {
    throw new TypeError("studio: trace content, audio, and retention options require --traces");
  }
  // Hosted accounts fail closed at startup (docs/auth.md): no weak secrets, no
  // accounts + token double-door.
  const hasAccounts = accountsDir !== undefined && accountsDir !== "";
  const authSecret = process.env.VOX_AUTH_SECRET ?? "";
  if (hasAccounts && authSecret.length < 32) {
    throw new TypeError("studio: --accounts requires VOX_AUTH_SECRET (at least 32 characters)");
  }
  if (hasAccounts && token !== undefined && token !== "") {
    throw new TypeError("studio: --accounts and --token are mutually exclusive");
  }
  if (token !== undefined) assertGatewayToken(token, "studio: --token/VOX_GATEWAY_TOKEN");
  const authBaseUrl = process.env.VOX_AUTH_BASE_URL;
  // A quota with no accounts would meter the one person running the studio.
  if (quotaOperations !== undefined && !hasAccounts) {
    throw new TypeError("studio: --quota requires --accounts");
  }
  if (demoAgentId !== undefined && demoAgentId !== "" && !demoMode) {
    throw new TypeError("studio: --demo-agent requires --demo");
  }
  if (demoAgentId !== undefined && demoAgentId !== "" && agentsDir === "") {
    throw new TypeError("studio: --demo-agent requires an Agent registry");
  }
  if (demoAgentId !== undefined && demoAgentId !== "" && hasAccounts) {
    throw new TypeError("studio: --demo-agent cannot be combined with --accounts");
  }
  let demoAgent: { id: string; version: number } | undefined;
  if (demoAgentId !== undefined && demoAgentId !== "") {
    const resolved = await new AgentRegistry(agentsDir).resolve("owner", demoAgentId, { type: "published" });
    if (!("version" in resolved)) throw new TypeError(`studio: agent ${demoAgentId} is not published`);
    demoAgent = { id: demoAgentId, version: resolved.version };
  }
  // The manifest is baked at build time; an API-only binary is a build outcome worth
  // saying out loud, not a runtime surprise.
  if (Object.keys(webAssets).length === 0) {
    io.err("studio: no web assets were embedded at build time (apps/web/dist missing); serving the API only");
  }
  // Resolve every fallible non-media input before spawning the helper. A config typo
  // must not leave an orphan LiveKit process behind.
  const decoder = ffmpegPcmDecoder();
  const configPath = await resolveConfigPath(explicitConfigPath === undefined ? {} : { explicit: explicitConfigPath });
  const externalLiveKitFields = [
    process.env.VOX_LIVEKIT_URL,
    process.env.VOX_LIVEKIT_API_KEY,
    process.env.VOX_LIVEKIT_API_SECRET,
  ].some(value => value !== undefined && value !== "");
  if (useEmbeddedLiveKit && externalLiveKitFields) {
    throw new TypeError(
      "studio: embedded LiveKit cannot be combined with VOX_LIVEKIT_URL/API_KEY/API_SECRET; "
      + "VOX_LIVEKIT_PUBLIC_URL remains available as the browser-facing override",
    );
  }
  let livekitRuntime: EmbeddedLiveKitRuntime | undefined;
  const externalLivekit = useEmbeddedLiveKit ? undefined : liveKitBootstrapFromEnv(process.env, "studio");
  if (useEmbeddedLiveKit) {
    livekitRuntime = await startEmbedded({
      ...embeddedLiveKitOptionsFromEnv(process.env),
      log: line => io.err(line),
    });
    io.out("Embedded LiveKit Server ready");
  }
  const livekit = livekitRuntime?.bootstrap ?? externalLivekit;
  // Without ffmpeg the decoder is absent and engines negotiate raw PCM instead.
  const livekitAdapter = livekit === undefined
    ? undefined
    : new DefaultLiveKitAgentMediaAdapter(livekit, undefined, line => io.err(line));
  let gateway: GatewayServer;
  try {
    gateway = start({
      config,
      staticAssets: webAssets,
      ...(decoder === undefined ? {} : { pcmDecoder: decoder }),
      ...(host === undefined ? {} : { hostname: host }),
      ...(port === undefined ? {} : { port }),
      ...(token === undefined || token === "" ? {} : { token }),
      ...(livekit === undefined ? {} : { livekit, livekitAdapter: livekitAdapter as DefaultLiveKitAgentMediaAdapter }),
      ...(maxSessions === undefined ? {} : { maxSessions }),
      ...(maxSessionSeconds === undefined ? {} : { maxSessionSeconds }),
      ...(demoMode ? { demoMode } : {}),
      ...(demoAgent === undefined ? {} : { demoAgent }),
      ...(agentsDir === "" ? {} : { agentsDir }),
      ...(libraryDir === undefined || libraryDir === "" ? {} : { libraryDir }),
      ...(libraryMaxBytes === undefined ? {} : { libraryMaxBytes }),
      ...(hasTraces ? { traceDir: traceDir as string } : {}),
      ...(traceContent ? { traceContent: true } : {}),
      ...(traceRetentionDays === undefined ? {} : { traceRetentionDays }),
      ...(traceMaxConversations === undefined ? {} : { traceMaxConversations }),
      ...(traceAudio === undefined ? {} : { traceAudio }),
      ...(traceMaxBytes === undefined ? {} : { traceMaxBytes }),
      ...(hasAccounts ? {
        accounts: {
          dir: accountsDir as string,
          secret: authSecret,
          ...(authBaseUrl === undefined || authBaseUrl === "" ? {} : { baseUrl: authBaseUrl }),
          ...(socialProvidersFromEnv() === undefined ? {} : { socialProviders: socialProvidersFromEnv() as Record<string, { clientId: string; clientSecret: string }> }),
          passwordLogin: passwordLoginFromEnv(),
        },
      } : {}),
      ...(quotaOperations === undefined
        ? {}
        : { quota: { operations: quotaOperations, windowSeconds: quotaWindow ?? 3_600 } }),
      ...(maxSynthesisSeconds === undefined ? {} : { maxSynthesisSeconds }),
      ...(maxConcurrentSynthesis === undefined
        ? {}
        : { synthesisConcurrency: { maxInFlight: maxConcurrentSynthesis, maxQueued: maxQueuedSynthesis ?? maxConcurrentSynthesis } }),
      loadSileroVad: () => loadSileroVadModel((line, level) => {
        if (level === "info") io.out(line);
        else io.err(line);
      }),
      ...(configPath === undefined ? {} : {
        persistPronunciations: (entries: Record<string, string>) => persistPronunciationsFile(configPath, entries),
      }),
      log: line => io.err(line),
    });
  } catch (error) {
    await livekitRuntime?.stop();
    throw error;
  }
  io.out(`Web Studio at ${gateway.url}`);
  if (token !== undefined && token !== "") {
    io.out("Shared-token Studio: append #token=<VOX_GATEWAY_TOKEN> once; the browser redacts it from the URL");
  }
  if (!waitForever) {
    await gateway.stop();
    await livekitRuntime?.stop();
    return 0;
  }
  let closing = false;
  const stop = (exitCode = 0) => {
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        await gateway.stop();
      } catch (error) {
        io.err(`studio: gateway shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await livekitRuntime?.stop().catch(error => {
          io.err(`studio: embedded LiveKit shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        process.exit(exitCode);
      }
    })();
  };
  if (livekitRuntime !== undefined) {
    void livekitRuntime.exited.then(code => {
      if (closing) return;
      io.err(`embedded LiveKit Server exited unexpectedly with status ${code}; stopping Studio`);
      stop(1);
    });
  }
  process.once("SIGINT", () => stop());
  process.once("SIGTERM", () => stop());
  return await new Promise<number>(() => {});
}
