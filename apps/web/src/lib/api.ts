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

export async function listVoices(): Promise<string[]> {
  const response = await fetch("/v1/voices");
  if (!response.ok) await fail(response, "获取音色列表");
  const payload = await response.json() as { voices?: ({ id?: string } | string)[] };
  return (payload.voices ?? [])
    .map(entry => typeof entry === "string" ? entry : entry.id ?? "")
    .filter(Boolean);
}

export async function registerVoice(id: string, text: string, audio: File): Promise<void> {
  const form = new FormData();
  form.set("id", id);
  form.set("text", text);
  form.set("audio", audio);
  const response = await fetch("/v1/voices", { method: "POST", body: form });
  if (!response.ok) await fail(response, "注册音色");
}

export async function deleteVoice(id: string): Promise<void> {
  const response = await fetch(`/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
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
  cfgValue?: number;
  timesteps?: number;
  seed?: number;
}

/** Batch synthesis through the facade; returns an object URL for playback/download. */
export async function synthesize(params: SynthesisParams): Promise<string> {
  const response = await fetch("/v1/audio/speech", {
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
