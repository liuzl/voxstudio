import {
  EnergyVadSegmenter,
  SileroVadSegmenter,
  type SpeechProbabilityModel,
  type VadSegmenter,
} from "@voxstudio/duplex-session";
import type { ConversationTool } from "./index";

/**
 * The phase-1 session tools (docs/tool-loop.md) shared by `vox listen` and the gateway:
 * self-referential, session-scoped, zero external dependencies. One definition, so the
 * measured tool-loop behavior cannot fork between surfaces — each surface injects only
 * its capabilities (its voice bank, its engine probe, its hang-up flag).
 */
export const builtinToolNames = ["set_voice", "set_speed", "get_engine_status", "end_call"] as const;

export interface BuiltinVoice {
  id: string;
  /** The engine instance carrying this voice, when the bank spans several. */
  engine?: string;
}

export interface BuiltinToolDeps {
  /**
   * The voice bank `set_voice` validates against. An empty bank accepts any id — the C++
   * voxcpm-server has no list-all route, and refusing would make voices unswitchable there.
   */
  listVoices: () => Promise<BuiltinVoice[]>;
  /** Called with the matched bank entry before the voice applies — the gateway retargets TTS across engines here. */
  onVoiceAccepted?: (voice: BuiltinVoice) => void;
  /** Takes effect from the next reply chunk resolution (per turn). */
  setVoice: (voice: string) => void;
  setSpeed: (rate: number) => void;
  /** Live engine health, or undefined when unavailable. */
  engineStatus: () => Promise<Array<{ name: string; kind?: string; healthy: boolean }> | undefined>;
  /** Hang up after the current turn finishes audibly. */
  endCall: () => void;
}

export function createBuiltinTools(deps: BuiltinToolDeps): ConversationTool[] {
  return [
    {
      name: "set_voice",
      description: "切换当前对话使用的 TTS 音色",
      parameters: {
        type: "object",
        properties: { voice: { type: "string", description: "音色 ID，如 zliu、zf_001、af_maple" } },
        required: ["voice"],
      },
      effect: "session",
      handler: async args => {
        const requested = String(args.voice ?? "").trim();
        if (!requested) return { error: "voice 不能为空" };
        const bank = await deps.listVoices();
        const entry = bank.find(voice => voice.id === requested);
        if (!entry && bank.length > 0) {
          // A structured miss the model can relay — including a taste of what exists.
          return { error: `没有找到音色 ${requested}`, examples: bank.slice(0, 8).map(voice => voice.id) };
        }
        if (entry) deps.onVoiceAccepted?.(entry);
        deps.setVoice(requested);
        return {
          ok: true,
          voice: requested,
          ...(entry?.engine === undefined ? {} : { engine: entry.engine }),
          note: "生效于下一句回复",
        };
      },
    },
    {
      name: "set_speed",
      description: "调整语音回复的语速倍率",
      parameters: {
        type: "object",
        properties: { rate: { type: "number", description: "语速倍率，0.5 到 2.0，1.0 为正常" } },
        required: ["rate"],
      },
      effect: "session",
      handler: async args => {
        const rate = Number(args.rate);
        if (!Number.isFinite(rate)) return { error: "rate 必须是数字" };
        const clamped = Math.min(2, Math.max(0.5, rate));
        deps.setSpeed(clamped);
        return { ok: true, rate: clamped, note: "生效于下一句回复；不支持变速的引擎会忽略该设置" };
      },
    },
    {
      name: "get_engine_status",
      description: "查询各语音引擎（ASR/LLM/TTS）的健康状态",
      parameters: { type: "object", properties: {} },
      effect: "read",
      handler: async () => {
        const engines = await deps.engineStatus();
        if (!engines) return { error: "状态不可用" };
        return {
          engines: engines.map(entry => ({
            name: entry.name,
            ...(entry.kind === undefined ? {} : { kind: entry.kind }),
            healthy: entry.healthy,
          })),
        };
      },
    },
    {
      name: "end_call",
      description: "结束本次语音对话",
      parameters: { type: "object", properties: {} },
      effect: "session",
      // Some OpenAI-compatible models emit a complete farewell beside the tool call.
      // In that case the farewell is already streaming to TTS; asking for a follow-up
      // produces the same sentence twice. Wordless calls still get the normal result round.
      followUp: "if-no-text",
      handler: async () => {
        deps.endCall();
        return { ok: true, note: "本轮回复播完后挂断" };
      },
    },
  ];
}

