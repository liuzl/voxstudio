import type { DesignProfileRequest, EngineConfig, SpeechInput, SpeechRequest, Voice } from "@voxstudio/contracts";
import { EngineClient, type Fetch } from "./http";

function isVoice(value: unknown): value is Voice {
  return typeof value === "object" && value !== null && "id" in value
    && typeof value.id === "string";
}

export class TtsClient extends EngineClient {
  constructor(config: EngineConfig, fetch?: Fetch) {
    super(config, fetch);
  }

  async speech(input: SpeechInput): Promise<ArrayBuffer> {
    const body: SpeechRequest = { ...input, model: this.config.model };
    const response = await this.request("/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.arrayBuffer();
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
}
