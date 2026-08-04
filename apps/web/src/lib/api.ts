/** REST facade helpers: same-origin /v1 endpoints proxied by the gateway. */
import { t, type MessageKey } from "../i18n";
import { gatewayFetch, gatewayResourceUrl } from "./gateway-auth";
import { reportUnauthorized } from "./unauthorized";
import type {
  AgentAudit,
  AgentPublishedVersion,
  AgentRecord,
  AgentSpec,
  CreateAgentInput,
} from "@voxstudio/agents";

async function fail(response: Response, what: MessageKey): Promise<never> {
  // A hosted session that expired (or was signed out elsewhere) must send the shell
  // back to the sign-in card, not bury a 401 in a panel-shaped error.
  if (response.status === 401) reportUnauthorized();
  let detail = "";
  try {
    const body = await response.json() as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    // Non-JSON error body; the status is the message.
  }
  throw new Error(t("{what}失败（{status}{detail}）", {
    what: t(what),
    status: response.status,
    detail: detail ? `: ${detail}` : "",
  }));
}

export type { AgentAudit, AgentPublishedVersion, AgentRecord, AgentSpec };

async function agentJson<T>(response: Response, what: MessageKey): Promise<T> {
  if (!response.ok) await fail(response, what);
  return response.json() as Promise<T>;
}

export async function listAgents(): Promise<AgentRecord[]> {
  const payload = await agentJson<{ agents?: AgentRecord[] }>(await gatewayFetch("/v1/agents"), "获取助手列表");
  return payload.agents ?? [];
}

export async function getAgent(id: string): Promise<AgentRecord> {
  return agentJson(await gatewayFetch(`/v1/agents/${encodeURIComponent(id)}`), "获取助手");
}

export async function createAgent(input: CreateAgentInput): Promise<AgentRecord> {
  return agentJson(await gatewayFetch("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }), "创建助手");
}

export async function updateAgent(id: string, revision: number, input: {
  name?: string;
  description?: string | null;
  avatar?: string | null;
  spec?: AgentSpec;
}): Promise<AgentRecord> {
  return agentJson(await gatewayFetch(`/v1/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, ...input }),
  }), "保存助手");
}

export async function deleteAgent(id: string, revision: number): Promise<void> {
  await agentJson(await gatewayFetch(`/v1/agents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision }),
  }), "删除助手");
}

