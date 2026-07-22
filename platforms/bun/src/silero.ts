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
// ONNX runtime it cannot carry. Hard prerequisite: onnxruntime-web ships only the
// WebAssembly-SIMD build, so the WASM path needs a SIMD-capable engine — every Bun
// target qualifies; if SIMD init ever fails it fails loudly into the energy fallback.
import ortWasmAsset from "onnxruntime-web/ort-wasm-simd-threaded.wasm" with { type: "file" };
import ortWasmLoaderAsset from "onnxruntime-web/ort-wasm-simd-threaded.mjs" with { type: "file" };

// The Silero VAD model is fetched into a verified local cache, never committed to the
// repository. Everything is pinned: a tag, a URL, and the artifact's SHA-256 — a cache hit
// is only trusted after its hash matches, so a corrupted or substituted file cannot load.
// Release builds embed the same verified bytes via tools/ensure-silero-model.ts, so the
// compiled binary needs no first-use network fetch.
const modelVersion = "v5.1.2";
const modelUrl = `https://raw.githubusercontent.com/snakers4/silero-vad/${modelVersion}/src/silero_vad/data/silero_vad.onnx`;
const modelSha256 = "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f";

// Silero v5 at 16kHz: 512-sample windows, each prepended with 64 samples of context from
// the previous window, plus a 2x1x128 recurrent state carried across calls.
const windowSamples = 512;
const contextSamples = 64;
const stateShape = [2, 1, 128] as const;
const stateSize = stateShape[0] * stateShape[1] * stateShape[2];

function cachePath(): string {
  if (process.env.VOXSTUDIO_SILERO_VAD) return process.env.VOXSTUDIO_SILERO_VAD;
  const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheRoot, "voxstudio", `silero-vad-${modelVersion}.onnx`);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The verified model bytes: the build-time embedded copy when this is a release
 * binary (or a workspace whose cache held the model at typecheck), the SHA-pinned
 * download cache otherwise. Either source is re-verified here — the pinned hash is
 * the trust anchor, not the file's location.
 */
async function modelBytes(): Promise<Uint8Array> {
  const embedded = await import("./generated/silero-model").then(m => m.embeddedSileroModel, () => undefined);
  if (embedded !== undefined) {
    const bytes = new Uint8Array(await Bun.file(embedded).arrayBuffer());
    const actual = digest(bytes);
    if (actual !== modelSha256) {
      throw new TypeError(`embedded Silero VAD model has SHA-256 ${actual}, expected ${modelSha256}; rebuild with tools/ensure-silero-model.ts`);
    }
    return bytes;
  }
  const path = cachePath();
  if (existsSync(path)) {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const actual = digest(bytes);
    if (actual === modelSha256) return bytes;
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
  const actual = digest(bytes);
  if (actual !== modelSha256) {
    throw new TypeError(`downloaded Silero VAD model has SHA-256 ${actual}, expected ${modelSha256}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  // pid + random: concurrent downloads in one process (or across processes) never
  // share a partial file; the rename is atomic and both sides were hash-verified.
  const partial = `${path}.download-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await Bun.write(partial, bytes);
  renameSync(partial, path);
  return bytes;
}

/**
 * The API subset both ONNX runtimes share; the probe measured their Silero outputs
 * identical to 2.4e-7, so which one loaded is an implementation detail, not a quality
 * tier.
 */
type OrtRuntime = typeof import("onnxruntime-web");

interface SharedBackend {
  ort: OrtRuntime;
  session: Awaited<ReturnType<OrtRuntime["InferenceSession"]["create"]>>;
  /**
   * Every inference serialized through one chain: the WASM instance is
   * single-threaded, and fairness across sessions costs nothing — a frame runs in
   * ~0.2–1ms against its 32ms budget.
   */
  enqueue<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * One ONNX session for the whole process (adversarial review 2026-07-22). Silero's
 * recurrence lives in tensors the caller passes in and out, so the session itself is
 * stateless across streams: every `loadSileroVadModel` call shares it and keeps only
 * its own context+state (320 floats). Session churn — connect, converse, disconnect,
 * repeat — allocates nothing on the ONNX side, which is what makes an undisposable
 * per-session InferenceSession leak impossible rather than merely handled.
 *
 * Each backend is attempted WHOLE (runtime import + session creation): a native
 * binding that imports but cannot create a session hands over to WASM instead of
 * surfacing a spurious total failure. Only a both-backends failure escapes, and a
 * failed attempt resets the singleflight so a later session may retry (e.g. the
 * network came back for the model fetch).
 */
let sharedBackend: Promise<SharedBackend> | undefined;

async function createBackend(log: (line: string) => void): Promise<SharedBackend> {
  const bytes = await modelBytes();
  let ort: OrtRuntime;
  let session: SharedBackend["session"];
  try {
    // The specifier is deliberately non-analyzable: compiling the CLI embeds the
    // .node binding but cannot embed libonnxruntime.dylib next to it, so a bundled
    // import dlopens a broken library at runtime — inside the compiled binary this
    // whole attempt fails cleanly and the WASM backend takes over.
    const specifier = "onnxruntime-node";
    ort = (await import(specifier)) as OrtRuntime;
    session = await ort.InferenceSession.create(bytes);
  } catch (nativeFailure) {
    try {
      ort = await import("onnxruntime-web");
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = {
        wasm: pathToFileURL(ortWasmAsset).href,
        mjs: pathToFileURL(ortWasmLoaderAsset).href,
      };
      session = await ort.InferenceSession.create(bytes);
      log("silero VAD: native ONNX runtime unavailable; using the embedded WASM backend (same model, same numbers)");
    } catch (wasmFailure) {
      const reason = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure);
      throw new TypeError(`the silero VAD failed on both runtimes — native: ${reason(nativeFailure)}; wasm: ${reason(wasmFailure)}`);
    }
  }
  for (const name of ["input", "state", "sr"]) {
    if (!session.inputNames.includes(name)) {
      throw new TypeError(`Silero VAD model is missing input "${name}"; got ${session.inputNames.join(", ")}`);
    }
  }
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  return { ort, session, enqueue };
}

function backend(log: (line: string) => void): Promise<SharedBackend> {
  if (!sharedBackend) {
    const attempt = createBackend(log);
    sharedBackend = attempt;
    attempt.catch(() => {
      if (sharedBackend === attempt) sharedBackend = undefined;
    });
  }
  return sharedBackend;
}

/**
 * Load the Silero VAD as a `SpeechProbabilityModel`. The heavy pieces (model bytes,
 * ONNX runtime, inference session) are process-shared and loaded lazily on first
 * use; what this returns is a per-stream view carrying only the recurrent state.
 */
export async function loadSileroVadModel(log: (line: string) => void = () => {}): Promise<SpeechProbabilityModel> {
  const { ort, session, enqueue } = await backend(log);
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
      // Context advances with the enqueue, outside the run: per-stream calls are
      // sequential (the segmenter awaits each window), so this stays ordered even
      // while other streams interleave on the shared session.
      context.set(window.subarray(windowSamples - contextSamples));
      return enqueue(async () => {
        const outputs = await session.run({
          input: new ort.Tensor("float32", input, [1, input.length]),
          state,
          sr,
        });
        state = outputs.stateN as typeof state;
        const probability = (outputs.output?.data as Float32Array)[0];
        if (probability === undefined || !Number.isFinite(probability)) {
          throw new TypeError("Silero VAD produced no probability");
        }
        return probability;
      });
    },
  };
}
