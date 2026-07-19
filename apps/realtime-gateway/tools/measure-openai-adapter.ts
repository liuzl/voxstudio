#!/usr/bin/env bun
/**
 * The OpenAI Realtime adapter gate (docs/openai-realtime-adapter.md §Phases): the
 * official `openai` npm SDK as the concrete client — configured with nothing but a
 * base URL — against the live engine stack. Two cases, both hard:
 *
 *   1. conversation — synthesized Mandarin speech in, a transcription and audible
 *      24kHz reply audio out, the full GA event choreography in order;
 *   2. function tool — a client-declared tool the model calls, the client answers,
 *      and the model speaks a continuation.
 *
 *   bun run measure:openai [--config CONFIG]
 */
import { decodePcm16, encodePcm16, LinearResampler, readWav } from "@voxstudio/audio";
import { TtsClient } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import { ffmpegPcmDecoder, loadConfig } from "@voxstudio/platform-bun";
import OpenAI from "openai";
import { OpenAIRealtimeWebSocket } from "openai/realtime/websocket";
import { startGateway } from "../src/server";

const wireRate = 24_000;
/** Synthesized speech carries intra-sentence pauses; a generous close keeps one utterance one turn. */
const silenceDurationMs = 600;

type Event = Record<string, unknown> & { type: string };

class GateClient {
  readonly events: Event[] = [];
  readonly rt: OpenAIRealtimeWebSocket;
  private wake: (() => void) | undefined;
  private readonly opened: Promise<void>;

