import type {
  EngineConfig,
  Transcription,
  TranscriptionOptions,
  TranscriptionSegment,
} from "@voxstudio/contracts";
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
    options: TranscriptionOptions = {},
  ): Promise<Transcription> {
    const form = new FormData();
    form.set("model", this.config.model);
    form.set("language", language);
    form.set("response_format", options.responseFormat ?? "json");
    if (options.maxNewTokens !== undefined) {
      form.set("max_new_tokens", String(options.maxNewTokens));
    }
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
    const transcription = parseTranscript(raw);
    if (typeof payload !== "object" || payload === null) return transcription;
    const record = payload as Record<string, unknown>;
    const segments = parseSegments(record.segments);
    const duration = typeof record.duration === "number" ? record.duration : undefined;
    return {
      ...transcription,
      ...(duration === undefined ? {} : { duration }),
      ...(segments === undefined ? {} : { segments }),
    };
  }
}

function parseSegments(value: unknown): TranscriptionSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: TranscriptionSegment[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const segment = item as Record<string, unknown>;
    if (
      typeof segment.start !== "number"
      || typeof segment.end !== "number"
      || typeof segment.text !== "string"
    ) continue;
    result.push({
      ...(typeof segment.id === "string" || typeof segment.id === "number" ? { id: segment.id } : {}),
      start: segment.start,
      end: segment.end,
      text: segment.text,
      ...(typeof segment.speaker === "string" ? { speaker: segment.speaker } : {}),
    });
  }
  return result;
}
