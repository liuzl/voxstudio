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
      handler: async () => {
        deps.endCall();
        return { ok: true, note: "本轮回复播完后挂断" };
      },
    },
  ];
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
 * energy on request or as the loud fallback when both silero runtimes fail.
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
