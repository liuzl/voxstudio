// Live end-to-end replay against a running gateway and REAL engines: synthesize a
// spoken utterance with the configured TTS, stream it as microphone PCM over the
// realtime WebSocket, ack playback like the web client, and print the event flow.
// This is the tool that caught the kokoro pipeline-lock wedge (2026-07-15).
//
//   bun run apps/realtime-gateway/tools/live-replay.ts
import { readWav } from "@voxstudio/audio";

const gateway = process.env.VOX_GATEWAY_URL ?? "http://127.0.0.1:8790";

// 1. Make "user speech" with kokoro through the facade.
const speech = await fetch(new URL("/v1/audio/speech", gateway), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "kokoro",
    input: process.env.VOX_REPLAY_TEXT ?? "现在几点了？",
    voice: "zf_001",
    response_format: "wav",
  }),
});
if (!speech.ok) throw new Error(`tts ${speech.status}`);
const wav = readWav(await speech.arrayBuffer());
console.log(`utterance: ${wav.samples.length} samples @ ${wav.sampleRate}Hz`);

// 2. Downsample to 16k mono (crude decimation is fine for a repro).
const ratio = wav.sampleRate / 16_000;
const mic = new Float32Array(Math.floor(wav.samples.length / ratio));
for (let index = 0; index < mic.length; index += 1) mic[index] = wav.samples[Math.floor(index * ratio)] as number;

// 3. Drive the protocol.
const started = Date.now();
const stamp = () => `+${String(Date.now() - started).padStart(5, " ")}ms`;
const ws = new WebSocket(new URL("/v1/realtime", gateway).toString().replace(/^http/, "ws"));
ws.binaryType = "arraybuffer";
let audioBytes = 0;
let audioChunks = 0;
let done: (() => void) | undefined;
const finished = new Promise<void>(resolve => { done = resolve; });
let playbackEndedTurn: string | undefined;

ws.addEventListener("message", event => {
  if (typeof event.data !== "string") {
    audioBytes += (event.data as ArrayBuffer).byteLength;
    audioChunks += 1;
    return;
  }
  const parsed = JSON.parse(event.data) as Record<string, unknown> & { type: string };
  const extra = ["state", "reason", "message", "text", "sampleRate", "endReason"]
    .filter(key => key in parsed)
    .map(key => `${key}=${JSON.stringify(parsed[key]).slice(0, 60)}`)
    .join(" ");
  const offsets = parsed.offsetsMs ? ` ${JSON.stringify(parsed.offsetsMs)}` : "";
  console.log(`${stamp()} ${parsed.type} ${extra}${offsets}`);
  if (parsed.type === "playback.ended") {
    playbackEndedTurn = parsed.turnId as string;
    // Simulate the web client's audible-end ack after a short render tail.
    setTimeout(() => {
      ws.send(JSON.stringify({ v: 1, type: "playback.complete", idempotencyKey: crypto.randomUUID(), turnId: playbackEndedTurn }));
    }, 300);
  }
  if (parsed.type === "turn.completed" || (parsed.type === "error" && parsed.recoverable === false)) done?.();
});

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({
    v: 1, type: "session.start", idempotencyKey: crypto.randomUUID(),
    options: { language: "zh", bargeIn: true, playbackAck: true, turnTaking: "speculative", voice: "zf_001" },
  }));
  // Stream the utterance in 20ms frames like the mic worklet, then 2s of near-silence
  // frames so the VAD sees the stream continue (a real mic never stops sending).
  const frame = 320;
  let offset = 0;
  const silenceFrames = Number.POSITIVE_INFINITY;
  let silent = 0;
  const timer = setInterval(() => {
    if (offset < mic.length) {
      ws.send(mic.slice(offset, offset + frame).buffer);
      offset += frame;
    } else if (silent < silenceFrames) {
      const noise = new Float32Array(frame);
      for (let index = 0; index < frame; index += 1) noise[index] = (Math.random() - 0.5) * 0.002;
      ws.send(noise.buffer);
      silent += 1;
    } else {
      clearInterval(timer);
    }
  }, 20);
});

const timeout = setTimeout(() => {
  console.log(`${stamp()} TIMEOUT waiting for turn.completed`);
  done?.();
}, 60_000);

await finished;
clearTimeout(timeout);
console.log(`${stamp()} received ${audioChunks} audio chunks, ${audioBytes} bytes (${(audioBytes / 4 / 48_000).toFixed(1)}s @48k)`);
ws.close();
process.exit(0);
