import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SpeechProbabilityModel } from "@voxstudio/duplex-session";
// The WASM backend's two artifacts, embedded as file assets: `bun build --compile`
// packs them into the binary (the same `with { type: "file" }` mechanism as the web
// shell), and under plain `bun` they resolve to the real files in node_modules. This
// is what lets the compiled `vox` run the certified Silero model without the native
// ONNX runtime it cannot carry.
import ortWasmAsset from "onnxruntime-web/ort-wasm-simd-threaded.wasm" with { type: "file" };
import ortWasmLoaderAsset from "onnxruntime-web/ort-wasm-simd-threaded.mjs" with { type: "file" };

// The Silero VAD model is fetched into a verified local cache, never committed to the
// repository. Everything is pinned: a tag, a URL, and the artifact's SHA-256 — a cache hit
// is only trusted after its hash matches, so a corrupted or substituted file cannot load.
const modelVersion = "v5.1.2";
const modelUrl = `https://raw.githubusercontent.com/snakers4/silero-vad/${modelVersion}/src/silero_vad/data/silero_vad.onnx`;
const modelSha256 = "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f";

// Silero v5 at 16kHz: 512-sample windows, each prepended with 64 samples of context from
// the previous window, plus a 2x1x128 recurrent state carried across calls.
const windowSamples = 512;
const contextSamples = 64;
const stateShape = [2, 1, 128] as const;

function cachePath(): string {
  if (process.env.VOXSTUDIO_SILERO_VAD) return process.env.VOXSTUDIO_SILERO_VAD;
  const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheRoot, "voxstudio", `silero-vad-${modelVersion}.onnx`);
}

async function sha256(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

async function ensureModel(): Promise<string> {
  const path = cachePath();
  if (existsSync(path)) {
    const actual = await sha256(path);
    if (actual === modelSha256) return path;
    throw new TypeError(
      `Silero VAD model at ${path} has SHA-256 ${actual}, expected ${modelSha256}; delete it or fix VOXSTUDIO_SILERO_VAD`,
    );
  }
  if (process.env.VOXSTUDIO_SILERO_VAD) {
    throw new TypeError(`VOXSTUDIO_SILERO_VAD points at ${path}, which does not exist`);
  }
  const response = await fetch(modelUrl);
  if (!response.ok) throw new TypeError(`fetching Silero VAD model failed: ${response.status} ${modelUrl}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== modelSha256) {
    throw new TypeError(`downloaded Silero VAD model has SHA-256 ${actual}, expected ${modelSha256}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.download-${process.pid}`;
  await Bun.write(partial, bytes);
  renameSync(partial, path); // atomic: a concurrent process never sees a half-written model
  return path;
}

/**
 * The API subset both ONNX runtimes share; the probe measured their Silero outputs
 * identical to 2.4e-7, so which one loaded is an implementation detail, not a quality
 * tier.
 */
type OrtRuntime = typeof import("onnxruntime-web");

/**
 * Native runtime first (in-process, no WASM boundary), the onnxruntime-web WASM
 * backend as the fallback. The native package's specifier is deliberately
 * non-analyzable: compiling the CLI embeds the .node binding but cannot embed
 * libonnxruntime.dylib next to it, so a bundled import dlopens a broken library at
 * runtime — inside the compiled binary the import fails cleanly and the WASM backend
 * (whose artifacts ARE embedded, see the file imports above) takes over.
 */
async function loadRuntime(log: (line: string) => void): Promise<OrtRuntime> {
  const specifier = "onnxruntime-node";
  try {
    return (await import(specifier)) as OrtRuntime;
  } catch {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = {
      wasm: pathToFileURL(ortWasmAsset).href,
      mjs: pathToFileURL(ortWasmLoaderAsset).href,
    };
    log("silero VAD: native ONNX runtime unavailable; using the embedded WASM backend (same model, same numbers)");
    return ort;
  }
}

/**
 * Load the Silero VAD ONNX model as a `SpeechProbabilityModel`. ONNX Runtime is imported
 * lazily so commands that never touch the model never pay for the binding.
 */
export async function loadSileroVadModel(log: (line: string) => void = () => {}): Promise<SpeechProbabilityModel> {
  const path = await ensureModel();
  const ort = await loadRuntime(log);
  const session = await ort.InferenceSession.create(new Uint8Array(await Bun.file(path).arrayBuffer()));
  for (const name of ["input", "state", "sr"]) {
    if (!session.inputNames.includes(name)) {
      throw new TypeError(`Silero VAD model is missing input "${name}"; got ${session.inputNames.join(", ")}`);
    }
  }
  const stateSize = stateShape[0] * stateShape[1] * stateShape[2];
  const context = new Float32Array(contextSamples);
  let state = new ort.Tensor("float32", new Float32Array(stateSize), [...stateShape]);
  const sr = new ort.Tensor("int64", BigInt64Array.from([16_000n]), []);
  return {
    windowSamples,
    reset(): void {
      context.fill(0);
      state = new ort.Tensor("float32", new Float32Array(stateSize), [...stateShape]);
    },
    async process(window: Float32Array): Promise<number> {
      if (window.length !== windowSamples) {
        throw new TypeError(`Silero VAD expects ${windowSamples}-sample windows, got ${window.length}`);
      }
      const input = new Float32Array(contextSamples + windowSamples);
      input.set(context);
      input.set(window, contextSamples);
      const outputs = await session.run({
        input: new ort.Tensor("float32", input, [1, input.length]),
        state,
        sr,
      });
      state = outputs.stateN as typeof state;
      context.set(window.subarray(windowSamples - contextSamples));
      const probability = (outputs.output?.data as Float32Array)[0];
      if (probability === undefined || !Number.isFinite(probability)) {
        throw new TypeError("Silero VAD produced no probability");
      }
      return probability;
    },
  };
}
