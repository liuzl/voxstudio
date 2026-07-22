import { probeEngine, AsrClient, LlmClient, TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import { type ConversationTool, runConversation, type ConversationPlayer } from "@voxstudio/conversation";
import type { VoxConfig } from "@voxstudio/contracts";
import { connectMcpServers, type McpToolSource } from "@voxstudio/mcp";
import {
  DuplexSession,
  EnergyVadSegmenter,
  SileroVadSegmenter,
  type SpeechProbabilityModel,
  type VadSegmenter,
} from "@voxstudio/duplex-session";
import { ffmpegPcmDecoder, capturePcm, FfplaySink, loadSileroVadModel, startMacosAudioHost, type MacosAudioHost, type PcmCapture, type PcmSink } from "@voxstudio/platform-bun";
import { join } from "node:path";
import type { CliIo } from "../io";

export const listenUsage = `usage: vox listen [--device NAME] [--language LANG] [--system TEXT] [--max-tokens N]
                 [--voice VOICE] [--barge-in | --speaker-duplex] [--vad energy|silero]
                 [--turn-taking conservative|speculative] [--reopen-ms N]
                 [--threshold N] [--silence-ms N] [--min-speech-ms N] [--timing]
                 [--welcome TEXT] [--nudge-after SECONDS] [--save-utterances DIR]

Run a continuous voice conversation. Press Ctrl-C to stop.
Without --barge-in, microphone input is suppressed while the agent speaks so external speakers
cannot interrupt playback. Use --barge-in only with headphones or a headset. --speaker-duplex uses
the macOS Voice Processing helper for external-speaker AEC. --vad silero uses the Silero ONNX
model (fetched into a verified local cache on first use) and is the default everywhere: the
native ONNX runtime in the workspace, an embedded WASM backend (same model, same numbers) in
the compiled binary. If neither loads, listen says so and uses the energy detector. --threshold is the
energy VAD's RMS threshold; under silero it sets the level pre-gate that keeps residual echo
below notice (both default 0.01). --timing
prints each turn's latency profile (VAD end, ASR, reply, first audio) to stderr. Turn-taking is
speculative by default: a turn ends after a short silence (--silence-ms defaults to 150) and the
reply starts immediately; if you keep talking within --reopen-ms (default 7000) before playback
begins, the turn reopens and answers your complete utterance instead. --turn-taking conservative
restores the single 650ms-silence policy. --save-utterances writes each
utterance to DIR as a WAV plus what ASR heard — an explicit opt-in for building an ASR test set
from your own voice; nothing is recorded without it. --welcome speaks TEXT once at start,
interruptible like any reply; --nudge-after speaks one short follow-up when the user stays
silent that many seconds after an exchange (docs/conversation-etiquette.md).`;

interface ListenOptions {
  device?: string;
  language: string;
  system?: string;
  maxTokens?: number;
  voice?: string;
  bargeIn: boolean;
  speakerDuplex: boolean;
  vad: "energy" | "silero";
  vadExplicit: boolean;
  turnTaking: "conservative" | "speculative";
  reopenMs: number;
  welcome?: string;
  nudgeAfterSeconds?: number;
  threshold?: number;
  silenceMs: number;
  minSpeechMs: number;
  timing: boolean;
  saveUtterances?: string;
}

export interface ListenPlayer extends PcmSink {
  abort?(): Promise<void>;
}

export interface ListenPlatform {
  capture(device: string | undefined): Promise<PcmCapture>;
  createPlayer(): ListenPlayer;
  startSpeakerDuplex?(): Promise<MacosAudioHost>;
  loadSileroVad?(): Promise<SpeechProbabilityModel>;
}

const defaultPlatform: ListenPlatform = {
  capture: device => capturePcm(device),
  createPlayer: () => new FfplaySink(),
  startSpeakerDuplex: startMacosAudioHost,
  loadSileroVad: () => loadSileroVadModel(line => console.error(line)),
};

function required(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new TypeError(`listen: ${option} requires a value`);
  return value;
}

function numberOption(args: string[], index: number, option: string): number {
  const value = Number(required(args, index, option));
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`listen: ${option} must be a non-negative number`);
  return value;
}

