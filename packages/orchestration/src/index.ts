import {
  matchLoudness,
  type PcmAudio,
  readWav,
  speechLevelDb,
  trimEdgeSilence,
  writeWav,
} from "@voxstudio/audio";
import type {
  ChunkConfig,
  SpeechInput,
  TtsDefaults,
} from "@voxstudio/contracts";
import { chunkText } from "@voxstudio/text";

export interface SpeechEngine {
  speech(input: SpeechInput, signal?: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
}

export type OnChunk = (
  index: number,
  total: number,
  text: string,
) => void | Promise<void>;

export interface SynthesisOptions {
  chunking: ChunkConfig;
  ttsDefaults: TtsDefaults;
  voice?: string;
  cfgValue?: number;
  timesteps?: number;
  promptPrefix?: string;
  seed?: number;
  prosodyPrompt?: boolean;
  continuationId?: string;
  onChunk?: OnChunk;
  signal?: AbortSignal;
}

function speechInput(text: string, options: SynthesisOptions, end: boolean): SpeechInput {
  return {
    input: `${options.promptPrefix ?? ""}${text}`,
    voice: options.voice ?? options.ttsDefaults.voice,
    response_format: options.ttsDefaults.responseFormat,
    cfg_value: options.cfgValue ?? options.ttsDefaults.cfgValue,
    timesteps: options.timesteps ?? options.ttsDefaults.timesteps,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.prosodyPrompt ? { prosody_prompt: true } : {}),
    ...(options.continuationId === undefined ? {} : {
      continuation_id: options.continuationId,
      continuation_end: end,
    }),
  };
}

export async function* streamLong(
  tts: SpeechEngine,
  text: string,
  options: SynthesisOptions,
): AsyncGenerator<PcmAudio> {
  const chunks = chunkText(text, {
    maxSeconds: options.chunking.maxSeconds,
    firstMaxSeconds: options.chunking.firstMaxSeconds,
    growth: options.chunking.growth,
    enders: options.chunking.sentenceEnders,
  });
  if (chunks.length === 0) throw new TypeError("nothing to synthesize");

  const gapMs = Math.max(0, options.chunking.joinPauseMs - 2 * options.chunking.edgePadMs);
  let pause: Float32Array | null = null;
  let targetDb: number | null = null;
  let sampleRate: number | null = null;

  for (let index = 0; index < chunks.length; index += 1) {
    options.signal?.throwIfAborted();
    const chunk = chunks[index] as string;
    await options.onChunk?.(index, chunks.length, chunk);
    options.signal?.throwIfAborted();
    const decoded = readWav(await tts.speech(
      speechInput(chunk, options, index === chunks.length - 1), options.signal,
    ));
    options.signal?.throwIfAborted();
    if (sampleRate !== null && decoded.sampleRate !== sampleRate) {
      throw new TypeError(`chunks disagree on sample rate: ${sampleRate}, ${decoded.sampleRate}`);
    }
    sampleRate ??= decoded.sampleRate;
    let samples = trimEdgeSilence(
      decoded.samples,
      decoded.sampleRate,
      options.chunking.trimFloorDb,
      options.chunking.edgePadMs,
    );
    if (samples.length === 0) continue;
    if (targetDb === null) {
      targetDb = speechLevelDb(samples, decoded.sampleRate);
      pause = new Float32Array(Math.floor(decoded.sampleRate * gapMs / 1000));
    } else {
      samples = matchLoudness(samples, decoded.sampleRate, targetDb);
      yield { samples: pause as Float32Array, sampleRate: decoded.sampleRate };
    }
    yield { samples, sampleRate: decoded.sampleRate };
  }
}

export async function synthesizeLong(
  tts: SpeechEngine,
  text: string,
  options: SynthesisOptions,
): Promise<Uint8Array> {
  const pieces: PcmAudio[] = [];
  for await (const piece of streamLong(tts, text, options)) pieces.push(piece);
  if (pieces.length === 0) throw new TypeError("engine returned no audio");
  const sampleRate = pieces[0]?.sampleRate as number;
  const length = pieces.reduce((total, piece) => total + piece.samples.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const piece of pieces) {
    samples.set(piece.samples, offset);
    offset += piece.samples.length;
  }
  return writeWav(samples, sampleRate);
}
