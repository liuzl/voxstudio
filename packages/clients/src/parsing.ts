import type { NormalizedEngineError, Transcription } from "@voxstudio/contracts";

const languageTag = /\s*<[a-z]{2}-[A-Z]{2}>/g;
const firstLanguage = /<([a-z]{2})-[A-Z]{2}>/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailMessage(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) || String(value);
  } catch {
    return String(value);
  }
}

export function normalizeEngineError(status: number, input: unknown): NormalizedEngineError {
  let body = input;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const recordBody: Record<string, unknown> = isRecord(body) ? body : {};

  let error: unknown = recordBody.detail ?? recordBody;
  if (isRecord(error)) error = error.error ?? error;
  if (!isRecord(error)) {
    return {
      status,
      code: "engine_error",
      message: detailMessage(error) || `HTTP ${status}`,
    };
  }

  const result: NormalizedEngineError = {
    status,
    code: typeof error.code === "string" && error.code ? error.code : "engine_error",
    message: typeof error.message === "string" && error.message
      ? error.message
      : `HTTP ${status}`,
  };
  if (typeof error.type === "string") result.type = error.type;
  return result;
}

export function parseTranscript(raw: string): Transcription {
  const match = firstLanguage.exec(raw);
  return {
    text: raw.replace(languageTag, "").trim(),
    lang: match?.[1] ?? null,
  };
}

export function extractChatContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return "";
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return "";
  return typeof choice.message.content === "string" ? choice.message.content : "";
}
