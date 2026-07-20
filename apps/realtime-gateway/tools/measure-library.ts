#!/usr/bin/env bun
/**
 * The Library gate (docs/web-studio.md Phase 4): against live engines, the ASR
 * reference-correction workflow runs end-to-end through the gateway — a spoken turn is
 * retained as a capture, the capture re-transcribes through the facade, an inline
 * correction writes the .ref.txt reference sidecar, and promotion registers the audio
 * as a clone voice sample with the corrected text. Cleans up after itself.
 *
 *   bun run measure:library [--config CONFIG]
 */
import { readWav } from "@voxstudio/audio";
import { ffmpegPcmDecoder, loadConfig } from "@voxstudio/platform-bun";
import { startGateway } from "../src/server";

async function main(): Promise<number> {
  const explicitIndex = process.argv.indexOf("--config");
  const config = explicitIndex >= 0
    ? await loadConfig({ explicit: process.argv[explicitIndex + 1] as string })
    : await loadConfig();
  const libraryDir = `/tmp/vox-library-gate-${process.pid}`;
  const decoder = ffmpegPcmDecoder();
  const gateway = startGateway({ config, port: 0, libraryDir, ...(decoder === undefined ? {} : { pcmDecoder: decoder }) });

  const failures: string[] = [];
  const check = (ok: boolean, what: string, detail: string): void => {
    console.error(`${ok ? "✓" : "✗"} ${what} -> ${detail}`);
    if (!ok) failures.push(what);
  };

  // 1. Make "user speech" with the configured TTS through the facade.
  const spoken = "今天天气怎么样？";
  const speech = await fetch(new URL("/v1/audio/speech", gateway.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "default", input: spoken, response_format: "wav" }),
  });
  if (!speech.ok) {
    console.error(`LIBRARY GATE: FAIL (tts ${speech.status} — are the live engines up?)`);
    await gateway.stop();
    return 1;
  }
  const wav = readWav(await speech.arrayBuffer());
  const ratio = wav.sampleRate / 16_000;
  const mic = new Float32Array(Math.floor(wav.samples.length / ratio));
  for (let index = 0; index < mic.length; index += 1) mic[index] = wav.samples[Math.floor(index * ratio)] as number;

  // 2. Speak it into a live session and let the turn complete.
  const events: { type: string; text?: string }[] = [];
  const ws = new WebSocket(`${gateway.url.replace(/^http/, "ws")}v1/realtime`);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", event => {
    if (typeof event.data === "string") events.push(JSON.parse(event.data) as { type: string; text?: string });
  });
  await new Promise(resolve => ws.addEventListener("open", () => resolve(null)));
  ws.send(JSON.stringify({
    v: 1, type: "session.start", idempotencyKey: "library-gate",
    options: { language: "auto", turnTaking: "conservative", vad: "energy" },
  }));
  for (let offset = 0; offset < mic.length; offset += 320) {
    ws.send(mic.slice(offset, offset + 320).buffer as ArrayBuffer);
  }
  for (let frames = 0; frames < 60; frames += 1) ws.send(new Float32Array(320).buffer);
  const deadline = Date.now() + 45_000;
  while (!events.some(event => event.type === "turn.completed" || event.type === "error") && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  ws.send(JSON.stringify({ v: 1, type: "session.stop", idempotencyKey: "library-gate-stop" }));
  await Bun.sleep(200);
  ws.close();

  const heard = events.find(event => event.type === "transcript.final")?.text ?? "";
  check(events.some(event => event.type === "turn.completed"), "a live turn completed", events.map(event => event.type).join(","));

  // 3. The utterance was retained: raw transcript, playable audio.
  const listed = await (await fetch(new URL("/v1/library", gateway.url))).json() as {
    captures: { id: string; transcript: string; corrected: string | null }[]; total: number;
  };
  check(listed.total === 1, "exactly one capture retained", `total=${listed.total}`);
  const capture = listed.captures[0];
  check(capture !== undefined && capture.transcript === heard, "the capture holds the raw ASR text", `"${capture?.transcript ?? ""}" vs heard "${heard}"`);
  if (!capture) {
    console.error("LIBRARY GATE: FAIL (no capture to continue with)");
    await gateway.stop();
    return 1;
  }
  const audio = await fetch(new URL(`/v1/library/${capture.id}/audio`, gateway.url));
  const audioBytes = new Uint8Array(await audio.arrayBuffer());
  check(audio.ok && new TextDecoder().decode(audioBytes.slice(0, 4)) === "RIFF", "the capture audio serves as WAV", `${audioBytes.byteLength} bytes`);

  // 4. Re-transcribe the served audio through the facade — the panel's 重转写 path.
  const form = new FormData();
  form.set("model", "default");
  form.set("language", "auto");
  form.set("file", new File([audioBytes], "capture.wav", { type: "audio/wav" }));
  const again = await (await fetch(new URL("/v1/audio/transcriptions", gateway.url), { method: "POST", body: form })).json() as { text?: string };
  check((again.text ?? "").trim() !== "", "the capture re-transcribes through the facade", `"${again.text ?? ""}"`);

  // 5. Inline correction writes the reference and its compare_asr.py sidecar.
  const corrected = await fetch(new URL(`/v1/library/${capture.id}`, gateway.url), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ corrected: spoken }),
  });
  check(corrected.ok, "the correction saves", `${corrected.status}`);
  const ref = Bun.file(`${libraryDir}/captures/${capture.id}.ref.txt`);
  check(await ref.exists() && (await ref.text()).trim() === spoken, ".ref.txt carries the reference", `${libraryDir}/captures/${capture.id}.ref.txt`);

  // 6. Promotion registers a clone voice sample with the corrected text.
  const voiceId = `libgate-${process.pid}`;
  const promoted = await fetch(new URL(`/v1/library/${capture.id}/promote`, gateway.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voice_id: voiceId }),
  });
  check(promoted.ok, "promote registers on the clone engine", `${promoted.status}`);
  const bank = await (await fetch(new URL("/v1/voices", gateway.url))).json() as { voices: { id: string }[] };
  check(bank.voices.some(voice => voice.id === voiceId), "the promoted voice is in the bank", voiceId);

  // 7. Cleanup: the gate must leave no trace in the live registry or on disk.
  const unregistered = await fetch(new URL(`/v1/voices/${voiceId}`, gateway.url), { method: "DELETE" });
  check(unregistered.ok, "cleanup: promoted voice unregistered", `${unregistered.status}`);
  const removed = await fetch(new URL(`/v1/library/${capture.id}`, gateway.url), { method: "DELETE" });
  check(removed.ok, "cleanup: capture deleted", `${removed.status}`);

  await gateway.stop();
  await Bun.$`rm -rf ${libraryDir}`.quiet().nothrow();

  const pass = failures.length === 0;
  console.error(pass ? "LIBRARY GATE: PASS" : `LIBRARY GATE: FAIL (${failures.join("; ")})`);
  return pass ? 0 : 1;
}

process.exitCode = await main();