function parse(args: string[]): ListenOptions {
  const options: ListenOptions = {
    language: "auto", bargeIn: false, speakerDuplex: false, vad: "silero", vadExplicit: false,
    silenceMs: 650, minSpeechMs: 250,
    turnTaking: "speculative", reopenMs: 7_000, timing: false,
  };
  let silenceSet = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--device") options.device = required(args, ++index, arg);
    else if (arg === "--language") options.language = required(args, ++index, arg);
    else if (arg === "--system") options.system = required(args, ++index, arg);
    else if (arg === "--voice") options.voice = required(args, ++index, arg);
    else if (arg === "--barge-in") options.bargeIn = true;
    else if (arg === "--speaker-duplex") options.speakerDuplex = true;
    else if (arg === "--timing") options.timing = true;
    else if (arg === "--save-utterances") options.saveUtterances = required(args, ++index, arg);
    else if (arg === "--turn-taking") {
      const value = required(args, ++index, arg);
      if (value !== "conservative" && value !== "speculative") {
        throw new TypeError("listen: --turn-taking must be conservative or speculative");
      }
      options.turnTaking = value;
    } else if (arg === "--reopen-ms") options.reopenMs = numberOption(args, ++index, arg);
    else if (arg === "--welcome") options.welcome = required(args, ++index, arg);
    else if (arg === "--nudge-after") options.nudgeAfterSeconds = numberOption(args, ++index, arg);
    else if (arg === "--vad") {
      const value = required(args, ++index, arg);
      if (value !== "energy" && value !== "silero") throw new TypeError("listen: --vad must be energy or silero");
      options.vad = value;
      options.vadExplicit = true;
    } else if (arg === "--max-tokens") {
      const value = numberOption(args, ++index, arg);
      if (!Number.isInteger(value) || value === 0) throw new TypeError("listen: --max-tokens must be a positive integer");
      options.maxTokens = value;
    } else if (arg === "--threshold") options.threshold = numberOption(args, ++index, arg);
    else if (arg === "--silence-ms") { options.silenceMs = numberOption(args, ++index, arg); silenceSet = true; }
    else if (arg === "--min-speech-ms") options.minSpeechMs = numberOption(args, ++index, arg);
    else throw new TypeError(`listen: unknown option ${arg}`);
  }
  // The speculative policy exists to stop paying the long silence up front; left at the
  // conservative 650ms it would speculate about nothing.
  if (options.turnTaking === "speculative" && !silenceSet) options.silenceMs = 150;
  return options;
}

