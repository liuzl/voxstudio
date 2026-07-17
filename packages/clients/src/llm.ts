import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatToolCall,
  ChatToolDeclaration,
  EngineConfig,
} from "@voxstudio/contracts";
import { EngineClient, type Fetch } from "./http";
import { extractChatContent, extractChatDelta, sseData } from "./parsing";

/** What a tool-aware stream yields: text deltas as they come, tool calls once complete. */
export type ChatStreamItem =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ChatToolCall[] };

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

  /**
   * Tool-aware streaming: text deltas yield as they arrive; tool-call fragments (the
   * OpenAI index-keyed `delta.tool_calls` shape) accumulate and yield once, complete, at
   * the end of the stream. An engine that answers plain JSON degrades the same way
   * `chatStream` does — one text item and/or one tool_calls item.
   */
  async *chatToolStream(
    messages: ChatMessage[],
    tools: ChatToolDeclaration[],
    maxTokens?: number,
    temperature?: number,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamItem> {
    const body: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      max_tokens: maxTokens || this.config.maxTokens || 4096,
      stream: true,
      ...(tools.length > 0 ? { tools } : {}),
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
      const payload = await response.json() as {
        choices?: { message?: { content?: string | null; tool_calls?: ChatToolCall[] } }[];
      };
      const message = payload.choices?.[0]?.message;
      if (message?.content) yield { type: "text", text: message.content };
      if (message?.tool_calls?.length) yield { type: "tool_calls", calls: message.tool_calls };
      return;
    }
    if (!response.body) throw new TypeError("chat stream response has no body");
    // Fragments are keyed by index: the first carries id and name, the rest append to the
    // JSON-string arguments. Nothing is complete until the stream ends.
    const pending = new Map<number, ChatToolCall>();
    for await (const data of sseData(response.body)) {
      signal?.throwIfAborted();
      const parsed = JSON.parse(data) as {
        choices?: { delta?: { content?: string | null; tool_calls?: {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }[] } }[];
      };
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) yield { type: "text", text: delta.content };
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const slot = pending.get(index)
          ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
        if (fragment.id) slot.id = fragment.id;
        if (fragment.function?.name) slot.function.name = fragment.function.name;
        if (fragment.function?.arguments) slot.function.arguments += fragment.function.arguments;
        pending.set(index, slot);
      }
    }
    if (pending.size > 0) {
      yield { type: "tool_calls", calls: [...pending.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]) };
    }
  }
}
