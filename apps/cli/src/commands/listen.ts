import { writeWav } from "@voxstudio/audio";
import { AsrClient, LlmClient, TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";
import {
  DuplexSession,
  EnergyVadSegmenter,
  SileroVadSegmenter,
  type DuplexTurn,
  type SpeechProbabilityModel,
  type VadSegmenter,
} from "@voxstudio/duplex-session";
import { streamReply } from "@voxstudio/orchestration";
import { capturePcm, FfplaySink, loadSileroVadModel, startMacosAudioHost, type MacosAudioHost, type PcmCapture, type PcmSink } from "@voxstudio/platform-bun";
import { sanitizeForTts } from "@voxstudio/text";
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
prints each turn's latency profile (VAD end, ASR, reply, first audio) to stderr. --turn-taking
speculative ends a turn after a short silence (--silence-ms defaults to 150 in this mode) and
starts answering immediately; if you keep talking within --reopen-ms (default 7000) before the
reply starts playing, the turn reopens and answers your complete utterance instead. It stays
opt-in until its latency win and false-reopen rate are measured. --save-utterances writes each
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
    turnTaking: "conservative", reopenMs: 7_000, timing: false,
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

function joinAudio(prefix: Float32Array, samples: Float32Array): Float32Array {
  const output = new Float32Array(prefix.length + samples.length);
  output.set(prefix);
  output.set(samples, prefix.length);
  return output;
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
      } else if (event.type === "turn.false_barge_in") {
        io.err("listen: ignored a brief sound during playback (not speech)");
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
  const allowBargeIn = options.bargeIn || options.speakerDuplex;
  const asr = new AsrClient(engine(config, "asr"), fetch);
  const llm = new LlmClient(engine(config, "llm"), fetch);
  const tts = new TtsClient(engine(config, "tts"), fetch);
  const work = new Set<Promise<void>>();
  let activeTurn: DuplexTurn | undefined;
  let activePlayer: ListenPlayer | undefined;
  let stopping = false;
  let suppressInputUntil = 0;
  // Speculative turn-taking state: the last soft-ended turn (reopenable until it speaks)
  // and, while a continuation is being captured, the audio it continues.
  let speculative: { turnId: string; samples: Float32Array; softEndedAtMs: number } | undefined;
  let continuationPrefix: Float32Array | undefined;

  const processTurn = async (turn: DuplexTurn, samples: Float32Array): Promise<void> => {
    try {
      if (!session.startThinking(turn.id)) return;
      const wav = writeWav(samples, 16_000);
      const transcription = await asr.transcribe(
        new File([new Uint8Array(wav)], "utterance.wav", { type: "audio/wav" }),
        "utterance.wav", options.language, {}, turn.signal,
      );
      session.mark(turn.id, "asr_done");
      const transcript = transcription.text.trim();
      if (options.saveUtterances) {
        // An explicit opt-in per the privacy rules. The empty-transcript failures are the
        // most valuable samples in the set, so saving happens regardless of the result.
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const base = join(options.saveUtterances, `utterance-${stamp}`);
        await Bun.write(`${base}.wav`, wav);
        await Bun.write(`${base}.txt`, `${transcript}\n`);
        io.err(`listen: saved utterance ${base}.wav`);
      }
      if (turn.signal.aborted) return;
      if (!transcript) {
        io.err("listen: ASR returned empty text");
        session.interrupt("cancel");
        return;
      }
      io.out(`transcript: ${transcript}`);
      // The reply pipelines: sentences flow into TTS while the model is still generating,
      // so first audio no longer waits for the full completion. The turn stays `thinking`
      // (still reopenable under the speculative policy) until the first piece exists.
      let replyText = "";
      const deltas = (async function* (): AsyncGenerator<string> {
        for await (const delta of llm.chatStream([
          ...(options.system === undefined ? [] : [{ role: "system" as const, content: options.system }]),
          { role: "user", content: transcript },
        ], options.maxTokens, undefined, turn.signal)) {
          if (replyText === "") session.mark(turn.id, "llm_first");
          replyText += delta;
          yield delta;
        }
      })();
      const player = speakerHost?.player ?? platform.createPlayer();
      activePlayer = player;
      const abort = () => { void stopPlayer(player); };
      turn.signal.addEventListener("abort", abort, { once: true });
      try {
        const voice = options.voice ?? config.ttsDefaults.voice;
        for await (const piece of streamReply(tts, deltas, {
          // Conversation is latency-bound where long-form reading is seam-bound: first
          // audio arrives when the first chunk finishes synthesizing (engine RTF ≈ 1), so
          // an 8s first chunk is 8s of dead air. A tight first cap trades an earlier seam
          // — inaudible between conversational sentences — for most of that wait; growth
          // restores full-size chunks immediately after.
          chunking: { ...config.chunking, firstMaxSeconds: Math.min(config.chunking.firstMaxSeconds, 2.5) },
          ttsDefaults: config.ttsDefaults,
          voice,
          ...(voice === "clone" || voice === "design" ? {} : { prosodyPrompt: true }),
          continuationId: crypto.randomUUID(),
          signal: turn.signal,
          streaming: true,
          transformChunk: text => sanitizeForTts(text).text,
        })) {
          if (turn.signal.aborted) return;
          if (session.state === "thinking" && !session.startSpeaking(turn.id)) return;
          if (!allowBargeIn) suppressInputUntil = Number.POSITIVE_INFINITY;
          session.mark(turn.id, "tts_first_audio");
          // Synthesis pieces, not low-latency PCM frames: a single piece can exceed the
          // session queue duration, so this direct path writes to the player immediately.
          await player.write(piece);
          session.mark(turn.id, "playback_first");
        }
        if (!turn.signal.aborted && !replyText.trim()) {
          io.err("listen: model returned empty content");
          session.interrupt("cancel");
          return;
        }
        if (!turn.signal.aborted) io.out(`reply: ${replyText}`);
        // The last byte entering the player is not the reply being finished: sinks render
        // at realtime after near-instant writes. Completing before close() flipped the
        // session to listening while the speaker was still talking, so speech during the
        // audible tail opened a fresh turn instead of barging in — and nothing stopped the
        // audio. The turn stays `speaking` until the reply is audibly done.
        if (!turn.signal.aborted) {
          await player.close();
          if (!turn.signal.aborted) session.complete(turn.id);
        }
      } finally {
        turn.signal.removeEventListener("abort", abort);
        if (activePlayer === player) activePlayer = undefined;
        if (!allowBargeIn) suppressInputUntil = Date.now() + 750;
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
  io.err(options.speakerDuplex ? "listening with macOS speaker duplex; press Ctrl-C to stop" : "listening with protected speaker mode; press Ctrl-C to stop");
  try {
    for await (const frame of capture.frames) {
      if (stopping) break;
      if (!allowBargeIn && (session.state === "speaking" || frame.timestampMs < suppressInputUntil)) {
        vad.reset();
        continue;
      }
      for (const event of await vad.push(frame.samples, frame.timestampMs)) {
        if (event.type === "speech.start") {
          // Continuation hysteresis: resuming a soft-ended turn takes a single voiced frame,
          // not full confirmation, because before the commitment point a wrong reopen costs
          // an aborted speculative dispatch and nothing audible. The kernel refuses the
          // reopen once the reply is speaking, so barge-in keeps its certified bar.
          if (speculative && !activeTurn && frame.timestampMs - speculative.softEndedAtMs <= options.reopenMs) {
            const resumed = session.reopen(speculative.turnId);
            if (resumed) {
              activeTurn = resumed;
              continuationPrefix = speculative.samples;
              speculative = undefined;
            }
          }
        } else if (event.type === "speech.confirmed") {
          // An interruption is provisional until confirmed. `speech.start` fires on a single
          // over-threshold frame — one 20ms residual-echo spike would kill the whole reply —
          // so a fresh turn starts (and playback stops) only on `speech.confirmed`, after
          // minSpeechMs of voiced audio. The VAD keeps the pre-roll, so no speech is lost.
          if (!activeTurn) activeTurn = session.startUserSpeech();
        } else if (event.type === "speech.dropped") {
          if (activeTurn && continuationPrefix) {
            // A reopen that never became speech. Put the superseded dispatch back exactly
            // as it was: same audio, soft-finalized again, still reopenable.
            const turn = activeTurn;
            const samples = continuationPrefix;
            activeTurn = undefined;
            continuationPrefix = undefined;
            if (session.softFinalizeUserSpeech(turn.id)) {
              speculative = { turnId: turn.id, samples, softEndedAtMs: event.timestampMs };
              startWork(turn, samples);
            }
          } else {
            session.recordFalseBargeIn();
          }
        } else if (event.type === "speech.end" && activeTurn) {
          const samples = continuationPrefix ? joinAudio(continuationPrefix, event.samples) : event.samples;
          continuationPrefix = undefined;
          const turn = activeTurn;
          if (options.turnTaking === "speculative") {
            if (session.softFinalizeUserSpeech(turn.id)) {
              activeTurn = undefined;
              speculative = { turnId: turn.id, samples, softEndedAtMs: event.timestampMs };
              startWork(turn, samples);
            }
          } else if (session.finalizeUserSpeech(turn.id)) {
            activeTurn = undefined;
            startWork(turn, samples);
          }
        }
      }
    }
    await Promise.allSettled([...work]);
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    stop();
    await speakerHost?.close();
    await Promise.allSettled([...work]);
  }
}
