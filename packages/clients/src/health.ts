import type { EngineConfig, HealthResult } from "@voxstudio/contracts";
import type { Fetch } from "./http";

function errorDetail(error: unknown): string {
  if (error instanceof Error && typeof error.cause === "object" && error.cause !== null
      && "code" in error.cause && typeof error.cause.code === "string") {
    return error.cause.code;
  }
  return error instanceof Error ? error.name : "Error";
}

export async function probeEngine(
  name: string,
  config: EngineConfig,
  fetch: Fetch = globalThis.fetch,
  timeoutMs = 5_000,
): Promise<HealthResult> {
  try {
    const base = config.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}${config.healthPath ?? "/health"}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      name,
      baseUrl: config.baseUrl,
      model: config.model,
      ok: response.ok,
      detail: response.ok ? "ok" : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      name,
      baseUrl: config.baseUrl,
      model: config.model,
      ok: false,
      detail: errorDetail(error),
    };
  }
}
