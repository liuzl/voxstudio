import { writeWav, type PcmAudio } from "@voxstudio/audio";
import type { ChatMessage, ChatToolCall, ChatToolDeclaration, ChunkConfig, TtsDefaults } from "@voxstudio/contracts";
import type { DuplexSession, DuplexTurn, VadSegmenter } from "@voxstudio/duplex-session";
import { streamReply, type SpeechEngine } from "@voxstudio/orchestration";
import { correctKeyterms, sanitizeForTts } from "@voxstudio/text";

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
  /** Tool-aware variant; without it, registered tools are ignored. */
  chatToolStream?(
    messages: ChatMessage[],
    tools: ChatToolDeclaration[],
    maxTokens?: number,
    temperature?: number,
    signal?: AbortSignal,
  ): AsyncIterable<{ type: "text"; text: string } | { type: "tool_calls"; calls: ChatToolCall[] }>;
}

/**
 * How much ceremony an invocation deserves. `read` and `session` execute immediately;
 * `external` (docs/mcp-tools.md) is never executed without spoken confirmation — the
 * loop holds it pending, the model asks aloud, and the next completed turn either
 * confirms, cancels, or drops it.
 */
export type ToolEffect = "read" | "session" | "external";

export const confirmToolName = "confirm_action";
export const cancelToolName = "cancel_action";

/**
 * What the model receives instead of a result when it calls an `external` tool. An
 * exported constant because the MCP gate (bun run measure:mcp) must measure the model
 * against exactly what the loop sends; changing it means re-running that gate.
 */
export function externalPendingResult(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    pending_confirmation: true,
    action: name,
    arguments: args,
    note: "该操作需要用户口头确认后才会执行。请向用户简要复述这个操作并询问是否执行，不要自行执行，也不要声称已经完成。",
  };
}

/**
 * The system line for the one turn a pending action is confirmable in. Same gate rule as
 * above. The hard sentence is measured (2026-07-19): without it the model cancels in
 * words without calling cancel_action — the same claiming-without-calling failure the
 * original tool spike found, fixed the same way.
 */
export function pendingSystemLine(name: string, args: Record<string, unknown>): string {
  return `当前有一个等待用户确认的操作：${name} ${JSON.stringify(args)}。`
    + `用户表示确认或同意时调用 ${confirmToolName}；用户表示取消、拒绝或反悔时调用 ${cancelToolName}；`
    + `确认和取消都必须通过调用对应工具完成，不能只在口头上回应。`
    + `用户说了无关的内容时正常回应，不要调用这两个工具。`;
}

/**
 * A typed capability the model may invoke mid-turn. Handlers are injected per surface
 * (the CLI and the gateway wire their own); the loop owns invocation and cancellation —
 * handlers receive the turn's AbortSignal, so a barge-in cancels an in-flight tool.
 */