/** The Studio tool names (docs/voice-studio-control.md, phases 2–3); reserved beside the built-ins. */
export const studioToolNames = [
  "save_last_utterance_as_voice", "redo_last_reply", "remember_pronunciation",
  "persist_pronunciations", "generate_take", "audit_profile",
] as const;

export interface StudioToolDeps {
  /**
   * The last finalized utterance (raw ASR transcript). Undefined until the user has
   * spoken — the tool answers a structured error the model can relay, not a crash.
   */
  lastUtterance?: () => { wav: Uint8Array; transcript: string } | undefined;
  /** Registers a clone voice from utterance audio. Omitted when the surface cannot. */
  registerVoice?: (id: string, wav: Uint8Array, transcript: string) => Promise<{ engine?: string } | void>;
  /** The last reply the user audibly heard. */
  lastReply?: () => string | undefined;
  /** The loop's ConversationControls handle: re-speaking rides the agent-turn machinery. */
  queueAgentSpeech?: (text: string, overrides?: { voice?: string; speed?: number }) => void;
  /** Writes the session pronunciation overlay the TTS boundary reads. */
  setPronunciation: (term: string, reading: string) => void;
  /** Writes session-added pronunciations into the user's config file. Omitted, persist refuses. */
  persistPronunciations?: (entries: Record<string, string>) => Promise<void>;
  /** Produces a generation take (a panel entry, a file — the surface decides). Returns where it landed. */
  generateTake?: (text: string, voice: string | undefined) => Promise<{ location?: string } | void>;
  /** Compares a design profile's saved model identity against the live TTS runtime. */
  auditProfile?: (id: string) => Promise<{ status: string; model?: string; detail?: string }>;
}

/**
 * The conversation-referent bookkeeping behind the Studio tools, shared so neither
 * surface re-derives it. The subtlety is the save tool's referent under the confirmation
 * flow: the sequence is [sample] → [save command] → [确认], and the handler runs at the
 * confirm — by which time "刚才那句" has been overwritten twice. So the referent is
 * **pinned at park time** (the surface's onToolPending fires exactly then): the utterance
 * before the command's. An unpinned read falls back to the previous utterance, which is
 * the same rule at zero turns' distance.
 */
export function createStudioReferents(): {
  recordUtterance(wav: Uint8Array, transcript: string): void;
  recordReply(text: string): void;
  /** Call from onToolPending: pins the save referent the moment the action parks. */
  onToolPending(name: string): void;
  /** Call when the pending save is cancelled or has succeeded: drops the retained audio. */
  clearPin(): void;
  lastUtterance(): { wav: Uint8Array; transcript: string } | undefined;
  lastReply(): string | undefined;
} {
  let current: { wav: Uint8Array; transcript: string } | undefined;
  let previous: { wav: Uint8Array; transcript: string } | undefined;
  let pinned: { wav: Uint8Array; transcript: string } | undefined;
  let reply: string | undefined;
  return {
    recordUtterance: (wav, transcript) => {
      previous = current;
      current = { wav, transcript };
    },
    recordReply: text => { reply = text; },
    onToolPending: name => {
      if (name === "save_last_utterance_as_voice") pinned = previous;
    },
    clearPin: () => { pinned = undefined; },
    // The read does NOT consume the pin: registration is asynchronous, and a transient
    // failure after a consuming read would lose the confirmed sample before the failure
    // was known (adversarial review, 2026-07-25). The pin is dropped explicitly —
    // clearPin on cancel or success — or overwritten by the next park.
    lastUtterance: () => pinned ?? previous,
    lastReply: () => reply,
  };
}

/**
 * The phase-2 Studio tools (docs/voice-studio-control.md): conversation-referent
 * operations whose referents — "刚才那句"、"上一条回复" — exist only in conversation
 * state. `save_last_utterance_as_voice` persists and is therefore `external`: the
 * capacity experiment watched the model invent a voice id for an underspecified save,
 * and the spoken confirmation restating that id before anything lands is the designed
 * catch.
 */
