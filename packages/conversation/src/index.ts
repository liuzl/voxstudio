import { writeWav, type PcmAudio } from "@voxstudio/audio";
import type { ChatMessage, ChunkConfig, TtsDefaults } from "@voxstudio/contracts";
import type { DuplexSession, DuplexTurn, VadSegmenter } from "@voxstudio/duplex-session";
import { streamReply, type SpeechEngine } from "@voxstudio/orchestration";
import { sanitizeForTts } from "@voxstudio/text";

/** Mono float32 microphone audio at 16kHz, stamped with a Date.now()-based clock. */
export interface ConversationFrame {
  samples: Float32Array;
  timestampMs: number;
}

/**
 * Where reply audio goes. `write` receives synthesis pieces, not paced PCM frames; `close`
 * resolves when the audio is audibly finished — completing a turn any earlier flips the
 * session to listening while the speaker is still talking. `abort` stops playback
 * immediately on interruption; a sink without it falls back to `close`.
 */
export interface ConversationPlayer {
  write(audio: PcmAudio): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

/** The slice of an ASR client the loop uses; `@voxstudio/clients` AsrClient satisfies it. */
export interface TranscriptionEngine {
  transcribe(
    audio: Blob,
    filename: string,
    language?: string,
    options?: Record<string, never>,
    signal?: AbortSignal,
  ): Promise<{ text: string }>;
}

/** The slice of an LLM client the loop uses; `@voxstudio/clients` LlmClient satisfies it. */
export interface ChatEngine {
  chatStream(
    messages: ChatMessage[],
    maxTokens?: number,
    temperature?: number,
    signal?: AbortSignal,
  ): AsyncIterable<string>;
}

export interface ConversationOptions {
  language: string;
  system?: string;
  maxTokens?: number;
  voice?: string;
  chunking: ChunkConfig;
  ttsDefaults: TtsDefaults;
  /**
   * Whether speech may interrupt playback. Off, the loop suppresses microphone input while
   * the agent speaks (plus a short post-playback tail) so external speakers cannot trigger
   * self-interruption; on requires an echo-cancelled route — a headset, the macOS
   * voice-processing helper, or a browser endpoint with negotiated AEC.
   */
  allowBargeIn: boolean;
  turnTaking: "conservative" | "speculative";
  reopenMs: number;
  /** Retained history messages (user+assistant pairs count as two). Default 16. */
  historyLimit?: number;
}

export type ConversationErrorCode = "asr_empty" | "llm_empty" | "turn_failed";

export interface ConversationCallbacks {
  onTranscript?(text: string, turn: DuplexTurn): void;
  onReplyDelta?(delta: string, turn: DuplexTurn): void;
  onReply?(text: string, turn: DuplexTurn): void;
  /**
   * Every finalized utterance with what ASR heard, empty or not — the explicit opt-in for
   * building an ASR test set. Nothing is retained unless this is provided.
   */
  onUtterance?(wav: Uint8Array, transcript: string): void | Promise<void>;
  onError?(code: ConversationErrorCode, message: string, turn?: DuplexTurn): void;
}

export interface ConversationDeps {
  session: DuplexSession;
  vad: VadSegmenter;
  frames: AsyncIterable<ConversationFrame>;
  /** Called once per reply. A persistent sink (the macOS helper) may return itself. */
  createPlayer(turn: DuplexTurn): ConversationPlayer;
  asr: TranscriptionEngine;
  llm: ChatEngine;
  tts: SpeechEngine;
}

function joinAudio(prefix: Float32Array, samples: Float32Array): Float32Array {
  const output = new Float32Array(prefix.length + samples.length);
  output.set(prefix);
  output.set(samples, prefix.length);
  return output;
}

async function stopPlayer(player: ConversationPlayer): Promise<void> {
  if (player.abort) await player.abort();
  else await player.close();
}

/**
 * The conversation loop shared by `vox listen` and the realtime gateway: VAD-delimited
 * turns, provisional barge-in (playback stops only on `speech.confirmed`), speculative
 * end-of-turn with reopen, the streaming reply pipeline, and conversation history. The
 * loop runs until the frame source ends or the session closes; the caller owns both. This
 * is the lifecycle the AEC gates certified — surfaces adapt around it, never fork it.
 */
export async function runConversation(
  deps: ConversationDeps,
  options: ConversationOptions,
  callbacks: ConversationCallbacks = {},
): Promise<void> {
  const { session, vad, asr, llm, tts } = deps;
  const work = new Set<Promise<void>>();
  // Conversation memory: without it, "那总人口呢？" after a question about Singapore gets
  // answered with the population of Earth. Superseded revisions and interrupted turns that
  // never spoke leave no trace; only exchanges the user actually heard become context.
  const history: ChatMessage[] = [];
  const historyLimit = options.historyLimit ?? 16;
  let activeTurn: DuplexTurn | undefined;
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
      // The empty-transcript failures are the most valuable samples in the set, so the
      // utterance callback fires regardless of the result.
      await callbacks.onUtterance?.(wav, transcript);
      if (turn.signal.aborted) return;
      if (!transcript) {
        callbacks.onError?.("asr_empty", "ASR returned empty text", turn);
        session.interrupt("cancel");
        return;
      }
      callbacks.onTranscript?.(transcript, turn);
      // The reply pipelines: sentences flow into TTS while the model is still generating,
      // so first audio no longer waits for the full completion. The turn stays `thinking`
      // (still reopenable under the speculative policy) until the first piece exists.
      let replyText = "";
      const deltas = (async function* (): AsyncGenerator<string> {
        for await (const delta of llm.chatStream([
          ...(options.system === undefined ? [] : [{ role: "system" as const, content: options.system }]),
          ...history,
          { role: "user", content: transcript },
        ], options.maxTokens, undefined, turn.signal)) {
          if (replyText === "") session.mark(turn.id, "llm_first");
          replyText += delta;
          callbacks.onReplyDelta?.(delta, turn);
          yield delta;
        }
      })();
      const player = deps.createPlayer(turn);
      const abort = () => { void stopPlayer(player); };
      turn.signal.addEventListener("abort", abort, { once: true });
      try {
        const voice = options.voice ?? options.ttsDefaults.voice;
        for await (const piece of streamReply(tts, deltas, {
          // Conversation is latency-bound where long-form reading is seam-bound: first
          // audio arrives when the first chunk finishes synthesizing (engine RTF ≈ 1), so
          // an 8s first chunk is 8s of dead air. A tight first cap trades an earlier seam
          // — inaudible between conversational sentences — for most of that wait; growth
          // restores full-size chunks immediately after.
          chunking: { ...options.chunking, firstMaxSeconds: Math.min(options.chunking.firstMaxSeconds, 2.5) },
          ttsDefaults: options.ttsDefaults,
          voice,
          ...(voice === "clone" || voice === "design" ? {} : { prosodyPrompt: true }),
          continuationId: crypto.randomUUID(),
          signal: turn.signal,
          streaming: true,
          transformChunk: text => sanitizeForTts(text).text,
        })) {
          if (turn.signal.aborted) return;
          if (session.state === "thinking" && !session.startSpeaking(turn.id)) return;
          if (!options.allowBargeIn) suppressInputUntil = Number.POSITIVE_INFINITY;
          session.mark(turn.id, "tts_first_audio");
          // Synthesis pieces, not low-latency PCM frames: a single piece can exceed the
          // session queue duration, so this direct path writes to the player immediately.
          await player.write(piece);
          session.mark(turn.id, "playback_first");
        }
        if (!turn.signal.aborted && !replyText.trim()) {
          callbacks.onError?.("llm_empty", "model returned empty content", turn);
          session.interrupt("cancel");
          return;
        }
        if (!turn.signal.aborted) callbacks.onReply?.(replyText, turn);
        if (replyText.trim()) {
          // Reached only when generation finished: a barge-in during the audible tail still
          // lands here (the user heard the reply's start), one mid-generation does not.
          history.push({ role: "user", content: transcript }, { role: "assistant", content: replyText });
          while (history.length > historyLimit) history.splice(0, 2);
        }
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
        if (!options.allowBargeIn) suppressInputUntil = Date.now() + 750;
      }
    } catch (error) {
      if (!turn.signal.aborted) {
        callbacks.onError?.("turn_failed", error instanceof Error ? error.message : String(error), turn);
        session.interrupt("cancel");
      }
    }
  };

  const startWork = (turn: DuplexTurn, samples: Float32Array): void => {
    const task = processTurn(turn, samples);
    work.add(task);
    void task.finally(() => work.delete(task));
  };

  try {
    for await (const frame of deps.frames) {
      if (session.state === "closed") break;
      if (!options.allowBargeIn && (session.state === "speaking" || frame.timestampMs < suppressInputUntil)) {
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
  } finally {
    await Promise.allSettled([...work]);
  }
}
