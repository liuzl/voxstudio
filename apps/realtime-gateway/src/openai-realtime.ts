import { decodePcm16, encodePcm16, LinearResampler } from "@voxstudio/audio";
import type { ConversationTool } from "@voxstudio/conversation";
import type { GatewayEvent, SessionStartOptions } from "./protocol";
import type { EventSink, GatewaySession } from "./session";

/**
 * The OpenAI Realtime dialect (docs/openai-realtime-adapter.md): a per-connection
 * translator that lets clients written for the OpenAI/xAI realtime wire protocol talk to
 * a GatewaySession. The adapter sits exactly where a native WebSocket sits — it is the
 * session's EventSink — and translates in both directions: native JSON events and binary
 * reply frames out to GA-shaped OpenAI events, OpenAI client events in to session
 * commands and 16kHz float32 microphone audio.
 *
 * Subset: WS only, `server_vad` only, audio conversation plus client-declared function
 * tools. Client tools ride the conversation tool loop; the handler round-trips each call
 * to the client and resolves on its `function_call_output`.
 */

/** The wire is PCM16 at 24kHz in both directions — the GA default and the only accepted format. */
const wireRate = 24_000;
const sessionInputRate = 16_000;
/** A client that never answers a function call resolves into a structured error instead of wedging the turn. */
const functionCallTimeoutMs = 15_000;

interface ClientToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface PendingFunctionCall {
  callId: string;
  resolve: (output: unknown) => void;
}

interface OpenResponse {
  id: string;
  itemId: string;
  audioDone: boolean;
  transcript: string;
}

export interface OpenAiRealtimeOptions {
  /** Serialized OpenAI events out to the client socket. */
  send: (text: string) => void;
  /** Close the client socket: the OpenAI protocol has no reattach, so session end is socket end. */
  close: () => void;
  /** Construct a not-yet-started GatewaySession with the client's tools registered. */
  createSession: (extraTools: ConversationTool[]) => GatewaySession;
  /** Tool names the session registers itself; client declarations may not shadow them. */
  reservedToolNames: readonly string[];
  /** The `?model=` the client asked for, echoed in session payloads. */
  model: string;
  /** Override for the function-call round-trip timeout (default 15s). */
  functionCallTimeoutMs?: number;
  log?: (line: string) => void;
}

export class OpenAiRealtimeConnection {
  private readonly options: OpenAiRealtimeOptions;
  private readonly sessionId = `sess_${crypto.randomUUID().replaceAll("-", "")}`;
  private eventCounter = 0;
  private idCounter = 0;
  /** Client events apply strictly in arrival order; audio decoding must not overtake a config update. */
  private queue: Promise<void> = Promise.resolve();
  private readonly inputResampler = new LinearResampler(wireRate, sessionInputRate);
  private outputResampler: LinearResampler | undefined;

  private session: GatewaySession | undefined;
  private starting: Promise<void> | undefined;
  private closed = false;

  // Pending configuration folded from session.update until the lazy session start.
  private instructions: string | undefined;
  private voice: string | undefined;
  private silenceMs: number | undefined;
  private bargeIn = true;
  private clientTools: ClientToolDeclaration[] = [];

  private currentTurn: { id: string; userItemId: string } | undefined;
  private response: OpenResponse | undefined;
  private pendingCall: PendingFunctionCall | undefined;
  /** Set when a function_call_output arrived: the client's follow-up response.create is the OpenAI-flow trigger our loop's refeed already provides. */
  private expectResponseCreate = false;

  constructor(options: OpenAiRealtimeOptions) {
    this.options = options;
    this.emit("session.created", { session: this.sessionPayload() });
  }

  /** The session's EventSink: native events as strings, reply audio as float32 bytes. */
  readonly sink: EventSink = {
    send: data => {
      if (typeof data === "string") this.handleNative(JSON.parse(data) as GatewayEvent);
      else this.handleReplyAudio(data);
    },
  };

  handleMessage(data: string): void {
    this.queue = this.queue.then(() => this.handleClientEvent(data)).catch(error => {
      this.sendError("server_error", error instanceof Error ? error.message : String(error));
    });
  }

  handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.settlePendingCall({ error: "the client disconnected before returning a function_call_output" });
    this.session?.stop();
  }

  private newId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}_${this.sessionId.slice(5, 13)}${this.idCounter.toString(36).padStart(4, "0")}`;
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    if (this.closed) return;
    this.eventCounter += 1;
    this.options.send(JSON.stringify({ type, event_id: `event_${this.eventCounter}`, ...payload }));
  }

  private sendError(code: string, message: string): void {
    this.emit("error", { error: { type: "invalid_request_error", code, message } });
  }

  /** Both the GA nested shape and the flat beta fields: harmless to over-describe, fatal to under-describe. */
  private sessionPayload(): Record<string, unknown> {
    const turnDetection = {
      type: "server_vad",
      silence_duration_ms: this.silenceMs ?? 150,
      interrupt_response: this.bargeIn,
    };
    const format = { type: "audio/pcm", rate: wireRate };
    return {
      id: this.sessionId,
      object: "realtime.session",
      model: this.options.model,
      output_modalities: ["audio"],
      instructions: this.instructions ?? "",
      tools: this.clientTools.map(tool => ({ type: "function", ...tool })),
      tool_choice: "auto",
      audio: {
        input: { format, turn_detection: turnDetection },
        output: { format, ...(this.voice === undefined ? {} : { voice: this.voice }) },
      },
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      turn_detection: turnDetection,
      ...(this.voice === undefined ? {} : { voice: this.voice }),
    };
  }

  // ---------------------------------------------------------------- client events

  private async handleClientEvent(text: string): Promise<void> {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("not an object");
      event = parsed as Record<string, unknown>;
    } catch {
      this.sendError("invalid_json", "client events must be JSON objects");
      return;
    }
    switch (event.type) {
      case "session.update":
        this.handleSessionUpdate(event.session);
        return;
      case "input_audio_buffer.append":
        await this.handleAppend(event.audio);
        return;
      case "input_audio_buffer.clear":
        this.emit("input_audio_buffer.cleared", {});
        return;
      case "input_audio_buffer.commit":
        this.sendError("unsupported_commit", "this endpoint runs server_vad; audio commits automatically at end of speech");
        return;
      case "conversation.item.create":
        this.handleItemCreate(event.item);
        return;
      case "response.create":
        // Under server_vad the server creates responses; the one legal client trigger is
        // the continuation after a function_call_output, which the loop's refeed covers.
        if (this.expectResponseCreate) this.expectResponseCreate = false;
        else this.sendError("unsupported_response_create", "responses are created by server_vad in this subset");
        return;
      case "response.cancel":
        if (this.session && this.currentTurn) {
          this.session.handleCommand({
            v: 1,
            type: "turn.interrupt",
            turnId: this.currentTurn.id,
            idempotencyKey: this.newId("oai_cancel"),
          });
        }
        return;
      default:
        this.sendError("unsupported_event", `${String(event.type)} is outside this adapter's subset`);
    }
  }

  private handleSessionUpdate(session: unknown): void {
    if (typeof session !== "object" || session === null) {
      this.sendError("invalid_session", "session.update requires a session object");
      return;
    }
    const update = session as Record<string, unknown>;
    const problems: string[] = [];

    if (typeof update.instructions === "string") this.instructions = update.instructions;
    const audio = typeof update.audio === "object" && update.audio !== null ? update.audio as Record<string, unknown> : undefined;
    const output = audio && typeof audio.output === "object" && audio.output !== null ? audio.output as Record<string, unknown> : undefined;
    const input = audio && typeof audio.input === "object" && audio.input !== null ? audio.input as Record<string, unknown> : undefined;
    const voice = typeof update.voice === "string" ? update.voice : output && typeof output.voice === "string" ? output.voice : undefined;
    if (voice !== undefined) this.voice = voice;

    for (const [field, value] of [
      ["input_audio_format", update.input_audio_format],
      ["output_audio_format", update.output_audio_format],
      ["audio.input.format", input?.format],
      ["audio.output.format", output?.format],
    ] as const) {
      if (value === undefined) continue;
      if (!this.acceptableFormat(value)) problems.push(`${field} must be pcm16 at ${wireRate}Hz`);
    }

    const turnDetection = update.turn_detection ?? input?.turn_detection;
    if (turnDetection !== undefined) {
      if (typeof turnDetection !== "object" || turnDetection === null) {
        problems.push("turn_detection must be an object");
      } else {
        const detection = turnDetection as Record<string, unknown>;
        if (detection.type !== undefined && detection.type !== "server_vad") {
          problems.push(`turn_detection.type ${String(detection.type)} is not supported; this subset is server_vad only`);
        } else {
          if (typeof detection.silence_duration_ms === "number" && detection.silence_duration_ms > 0) {
            this.silenceMs = detection.silence_duration_ms;
          }
          if (typeof detection.interrupt_response === "boolean") this.bargeIn = detection.interrupt_response;
        }
      }
    }

    if (update.tools !== undefined) {
      if (this.session) {
        problems.push("tools cannot change after the conversation started; declare them before sending audio");
      } else if (!Array.isArray(update.tools)) {
        problems.push("tools must be an array");
      } else {
        const declared: ClientToolDeclaration[] = [];
        for (const entry of update.tools as unknown[]) {
          if (typeof entry !== "object" || entry === null) continue;
          const tool = entry as Record<string, unknown>;
          if (tool.type !== undefined && tool.type !== "function") {
            problems.push(`tool type ${String(tool.type)} is not supported`);
            continue;
          }
          if (typeof tool.name !== "string" || tool.name === "") continue;
          if (this.options.reservedToolNames.includes(tool.name)) {
            problems.push(`tool name ${tool.name} is reserved by a built-in session tool`);
            continue;
          }
          declared.push({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : "",
            parameters: typeof tool.parameters === "object" && tool.parameters !== null
              ? tool.parameters as Record<string, unknown>
              : { type: "object", properties: {} },
          });
        }
        this.clientTools = declared;
      }
    }

    for (const problem of problems) this.sendError("invalid_session_update", problem);
    this.emit("session.updated", { session: this.sessionPayload() });
  }

  private acceptableFormat(value: unknown): boolean {
    if (value === "pcm16") return true;
    if (typeof value !== "object" || value === null) return false;
    const format = value as Record<string, unknown>;
    return (format.type === "audio/pcm" || format.type === "pcm16")
      && (format.rate === undefined || format.rate === wireRate);
  }

  private async handleAppend(audio: unknown): Promise<void> {
    if (typeof audio !== "string" || audio === "") {
      this.sendError("invalid_audio", "input_audio_buffer.append requires base64 audio");
      return;
    }
    const bytes = new Uint8Array(Buffer.from(audio, "base64"));
    if (bytes.length === 0) {
      this.sendError("invalid_audio", "audio is not valid base64");
      return;
    }
    await this.ensureStarted();
    if (!this.session || this.closed) return;
    const samples = this.inputResampler.push(decodePcm16(bytes));
    if (samples.length === 0) return;
    this.session.pushAudio(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  private ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    const session = this.options.createSession(this.clientTools.map(tool => this.bridgeTool(tool)));
    this.session = session;
    const start: SessionStartOptions = {
      language: "auto",
      turnTaking: "speculative",
      bargeIn: this.bargeIn,
      playbackAck: false,
      ...(this.instructions === undefined ? {} : { system: this.instructions }),
      ...(this.voice === undefined ? {} : { voice: this.voice }),
      ...(this.silenceMs === undefined ? {} : { silenceMs: this.silenceMs }),
    };
    this.starting = session.start(start, this.sink).then(() => {
      // Only after start resolves does `done` track the live conversation. The session's
      // end, however it ends, ends the socket: this dialect has no reattach.
      void session.done.finally(() => {
        if (!this.closed) this.options.close();
      });
    }).catch(error => {
      this.sendError("session_start_failed", error instanceof Error ? error.message : String(error));
      session.stop();
      this.options.close();
    });
    return this.starting;
  }

  private handleItemCreate(item: unknown): void {
    if (typeof item !== "object" || item === null) {
      this.sendError("invalid_item", "conversation.item.create requires an item");
      return;
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "function_call_output") {
      this.sendError("unsupported_item", "only function_call_output items are supported; this subset is audio conversation");
      return;
    }
    if (!this.pendingCall || record.call_id !== this.pendingCall.callId) {
      this.sendError("unknown_call", `no function call is waiting for output${typeof record.call_id === "string" ? ` ${record.call_id}` : ""}`);
      return;
    }
    const output = typeof record.output === "string" ? record.output : JSON.stringify(record.output ?? "");
    const itemId = this.newId("item");
    const payload = { item: { id: itemId, type: "function_call_output", call_id: this.pendingCall.callId, output, status: "completed" } };
    this.emit("conversation.item.added", payload);
    this.emit("conversation.item.done", payload);
    this.expectResponseCreate = true;
    // The tool result the loop refeeds: parsed when the client sent JSON, verbatim otherwise.
    let parsed: unknown = output;
    try {
      parsed = JSON.parse(output);
    } catch {
      // plain text output stands as-is
    }
    this.settlePendingCall(parsed);
  }

  private settlePendingCall(result: unknown): void {
    const pending = this.pendingCall;
    if (!pending) return;
    this.pendingCall = undefined;
    pending.resolve(result);
  }

  /** A client-declared function as a loop tool: the handler is the wire round-trip. */
  private bridgeTool(tool: ClientToolDeclaration): ConversationTool {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      effect: "session",
      handler: (args, signal) => this.dispatchFunctionCall(tool.name, args, signal),
    };
  }

  private dispatchFunctionCall(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    // The function call is this response's output; the spoken continuation after the
    // client answers arrives as a fresh response, exactly like the OpenAI flow. A round
    // with several calls becomes several single-call responses — protocol-legal, and the
    // loop executes calls sequentially anyway.
    this.ensureResponse();
    const response = this.response as OpenResponse;
    const callId = this.newId("call");
    const itemId = this.newId("item");
    const argsJson = JSON.stringify(args);
    const item = { id: itemId, type: "function_call", call_id: callId, name, arguments: argsJson, status: "completed" };
    this.emit("response.output_item.added", {
      response_id: response.id,
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    });
    this.emit("response.function_call_arguments.delta", { response_id: response.id, item_id: itemId, call_id: callId, delta: argsJson });
    this.emit("response.function_call_arguments.done", { response_id: response.id, item_id: itemId, call_id: callId, name, arguments: argsJson });
    this.emit("response.output_item.done", { response_id: response.id, output_index: 0, item });
    this.closeResponse("completed", [item]);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.settlePendingCall({ error: "the client did not return a function_call_output in time" });
      }, this.options.functionCallTimeoutMs ?? functionCallTimeoutMs);
      const onAbort = (): void => {
        this.settlePendingCall({ error: "the turn was interrupted before the tool returned" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingCall = {
        callId,
        resolve: output => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(output);
        },
      };
    });
  }

  // ---------------------------------------------------------------- native events

  private handleNative(event: GatewayEvent): void {
    switch (event.type) {
      case "turn.started": {
        this.currentTurn = { id: event.turnId, userItemId: this.newId("item") };
        this.emit("input_audio_buffer.speech_started", { item_id: this.currentTurn.userItemId, audio_start_ms: 0 });
        return;
      }
      case "vad.end": {
        if (!this.currentTurn) return;
        const itemId = this.currentTurn.userItemId;
        this.emit("input_audio_buffer.speech_stopped", { item_id: itemId, audio_end_ms: 0 });
        this.emit("input_audio_buffer.committed", { item_id: itemId });
        this.emit("conversation.item.added", {
          item: { id: itemId, type: "message", role: "user", status: "completed", content: [{ type: "input_audio" }] },
        });
        return;
      }
      case "transcript.final": {
        if (!this.currentTurn) return;
        this.emit("conversation.item.input_audio_transcription.completed", {
          item_id: this.currentTurn.userItemId,
          content_index: 0,
          transcript: event.text,
        });
        return;
      }
      case "response.text.delta": {
        this.ensureResponse();
        const response = this.response as OpenResponse;
        response.transcript += event.text;
        this.emit("response.output_audio_transcript.delta", {
          response_id: response.id,
          item_id: response.itemId,
          output_index: 0,
          content_index: 0,
          delta: event.text,
        });
        return;
      }
      case "response.text.final": {
        if (!this.response) return;
        this.emit("response.output_audio_transcript.done", {
          response_id: this.response.id,
          item_id: this.response.itemId,
          output_index: 0,
          content_index: 0,
          transcript: event.text,
        });
        return;
      }
      case "playback.format": {
        this.outputResampler = new LinearResampler(event.sampleRate, wireRate);
        return;
      }
      case "playback.ended": {
        if (!this.response || this.response.audioDone) return;
        this.response.audioDone = true;
        this.emit("response.output_audio.done", {
          response_id: this.response.id,
          item_id: this.response.itemId,
          output_index: 0,
          content_index: 0,
        });
        return;
      }
      case "turn.completed": {
        if (!this.response) return;
        if (!this.response.audioDone) {
          this.response.audioDone = true;
          this.emit("response.output_audio.done", {
            response_id: this.response.id,
            item_id: this.response.itemId,
            output_index: 0,
            content_index: 0,
          });
        }
        const done = this.response;
        this.emit("response.content_part.done", {
          response_id: done.id,
          item_id: done.itemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_audio", transcript: done.transcript },
        });
        const item = this.assistantItem(done, "completed");
        this.emit("response.output_item.done", { response_id: done.id, output_index: 0, item });
        this.closeResponse("completed", [item]);
        return;
      }
      case "turn.interrupted":
      case "turn.reopened": {
        // The reply this envelope described is dead either way; a reopened turn's fresh
        // revision opens a fresh response when its output starts.
        if (this.response) this.closeResponse("cancelled", [this.assistantItem(this.response, "incomplete")]);
        return;
      }
      case "error": {
        this.emit("error", { error: { type: "server_error", code: event.code, message: event.message } });
        return;
      }
      default:
        // Command acknowledgements, snapshots, timings, built-in tool activity: native
        // bookkeeping with no OpenAI representation (adapter doc, decision 6).
        return;
    }
  }

  private handleReplyAudio(bytes: Uint8Array): void {
    if (!this.outputResampler || this.closed) return;
    this.ensureResponse();
    const response = this.response as OpenResponse;
    const samples = new Float32Array(bytes.byteLength / 4);
    new Uint8Array(samples.buffer).set(bytes);
    const resampled = this.outputResampler.push(samples);
    if (resampled.length === 0) return;
    this.emit("response.output_audio.delta", {
      response_id: response.id,
      item_id: response.itemId,
      output_index: 0,
      content_index: 0,
      delta: Buffer.from(encodePcm16(resampled)).toString("base64"),
    });
  }

  private ensureResponse(): void {
    if (this.response) return;
    this.response = { id: this.newId("resp"), itemId: this.newId("item"), audioDone: false, transcript: "" };
    this.emit("response.created", {
      response: { id: this.response.id, object: "realtime.response", status: "in_progress", output: [] },
    });
    this.emit("response.output_item.added", {
      response_id: this.response.id,
      output_index: 0,
      item: { id: this.response.itemId, type: "message", role: "assistant", status: "in_progress", content: [] },
    });
    this.emit("response.content_part.added", {
      response_id: this.response.id,
      item_id: this.response.itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_audio" },
    });
  }

  private assistantItem(response: OpenResponse, status: "completed" | "incomplete"): Record<string, unknown> {
    return {
      id: response.itemId,
      type: "message",
      role: "assistant",
      status,
      content: [{ type: "output_audio", transcript: response.transcript }],
    };
  }

  private closeResponse(status: "completed" | "cancelled", output: Record<string, unknown>[]): void {
    if (!this.response) return;
    const response = this.response;
    this.response = undefined;
    this.emit("response.done", {
      response: { id: response.id, object: "realtime.response", status, output },
    });
  }
}
