import { ffmpegPcmDecoder, loadConfig, loadSileroVadModel } from "@voxstudio/platform-bun";
import { startGateway } from "./server";

const usage = `usage: vox-gateway [--config CONFIG] [--host HOST] [--port PORT] [--token TOKEN]

Realtime gateway for the Web Studio: the duplex session protocol over WebSocket at
/v1/realtime, plus a REST facade over the engine contract. Binds loopback by default;
reaching it from a browser is a deployment decision (a tunnel in front, Access at the
door). TOKEN, when set, is required as a Bearer header or ?token= query parameter.
Environment: VOX_GATEWAY_HOST, VOX_GATEWAY_PORT, VOX_GATEWAY_TOKEN. Demo guardrails
(docs/public-demo.md): --max-sessions N, --max-session-seconds N, --demo (or
VOX_GATEWAY_MAX_SESSIONS, VOX_GATEWAY_MAX_SESSION_SECONDS, VOX_GATEWAY_DEMO=1).`;

async function main(args: string[]): Promise<number> {
  let explicit: string | undefined;
  let host = process.env.VOX_GATEWAY_HOST;
  let port = process.env.VOX_GATEWAY_PORT;
  let token = process.env.VOX_GATEWAY_TOKEN;
  let maxSessions = process.env.VOX_GATEWAY_MAX_SESSIONS;
  let maxSessionSeconds = process.env.VOX_GATEWAY_MAX_SESSION_SECONDS;
  let demoMode = process.env.VOX_GATEWAY_DEMO === "1";
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
    else throw new TypeError(`vox-gateway: unknown option ${arg}`);
  }
  const config = explicit === undefined ? await loadConfig() : await loadConfig({ explicit });
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
  const decoder = ffmpegPcmDecoder();
  const gateway = startGateway({
    config,
    ...(host === undefined ? {} : { hostname: host }),
    ...(parsedPort === undefined ? {} : { port: parsedPort }),
    ...(token === undefined || token === "" ? {} : { token }),
    ...(cappedSessions === undefined ? {} : { maxSessions: cappedSessions }),
    ...(cappedSeconds === undefined ? {} : { maxSessionSeconds: cappedSeconds }),
    ...(demoMode ? { demoMode } : {}),
    loadSileroVad: loadSileroVadModel,
    ...(decoder === undefined ? {} : { pcmDecoder: decoder }),
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