export async function publishAgent(id: string, revision: number): Promise<{
  record: AgentRecord;
  version: AgentPublishedVersion;
}> {
  return agentJson(await gatewayFetch(`/v1/agents/${encodeURIComponent(id)}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision }),
  }), "发布助手");
}

export async function auditAgent(id: string): Promise<AgentAudit> {
  return agentJson(await gatewayFetch(`/v1/agents/${encodeURIComponent(id)}/audit`, { method: "POST" }), "检查助手版本");
}

export async function listAgentVersions(id: string): Promise<AgentPublishedVersion[]> {
  const payload = await agentJson<{ versions?: AgentPublishedVersion[] }>(
    await gatewayFetch(`/v1/agents/${encodeURIComponent(id)}/versions`),
    "获取助手版本",
  );
  return payload.versions ?? [];
}

export type ConversationOutcome = "active" | "completed" | "error" | "abandoned";

export interface ConversationTracePolicy {
  enabled: boolean;
  content: boolean;
  audio: boolean;
  retentionDays?: number | null;
  maxConversations?: number | null;
}

export interface ConversationTraceSummary {
  id: string;
  agentId: string;
  agentSource: "draft" | "published";
  agentRevision: number | null;
  agentVersion: number | null;
  agentHash: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  outcome: ConversationOutcome;
  errorCode: string | null;
  turnCount: number;
  contentRetained: boolean;
}

export interface ConversationTraceEvent {
  type: string;
  sequence: number;
  timestampMs: number;
  sessionId: string;
  turnId?: string;
  revision?: number;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  ok?: boolean;
  code?: string;
  message?: string;
  recoverable?: boolean;
  state?: string;
  previous?: string;
  reason?: string;
  offsetsMs?: Record<string, number>;
  [key: string]: unknown;
}

export interface ConversationTraceDetail extends ConversationTraceSummary {
  events: ConversationTraceEvent[];
}

export async function listAgentConversations(id: string, filters: {
  outcome?: ConversationOutcome;
  query?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
} = {}): Promise<{ conversations: ConversationTraceSummary[]; total: number; policy: ConversationTracePolicy }> {
  const query = new URLSearchParams();
  if (filters.outcome) query.set("outcome", filters.outcome);
  if (filters.query?.trim()) query.set("id", filters.query.trim());
  if (filters.limit !== undefined) query.set("limit", String(filters.limit));
  if (filters.offset !== undefined) query.set("offset", String(filters.offset));
  const response = await gatewayFetch(
    `/v1/agents/${encodeURIComponent(id)}/conversations${query.size ? `?${query}` : ""}`,
    filters.signal === undefined ? undefined : { signal: filters.signal },
  );
  if (response.status === 404) {
    const body = await response.clone().json().catch(() => null) as { error?: { code?: string } } | null;
    if (body?.error?.code === "traces_disabled") {
      return { conversations: [], total: 0, policy: { enabled: false, content: false, audio: false } };
    }
  }
  if (!response.ok) await fail(response, "获取助手会话");
  return response.json() as Promise<{ conversations: ConversationTraceSummary[]; total: number; policy: ConversationTracePolicy }>;
}

export async function getAgentConversation(agentId: string, sessionId: string): Promise<{
  conversation: ConversationTraceDetail;
  policy: ConversationTracePolicy;
}> {
  const response = await gatewayFetch(`/v1/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(sessionId)}`);
  if (!response.ok) await fail(response, "获取会话详情");
  return response.json() as Promise<{ conversation: ConversationTraceDetail; policy: ConversationTracePolicy }>;
}

export async function deleteAgentConversation(agentId: string, sessionId: string): Promise<void> {
  const response = await gatewayFetch(`/v1/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  if (!response.ok) await fail(response, "删除会话");
}

export interface DeploymentInfo {
  auth: "self" | "accounts";
  demo: boolean;
  tokenRequired: boolean;
  demoAgent?: { id: string; version: number };
  maxSessions?: number;
  maxSessionSeconds?: number;
}

export async function getDeploymentInfo(): Promise<DeploymentInfo> {
  const response = await fetch("/healthz");
  if (!response.ok) await fail(response, "获取部署信息");
  const body = await response.json() as {
    auth?: "self" | "accounts";
    deployment?: Omit<DeploymentInfo, "auth">;
  };
  return {
    auth: body.auth ?? "self",
    demo: body.deployment?.demo ?? false,
    tokenRequired: body.deployment?.tokenRequired ?? false,
    ...(body.deployment?.demoAgent === undefined ? {} : { demoAgent: body.deployment.demoAgent }),
    ...(body.deployment?.maxSessions === undefined ? {} : { maxSessions: body.deployment.maxSessions }),
    ...(body.deployment?.maxSessionSeconds === undefined ? {} : { maxSessionSeconds: body.deployment.maxSessionSeconds }),
  };
}

export interface DesignProfileMeta {
  description: string;
  seed: number;
  cfg_value: number;
  timesteps: number;
  model: string;
  model_manifest_sha256?: string | null;
  audio_sha256?: string;
}

export interface VoiceEntry {
  id: string;
  /** Which TTS instance owns the id — the union bank spans engines. */
  engine: string;
  /** Present when the voice is a reproducible design profile. */
  designProfile?: DesignProfileMeta;
  promptText?: string;
}

export async function listVoices(): Promise<VoiceEntry[]> {
  const response = await gatewayFetch("/v1/voices");
  if (!response.ok) await fail(response, "获取音色列表");
  const payload = await response.json() as {
    voices?: { id?: string; engine?: string; design_profile?: DesignProfileMeta; prompt_text?: string }[];
  };
  return (payload.voices ?? [])
    .map(entry => ({
      id: entry.id ?? "",
      engine: entry.engine ?? "",
      ...(entry.design_profile === undefined ? {} : { designProfile: entry.design_profile }),
      ...(entry.prompt_text === undefined ? {} : { promptText: entry.prompt_text }),
    }))
    .filter(entry => entry.id !== "");
}

export interface DesignProfileRequestParams {
  id: string;
  description: string;
  anchorText: string;
  seed: number;
  cfgValue?: number;
  timesteps?: number;
}

/** Create a reproducible design voice; routed to a design-capable engine. */
export async function createDesignProfile(params: DesignProfileRequestParams, engine?: string): Promise<VoiceEntry> {
  const query = engine ? `?engine=${encodeURIComponent(engine)}` : "";
  const response = await gatewayFetch(`/v1/design-profiles${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: params.id,
      description: params.description,
      anchor_text: params.anchorText,
      seed: params.seed,
      ...(params.cfgValue === undefined ? {} : { cfg_value: params.cfgValue }),
      ...(params.timesteps === undefined ? {} : { timesteps: params.timesteps }),
    }),
  });
  if (!response.ok) await fail(response, "创建设计档");
  const voice = await response.json() as { id?: string; design_profile?: DesignProfileMeta; prompt_text?: string };
  return {
    id: voice.id ?? params.id,
    engine: engine ?? "",
    ...(voice.design_profile === undefined ? {} : { designProfile: voice.design_profile }),
    ...(voice.prompt_text === undefined ? {} : { promptText: voice.prompt_text }),
  };
}

export interface EngineEntry {
  name: string;
  kind: string | null;
  model: string;
  capabilities: string[];
  roles: string[];
  healthy: boolean;
  /** Self-reported model identity — what design-profile audits compare against. */
  runtime: { model: string; manifestSha256: string | null } | null;
}

export interface RuntimeCatalog {
  engines: EngineEntry[];
  /** Sanitized connected names only; transports and credentials stay gateway-side. */
  mcpServers: string[];
}

export async function listRuntimeCatalog(): Promise<RuntimeCatalog> {
  const response = await gatewayFetch("/v1/engines");
  if (!response.ok) await fail(response, "获取引擎列表");
  const payload = await response.json() as { engines?: EngineEntry[]; mcpServers?: string[] };
  return { engines: payload.engines ?? [], mcpServers: payload.mcpServers ?? [] };
}

export async function listEngines(): Promise<EngineEntry[]> {
  return (await listRuntimeCatalog()).engines;
}

export interface VoiceRegistrationEngineResult {
  engine: string;
  ok: boolean;
  status: number;
  error?: { code: string; message: string };
}

export interface VoiceRegistrationResult {
  id: string;
  registered: string[];
  failed: string[];
  results: VoiceRegistrationEngineResult[];
}

export async function registerVoice(id: string, text: string, audio: File, engines: string[]): Promise<VoiceRegistrationResult> {
  const form = new FormData();
  form.set("id", id);
  form.set("text", text);
  form.set("audio", audio);
  for (const engine of engines) form.append("engine", engine);
  const response = await gatewayFetch("/v1/voices", { method: "POST", body: form });
  const parsed = await response.clone().json().catch(() => null) as Partial<VoiceRegistrationResult> | null;
  const structured = parsed !== null
    && typeof parsed.id === "string"
    && Array.isArray(parsed.registered)
    && Array.isArray(parsed.failed)
    && Array.isArray(parsed.results);
  if (!structured) {
    if (!response.ok) await fail(response, "注册音色");
    throw new TypeError("注册音色失败：网关返回了无效结果");
  }
  return parsed as VoiceRegistrationResult;
}

export async function deleteVoice(id: string, engine?: string): Promise<void> {
  const query = engine ? `?engine=${encodeURIComponent(engine)}` : "";
  const response = await gatewayFetch(`/v1/voices/${encodeURIComponent(id)}${query}`, { method: "DELETE" });
  if (!response.ok) await fail(response, "删除音色");
}

/** Transcribe a recording through the facade — prefills the reference transcript.
 * `revise` routes through the ASR accuracy tier (slower; silently falls back to the draft engine). */
export async function transcribe(audio: File, language = "auto", revise = false): Promise<string> {
  const form = new FormData();
  form.set("model", "default");
  form.set("language", language);
  if (revise) form.set("revise", "true");
  form.set("file", audio);
  const response = await gatewayFetch("/v1/audio/transcriptions", { method: "POST", body: form });
  if (!response.ok) await fail(response, "识别");
  const payload = await response.json() as { text?: string };
  return (payload.text ?? "").trim();
}

export interface CaptureEntry {
  id: string;
  createdAt: number;
  sessionId: string;
  /** The raw ASR text — never rewritten; the correction lives beside it. */
  transcript: string;
  corrected: string | null;
  durationMs: number;
  sampleRate: number;
  promotedVoiceId: string | null;
}

export interface CapturePage {
  /** False when the gateway was started without --library: retention never opted in. */
  enabled: boolean;
  captures: CaptureEntry[];
  total: number;
  /** Audio bytes currently retained across the whole library. */
  bytes: number;
  /** The retention quota, or null when the library is unbounded. */
  maxBytes: number | null;
}

interface CaptureWire {
  id?: string;
  created_at?: number;
  session_id?: string;
  transcript?: string;
  corrected?: string | null;
  duration_ms?: number;
  sample_rate?: number;
  promoted_voice_id?: string | null;
}

function captureFromWire(wire: CaptureWire): CaptureEntry {
  return {
    id: wire.id ?? "",
    createdAt: wire.created_at ?? 0,
    sessionId: wire.session_id ?? "",
    transcript: wire.transcript ?? "",
    corrected: wire.corrected ?? null,
    durationMs: wire.duration_ms ?? 0,
    sampleRate: wire.sample_rate ?? 0,
    promotedVoiceId: wire.promoted_voice_id ?? null,
  };
}

/** A disabled library is a state, not an error: the panel explains the opt-in. */
async function libraryDisabled(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  try {
    const body = await response.clone().json() as { error?: { code?: string } };
    return body.error?.code === "library_disabled";
  } catch {
    return false;
  }
}

export async function listCaptures(limit = 50, offset = 0): Promise<CapturePage> {
  const response = await gatewayFetch(`/v1/library?limit=${limit}&offset=${offset}`);
  if (await libraryDisabled(response)) return { enabled: false, captures: [], total: 0, bytes: 0, maxBytes: null };
  if (!response.ok) await fail(response, "获取素材库");
  const payload = await response.json() as { captures?: CaptureWire[]; total?: number; bytes?: number; max_bytes?: number | null };
  return {
    enabled: true,
    captures: (payload.captures ?? []).map(captureFromWire).filter(entry => entry.id !== ""),
    total: payload.total ?? 0,
    bytes: payload.bytes ?? 0,
    maxBytes: payload.max_bytes ?? null,
  };
}

export function captureAudioUrl(id: string): string {
  return gatewayResourceUrl(`/v1/library/${encodeURIComponent(id)}/audio`);
}

/** Set (or with an empty string, clear) the human reference transcript. */
export async function correctCapture(id: string, corrected: string): Promise<CaptureEntry> {
  const response = await gatewayFetch(`/v1/library/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ corrected }),
  });
  if (!response.ok) await fail(response, "保存校正");
  return captureFromWire(await response.json() as CaptureWire);
}

