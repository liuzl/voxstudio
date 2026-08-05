import { AccessToken, TrackSource } from "livekit-server-sdk";

/**
 * Server-side credentials used only to mint short-lived browser participant tokens.
 * The API secret must never cross the gateway boundary or enter the web bundle.
 */
export interface LiveKitBootstrapOptions {
  serverUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Browser token lifetime. Defaults to five minutes and is capped at ten. */
  tokenTtlSeconds?: number;
}

export interface LiveKitBootstrapResponse {
  server_url: string;
  participant_token: string;
  room_name: string;
  participant_identity: string;
  expires_at: string;
}

export interface LiveKitAgentToken {
  participantToken: string;
  participantIdentity: string;
}

export const defaultLiveKitTokenTtlSeconds = 300;
export const minLiveKitTokenTtlSeconds = 30;
export const maxLiveKitTokenTtlSeconds = 600;

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Validate once at process startup, before the gateway starts accepting requests. */
export function validateLiveKitBootstrapOptions(options: LiveKitBootstrapOptions): void {
  let url: URL;
  try {
    url = new URL(options.serverUrl);
  } catch {
    throw new TypeError("LiveKit server URL must be an absolute wss:// URL");
  }
  const secure = url.protocol === "wss:";
  const localDevelopment = url.protocol === "ws:" && isLoopback(url.hostname);
  if (!secure && !localDevelopment) {
    throw new TypeError("LiveKit server URL must use wss:// (ws:// is allowed only on loopback)");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("LiveKit server URL must not contain credentials, a query, or a fragment");
  }
  if (options.apiKey.trim() === "") throw new TypeError("LiveKit API key must not be empty");
  if (options.apiSecret.trim() === "") throw new TypeError("LiveKit API secret must not be empty");
  // LiveKit's documented loopback dev server intentionally uses devkey/secret. Keep
  // that path usable, but refuse weak signing material anywhere a network can reach.
  if (!localDevelopment && new TextEncoder().encode(options.apiSecret).byteLength < 32) {
    throw new TypeError("production LiveKit API secret must be at least 32 bytes");
  }
  const ttl = options.tokenTtlSeconds ?? defaultLiveKitTokenTtlSeconds;
  if (!Number.isInteger(ttl) || ttl < minLiveKitTokenTtlSeconds || ttl > maxLiveKitTokenTtlSeconds) {
    throw new TypeError(
      `LiveKit token TTL must be an integer between ${minLiveKitTokenTtlSeconds} and ${maxLiveKitTokenTtlSeconds} seconds`,
    );
  }
}

/** Read the deployment-only signing contract consistently in both gateway entrypoints. */
export function liveKitBootstrapFromEnv(
  env: Record<string, string | undefined>,
  source = "LiveKit",
): LiveKitBootstrapOptions | undefined {
  const serverUrl = env.VOX_LIVEKIT_URL;
  const apiKey = env.VOX_LIVEKIT_API_KEY;
  const apiSecret = env.VOX_LIVEKIT_API_SECRET;
  const rawTtl = env.VOX_LIVEKIT_TOKEN_TTL_SECONDS;
  const hasAny = [serverUrl, apiKey, apiSecret, rawTtl].some(value => value !== undefined && value !== "");
  if (!hasAny) return undefined;
  if (!serverUrl || !apiKey || !apiSecret) {
    throw new TypeError(`${source}: VOX_LIVEKIT_URL, VOX_LIVEKIT_API_KEY, and VOX_LIVEKIT_API_SECRET must be set together`);
  }
  const tokenTtlSeconds = rawTtl === undefined || rawTtl === "" ? undefined : Number(rawTtl);
  const options: LiveKitBootstrapOptions = {
    serverUrl,
    apiKey,
    apiSecret,
    ...(tokenTtlSeconds === undefined ? {} : { tokenTtlSeconds }),
  };
  try {
    validateLiveKitBootstrapOptions(options);
  } catch (error) {
    throw new TypeError(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return options;
}

/**
 * Mint one opaque room and participant per request. Account ids, emails, and display
 * names deliberately never become LiveKit-visible identity or metadata.
 */
export async function issueLiveKitBrowserToken(
  options: LiveKitBootstrapOptions,
): Promise<LiveKitBootstrapResponse> {
  validateLiveKitBootstrapOptions(options);
  const ttl = options.tokenTtlSeconds ?? defaultLiveKitTokenTtlSeconds;
  const roomName = `vox-${crypto.randomUUID().replaceAll("-", "")}`;
  const participantIdentity = `web-${crypto.randomUUID().replaceAll("-", "")}`;
  const token = new AccessToken(options.apiKey, options.apiSecret, {
    identity: participantIdentity,
    ttl,
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  const participantToken = await token.toJwt();
  const encodedClaims = participantToken.split(".")[1];
  if (encodedClaims === undefined) throw new TypeError("LiveKit generated a malformed participant token");
  const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as { exp?: unknown };
  if (!Number.isSafeInteger(claims.exp) || (claims.exp as number) <= 0) {
    throw new TypeError("LiveKit participant token has no valid expiration");
  }
  return {
    server_url: options.serverUrl,
    participant_token: participantToken,
    room_name: roomName,
    participant_identity: participantIdentity,
    expires_at: new Date((claims.exp as number) * 1_000).toISOString(),
  };
}

/**
 * Mint the matching programmatic-participant grant used by VoxStudio's media adapter.
 * It is never returned to the browser: the adapter may subscribe to the one browser
 * microphone and publish one Agent audio track plus control data in this room only.
 */
export async function issueLiveKitAgentToken(
  options: LiveKitBootstrapOptions,
  roomName: string,
): Promise<LiveKitAgentToken> {
  validateLiveKitBootstrapOptions(options);
  if (!/^vox-[a-f0-9]{32}$/.test(roomName)) throw new TypeError("invalid VoxStudio LiveKit room name");
  const participantIdentity = `agent-${crypto.randomUUID().replaceAll("-", "")}`;
  const token = new AccessToken(options.apiKey, options.apiSecret, {
    identity: participantIdentity,
    ttl: options.tokenTtlSeconds ?? defaultLiveKitTokenTtlSeconds,
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  return { participantToken: await token.toJwt(), participantIdentity };
}