export function createStudioTools(deps: StudioToolDeps): ConversationTool[] {
  // Session-added pronunciations, recorded here so persist knows the delta against the
  // config file without the surfaces bookkeeping it.
  const overlay: Record<string, string> = {};
  return [
    {
      name: "save_last_utterance_as_voice",
      description: "把用户刚才说的那句话注册为一个新的克隆音色样本",
      parameters: {
        type: "object",
        properties: { voice: { type: "string", description: "新音色的 ID" } },
        required: ["voice"],
      },
      effect: "external",
      handler: async args => {
        const id = String(args.voice ?? "").trim();
        if (!id) return { error: "voice 不能为空" };
        // The same rule the gateway facade enforces; a model-invented id with control
        // characters must not reach the engine from either surface.
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
          return { error: "音色 ID 只能包含字母、数字、点、下划线和连字符，最长 64 个字符" };
        }
        if (!deps.lastUtterance || !deps.registerVoice) return { error: "这个环境不支持注册音色" };
        const utterance = deps.lastUtterance();
        if (!utterance) return { error: "本次对话还没有录到你的话，没有可保存的语音" };
        if (!utterance.transcript.trim()) return { error: "刚才那句没有识别出文字，无法用作克隆样本" };
        const registered = await deps.registerVoice(id, utterance.wav, utterance.transcript);
        return {
          ok: true,
          voice: id,
          ...(registered && registered.engine !== undefined ? { engine: registered.engine } : {}),
          note: "音色已注册，可以用 set_voice 切换过去",
        };
      },
    },
    {
      name: "redo_last_reply",
      description: "把上一条回复重新念一遍，可以换音色或语速",
      parameters: {
        type: "object",
        properties: {
          voice: { type: "string", description: "改用的音色 ID，可选" },
          rate: { type: "number", description: "语速倍率 0.5-2.0，可选" },
        },
      },
      effect: "session",
      handler: async args => {
        if (!deps.lastReply || !deps.queueAgentSpeech) return { error: "这个环境不支持重念" };
        const text = deps.lastReply();
        if (!text || !text.trim()) return { error: "还没有可以重念的回复" };
        const overrides: { voice?: string; speed?: number } = {};
        const voice = args.voice === undefined ? "" : String(args.voice).trim();
        if (voice) overrides.voice = voice;
        if (args.rate !== undefined) {
          const rate = Number(args.rate);
          if (!Number.isFinite(rate)) return { error: "rate 必须是数字" };
          overrides.speed = Math.min(2, Math.max(0.5, rate));
        }
        deps.queueAgentSpeech(text, Object.keys(overrides).length > 0 ? overrides : undefined);
        return { ok: true, note: "说完这句就重念上一条回复，请简短确认即可，不要复述内容" };
      },
    },
    {
      name: "remember_pronunciation",
      description: "记住一个词的正确读法，之后的回复按这个发音读",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string", description: "要纠正的词" },
          reading: { type: "string", description: "正确读法" },
        },
        required: ["term", "reading"],
      },
      effect: "session",
      handler: async args => {
        const term = String(args.term ?? "").trim();
        const reading = String(args.reading ?? "").trim();
        if (!term || !reading) return { error: "term 和 reading 都不能为空" };
        deps.setPronunciation(term, reading);
        overlay[term] = reading;
        return { ok: true, term, reading, note: "从下一句回复开始按这个读法" };
      },
    },
    {
      name: "persist_pronunciations",
      description: "把本次对话记住的发音永久保存到配置文件",
      parameters: { type: "object", properties: {} },
      effect: "external",
      handler: async () => {
        if (!deps.persistPronunciations) return { error: "这个环境不支持保存发音配置" };
        const entries = { ...overlay };
        if (Object.keys(entries).length === 0) return { error: "本次对话还没有新记的发音" };
        await deps.persistPronunciations(entries);
        for (const term of Object.keys(entries)) delete overlay[term];
        return { ok: true, saved: Object.keys(entries), note: "已写入配置文件，以后每次对话都生效" };
      },
    },
    {
      name: "generate_take",
      description: "用指定音色合成一段语音，保存到生成面板",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "要合成的文本" },
          voice: { type: "string", description: "音色 ID，可选" },
        },
        required: ["text"],
      },
      effect: "session",
      handler: async args => {
        if (!deps.generateTake) return { error: "这个环境不支持生成" };
        const text = String(args.text ?? "").trim();
        if (!text) return { error: "text 不能为空" };
        if (text.length > 500) return { error: "生成的文本请控制在 500 字以内；更长的合成请用生成面板或 vox say" };
        const voice = args.voice === undefined ? undefined : String(args.voice).trim() || undefined;
        const produced = await deps.generateTake(text, voice);
        return {
          ok: true,
          ...(produced && produced.location !== undefined ? { location: produced.location } : {}),
          note: "已开始生成，请简短确认即可",
        };
      },
    },
    {
      name: "audit_profile",
      description: "检查一个设计音色与当前引擎运行时是否一致（有没有漂移）",
      parameters: {
        type: "object",
        properties: { profile: { type: "string", description: "设计音色的 ID" } },
        required: ["profile"],
      },
      effect: "read",
      handler: async args => {
        if (!deps.auditProfile) return { error: "这个环境不支持音色审计" };
        const id = String(args.profile ?? "").trim();
        if (!id) return { error: "profile 不能为空" };
        return deps.auditProfile(id);
      },
    },
  ];
}