export async function runListen(
  args: string[],
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch = globalThis.fetch,
  platform: ListenPlatform = defaultPlatform,
): Promise<number> {
  const options = parse(args);
  let endAfterTurn = false;
  const session = new DuplexSession({
    onEvent: event => {
      if (event.type === "turn.completed" && endAfterTurn) {
        // The end_call tool hangs up after the farewell finished audibly.
        queueMicrotask(() => stop());
      }
      if (event.type === "audio.queue_overflow") {
        io.err(`listen: playback queue reached ${event.maxQueuedMs}ms; dropping audio`);
      } else if (event.type === "turn.false_barge_in") {
        io.err("listen: ignored a brief sound during playback (not speech)");
      } else if (event.type === "turn.reopened" && options.timing) {
        // The wasted-speculation counter: each reopen means one speculative dispatch was
        // aborted and re-run on the merged utterance.
        io.err(`timing: turn reopened (revision ${event.revision})`);
      } else if (event.type === "turn.timing" && options.timing) {
        const points = Object.entries(event.offsetsMs).map(([point, ms]) => `${point} +${Math.round(ms)}ms`);
        io.err(`timing: ${points.join("  ")} (${event.endReason})`);
      }
    },
  });
  const energyVad = (): VadSegmenter => new EnergyVadSegmenter({
    sampleRate: 16_000,
    threshold: options.threshold ?? 0.01,
    silenceMs: options.silenceMs,
    minSpeechMs: options.minSpeechMs,
  });
  const sileroVad = async (): Promise<VadSegmenter> => {
    if (!platform.loadSileroVad) throw new TypeError("the silero VAD is not available on this platform");
    return new SileroVadSegmenter({
      model: await platform.loadSileroVad(),
      silenceMs: options.silenceMs,
      minSpeechMs: options.minSpeechMs,
      // Under silero, --threshold is the level pre-gate. Residual echo after cancellation
      // is quiet speech, and the model recognizes it; the gate is what keeps the agent's
      // own leaked voice below notice, exactly as it does for the energy detector.
      ...(options.threshold === undefined ? {} : { minLevel: options.threshold }),
    });
  };
  let vad: VadSegmenter;
  if (options.vad === "energy") {
    vad = energyVad();
  } else {
    try {
      vad = await sileroVad();
    } catch (error) {
      // Silero is the certified default and carries its own WASM fallback for the compiled
      // binary, so reaching here means both runtimes failed (or the model fetch did).
      // Asked-for silero fails loudly; the default degrades loudly to the energy
      // detector, which passed the same gate.
      if (options.vadExplicit) throw error;
      io.err(`listen: silero VAD unavailable (${error instanceof Error ? error.message : String(error)}); using the energy detector`);
      vad = energyVad();
    }
  }
  if (options.speakerDuplex && !platform.startSpeakerDuplex) {
    throw new TypeError("speaker duplex is not available on this platform");
  }
  const speakerHost = options.speakerDuplex ? await platform.startSpeakerDuplex?.() : undefined;
  const capture = speakerHost?.capture ?? await platform.capture(options.device);
  let stopping = false;
  let mcpSource: McpToolSource | undefined;

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    // Closing the session aborts the active turn, which stops its player through the
    // loop's abort handler; closing the capture ends the frame source and the loop.
    session.close();
    void capture.close();
  };

  process.once("SIGINT", stop);
  session.start();
  io.err(options.speakerDuplex ? "listening with macOS speaker duplex; press Ctrl-C to stop" : "listening with protected speaker mode; press Ctrl-C to stop");
  try {
    const tts = new TtsClient(engine(config, "tts"), fetch, ffmpegPcmDecoder());
    const conversationOptions = {
      language: options.language,
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.voice === undefined ? {} : { voice: options.voice }),
      chunking: config.chunking,
      // A run-local copy: the set_speed tool mutates it.
      ttsDefaults: { ...config.ttsDefaults },
      allowBargeIn: options.bargeIn || options.speakerDuplex,
      turnTaking: options.turnTaking,
      reopenMs: options.reopenMs,
      ...(options.welcome === undefined ? {} : { welcome: options.welcome }),
      ...(options.nudgeAfterSeconds === undefined ? {} : { nudgeAfterSeconds: options.nudgeAfterSeconds }),
      ...(Object.keys(config.pronunciations).length === 0 ? {} : { pronunciations: config.pronunciations }),
    } as Parameters<typeof runConversation>[1];
    // The phase-1 session tools (docs/tool-loop.md), CLI edition: the voice bank is the
    // configured tts engine's own registry (the CLI speaks through one instance).
    const tools: ConversationTool[] = [
      {
        name: "set_voice", description: "切换当前对话使用的 TTS 音色", effect: "session",
        parameters: { type: "object", properties: { voice: { type: "string", description: "音色 ID" } }, required: ["voice"] },
        handler: async args => {
          const requested = String(args.voice ?? "").trim();
          if (!requested) return { error: "voice 不能为空" };
          const bank = await tts.listVoices();
          if (bank.length > 0 && !bank.some(entry => entry.id === requested)) {
            return { error: `没有找到音色 ${requested}`, examples: bank.slice(0, 8).map(entry => entry.id) };
          }
          conversationOptions.voice = requested;
          return { ok: true, voice: requested, note: "生效于下一句回复" };
        },
      },
      {
        name: "set_speed", description: "调整语音回复的语速倍率", effect: "session",
        parameters: { type: "object", properties: { rate: { type: "number", description: "0.5 到 2.0，1.0 为正常" } }, required: ["rate"] },
        handler: async args => {
          const rate = Number(args.rate);
          if (!Number.isFinite(rate)) return { error: "rate 必须是数字" };
          const clamped = Math.min(2, Math.max(0.5, rate));
          conversationOptions.speed = clamped;
          return { ok: true, rate: clamped, note: "生效于下一句回复；不支持变速的引擎会忽略该设置" };
        },
      },
      {
        name: "get_engine_status", description: "查询各语音引擎（ASR/LLM/TTS）的健康状态", effect: "read",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          const entries = await Promise.all(Object.entries(config.engines)
            .filter(([, target]) => target.baseUrl)
            .map(async ([name, target]) => {
              const probe = await probeEngine(name, target, fetch);
              return { name, healthy: probe.ok };
            }));
          return { engines: entries };
        },
      },
      {
        name: "end_call", description: "结束本次语音对话", effect: "session",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          endAfterTurn = true;
          return { ok: true, note: "本轮回复播完后挂断" };
        },
      },
    ];
    // MCP tools join through the same registration (docs/mcp-tools.md); a dead server
    // is logged and skipped, and the built-in names stay reserved.
    mcpSource = config.mcpServers.length > 0
      ? await connectMcpServers(config.mcpServers, {
        log: line => io.err(`listen: ${line}`),
        reservedNames: tools.map(tool => tool.name),
      })
      : undefined;
    conversationOptions.tools = [...tools, ...(mcpSource?.tools() ?? [])];
    let keytermCache: { at: number; terms: string[] } | undefined;
    conversationOptions.keyterms = async () => {
      if (keytermCache && Date.now() - keytermCache.at < 60_000) return keytermCache.terms;
      const bank = await tts.listVoices().catch(() => []);
      keytermCache = { at: Date.now(), terms: [...config.keyterms, ...bank.map(entry => entry.id)] };
      return keytermCache.terms;
    };
    await runConversation({
      session,
      vad,
      frames: capture.frames,
      createPlayer: (): ConversationPlayer => speakerHost?.player ?? platform.createPlayer(),
      asr: new AsrClient(engine(config, "asr"), fetch),
      llm: new LlmClient(engine(config, "llm"), fetch),
      tts,
    }, conversationOptions, {
      onTranscript: text => io.out(`transcript: ${text}`),
      onReply: text => io.out(`reply: ${text}`),
      onError: (_code, message) => io.err(`listen: ${message}`),
      onKeytermCorrection: (from, to) => io.err(`keyterm: "${from}" -> "${to}"`),
      onToolCall: (name, args) => io.err(`tool: ${name} ${JSON.stringify(args)}`),
      onToolResult: (name, ok) => io.err(`tool: ${name} ${ok ? "ok" : "failed"}`),
      onToolPending: (name, args) => io.err(`tool: ${name} ${JSON.stringify(args)} awaiting spoken confirmation`),
      ...(options.saveUtterances === undefined ? {} : {
        onUtterance: async (wav: Uint8Array, transcript: string) => {
          // An explicit opt-in per the privacy rules. The empty-transcript failures are the
          // most valuable samples in the set, so saving happens regardless of the result.
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const base = join(options.saveUtterances as string, `utterance-${stamp}`);
          await Bun.write(`${base}.wav`, wav);
          await Bun.write(`${base}.txt`, `${transcript}\n`);
          io.err(`listen: saved utterance ${base}.wav`);
        },
      }),
    });
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    stop();
    await mcpSource?.close();
    await speakerHost?.close();
  }
}
