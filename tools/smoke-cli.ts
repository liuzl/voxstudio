/**
 * Compiled-binary smoke test: does `vox` still start?
 *
 * The source path and the compiled path are not the same program. `bun build --compile`
 * has twice emitted a binary whose module graph fails at import while `bun test` stayed
 * green — most recently by dropping the init call for zod's lazily-wrapped classic
 * module, which killed every subcommand before argument parsing (2026-07-26). Nothing in
 * the test suite runs the artifact, so this does: it costs a second and it catches the
 * whole class.
 *
 * `main.ts` imports every command module statically, and `listen` pulls in the MCP
 * client, so simply reaching argument parsing proves the entire graph evaluated.
 */
import { existsSync } from "node:fs";

/**
 * The artifact, wherever this platform put it. `bun build --compile` appends `.exe` on
 * Windows, and CI passes the matrix path through VOX.
 */
function findBinary(): string | undefined {
  const override = process.env.VOX;
  const candidates = override
    ? [override]
    : [`${import.meta.dir}/../apps/cli/dist/vox`, `${import.meta.dir}/../apps/cli/dist/vox.exe`];
  return candidates.find(candidate => existsSync(candidate));
}

/** An import-time death looks nothing like a usage error; say which one happened. */
const crashMarkers = [
  "is not a constructor",
  "is not a function",
  "Cannot find module",
  "undefined is not an object",
  "ReferenceError",
  "TypeError",
];

interface Check {
  what: string;
  args: string[];
  expectExit: number;
  expectOutput: string;
}

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Start the actual compiled server and force the certified VAD path to initialize.
 * Help output alone cannot catch missing compiled WASM assets or a runtime that silently
 * picked native, so this is deliberately a real WebSocket session rather than an import
 * check. Explicit `vad: silero` also prevents the ordinary energy-VAD fallback from
 * turning a broken release artifact green.
 */
async function checkCompiledSilero(binary: string): Promise<void> {
  const child = Bun.spawn([binary, "studio", "--host", "127.0.0.1", "--port", "0"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, VOXSTUDIO_ONNX_BACKEND: "wasm" },
  });
  let output = "";
  const capture = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
  };
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  let socket: WebSocket | undefined;
  try {
    const base = await until(() => {
      const match = output.match(/Web Studio at (http:\/\/127\.0\.0\.1:\d+\/)/);
      return match?.[1];
    }, "the compiled Studio URL");
    socket = new WebSocket(new URL("/v1/realtime", base).toString().replace(/^http/, "ws"));
    const events: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for a Silero session; saw ${events.map(event => event.type).join(", ") || "no events"}`));
      }, 8_000);
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      socket?.addEventListener("open", () => {
        socket?.send(JSON.stringify({
          v: 1,
          type: "session.start",
          idempotencyKey: "compiled-silero-smoke",
          options: { vad: "silero" },
        }));
      });
      socket?.addEventListener("message", event => {
        if (typeof event.data !== "string") return;
        const payload = JSON.parse(event.data) as Record<string, unknown>;
        events.push(payload);
        if (payload.type === "command.rejected" || payload.type === "error") {
          finish(new Error(`compiled Silero session failed: ${JSON.stringify(payload)}`));
        } else if (payload.type === "session.state" && payload.state === "listening") {
          finish();
        }
      });
      socket?.addEventListener("error", () => finish(new Error("compiled Studio WebSocket failed")));
      socket?.addEventListener("close", () => finish(new Error("compiled Studio WebSocket closed before the session started")));
    });
    await until(
      () => output.includes("silero VAD: using WASM SIMD backend") ? true : undefined,
      "the compiled Silero WASM initialization log",
    );
    if (output.includes("native ONNX Runtime")) {
      throw new Error("compiled Studio probed the native ONNX Runtime despite an explicit WASM backend");
    }
  } catch (error) {
    const detail = output.trim().split("\n").slice(-12).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`);
  } finally {
    socket?.close();
    child.kill();
    await child.exited;
    await Promise.all([stdout, stderr]);
  }
}

const checks: Check[] = [
  // Reaching the banner means every top-level import evaluated.
  { what: "vox --help", args: ["--help"], expectExit: 0, expectOutput: "voxstudio: self-hosted voice i/o" },
  // Per-command usage: the command modules resolved, not just the entrypoint.
  { what: "vox say --help", args: ["say", "--help"], expectExit: 0, expectOutput: "usage: vox say" },
  { what: "vox voices --help", args: ["voices", "--help"], expectExit: 0, expectOutput: "usage: vox voices" },
  // An unknown command must be *rejected* — usage on stderr, exit 2 — not crashed on:
  // the difference between a program that started and one that died loading.
  { what: "vox nonesuch", args: ["nonesuch"], expectExit: 2, expectOutput: "usage" },
];

async function main(): Promise<number> {
  const binary = findBinary();
  if (binary === undefined) {
    console.error("smoke-cli: no compiled binary found (apps/cli/dist/vox[.exe], or $VOX) — run `bun run build:cli` first");
    return 2;
  }
  const started = Date.now();
  let failed = 0;
  for (const check of checks) {
    const run = Bun.spawnSync([binary, ...check.args], { stdout: "pipe", stderr: "pipe" });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    const crashed = crashMarkers.find(marker => output.includes(marker));
    if (crashed !== undefined) {
      console.error(`smoke-cli: ${check.what} died loading (${crashed}):\n${output.trim().split("\n").slice(0, 8).join("\n")}`);
      failed += 1;
      continue;
    }
    if (run.exitCode !== check.expectExit) {
      console.error(`smoke-cli: ${check.what} exited ${run.exitCode}, expected ${check.expectExit}\n${output.trim().slice(0, 400)}`);
      failed += 1;
      continue;
    }
    if (!output.toLowerCase().includes(check.expectOutput)) {
      console.error(`smoke-cli: ${check.what} did not mention "${check.expectOutput}"\n${output.trim().slice(0, 400)}`);
      failed += 1;
      continue;
    }
    console.error(`smoke-cli: ${check.what} ok`);
  }
  try {
    await checkCompiledSilero(binary);
    console.error("smoke-cli: compiled Silero WASM session ok");
  } catch (error) {
    console.error(`smoke-cli: compiled Silero WASM session failed:\n${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
  }
  const seconds = ((Date.now() - started) / 1_000).toFixed(1);
  const total = checks.length + 1;
  if (failed > 0) {
    console.error(`smoke-cli: ${failed} of ${total} checks failed in ${seconds}s — the compiled binary is broken even if the tests pass`);
    return 1;
  }
  console.error(`smoke-cli: the compiled binary starts (${total} checks, ${seconds}s)`);
  return 0;
}

process.exit(await main());
