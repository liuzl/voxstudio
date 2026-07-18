export type EngineName = "asr" | "llm" | "tts";

/** What an engine instance is. Unset means "not declared"; role-named legacy entries infer it. */
export type EngineKind = "asr" | "llm" | "tts";

export interface EngineConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  healthPath?: string;
  maxTokens?: number;
  kind?: EngineKind;
  /** What the instance can do (well-known tags: clone, design, preset, fast, streaming, longform, diarize). */
  capabilities?: string[];
  /**
   * Wire format for streamed synthesis. "opus" (Ogg container) cuts the stream ~30x —
   * raw f32 PCM at 48kHz needs 187.5KB/s, which a slow WAN link cannot carry — and
   * requires a PCM decoder on the consumer; without one the client falls back to PCM.
   */
  streamFormat?: "pcm" | "opus";
}

export interface ResolvedEngineConfig extends EngineConfig {
  apiKey: string;
  healthPath: string;
  maxTokens: number;
  capabilities: string[];
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
  /** Role → instance name. A role without an entry falls back to an instance named like it. */
  roles: Record<string, string>;
  ttsDefaults: TtsDefaults;
  chunking: ChunkConfig;
  /** Product terms ASR tends to mishear; transcripts are conservatively corrected toward them. */
  keyterms: string[];
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
  /** Playback-rate multiplier; engines without rate control ignore it. */
  speed?: number;
  prosody_prompt?: boolean;
  continuation_id?: string;
  continuation_end?: boolean;
  /** Chunked f32le PCM as generation proceeds, instead of one WAV after it finishes. */
  stream?: boolean;
}

export type SpeechInput = Omit<SpeechRequest, "model">;

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** One requested function invocation, OpenAI wire shape (arguments is a JSON string). */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A tool offered to the model, OpenAI wire shape. */
export interface ChatToolDeclaration {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Assistant messages that requested tools carry them back into history. */
  tool_calls?: ChatToolCall[];
  /** Tool messages name the call they answer. */
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
  /** Offered tools; the engine may answer with tool_calls instead of content. */
  tools?: ChatToolDeclaration[];
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
  model_manifest_sha256?: string | null;
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

export interface TtsRuntimeIdentity {
  status: string;
  model: string;
  model_manifest_sha256: string | null;
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
