import type { EngineConfig, Transcription } from "@voxstudio/contracts";
import { EngineClient, type Fetch } from "./http";
import { parseTranscript } from "./parsing";

export class AsrClient extends EngineClient {
  constructor(config: EngineConfig, fetch?: Fetch) {
    super(config, fetch);
  }

  async transcribe(
    audio: Blob,
    filename: string,
    language = "auto",
  ): Promise<Transcription> {
    const form = new FormData();
    form.set("model", this.config.model);
    form.set("language", language);
    form.set("response_format", "json");
    form.set("file", audio, filename);
    const response = await this.request("/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    const payload: unknown = await response.json();
    const raw = typeof payload === "object" && payload !== null && "text" in payload
      && typeof payload.text === "string"
      ? payload.text
      : "";
    return parseTranscript(raw);
  }
}
