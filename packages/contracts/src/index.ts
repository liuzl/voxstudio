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
  duration?: number;
  segments?: TranscriptionSegment[];
}

export interface TranscriptionSegment {
  id?: string | number;
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscriptionOptions {
  responseFormat?: "json" | "verbose_json";
  maxNewTokens?: number;
}

export interface SpeechRequest {
  input: string;
  model: string;
  voice: string;
  response_format: string;
  cfg_value: number;
  timesteps: number;
  seed?: number;
  prosody_prompt?: boolean;
  continuation_id?: string;
  continuation_end?: boolean;
}

export type SpeechInput = Omit<SpeechRequest, "model">;

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
  prompt_text?: string;
  prompt_audio_length?: number;
  created_at?: string;
  design_profile?: DesignProfile;
}

export interface DesignProfile {
  description: string;
  seed: number;
  cfg_value: number;
  timesteps: number;
  model: string;
  audio_sha256?: string;
}

export interface DesignProfileRequest {
  id: string;
  description: string;
  anchor_text: string;
  seed: number;
  cfg_value?: number;
  timesteps?: number;
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
