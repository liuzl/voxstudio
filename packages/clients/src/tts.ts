import type { PcmAudio } from "@voxstudio/audio";
import { readWav } from "@voxstudio/audio";
import type { DesignProfileRequest, EngineConfig, SpeechInput, SpeechRequest, TtsRuntimeIdentity, Voice } from "@voxstudio/contracts";
import { EngineClient, type Fetch } from "./http";

function isVoice(value: unknown): value is Voice {
  return typeof value === "object" && value !== null && "id" in value
    && typeof value.id === "string";
}

function isRuntimeIdentity(value: unknown): value is TtsRuntimeIdentity {
  return typeof value === "object" && value !== null
    && "status" in value && typeof value.status === "string"
    && "model" in value && typeof value.model === "string"
    && "model_manifest_sha256" in value
    && (typeof value.model_manifest_sha256 === "string" || value.model_manifest_sha256 === null);
}

export class TtsClient extends EngineClient {
  constructor(config: EngineConfig, fetch?: Fetch) {
    super(config, fetch);
  }

  async speech(input: SpeechInput, signal?: AbortSignal): Promise<ArrayBuffer> {
    const body: SpeechRequest = { ...input, model: this.config.model };
    const response = await this.request("/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    return response.arrayBuffer();
  }

  /**
   * Stream synthesis as PCM pieces while the engine is still generating. An engine that
   * answers with a whole WAV (streaming not deployed) degrades to one piece at the end —
   * the caller keeps working, just without the early audio.
   */
  async *speechStream(input: SpeechInput, signal?: AbortSignal): AsyncGenerator<PcmAudio> {
    const body: SpeechRequest = { ...input, model: this.config.model, stream: true };
    const response = await this.request("/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("audio/pcm")) {
      const wav = readWav(await response.arrayBuffer());
      yield { samples: wav.samples, sampleRate: wav.sampleRate };
      return;
    }
    const sampleRate = Number(response.headers.get("x-sample-rate"));
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new TypeError("streaming speech response is missing X-Sample-Rate");
    }
    if (!response.body) throw new TypeError("streaming speech response has no body");
    // Network chunks split anywhere; samples are 4-byte floats, so carry the remainder.
    let pending = new Uint8Array(0);
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      const bytes = new Uint8Array(pending.length + chunk.length);
      bytes.set(pending);
      bytes.set(chunk, pending.length);
      const usable = bytes.length - (bytes.length % 4);
      pending = bytes.slice(usable);
      if (usable === 0) continue;
      const view = new DataView(bytes.buffer, 0, usable);
      const samples = new Float32Array(usable / 4);
      for (let index = 0; index < samples.length; index += 1) samples[index] = view.getFloat32(index * 4, true);
      yield { samples, sampleRate };
    }
    if (pending.length > 0) throw new TypeError("streaming speech response ended mid-sample");
  }

  async createVoice(id: string, text: string, audio: Blob, filename: string): Promise<Voice> {
    const form = new FormData();
    form.set("id", id);
    form.set("text", text);
    form.set("audio", audio, filename);
    const response = await this.request("/v1/voices", { method: "POST", body: form });
    const voice: unknown = await response.json();
    if (!isVoice(voice)) throw new TypeError("voice response has no string id");
    return voice;
  }

  async createDesignProfile(profile: DesignProfileRequest): Promise<Voice> {
    const response = await this.request("/v1/design-profiles", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile),
    });
    const voice: unknown = await response.json();
    if (!isVoice(voice)) throw new TypeError("design profile response has no string id");
    return voice;
  }

  async listVoices(): Promise<Voice[]> {
    const response = await this.send("/v1/voices");
    if (response.status === 404) return [];
    await this.validate(response);
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("voices" in payload)
        || !Array.isArray(payload.voices)) return [];
    return payload.voices.filter(isVoice);
  }

  async getVoice(id: string): Promise<Voice> {
    const response = await this.request(`/v1/voices/${encodeURIComponent(id)}`);
    const voice: unknown = await response.json();
    if (!isVoice(voice)) throw new TypeError("voice response has no string id");
    return voice;
  }

  async deleteVoice(id: string): Promise<void> {
    await this.request(`/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async runtimeIdentity(): Promise<TtsRuntimeIdentity> {
    const response = await this.request("/health");
    const identity: unknown = await response.json();
    if (!isRuntimeIdentity(identity)) throw new TypeError("TTS health response has no runtime identity");
    return identity;
  }
}
