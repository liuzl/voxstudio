import type {
  ChatCompletionRequest,
  ChatMessage,
  EngineConfig,
} from "@voxstudio/contracts";
import { EngineClient, type Fetch } from "./http";
import { extractChatContent } from "./parsing";

export class LlmClient extends EngineClient {
  constructor(config: EngineConfig, fetch?: Fetch) {
    super(config, fetch);
  }

  async chat(messages: ChatMessage[], maxTokens?: number, temperature?: number): Promise<string> {
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
    });
    return extractChatContent(await response.json());
  }
}
