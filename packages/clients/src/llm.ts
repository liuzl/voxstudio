import type {
  ChatCompletionRequest,
  ChatMessage,
  EngineConfig,
} from "@voxstudio/contracts";
import { EngineClient, type Fetch } from "./http";
import { extractChatContent, extractChatDelta, sseData } from "./parsing";

export class LlmClient extends EngineClient {
  constructor(config: EngineConfig, fetch?: Fetch) {
    super(config, fetch);
  }

  async chat(
    messages: ChatMessage[],
    maxTokens?: number,
    temperature?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const body: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      max_tokens: maxTokens || this.config.maxTokens || 4096,
    };
    if (temperature !== undefined) body.temperature = temperature;
    const response = await this.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    return extractChatContent(await response.json());
  }

  /**
   * Stream the reply as text deltas. If the engine answers a `stream: true` request with a
   * plain JSON completion instead of SSE, the full reply is yielded once — the streaming
   * caller keeps working against a batch-only engine, just without the early tokens.
   */
  async *chatStream(
    messages: ChatMessage[],
    maxTokens?: number,
    temperature?: number,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const body: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      max_tokens: maxTokens || this.config.maxTokens || 4096,
      stream: true,
    };
    if (temperature !== undefined) body.temperature = temperature;
    const response = await this.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
      const content = extractChatContent(await response.json());
      if (content) yield content;
      return;
    }
    if (!response.body) throw new TypeError("chat stream response has no body");
    for await (const data of sseData(response.body)) {
      signal?.throwIfAborted();
      const delta = extractChatDelta(JSON.parse(data));
      if (delta) yield delta;
    }
  }
}