  constructor(baseUrl: string) {
    const api = new OpenAI({ apiKey: "vox-gate", baseURL: baseUrl });
    this.rt = new OpenAIRealtimeWebSocket({
      model: "voxstudio-realtime",
      dangerouslyAllowBrowser: true,
      // The SDK hardwires wss:; its own URL hook downgrades for the loopback gateway.
      onURL: url => { url.protocol = "ws:"; },
    }, api);
    this.rt.on("error", () => { /* surfaced through the captured error events */ });
    const socket = this.rt.socket as WebSocket;
    this.opened = new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("the SDK websocket failed to connect")));
    });
    socket.addEventListener("message", event => {
      this.events.push(JSON.parse(String(event.data)) as Event);
      this.wake?.();
    });
  }

  async ready(): Promise<void> {
    await this.opened;
  }

  ofType(type: string): Event[] {
    return this.events.filter(event => event.type === type);
  }

  async until(predicate: (events: Event[]) => boolean, what: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; saw: ${this.events.map(event => event.type).join(", ")}`);
      }
      await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, 100); });
      this.wake = undefined;
    }
  }

  /** Ship an utterance the way an SDK client does: 100ms base64 PCM16@24k appends, then silence. */
  speak(samples: Float32Array): void {
    const chunk = wireRate / 10;
    const padded = new Float32Array(samples.length + wireRate);
    padded.set(samples);
    for (let offset = 0; offset < padded.length; offset += chunk) {
      this.rt.send({
        type: "input_audio_buffer.append",
        audio: Buffer.from(encodePcm16(padded.slice(offset, offset + chunk))).toString("base64"),
      });
    }
  }

  close(): void {
    this.rt.close();
  }
}

async function main(): Promise<number> {
  const explicitIndex = process.argv.indexOf("--config");
  const config = explicitIndex >= 0
    ? await loadConfig({ explicit: process.argv[explicitIndex + 1] as string })
    : await loadConfig();
  const decoder = ffmpegPcmDecoder();
  const gateway = startGateway({
    config,
    port: 0,
    ...(decoder === undefined ? {} : { pcmDecoder: decoder }),
    openAiFunctionCallTimeoutMs: 20_000,
  });
  const baseUrl = `${gateway.url}v1`;
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.error(`${ok ? "✓" : "✗"} ${what}`);
    if (!ok) failures.push(what);
  };

  // Gate input speech comes from the live TTS: the stack talks to itself, no fixtures.
  const tts = new TtsClient(engine(config, "tts"));
  const say = async (text: string): Promise<Float32Array> => {
    const wav = readWav(await tts.speech({
      input: text,
      voice: config.ttsDefaults.voice,
      response_format: "wav",
      cfg_value: config.ttsDefaults.cfgValue,
      timesteps: config.ttsDefaults.timesteps,
    }));
    return new LinearResampler(wav.sampleRate, wireRate).push(wav.samples);
  };

  try {
    // ---- Case 1: plain audio conversation -------------------------------------
    {
      const client = new GateClient(baseUrl);
      await client.ready();
      await client.until(events => events.some(event => event.type === "session.created"), "session.created");
      client.rt.send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: "你是一个语音助手，回答保持在一两句话。",
          audio: { input: { turn_detection: { type: "server_vad", silence_duration_ms: silenceDurationMs } } },
        },
      });
      await client.until(events => events.some(event => event.type === "session.updated"), "session.updated");
      client.speak(await say("请用一句话介绍一下你自己。"));
      const sent = Date.now();
      await client.until(events => events.some(event => event.type === "response.done"), "response.done", 60_000);

      const order = client.events.map(event => event.type);
      const choreography = [
        "input_audio_buffer.speech_started",
        "input_audio_buffer.speech_stopped",
        "conversation.item.input_audio_transcription.completed",
        "response.created",
        "response.output_audio.delta",
        "response.done",
      ];
      let cursor = -1;
      check(choreography.every(step => (cursor = order.indexOf(step, cursor + 1)) >= 0), "GA event choreography in order");
      const transcription = client.ofType("conversation.item.input_audio_transcription.completed")[0] as { transcript?: string };
      check((transcription?.transcript ?? "").length > 0, `transcription non-empty ("${transcription?.transcript ?? ""}")`);
      const transcriptDone = client.ofType("response.output_audio_transcript.done")[0] as { transcript?: string };
      check((transcriptDone?.transcript ?? "").length > 0, `reply transcript non-empty ("${(transcriptDone?.transcript ?? "").slice(0, 30)}…")`);
      const deltas = client.ofType("response.output_audio.delta") as { delta?: string }[];
      const samples = deltas.flatMap(event => [...decodePcm16(new Uint8Array(Buffer.from(event.delta ?? "", "base64")))]);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, samples.length));
      check(samples.length > wireRate / 2, `reply audio ${(samples.length / wireRate).toFixed(1)}s at 24kHz`);
      check(rms > 0.01, `reply audio audible (rms ${rms.toFixed(3)})`);
      check(client.ofType("error").length === 0, "no error events");
      const firstAudio = client.events.find(event => event.type === "response.output_audio.delta");
      console.error(`  (first audio delta ${firstAudio ? "received" : "missing"}; turn ${((Date.now() - sent) / 1000).toFixed(1)}s end-to-end)`);
      client.close();
    }

    // ---- Case 2: a client-declared function tool round-trips ------------------
    {
      const client = new GateClient(baseUrl);
      await client.ready();
      client.rt.send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: "你是一个语音助手，回答保持在一两句话。",
          audio: { input: { turn_detection: { type: "server_vad", silence_duration_ms: silenceDurationMs } } },
          tools: [{
            type: "function",
            name: "get_current_time",
            description: "查询现在的时间",
            parameters: { type: "object", properties: {} },
          }],
        },
      });
      await client.until(events => events.some(event => event.type === "session.updated"), "session.updated");
      client.speak(await say("现在几点了？"));
      await client.until(events => events.some(event => event.type === "response.function_call_arguments.done"), "function call", 60_000);

      const call = client.ofType("response.function_call_arguments.done")[0] as { call_id?: string; name?: string };
      check(call?.name === "get_current_time", `model called the declared tool (${call?.name ?? "none"})`);
      client.rt.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call?.call_id ?? "", output: "{\"time\":\"14:05\"}" },
      });
      client.rt.send({ type: "response.create" });
      await client.until(events => events.filter(event => event.type === "response.done").length >= 2, "spoken continuation", 60_000);

      const transcriptDone = client.ofType("response.output_audio_transcript.done")[0] as { transcript?: string };
      check((transcriptDone?.transcript ?? "").length > 0, `continuation spoken ("${(transcriptDone?.transcript ?? "").slice(0, 30)}…")`);
      check(client.ofType("error").length === 0, "no error events");
      client.close();
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    console.error(`✗ ${failures[failures.length - 1] as string}`);
  } finally {
    await gateway.stop();
  }

  const pass = failures.length === 0;
  console.error(pass ? "OPENAI ADAPTER GATE: PASS" : `OPENAI ADAPTER GATE: FAIL (${failures.join("; ")})`);
  return pass ? 0 : 1;
}

process.exitCode = await main();
