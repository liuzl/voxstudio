import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SpeechProbabilityModel } from "@voxstudio/duplex-session";
// The WASM backend's two artifacts, embedded as file assets: `bun build --compile`
// packs them into the binary (the same `with { type: "file" }` mechanism as the web
// shell), and under plain `bun` they resolve to the real files in node_modules. WASM
// SIMD is the production default in both forms: one backend is easier to certify and
// deploy consistently across macOS, Linux, and Windows. Native ONNX remains an explicit
// opt-in for high-concurrency measurement. Hard prerequisite: onnxruntime-web ships only
// the WebAssembly-SIMD build, and every supported Bun target qualifies; if SIMD init ever
// fails it propagates loudly to the calling VAD policy.
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
export type SileroBackendPreference = "wasm" | "native";
export type SileroLogLevel = "info" | "warn";

/** Parse the one deliberate backend override without silently accepting a typo. */
export function sileroBackendPreference(
  environment: Record<string, string | undefined> = process.env,
): SileroBackendPreference {
  const configured = environment.VOXSTUDIO_ONNX_BACKEND?.trim().toLowerCase() || "wasm";
  if (configured !== "wasm" && configured !== "native") {
    throw new TypeError(`VOXSTUDIO_ONNX_BACKEND must be "wasm" or "native", not ${JSON.stringify(configured)}`);
  }
  return configured;
}

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
 * A backend attempt includes both runtime import and session creation. WASM is the
 * normal path. Native is selected only for deliberate measurement and therefore fails
 * closed rather than silently measuring WASM. A failed attempt resets that backend's
 * singleflight so a later session may retry (e.g. after installing the optional peer).
 */
const sharedBackends = new Map<SileroBackendPreference, Promise<SharedBackend>>();

async function createBackend(
  preference: SileroBackendPreference,
  log: (line: string, level: SileroLogLevel) => void,
): Promise<SharedBackend> {
  const bytes = await modelBytes();
  type BackendParts = Pick<SharedBackend, "ort" | "session">;
  const reason = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure);
  const wasm = async (): Promise<BackendParts> => {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = {
      wasm: pathToFileURL(ortWasmAsset).href,
      mjs: pathToFileURL(ortWasmLoaderAsset).href,
    };
    const session = await ort.InferenceSession.create(bytes);
    return { ort, session };
  };

  const selected = await (async (): Promise<BackendParts> => {
    if (preference === "native") {
      try {
        // Deliberately non-analyzable: native is an optional dependency and must not become
        // a required asset of the compiled single-file CLI.
        const specifier = "onnxruntime-node";
        const ort = (await import(specifier)) as OrtRuntime;
        const session = await ort.InferenceSession.create(bytes);
        log("silero VAD: using explicitly requested native ONNX Runtime backend", "info");
        return { ort, session };
      } catch (nativeFailure) {
        throw new TypeError(`the explicitly requested native ONNX Runtime failed: ${reason(nativeFailure)}`);
      }
    }
    try {
      const selected = await wasm();
      log("silero VAD: using WASM SIMD backend", "info");
      return selected;
    } catch (wasmFailure) {
      throw new TypeError(`the silero VAD WASM runtime failed: ${reason(wasmFailure)}`);
    }
  })();
  const { ort, session } = selected;
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

function backend(
  preference: SileroBackendPreference,
  log: (line: string, level: SileroLogLevel) => void,
): Promise<SharedBackend> {
  let shared = sharedBackends.get(preference);
  if (!shared) {
    const attempt = createBackend(preference, log);
    shared = attempt;
    sharedBackends.set(preference, attempt);
    attempt.catch(() => {
      if (sharedBackends.get(preference) === attempt) sharedBackends.delete(preference);
    });
  }
  return shared;
}

/**
 * Load the Silero VAD as a `SpeechProbabilityModel`. The heavy pieces (model bytes,
 * ONNX runtime, inference session) are process-shared and loaded lazily on first
 * use; what this returns is a per-stream view carrying only the recurrent state.
 */
export async function loadSileroVadModel(
  log: (line: string, level: SileroLogLevel) => void = () => {},
  options: { backend?: SileroBackendPreference } = {},
): Promise<SpeechProbabilityModel> {
  // Validate configuration before modelBytes can fetch or write anything.
  const preference = options.backend ?? sileroBackendPreference();
  const { ort, session, enqueue } = await backend(preference, log);
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