/**
 * The keyterm provider shared by both surfaces: config terms plus the live voice-bank
 * ids, cached briefly so the ASR correction pass does not refetch the bank every turn.
 * A failed bank fetch degrades to the config terms rather than failing the turn.
 */
export function createKeytermProvider(options: {
  configTerms: readonly string[];
  listVoices: () => Promise<BuiltinVoice[]>;
  cacheMs?: number;
}): () => Promise<string[]> {
  let cache: { at: number; terms: string[] } | undefined;
  return async () => {
    if (cache && Date.now() - cache.at < (options.cacheMs ?? 60_000)) return cache.terms;
    const bank = await options.listVoices().catch(() => []);
    cache = { at: Date.now(), terms: [...options.configTerms, ...bank.map(voice => voice.id)] };
    return cache.terms;
  };
}

export interface CreateVadOptions {
  /** Explicit detector choice; undefined prefers silero and degrades loudly to energy. */
  choice?: "energy" | "silero";
  /**
   * The choice was user-stated. Asked-for silero fails loudly; the default degrades
   * loudly to the energy detector, which passed the same certification gate.
   */
  explicit?: boolean;
  sampleRate?: number;
  /** Energy threshold — or, under silero, the level pre-gate (`minLevel`). */
  threshold?: number;
  silenceMs?: number;
  minSpeechMs?: number;
  loadSileroVad?: () => Promise<SpeechProbabilityModel>;
  /** Told about the degradation; the surface decides where that lands (stderr, session.notice). */
  onFallback: (message: string) => void;
}

/**
 * The certified VAD selection shared by `vox listen` and the gateway: silero by default,
 * energy on request or as the loud fallback when the selected Silero backend fails.
 */
export async function createSessionVad(options: CreateVadOptions): Promise<VadSegmenter> {
  const energy = (): VadSegmenter => new EnergyVadSegmenter({
    sampleRate: options.sampleRate ?? 16_000,
    threshold: options.threshold ?? 0.01,
    ...(options.silenceMs === undefined ? {} : { silenceMs: options.silenceMs }),
    ...(options.minSpeechMs === undefined ? {} : { minSpeechMs: options.minSpeechMs }),
  });
  if (options.choice === "energy") return energy();
  try {
    if (!options.loadSileroVad) throw new TypeError("the silero VAD is not available on this platform");
    return new SileroVadSegmenter({
      model: await options.loadSileroVad(),
      ...(options.silenceMs === undefined ? {} : { silenceMs: options.silenceMs }),
      ...(options.minSpeechMs === undefined ? {} : { minSpeechMs: options.minSpeechMs }),
      // Under silero, the threshold is the level pre-gate. Residual echo after cancellation
      // is quiet speech, and the model recognizes it; the gate is what keeps the agent's
      // own leaked voice below notice, exactly as it does for the energy detector.
      ...(options.threshold === undefined ? {} : { minLevel: options.threshold }),
    });
  } catch (error) {
    if (options.explicit) throw error;
    options.onFallback(
      `silero VAD unavailable (${error instanceof Error ? error.message : String(error)}); using the energy detector`,
    );
    return energy();
  }
}
