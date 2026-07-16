import type { VoxConfig } from "@voxstudio/contracts";
import { ffmpegPcmDecoder, loadSileroVadModel } from "@voxstudio/platform-bun";
import { startGateway, type GatewayServer, type GatewayServerOptions } from "@voxstudio/realtime-gateway";
import { webAssets } from "../generated/web-assets";
import type { CliIo } from "../io";

export const studioUsage = `usage: vox studio [--host HOST] [--port PORT] [--token TOKEN]

Serve the Web Studio: the browser app, the realtime WebSocket (/v1/realtime), and the
credential-hiding REST facade in one process. Binds loopback by default; reaching it
from another machine is a deployment decision (a tunnel, Access at the door). TOKEN,
when set, guards every /v1 request and the WebSocket upgrade; the app shell itself is
served without it. The compiled binary carries no ONNX runtime, so barge-in detection
degrades loudly to the certified energy detector.

options:
  --host HOST    bind address (default 127.0.0.1)
  --port PORT    listen port (default 8790)
  --token TOKEN  bearer token required on /v1 requests and the realtime socket`;

export async function runStudio(
  args: string[],
  config: VoxConfig,
  io: CliIo,
  start: (options: GatewayServerOptions) => GatewayServer = startGateway,
  waitForever = true,
): Promise<number> {
  let host: string | undefined;
  let port: number | undefined;
  let token: string | undefined;
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
    else throw new TypeError(`studio: unknown option ${arg}`);
  }
  // The manifest is baked at build time; an API-only binary is a build outcome worth
  // saying out loud, not a runtime surprise.
  if (Object.keys(webAssets).length === 0) {
    io.err("studio: no web assets were embedded at build time (apps/web/dist missing); serving the API only");
  }
  // Without ffmpeg the decoder is absent and engines negotiate raw PCM instead.
  const decoder = ffmpegPcmDecoder();
  const gateway = start({
    config,
    staticAssets: webAssets,
    ...(decoder === undefined ? {} : { pcmDecoder: decoder }),
    ...(host === undefined ? {} : { hostname: host }),
    ...(port === undefined ? {} : { port }),
    ...(token === undefined || token === "" ? {} : { token }),
    loadSileroVad: loadSileroVadModel,
    log: line => io.err(line),
  });
  io.out(`Web Studio at ${gateway.url}`);
  if (!waitForever) {
    await gateway.stop();
    return 0;
  }
  const stop = () => {
    void gateway.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return await new Promise<number>(() => {});
}