export interface ConversationTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: ToolEffect;
  handler(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/**
 * The measured prompt rules from the 2026-07-18 tool spike (docs/tool-loop.md §2): the
 * bare prompt's two systematic failures — farewells without end_call, claiming an action
 * without calling its tool — each cost a hard rule. Changing this text means re-running
 * the tool gate (bun run measure:tools).
 */
export const toolPromptRules =
  "你可以使用提供的工具来完成用户的请求。只在用户明确需要时调用工具；普通聊天、提问、闲谈直接用简短的话回答，不要调用工具。"
  + "两条硬规则：1) 用户表示要结束对话或告别时，调用 end_call；"
  + "2) 如果你打算执行某个操作（如调整语速、切换音色），必须调用对应工具，不能只在口头上答应。";

/** A confused model must converge: after this many tool rounds the last request offers no tools. */
const maxToolRounds = 3;

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
  /** Typed capabilities the model may invoke; requires an llm with chatToolStream. */
  tools?: ConversationTool[];
  /** Reply playback-rate multiplier; engines without rate control ignore it. */
  speed?: number;
  /**
   * Terms ASR tends to mishear (voice ids above all); transcripts are conservatively
   * corrected toward them (see @voxstudio/text correctKeyterms). A provider, because
   * the voice bank changes at runtime; surfaces cache it.
   */
  keyterms?: () => Promise<string[]>;
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
  onKeytermCorrection?(from: string, to: string, turn: DuplexTurn): void;
  onToolCall?(name: string, args: Record<string, unknown>, turn: DuplexTurn): void;
  onToolResult?(name: string, ok: boolean, result: unknown, turn: DuplexTurn): void;
  /** An `external` tool was requested and now waits for spoken confirmation. */
  onToolPending?(name: string, args: Record<string, unknown>, turn: DuplexTurn): void;
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
  // The confirmation flow (docs/mcp-tools.md): at most one external call waits for a
  // spoken yes, and only across turns the user actually heard — an aborted or reopened
  // dispatch leaves it intact, a completed turn that ignored it drops it.
  let pendingExternal: { tool: ConversationTool; args: Record<string, unknown> } | undefined;
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
      let transcript = transcription.text.trim();
      // The empty-transcript failures are the most valuable samples in the set, so the
      // utterance callback fires regardless of the result — and it receives the RAW
      // transcript: the utterance set exists to measure ASR, so keyterm correction
      // must never launder its samples.
      await callbacks.onUtterance?.(wav, transcript);
      if (turn.signal.aborted) return;
      if (!transcript) {
        callbacks.onError?.("asr_empty", "ASR returned empty text", turn);
        session.interrupt("cancel");
        return;
      }
      if (options.keyterms) {
        try {
          const corrected = correctKeyterms(transcript, await options.keyterms());
          for (const correction of corrected.corrections) {
            callbacks.onKeytermCorrection?.(correction.from, correction.to, turn);
          }
          transcript = corrected.text;
        } catch {
          // A failed keyterm fetch must not cost the turn; the raw transcript stands.
        }
      }
      callbacks.onTranscript?.(transcript, turn);
      // The reply pipelines: sentences flow into TTS while the model is still generating,
      // so first audio no longer waits for the full completion. The turn stays `thinking`
      // (still reopenable under the speculative policy) until the first piece exists.
      let replyText = "";
      let toolsRan = 0;
      const tools = options.tools ?? [];
      const useTools = tools.length > 0 && llm.chatToolStream !== undefined;
      // The pending action this dispatch may confirm. Captured, not consumed: the window
      // closes when the turn completes audibly, not when a dispatch starts.
      const offeredPending = useTools ? pendingExternal : undefined;
      const system = [
        options.system,
        useTools ? toolPromptRules : undefined,
        offeredPending ? pendingSystemLine(offeredPending.tool.name, offeredPending.args) : undefined,
      ]
        .filter((part): part is string => part !== undefined && part !== "")
        .join("\n");
      const declarations: ChatToolDeclaration[] = [
        ...tools.map(tool => ({
          type: "function" as const,
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        ...(offeredPending ? [
          { type: "function" as const, function: {
            name: confirmToolName, description: "执行当前等待用户确认的操作",
            parameters: { type: "object", properties: {} } } },
          { type: "function" as const, function: {
            name: cancelToolName, description: "取消当前等待用户确认的操作",
            parameters: { type: "object", properties: {} } } },
        ] : []),
      ];
      const messages: ChatMessage[] = [
        ...(system === "" ? [] : [{ role: "system" as const, content: system }]),
        ...history,
        { role: "user" as const, content: transcript },
      ];
      // One continuous delta stream across tool rounds: the sentence/TTS pipeline sees a
      // single reply, while tool calls execute between rounds. The final round offers no
      // tools, so a confused model converges on words.
      const deltas = (async function* (): AsyncGenerator<string> {
        for (let round = 0; ; round += 1) {
          const offer = useTools && round < maxToolRounds ? declarations : [];
          let calls: ChatToolCall[] = [];
          let roundText = "";
          const emit = (delta: string): void => {
            if (replyText === "") session.mark(turn.id, "llm_first");
            replyText += delta;
            roundText += delta;
            callbacks.onReplyDelta?.(delta, turn);
          };
          if (useTools && llm.chatToolStream) {
            for await (const item of llm.chatToolStream(messages, offer, options.maxTokens, undefined, turn.signal)) {
              if (item.type === "text") {
                emit(item.text);
                yield item.text;
              } else {
                calls = calls.concat(item.calls);
              }
            }
          } else {
            for await (const delta of llm.chatStream(messages, options.maxTokens, undefined, turn.signal)) {
              emit(delta);
              yield delta;
            }
          }
          if (calls.length === 0) return;
          messages.push({ role: "assistant", content: roundText, tool_calls: calls });
          for (const call of calls) {
            if (turn.signal.aborted) return;
            const tool = tools.find(candidate => candidate.name === call.function.name);
            let reportName = call.function.name;
            let args: Record<string, unknown> = {};
            let ok = false;
            let result: unknown;
            try {
              args = call.function.arguments ? JSON.parse(call.function.arguments) as Record<string, unknown> : {};
            } catch {
              result = { error: "arguments were not valid JSON" };
            }
            const execute = async (target: ConversationTool, targetArgs: Record<string, unknown>): Promise<void> => {
              callbacks.onToolCall?.(target.name, targetArgs, turn);
              try {
                result = await target.handler(targetArgs, turn.signal) ?? { ok: true };
                // Convention: a handler that returns { error } (so the model can read a
                // structured refusal) still reports as a failed invocation.
                ok = !(typeof result === "object" && result !== null && "error" in result);
                if (ok) toolsRan += 1;
              } catch (error) {
                result = { error: error instanceof Error ? error.message : String(error) };
              }
            };
            if (result === undefined) {
              if (call.function.name === confirmToolName || call.function.name === cancelToolName) {
                // Valid only for the action offered to THIS dispatch and not yet settled.
                const pending = offeredPending !== undefined && pendingExternal === offeredPending ? offeredPending : undefined;
                if (!pending) {
                  result = { error: "当前没有等待确认的操作" };
                } else if (call.function.name === cancelToolName) {
                  pendingExternal = undefined;
                  ok = true;
                  toolsRan += 1;
                  result = { cancelled: true, action: pending.tool.name };
                } else {
                  pendingExternal = undefined;
                  reportName = pending.tool.name;
                  await execute(pending.tool, pending.args);
                }
              } else if (!tool) {
                // The model invented a name; a structured refusal keeps it honest.
                result = { error: `unknown tool ${call.function.name}` };
              } else if (tool.effect === "external") {
                if (pendingExternal) {
                  result = { error: "已有一个等待用户确认的操作，请先让用户确认或取消它" };
                } else {
                  // Held, not run: the model is told to ask aloud, and the next completed
                  // turn confirms, cancels, or drops it (docs/mcp-tools.md, decision 3).
                  pendingExternal = { tool, args };
                  ok = true;
                  toolsRan += 1;
                  result = externalPendingResult(tool.name, args);
                  callbacks.onToolPending?.(tool.name, args, turn);
                }
              } else {
                await execute(tool, args);
              }
            }
            callbacks.onToolResult?.(reportName, ok, result, turn);
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          }
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
          // restores larger chunks immediately after, but capped at 8s: a single VoxCPM
          // generation drifts from the reference as it runs, and the growth policy was
          // putting the longest chunks at the end of long replies, exactly where the
          // accumulated drift already peaked.
          chunking: {
            ...options.chunking,
            firstMaxSeconds: Math.min(options.chunking.firstMaxSeconds, 2.5),
            maxSeconds: Math.min(options.chunking.maxSeconds, 8),
            // Conversation is latency-bound, so the clause fast path defaults on here
            // (measured 2026-07-19: the first-sentence wait was 60–70% of first-audio
            // latency); long-form reading keeps sentence seams unless configured.
            firstClauseSeconds: options.chunking.firstClauseSeconds ?? 1.2,
          },
          ttsDefaults: options.ttsDefaults,
          voice,
          ...(options.speed === undefined ? {} : { speed: options.speed }),
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
        // A tool-only turn (an end_call farewell can be wordless) is a success, not an
        // empty completion.
        if (!turn.signal.aborted && !replyText.trim() && toolsRan === 0) {
          callbacks.onError?.("llm_empty", "model returned empty content", turn);
          session.interrupt("cancel");
          return;
        }
        if (!turn.signal.aborted) {
          callbacks.onReply?.(replyText, turn);
          // The confirmation window is one completed turn wide: an offer this turn
          // neither confirmed nor cancelled is dropped — unless this turn parked a new
          // action, which gets its own window.
          if (offeredPending !== undefined && pendingExternal === offeredPending) pendingExternal = undefined;
        }
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
