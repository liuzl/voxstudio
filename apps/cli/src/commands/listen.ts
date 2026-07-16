import { AsrClient, LlmClient, TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import { runConversation, type ConversationPlayer } from "@voxstudio/conversation";
import type { VoxConfig } from "@voxstudio/contracts";
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
                 [--save-utterances DIR]

Run a continuous voice conversation. Press Ctrl-C to stop.
Without --barge-in, microphone input is suppressed while the agent speaks so external speakers
cannot interrupt playback. Use --barge-in only with headphones or a headset. --speaker-duplex uses
the macOS Voice Processing helper for external-speaker AEC. --vad silero uses the Silero ONNX
model (fetched into a verified local cache on first use) and is the default where the ONNX
runtime is available; otherwise listen says so and uses the energy detector. --threshold is the
energy VAD's RMS threshold; under silero it sets the level pre-gate that keeps residual echo
below notice (both default 0.01). --timing
prints each turn's latency profile (VAD end, ASR, reply, first audio) to stderr. Turn-taking is
speculative by default: a turn ends after a short silence (--silence-ms defaults to 150) and the
reply starts immediately; if you keep talking within --reopen-ms (default 7000) before playback
begins, the turn reopens and answers your complete utterance instead. --turn-taking conservative
restores the single 650ms-silence policy. --save-utterances writes each
utterance to DIR as a WAV plus what ASR heard — an explicit opt-in for building an ASR test set
from your own voice; nothing is recorded without it.`;

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
  loadSileroVad: loadSileroVadModel,
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
  const session = new DuplexSession({
    onEvent: event => {
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
      // Silero is the certified default, but it needs the ONNX runtime, which the compiled
      // standalone binary cannot carry. Asked-for silero fails loudly; the default degrades
      // loudly to the energy detector, which passed the same gate.
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
    await runConversation({
      session,
      vad,
      frames: capture.frames,
      createPlayer: (): ConversationPlayer => speakerHost?.player ?? platform.createPlayer(),
      asr: new AsrClient(engine(config, "asr"), fetch),
      llm: new LlmClient(engine(config, "llm"), fetch),
      tts: new TtsClient(engine(config, "tts"), fetch, ffmpegPcmDecoder()),
    }, {
      language: options.language,
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.voice === undefined ? {} : { voice: options.voice }),
      chunking: config.chunking,
      ttsDefaults: config.ttsDefaults,
      allowBargeIn: options.bargeIn || options.speakerDuplex,
      turnTaking: options.turnTaking,
      reopenMs: options.reopenMs,
    }, {
      onTranscript: text => io.out(`transcript: ${text}`),
      onReply: text => io.out(`reply: ${text}`),
      onError: (_code, message) => io.err(`listen: ${message}`),
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
    await speakerHost?.close();
  }
}
