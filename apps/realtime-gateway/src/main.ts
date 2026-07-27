import { ffmpegPcmDecoder, loadConfig, loadSileroVadModel, persistPronunciationsFile, resolveConfigPath } from "@voxstudio/platform-bun";
import { parseByteSize } from "./library";
import { startGateway } from "./server";

const usage = `usage: vox-gateway [--config CONFIG] [--host HOST] [--port PORT] [--token TOKEN]

Realtime gateway for the Web Studio: the duplex session protocol over WebSocket at
/v1/realtime, plus a REST facade over the engine contract. Binds loopback by default;
reaching it from a browser is a deployment decision (a tunnel in front, Access at the
door). TOKEN, when set, is required as a Bearer header or ?token= query parameter.
Environment: VOX_GATEWAY_HOST, VOX_GATEWAY_PORT, VOX_GATEWAY_TOKEN. Demo guardrails
(docs/public-demo.md): --max-sessions N, --max-session-seconds N, --demo (or
VOX_GATEWAY_MAX_SESSIONS, VOX_GATEWAY_MAX_SESSION_SECONDS, VOX_GATEWAY_DEMO=1).
--library DIR (or VOX_GATEWAY_LIBRARY) retains every finalized utterance — WAV +
transcript in DIR, served at /v1/library for the Web Studio 素材库 panel. Off by
default; demo mode keeps it off regardless. --library-max-bytes SIZE (or
VOX_GATEWAY_LIBRARY_MAX_BYTES; plain bytes or K/M/G, e.g. 512M) bounds retained
audio: oldest uncorrected/unpromoted captures are evicted first, corrected or
promoted ones never — ingest is refused instead once they alone fill the quota.
--accounts DIR (or VOX_GATEWAY_ACCOUNTS) turns on hosted accounts (docs/auth.md):
auth.db in DIR, signup/login at /v1/auth, cookie sessions and API keys instead of
the shared token (the two are mutually exclusive). Requires VOX_AUTH_SECRET
(>= 32 chars); VOX_AUTH_BASE_URL sets the public origin behind a tunnel.
Social login: VOX_AUTH_GITHUB_ID/_SECRET or VOX_AUTH_GOOGLE_ID/_SECRET;
VOX_AUTH_PASSWORD=off closes the email-and-password door.
--quota N (or VOX_GATEWAY_QUOTA) bounds each account to N chargeable operations
per window — synthesis, transcription, chat, voice/profile creation, promote, and
starting a realtime conversation; reads, deletes, health and the discovery surface
are free. --quota-window SECONDS (VOX_GATEWAY_QUOTA_WINDOW, default 3600) sets the
window. Requires --accounts; off by default.
--max-synthesis-seconds N (or VOX_GATEWAY_MAX_SYNTHESIS_SECONDS) refuses a single
/v1/audio/speech request longer than N estimated seconds of speech. A quota counts
requests, not engine time, so without this one unit can buy an arbitrarily long
synthesis. Off by default.
--max-concurrent-synthesis N (VOX_GATEWAY_MAX_CONCURRENT_SYNTHESIS) admits N
syntheses at once and queues --max-queued-synthesis Q (default N) more; past that a
caller gets 429 with Retry-After. Measured: throughput is flat past two in flight
while latency grows linearly, so admitting more finishes nothing sooner.`;

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

