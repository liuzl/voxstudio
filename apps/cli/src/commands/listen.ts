import { writeWav } from "@voxstudio/audio";
import { AsrClient, LlmClient, TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";
import { EnergyVadSegmenter, DuplexSession, type DuplexTurn } from "@voxstudio/duplex-session";
import { streamLong } from "@voxstudio/orchestration";
import { capturePcm, FfplaySink, type PcmCapture, type PcmSink } from "@voxstudio/platform-bun";
import { sanitizeForTts } from "@voxstudio/text";
import type { CliIo } from "../io";

export const listenUsage = `usage: vox listen [--device NAME] [--language LANG] [--system TEXT] [--max-tokens N]
                 [--voice VOICE] [--threshold N] [--silence-ms N] [--min-speech-ms N]

Run a continuous headset-oriented voice conversation. Press Ctrl-C to stop.
This mode has no speaker echo cancellation; use headphones or a headset.`;

interface ListenOptions {
  device?: string;
  language: string;
  system?: string;
  maxTokens?: number;
  voice?: string;
  threshold: number;
  silenceMs: number;
  minSpeechMs: number;
}

export interface ListenPlayer extends PcmSink {
  abort?(): Promise<void>;
}

export interface ListenPlatform {
  capture(device: string | undefined): Promise<PcmCapture>;
  createPlayer(): ListenPlayer;
}

const defaultPlatform: ListenPlatform = {
  capture: device => capturePcm(device),
  createPlayer: () => new FfplaySink(),
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
    language: "auto", threshold: 0.01, silenceMs: 650, minSpeechMs: 250,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--device") options.device = required(args, ++index, arg);
    else if (arg === "--language") options.language = required(args, ++index, arg);
    else if (arg === "--system") options.system = required(args, ++index, arg);
    else if (arg === "--voice") options.voice = required(args, ++index, arg);
    else if (arg === "--max-tokens") {
      const value = numberOption(args, ++index, arg);
      if (!Number.isInteger(value) || value === 0) throw new TypeError("listen: --max-tokens must be a positive integer");
      options.maxTokens = value;
    } else if (arg === "--threshold") options.threshold = numberOption(args, ++index, arg);
    else if (arg === "--silence-ms") options.silenceMs = numberOption(args, ++index, arg);
    else if (arg === "--min-speech-ms") options.minSpeechMs = numberOption(args, ++index, arg);
    else throw new TypeError(`listen: unknown option ${arg}`);
  }
  return options;
}

async function stopPlayer(player: ListenPlayer | undefined): Promise<void> {
  if (!player) return;
  if (player.abort) await player.abort();
  else await player.close();
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
      }
    },
  });
  const vad = new EnergyVadSegmenter({
    sampleRate: 16_000,
    threshold: options.threshold,
    silenceMs: options.silenceMs,
    minSpeechMs: options.minSpeechMs,
  });
  const capture = await platform.capture(options.device);
  const asr = new AsrClient(engine(config, "asr"), fetch);
  const llm = new LlmClient(engine(config, "llm"), fetch);
  const tts = new TtsClient(engine(config, "tts"), fetch);
  const work = new Set<Promise<void>>();
  let activeTurn: DuplexTurn | undefined;
  let activePlayer: ListenPlayer | undefined;
  let stopping = false;

  const processTurn = async (turn: DuplexTurn, samples: Float32Array): Promise<void> => {
    try {
      if (!session.startThinking(turn.id)) return;
      const wav = writeWav(samples, 16_000);
      const transcription = await asr.transcribe(
        new File([new Uint8Array(wav)], "utterance.wav", { type: "audio/wav" }), "utterance.wav", options.language,
      );
      const transcript = transcription.text.trim();
      if (turn.signal.aborted) return;
      if (!transcript) {
        io.err("listen: ASR returned empty text");
        session.interrupt("cancel");
        return;
      }
      io.out(`transcript: ${transcript}`);
      const reply = await llm.chat([
        ...(options.system === undefined ? [] : [{ role: "system" as const, content: options.system }]),
        { role: "user", content: transcript },
      ], options.maxTokens);
      if (turn.signal.aborted) return;
      if (!reply.trim()) {
        io.err("listen: model returned empty content");
        session.interrupt("cancel");
        return;
      }
      io.out(`reply: ${reply}`);
      if (!session.startSpeaking(turn.id)) return;
      const player = platform.createPlayer();
      activePlayer = player;
      const abort = () => { void stopPlayer(player); };
      turn.signal.addEventListener("abort", abort, { once: true });
      try {
        const voice = options.voice ?? config.ttsDefaults.voice;
        const sanitized = sanitizeForTts(reply);
        for await (const piece of streamLong(tts, sanitized.text, {
          chunking: config.chunking,
          ttsDefaults: config.ttsDefaults,
          voice,
          ...(voice === "clone" || voice === "design" ? {} : { prosodyPrompt: true }),
          continuationId: crypto.randomUUID(),
        })) {
          if (turn.signal.aborted) return;
          if (!session.queueOutput(turn.id, { ...piece, timestampMs: Date.now() })) return;
          const queued = session.output.shift();
          if (queued) await player.write(queued.audio);
        }
        if (!turn.signal.aborted) session.complete(turn.id);
      } finally {
        turn.signal.removeEventListener("abort", abort);
        if (activePlayer === player) activePlayer = undefined;
        if (!turn.signal.aborted) await player.close();
      }
    } catch (error) {
      if (!turn.signal.aborted) {
        io.err(`listen: ${error instanceof Error ? error.message : String(error)}`);
        session.interrupt("cancel");
      }
    }
  };

  const startWork = (turn: DuplexTurn, samples: Float32Array): void => {
    const task = processTurn(turn, samples);
    work.add(task);
    void task.finally(() => work.delete(task));
  };

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    session.close();
    void stopPlayer(activePlayer);
    void capture.close();
  };

  process.once("SIGINT", stop);
  session.start();
  io.err("listening with headset mode; press Ctrl-C to stop");
  try {
    for await (const frame of capture.frames) {
      if (stopping) break;
      for (const event of vad.push(frame.samples, frame.timestampMs)) {
        if (event.type === "speech.start") {
          activeTurn = session.startUserSpeech();
        } else if (activeTurn && session.finalizeUserSpeech(activeTurn.id)) {
          const turn = activeTurn;
          activeTurn = undefined;
          startWork(turn, event.samples);
        }
      }
    }
    await Promise.allSettled([...work]);
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    stop();
    await Promise.allSettled([...work]);
  }
}
