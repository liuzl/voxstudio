import type { EngineConfig, NormalizedEngineError } from "@voxstudio/contracts";
import { normalizeEngineError } from "./parsing";

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class EngineHttpError extends Error implements NormalizedEngineError {
  readonly status: number;
  readonly code: string;
  readonly type?: string;

  constructor(error: NormalizedEngineError) {
    super(`[${error.status}] ${error.code}: ${error.message}`);
    this.name = "EngineHttpError";
    this.status = error.status;
    this.code = error.code;
    if (error.type !== undefined) this.type = error.type;
  }
}

export class EngineClient {
  protected readonly config: EngineConfig;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;

  constructor(config: EngineConfig, fetch: Fetch = globalThis.fetch, timeoutMs = 600_000) {
    this.config = config;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  protected send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.config.apiKey) headers.set("Authorization", `Bearer ${this.config.apiKey}`);
    const endpoint = path.startsWith("/") ? path : `/${path}`;
    const signal = init.signal ?? AbortSignal.timeout(this.timeoutMs);
    return this.fetch(new URL(endpoint, this.config.baseUrl), { ...init, headers, signal });
  }

  protected async request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.validate(await this.send(path, init));
  }

  protected async validate(response: Response): Promise<Response> {
    if (!response.ok) {
      throw new EngineHttpError(normalizeEngineError(response.status, await response.text()));
    }
    return response;
  }
}
