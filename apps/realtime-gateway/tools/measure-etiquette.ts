#!/usr/bin/env bun
/**
 * The conversation-etiquette gate (docs/conversation-etiquette.md §Phases), promoted
 * from the 2026-07-19 probe to a repeatable measurement: against live engines, a
 * session started with a welcome speaks before the client has sent a single frame, and
 * a short nudge window nudges exactly once while the (silently streaming) client stays
 * quiet.
 *
 *   bun run measure:etiquette [--config CONFIG]
 */
import { ffmpegPcmDecoder, loadConfig } from "@voxstudio/platform-bun";
import { startGateway } from "../src/server";

async function main(): Promise<number> {
  const explicitIndex = process.argv.indexOf("--config");
  const config = explicitIndex >= 0
    ? await loadConfig({ explicit: process.argv[explicitIndex + 1] as string })
    : await loadConfig();
  const decoder = ffmpegPcmDecoder();
  const gateway = startGateway({ config, port: 0, ...(decoder === undefined ? {} : { pcmDecoder: decoder }) });

  const failures: string[] = [];
  const check = (ok: boolean, what: string, detail: string): void => {
    console.error(`${ok ? "✓" : "✗"} ${what} -> ${detail}`);
    if (!ok) failures.push(what);
  };

  const started = Date.now();
  const events: { type: string; text?: string; message?: string }[] = [];
  let firstAudioAtMs: number | undefined;
  const ws = new WebSocket(`${gateway.url.replace(/^http/, "ws")}v1/realtime`);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", event => {
    if (typeof event.data !== "string") {
      firstAudioAtMs ??= Date.now() - started;
      return;
    }
    events.push(JSON.parse(event.data) as { type: string; text?: string });
  });
  await new Promise(resolve => ws.addEventListener("open", () => resolve(null)));
  ws.send(JSON.stringify({
    v: 1, type: "session.start", idempotencyKey: "etiquette-gate",
    options: { language: "auto", welcome: "你好，我是语音助手，请讲。", nudgeAfterSeconds: 2 },
  }));
  // A real client streams its (silent) microphone; speech never comes. The nudge ticks
  // on incoming frames by design, so the gate streams like an endpoint does.
  const silence = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(new Float32Array(320).buffer);
  }, 20);
  await new Promise(resolve => setTimeout(resolve, 12_000));
  clearInterval(silence);
  ws.close();
  await gateway.stop();

  const finals = events.filter(event => event.type === "response.text.final").map(event => event.text ?? "");
  const turns = events.filter(event => event.type === "turn.completed").length;
  check(finals[0] === "你好，我是语音助手，请讲。", "welcome spoken with zero client speech", `"${finals[0] ?? ""}"`);
  check(firstAudioAtMs !== undefined && firstAudioAtMs < 3_000, "welcome audio arrived promptly", `${String(firstAudioAtMs)}ms`);
  check(finals.length === 2 && (finals[1] ?? "").includes("还在吗"), "the nudge fired exactly once in 12s of silence", JSON.stringify(finals));
  check(turns === 2, "two completed agent turns, no more", `${turns} turns`);

  const pass = failures.length === 0;
  console.error(pass ? "ETIQUETTE GATE: PASS" : `ETIQUETTE GATE: FAIL (${failures.join("; ")})`);
  return pass ? 0 : 1;
}

process.exitCode = await main();
