#!/usr/bin/env bun
/**
 * The public-demo guardrail gate (docs/public-demo.md §Phases), promoted from the
 * 2026-07-19 probe to a repeatable measurement: a gateway started with all three flags
 * refuses the second conversation, 403s registry writes while reads stay, and stops the
 * first session at its ceiling.
 *
 *   bun run measure:guardrails [--config CONFIG]
 */
import { loadConfig } from "@voxstudio/platform-bun";
import { startGateway } from "../src/server";

interface Probe {
  ws: WebSocket;
  events: { type: string; reason?: string; message?: string; state?: string }[];
  start: (key: string) => void;
}

function connect(url: string): Probe {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}v1/realtime`);
  const events: Probe["events"] = [];
  ws.addEventListener("message", event => {
    if (typeof event.data === "string") events.push(JSON.parse(event.data) as Probe["events"][number]);
  });
  return { ws, events, start: key => ws.send(JSON.stringify({ v: 1, type: "session.start", idempotencyKey: key, options: {} })) };
}

async function main(): Promise<number> {
  const explicitIndex = process.argv.indexOf("--config");
  const config = explicitIndex >= 0
    ? await loadConfig({ explicit: process.argv[explicitIndex + 1] as string })
    : await loadConfig();
  const gateway = startGateway({ config, port: 0, maxSessions: 1, maxSessionSeconds: 6, demoMode: true });

  const failures: string[] = [];
  const check = (ok: boolean, what: string, detail: string): void => {
    console.error(`${ok ? "✓" : "✗"} ${what} -> ${detail}`);
    if (!ok) failures.push(what);
  };
  const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  const writes = await Promise.all([
    fetch(new URL("/v1/voices", gateway.url), { method: "POST", body: "{}" }),
    fetch(new URL("/v1/design-profiles", gateway.url), { method: "POST", body: "{}" }),
    fetch(new URL("/v1/voices/alice", gateway.url), { method: "DELETE" }),
  ]);
  check(writes.every(response => response.status === 403), "registry writes answer 403 in demo mode",
    writes.map(response => response.status).join("/"));
  const reads = await fetch(new URL("/v1/voices", gateway.url));
  check(reads.status === 200, "the voice bank stays readable", String(reads.status));

  const first = connect(gateway.url);
  await new Promise(resolve => first.ws.addEventListener("open", () => resolve(null)));
  first.start("gate-a");
  await wait(1_500);
  const second = connect(gateway.url);
  await new Promise(resolve => second.ws.addEventListener("open", () => resolve(null)));
  second.start("gate-b");
  await wait(1_000);
  check(first.events.some(event => event.type === "session.snapshot"), "the first conversation started", "snapshot seen");
  check(second.events.some(event => event.type === "command.rejected" && event.reason === "session_capacity"),
    "the second conversation is refused at capacity", "session_capacity");

  await wait(6_000);
  check(first.events.some(event => event.type === "session.notice" && (event.message ?? "").includes("demo ceiling")),
    "the ceiling notice arrived", "session.notice");
  check(first.events.some(event => event.type === "session.state" && event.state === "closed"),
    "the session stopped at its ceiling", "closed");

  first.ws.close();
  second.ws.close();
  await gateway.stop();

  const pass = failures.length === 0;
  console.error(pass ? "GUARDRAIL GATE: PASS" : `GUARDRAIL GATE: FAIL (${failures.join("; ")})`);
  return pass ? 0 : 1;
}

process.exitCode = await main();
