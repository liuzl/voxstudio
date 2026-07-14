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
import { chunkText, estSeconds, SentenceAssembler } from "@voxstudio/text";

export interface SpeechEngine {
  speech(input: SpeechInput, signal?: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
  /** Streamed synthesis: PCM pieces while generation runs. Batch-only engines omit it. */
  speechStream?(input: SpeechInput, signal?: AbortSignal): AsyncIterable<PcmAudio>;
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
  /**
   * Render through the engine's streaming endpoint when it has one. Opt-in per caller:
   * conversation wants the early audio; long-form reading keeps the batch path whose
   * seam-hiding machinery needs whole chunks.
   */
  streaming?: boolean;
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

interface TextChunk {
  text: string;
  last: boolean;
}

/**
 * The synthesis pipeline shared by both entry points: per-chunk engine calls carrying the
 * continuation session, edge-silence trims, loudness matching to the first chunk, and one
 * fixed pause between pieces. Chunks may arrive incrementally; only the producer knows
 * which is last, so each carries its own flag.
 */
async function* synthesizeChunks(
  tts: SpeechEngine,
  chunks: AsyncIterable<TextChunk> | Iterable<TextChunk>,
  options: SynthesisOptions,
): AsyncGenerator<PcmAudio> {
  // A streaming engine renders each chunk as PCM pieces while it generates. The pieces are
  // forwarded untouched: within one continuation session the model produces continuous
  // audio across chunks, so the trim/loudness/pause machinery below — which exists to hide
  // seams between independent batch generations — has nothing to fix and would need
  // lookahead the stream cannot give.
  if (options.streaming && tts.speechStream) {
    for await (const chunk of chunks) {
      options.signal?.throwIfAborted();
      for await (const piece of tts.speechStream(speechInput(chunk.text, options, chunk.last), options.signal)) {
        options.signal?.throwIfAborted();
        if (piece.samples.length > 0) yield piece;
      }
    }
    return;
  }

  const gapMs = Math.max(0, options.chunking.joinPauseMs - 2 * options.chunking.edgePadMs);
  let pause: Float32Array | null = null;
  let targetDb: number | null = null;
  let sampleRate: number | null = null;

  for await (const chunk of chunks) {
    options.signal?.throwIfAborted();
    const decoded = readWav(await tts.speech(
      speechInput(chunk.text, options, chunk.last), options.signal,
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
  const pieces = async function* (): AsyncGenerator<TextChunk> {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] as string;
      await options.onChunk?.(index, chunks.length, chunk);
      yield { text: chunk, last: index === chunks.length - 1 };
    }
  };
  yield* synthesizeChunks(tts, pieces(), options);
}

export interface StreamReplyOptions extends SynthesisOptions {
  /** Applied to each chunk's text before synthesis (e.g. TTS sanitization). */
  transformChunk?: (text: string) => string;
}

/**
 * Pipeline a streaming reply into speech: sentences are assembled from the model's text
 * deltas, the very first complete sentence is synthesized immediately — it is the reply's
 * time-to-first-audio — and later sentences accumulate into growing chunks exactly like
 * `streamLong`'s, all under one continuation session. The model keeps generating while the
 * engine synthesizes: the two stages overlap instead of queueing.
 */
export async function* streamReply(
  tts: SpeechEngine,
  deltas: AsyncIterable<string>,
  options: StreamReplyOptions,
): AsyncGenerator<PcmAudio> {
  const chunking = options.chunking;
  const textChunks = async function* (): AsyncGenerator<TextChunk> {
    const assembler = new SentenceAssembler(chunking.sentenceEnders);
    let pending = "";
    let emitted = 0;
    let previousSeconds = 0;
    let held: string | undefined;

    const capSeconds = (): number => emitted === 0
      ? Math.min(chunking.firstMaxSeconds ?? chunking.maxSeconds, chunking.maxSeconds)
      : Math.min(chunking.maxSeconds, chunking.growth * Math.max(previousSeconds, 1));

    // One chunk of lookahead: only the producer's end reveals which chunk is last, so each
    // ready chunk is held until the next exists (last: false) or the stream ends (last: true).
    function* release(text: string, last: boolean): Generator<TextChunk> {
      const transformed = options.transformChunk ? options.transformChunk(text) : text;
      if (!transformed.trim()) return;
      if (held !== undefined) yield { text: held, last: false };
      held = undefined;
      if (last) yield { text: transformed, last: true };
      else held = transformed;
    }

    function* drain(final: boolean): Generator<TextChunk> {
      while (pending.trim()) {
        if (!final && emitted > 0 && estSeconds(pending) < capSeconds()) break;
        const cap = capSeconds();
        let text = pending;
        if (estSeconds(text) > cap * 1.2) {
          const parts = chunkText(text, {
            maxSeconds: chunking.maxSeconds,
            firstMaxSeconds: cap,
            growth: chunking.growth,
            enders: chunking.sentenceEnders,
          });
          text = parts[0] as string;
          pending = parts.slice(1).join(" ");
        } else {
          pending = "";
        }
        emitted += 1;
        previousSeconds = estSeconds(text);
        yield* release(text, final && !pending.trim());
      }
    }

    for await (const delta of deltas) {
      options.signal?.throwIfAborted();
      for (const sentence of assembler.push(delta)) {
        pending += sentence;
        yield* drain(false);
      }
      // The hold below exists only for the last-chunk flag. The moment any further text is
      // in flight — even half a sentence — the held chunk cannot be last, so release it now
      // rather than delaying its synthesis until the next full chunk forms.
      if (held !== undefined && (pending.trim() || assembler.hasBuffered())) {
        yield { text: held, last: false };
        held = undefined;
      }
    }
    pending += assembler.flush();
    yield* drain(true);
    if (held !== undefined) yield { text: held, last: true };
  };
  yield* synthesizeChunks(tts, textChunks(), options);
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