export async function deleteCapture(id: string): Promise<void> {
  const response = await gatewayFetch(`/v1/library/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) await fail(response, "删除素材");
}

/** Register the capture as a voice sample on the clone-capable engine. */
export async function promoteCapture(id: string, voiceId: string): Promise<CaptureEntry> {
  const response = await gatewayFetch(`/v1/library/${encodeURIComponent(id)}/promote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voice_id: voiceId }),
  });
  if (!response.ok) await fail(response, "升级为音色");
  const payload = await response.json() as { capture?: CaptureWire };
  return captureFromWire(payload.capture ?? {});
}

export interface SynthesisParams {
  input: string;
  voice: string;
  /** Instance override; unset uses the configured tts role default. */
  engine?: string;
  cfgValue?: number;
  timesteps?: number;
  seed?: number;
  /** Long syntheses are cancellable; aborting rejects with an AbortError. */
  signal?: AbortSignal;
}

/** Batch synthesis through the facade; returns an object URL for playback/download. */
export async function synthesize(params: SynthesisParams): Promise<string> {
  const query = params.engine ? `?engine=${encodeURIComponent(params.engine)}` : "";
  const response = await gatewayFetch(`/v1/audio/speech${query}`, {
    method: "POST",
    ...(params.signal ? { signal: params.signal } : {}),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "default",
      input: params.input,
      // Engines default their own voice (kokoro: bank default; voxcpm2: clone) — an
      // empty picker must not impose one engine's convention on another.
      ...(params.voice ? { voice: params.voice } : {}),
      response_format: "wav",
      ...(params.cfgValue === undefined ? {} : { cfg_value: params.cfgValue }),
      ...(params.timesteps === undefined ? {} : { timesteps: params.timesteps }),
      ...(params.seed === undefined ? {} : { seed: params.seed }),
    }),
  });
  if (!response.ok) await fail(response, "合成");
  return URL.createObjectURL(await response.blob());
}