async function main(args: string[]): Promise<number> {
  let explicit: string | undefined;
  let host = process.env.VOX_GATEWAY_HOST;
  let port = process.env.VOX_GATEWAY_PORT;
  let token = process.env.VOX_GATEWAY_TOKEN;
  let maxSessions = process.env.VOX_GATEWAY_MAX_SESSIONS;
  let maxSessionSeconds = process.env.VOX_GATEWAY_MAX_SESSION_SECONDS;
  let demoMode = process.env.VOX_GATEWAY_DEMO === "1";
  let libraryDir = process.env.VOX_GATEWAY_LIBRARY;
  let libraryMaxBytes = process.env.VOX_GATEWAY_LIBRARY_MAX_BYTES;
  let accountsDir = process.env.VOX_GATEWAY_ACCOUNTS;
  let quotaOperations = process.env.VOX_GATEWAY_QUOTA;
  let quotaWindow = process.env.VOX_GATEWAY_QUOTA_WINDOW;
  let maxSynthesisSeconds = process.env.VOX_GATEWAY_MAX_SYNTHESIS_SECONDS;
  let maxConcurrentSynthesis = process.env.VOX_GATEWAY_MAX_CONCURRENT_SYNTHESIS;
  let maxQueuedSynthesis = process.env.VOX_GATEWAY_MAX_QUEUED_SYNTHESIS;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const value = (): string => {
      const next = args[++index];
      if (!next) throw new TypeError(`vox-gateway: ${arg} requires a value`);
      return next;
    };
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      return 0;
    } else if (arg === "--config") explicit = value();
    else if (arg === "--host") host = value();
    else if (arg === "--port") port = value();
    else if (arg === "--token") token = value();
    else if (arg === "--max-sessions") maxSessions = value();
    else if (arg === "--max-session-seconds") maxSessionSeconds = value();
    else if (arg === "--demo") demoMode = true;
    else if (arg === "--library") libraryDir = value();
    else if (arg === "--library-max-bytes") libraryMaxBytes = value();
    else if (arg === "--accounts") accountsDir = value();
    else if (arg === "--quota") quotaOperations = value();
    else if (arg === "--quota-window") quotaWindow = value();
    else if (arg === "--max-synthesis-seconds") maxSynthesisSeconds = value();
    else if (arg === "--max-concurrent-synthesis") maxConcurrentSynthesis = value();
    else if (arg === "--max-queued-synthesis") maxQueuedSynthesis = value();
    else throw new TypeError(`vox-gateway: unknown option ${arg}`);
  }
  const config = explicit === undefined ? await loadConfig() : await loadConfig({ explicit });
  const configPath = await resolveConfigPath(explicit === undefined ? {} : { explicit });
  const parsedPort = port === undefined ? undefined : Number(port);
  if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535)) {
    throw new TypeError("vox-gateway: --port must be an integer between 0 and 65535");
  }
  // Without ffmpeg the decoder is absent and engines negotiate raw PCM instead.
  const positive = (raw: string | undefined, name: string, integer = false): number | undefined => {
    if (raw === undefined || raw === "") return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
      throw new TypeError(`vox-gateway: ${name} must be a positive ${integer ? "integer" : "number"}`);
    }
    return parsed;
  };
  const cappedSessions = positive(maxSessions, "--max-sessions", true);
  const cappedSeconds = positive(maxSessionSeconds, "--max-session-seconds");
  const hasLibrary = libraryDir !== undefined && libraryDir !== "";
  const quotaBytes = libraryMaxBytes === undefined || libraryMaxBytes === ""
    ? undefined
    : parseByteSize(libraryMaxBytes, "vox-gateway: --library-max-bytes");
  // A quota with no library is a config mistake; failing closed beats silently ignoring it.
  if (quotaBytes !== undefined && !hasLibrary) {
    throw new TypeError("vox-gateway: --library-max-bytes requires --library");
  }
  // Hosted accounts fail closed at startup: a weak or missing secret must never boot,
  // and accounts + token is two products in one config (docs/auth.md decision 1).
  const hasAccounts = accountsDir !== undefined && accountsDir !== "";
  const authSecret = process.env.VOX_AUTH_SECRET ?? "";
  if (hasAccounts && authSecret.length < 32) {
    throw new TypeError("vox-gateway: --accounts requires VOX_AUTH_SECRET (at least 32 characters)");
  }
  if (hasAccounts && token !== undefined && token !== "") {
    throw new TypeError("vox-gateway: --accounts and --token are mutually exclusive");
  }
  const authBaseUrl = process.env.VOX_AUTH_BASE_URL;
  // A quota typo fails closed, and a quota without accounts is a config mistake: there
  // would be exactly one account to meter, the operator's own.
  const quotaCount = positive(quotaOperations, "--quota", true);
  const quotaSeconds = positive(quotaWindow, "--quota-window") ?? 3_600;
  const synthesisCeiling = positive(maxSynthesisSeconds, "--max-synthesis-seconds");
  const inFlight = positive(maxConcurrentSynthesis, "--max-concurrent-synthesis", true);
  const queued = positive(maxQueuedSynthesis, "--max-queued-synthesis", true);
  if (queued !== undefined && inFlight === undefined) {
    throw new TypeError("vox-gateway: --max-queued-synthesis requires --max-concurrent-synthesis");
  }
  if (quotaCount !== undefined && !hasAccounts) {
    throw new TypeError("vox-gateway: --quota requires --accounts");
  }
  const decoder = ffmpegPcmDecoder();
  const gateway = startGateway({
    config,
    ...(host === undefined ? {} : { hostname: host }),
    ...(parsedPort === undefined ? {} : { port: parsedPort }),
    ...(token === undefined || token === "" ? {} : { token }),
    ...(cappedSessions === undefined ? {} : { maxSessions: cappedSessions }),
    ...(cappedSeconds === undefined ? {} : { maxSessionSeconds: cappedSeconds }),
    ...(demoMode ? { demoMode } : {}),
    ...(hasLibrary ? { libraryDir: libraryDir as string } : {}),
    ...(quotaBytes === undefined ? {} : { libraryMaxBytes: quotaBytes }),
    ...(hasAccounts ? {
      accounts: {
        dir: accountsDir as string,
        secret: authSecret,
        ...(authBaseUrl === undefined || authBaseUrl === "" ? {} : { baseUrl: authBaseUrl }),
        ...(socialProvidersFromEnv() === undefined ? {} : { socialProviders: socialProvidersFromEnv() as Record<string, { clientId: string; clientSecret: string }> }),
        passwordLogin: passwordLoginFromEnv(),
      },
    } : {}),
    ...(quotaCount === undefined ? {} : { quota: { operations: quotaCount, windowSeconds: quotaSeconds } }),
    ...(synthesisCeiling === undefined ? {} : { maxSynthesisSeconds: synthesisCeiling }),
    ...(inFlight === undefined ? {} : { synthesisConcurrency: { maxInFlight: inFlight, maxQueued: queued ?? inFlight } }),
    loadSileroVad: () => loadSileroVadModel(line => console.error(line)),
    ...(decoder === undefined ? {} : { pcmDecoder: decoder }),
    ...(configPath === undefined ? {} : {
      persistPronunciations: (entries: Record<string, string>) => persistPronunciationsFile(configPath, entries),
    }),
    log: line => console.error(line),
  });
  const stop = () => { void gateway.stop().then(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return await new Promise<number>(() => {});
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
