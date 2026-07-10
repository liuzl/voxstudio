export type EngineName = "asr" | "llm" | "tts";

export interface EngineConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  healthPath?: string;
  maxTokens?: number;
}

export interface ResolvedEngineConfig extends EngineConfig {
  apiKey: string;
  healthPath: string;
  maxTokens: number;
}

export interface TtsDefaults {
  voice: string;
  cfgValue: number;
  timesteps: number;
  responseFormat: string;
}

export interface ChunkConfig {
  maxSeconds: number;
  firstMaxSeconds: number;
  growth: number;
  sentenceEnders: string;
  joinPauseMs: number;
  trimFloorDb: number;
  edgePadMs: number;
}

export interface VoxConfig {
  engines: Record<string, ResolvedEngineConfig>;
  ttsDefaults: TtsDefaults;
  chunking: ChunkConfig;
}

export interface Transcription {
  text: string;
  lang: string | null;
}

export interface SpeechRequest {
  input: string;
  model: string;
  voice: string;
  response_format: string;
  cfg_value: number;
  timesteps: number;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature?: number;
}

export interface Voice {
  id: string;
  prompt_audio_length?: number;
  created_at?: string;
}

export interface NormalizedEngineError {
  status: number;
  code: string;
  message: string;
  type?: string;
}

export interface HealthResult {
  name: string;
  baseUrl: string;
  model: string;
  ok: boolean;
  detail: string;
}
