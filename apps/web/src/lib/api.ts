/** REST facade helpers: same-origin /v1 endpoints proxied by the gateway. */

async function fail(response: Response, what: string): Promise<never> {
  let detail = "";
  try {
    const body = await response.json() as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    // Non-JSON error body; the status is the message.
  }
  throw new Error(`${what}失败（${response.status}${detail ? `：${detail}` : ""}）`);
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
  const response = await fetch("/v1/voices");
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
  const response = await fetch(`/v1/design-profiles${query}`, {
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

export async function listEngines(): Promise<EngineEntry[]> {
  const response = await fetch("/v1/engines");
  if (!response.ok) await fail(response, "获取引擎列表");
  const payload = await response.json() as { engines?: EngineEntry[] };
  return payload.engines ?? [];
}

export async function registerVoice(id: string, text: string, audio: File): Promise<void> {
  const form = new FormData();
  form.set("id", id);
  form.set("text", text);
  form.set("audio", audio);
  const response = await fetch("/v1/voices", { method: "POST", body: form });
  if (!response.ok) await fail(response, "注册音色");
}

export async function deleteVoice(id: string, engine?: string): Promise<void> {
  const query = engine ? `?engine=${encodeURIComponent(engine)}` : "";
  const response = await fetch(`/v1/voices/${encodeURIComponent(id)}${query}`, { method: "DELETE" });
  if (!response.ok) await fail(response, "删除音色");
}

/** Transcribe a recording through the facade — prefills the reference transcript. */
export async function transcribe(audio: File, language = "auto"): Promise<string> {
  const form = new FormData();
  form.set("model", "default");
  form.set("language", language);
  form.set("file", audio);
  const response = await fetch("/v1/audio/transcriptions", { method: "POST", body: form });
  if (!response.ok) await fail(response, "识别");
  const payload = await response.json() as { text?: string };
  return (payload.text ?? "").trim();
}

export interface SynthesisParams {
  input: string;
  voice: string;
  /** Instance override; unset uses the configured tts role default. */
  engine?: string;
  cfgValue?: number;
  timesteps?: number;
  seed?: number;
}

/** Batch synthesis through the facade; returns an object URL for playback/download. */
export async function synthesize(params: SynthesisParams): Promise<string> {
  const query = params.engine ? `?engine=${encodeURIComponent(params.engine)}` : "";
  const response = await fetch(`/v1/audio/speech${query}`, {
    method: "POST",
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
