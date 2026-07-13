import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readWav, trimEdgeSilence, writeWav } from "@voxstudio/audio";
import { EnergyVadSegmenter, SileroVadSegmenter, type VadSegmenter, type VadSegmentEvent } from "@voxstudio/duplex-session";
import { loadSileroVadModel } from "@voxstudio/platform-bun";

// Speaker-mode AEC gate for `vox listen --speaker-duplex`. It drives the real
// audio host over its real IPC and scores the capture with the same VAD and the
// same thresholds the CLI uses, so a passing run is evidence about the product
// path rather than about a bespoke detector.

const helper = join(import.meta.dir, "dist", "vox-audio-host");
const clearPlaybackSignal = 30; // SIGUSR1; Bun maps the string name to SIGBUS on macOS.
const playbackRate = 48_000;
const captureRate = 16_000;
const packetFrames = 960; // 20ms at 48kHz.
const packetMs = 1_000 * packetFrames / playbackRate;
const captureFrameSamples = 320; // 20ms at 16kHz, matching the CLI capture framing.

// The CLI's `listen` defaults. Barge-in is triggered by `speech.start`, so these
// are the exact thresholds that decide a self-interruption in the product.
const vadDefaults = { sampleRate: captureRate, threshold: 0.01, minSpeechMs: 250, silenceMs: 650 };

interface Options {
  farEnd?: string;
  outDir: string;
  volume: number;
  trials: number;
  scenarios: string[];
  seconds?: number;
  quick: boolean;
  vad: "energy" | "silero";
}

// A smoke run for the edit loop: does the endpoint still start, cancel, and cancel echo at
// all? It is far too short to estimate a rate like "1.4 self-interruptions per minute", and
// it skips double-talk because that needs a person. It can never pass the gate — see
// `evaluateGate` — it exists to fail fast, not to certify.
const quickSeconds = 8; // 5s for the canceller to converge, 3s measured
const quickTrials = 1;
const quickScenarios = ["noise-floor", "echo", "capture-to-mute"];

interface CaptureChunk {
  samples: Float32Array;
  arrivedAtMs: number;
}

interface HostSession {
  write(samples: Float32Array): Promise<void>;
  clearPlayback(): void;
  chunks: CaptureChunk[];
  capability: () => string;
  stop(): Promise<Float32Array>;
}

function fail(message: string): never {
  throw new Error(message);
}

function parse(argv: string[]): Options {
  const options: Options = {
    outDir: join(process.cwd(), "outputs", "aec"),
    volume: 45,
    trials: 5,
    scenarios: ["noise-floor", "echo", "capture-to-mute", "double-talk"],
    quick: false,
    vad: "energy",
  };
  let scenariosSet = false;
  let trialsSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const value = (): string => argv[++index] ?? fail(`aec-measure: ${arg} requires a value`);
    if (arg === "--far-end") options.farEnd = value();
    else if (arg === "--out") options.outDir = value();
    else if (arg === "--volume") options.volume = Number(value());
    else if (arg === "--seconds") options.seconds = Number(value());
    else if (arg === "--quick") options.quick = true;
    else if (arg === "--vad") {
      const kind = value();
      if (kind !== "energy" && kind !== "silero") fail("aec-measure: --vad must be energy or silero");
      options.vad = kind;
    }
    else if (arg === "--trials") { options.trials = Number(value()); trialsSet = true; }
    else if (arg === "--scenario") { options.scenarios = value().split(","); scenariosSet = true; }
    else fail(`aec-measure: unknown option ${arg}`);
  }
  if (options.quick) {
    options.seconds ??= quickSeconds;
    if (!trialsSet) options.trials = quickTrials;
    if (!scenariosSet) options.scenarios = quickScenarios;
  }
  if (!Number.isInteger(options.volume) || options.volume < 0 || options.volume > 100) {
    fail("aec-measure: --volume must be an integer between 0 and 100");
  }
  if (!Number.isInteger(options.trials) || options.trials <= 0) {
    fail("aec-measure: --trials must be a positive integer");
  }
  if (options.seconds !== undefined && (!Number.isFinite(options.seconds) || options.seconds <= 0)) {
    fail("aec-measure: --seconds must be a positive number");
  }
  return options;
}

/** Repeat `samples` until it covers `milliseconds`, so a short far-end still drives a scenario. */
function tile(samples: Float32Array, milliseconds: number): Float32Array {
  const length = Math.ceil(playbackRate * milliseconds / 1_000);
  if (samples.length === 0) fail("aec-measure: the far-end is empty");
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) output[index] = samples[index % samples.length] as number;
  return output;
}

function rmsDb(samples: Float32Array): number {
  if (samples.length === 0) return -120;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const value = Math.sqrt(sum / samples.length);
  return value <= 1e-6 ? -120 : 20 * Math.log10(value);
}

function frameLevelsDb(samples: Float32Array): number[] {
  const levels: number[] = [];
  for (let offset = 0; offset + captureFrameSamples <= samples.length; offset += captureFrameSamples) {
    levels.push(rmsDb(samples.subarray(offset, offset + captureFrameSamples)));
  }
  return levels;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const weight = position - low;
  return (sorted[low] as number) * (1 - weight) + (sorted[high] as number) * weight;
}

/** Engine start-up. Enough for a capture with no playback in it. */
const startupMs = 1_000;

/**
 * An adaptive canceller has not converged when playback begins; until it does, it leaks echo
 * that the VAD counts as speech. Discarding only start-up leaves those artifacts in, which
 * inflates the self-interruption rate — invisibly in a long run, catastrophically in a short
 * one. Every consumer of an echo capture must trim by this, and by the same amount, or the
 * same recording yields different rates depending on who is counting.
 */
const aecWarmupMs = 3_000;

function steadyState(capture: Float32Array, skipMs = startupMs): Float32Array {
  return capture.subarray(Math.min(Math.round(captureRate * skipMs / 1_000), capture.length));
}

function join32(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function decodeFloat32le(bytes: Uint8Array): Float32Array {
  const values = new Float32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < values.length; index += 1) values[index] = view.getFloat32(index * 4, true);
  return values;
}

export interface Cue {
  startMs: number;
  endMs: number;
}

export interface DoubleTalkScore {
  detected: number;
  missed: number;
  falseBargeIns: number;
  latenciesMs: number[];
}

/**
 * Match VAD detections against the cue timeline.
 *
 * A cue matches the first unclaimed detection inside its window, which opens slightly early
 * (the operator can anticipate the tone) and closes late (they can start speaking after it).
 * Every detection outside every cue is the agent interrupting itself.
 *
 * The detector cannot tell near-end speech from residual echo, so a self-interruption that
 * happens to land inside a cue window is credited to the operator. That makes the resulting
 * missed-barge-in rate optimistic — it is a lower bound on how often the product fails to
 * hear the user, not an exact figure.
 */
export function scoreDoubleTalk(cues: Cue[], detections: number[], earlyMs = 200, lateMs = 800): DoubleTalkScore {
  const claimed = new Set<number>();
  const latenciesMs: number[] = [];
  for (const cue of cues) {
    const index = detections.findIndex((value, position) =>
      !claimed.has(position) && value >= cue.startMs - earlyMs && value <= cue.endMs + lateMs);
    if (index < 0) continue;
    claimed.add(index);
    latenciesMs.push((detections[index] as number) - cue.startMs);
  }
  return {
    detected: claimed.size,
    missed: cues.length - claimed.size,
    falseBargeIns: detections.length - claimed.size,
    latenciesMs,
  };
}

function vadEvents(samples: Float32Array, threshold: number, type: VadSegmentEvent["type"]): number[] {
  const vad = new EnergyVadSegmenter({ ...vadDefaults, threshold });
  const timestamps: number[] = [];
  for (let offset = 0; offset + captureFrameSamples <= samples.length; offset += captureFrameSamples) {
    const timestampMs = 1_000 * offset / captureRate;
    for (const event of vad.push(samples.subarray(offset, offset + captureFrameSamples), timestampMs)) {
      if (event.type === type) timestamps.push(event.timestampMs);
    }
  }
  return timestamps;
}

/**
 * Score a capture with the CLI's VAD. Since the provisional-barge-in policy, `listen`
 * interrupts playback on `speech.confirmed` — after minSpeechMs of voiced audio — not on
 * `speech.start`. Counting starts here would fail the product for spikes it now ignores.
 */
export function bargeIns(samples: Float32Array, threshold = vadDefaults.threshold): number[] {
  return vadEvents(samples, threshold, "speech.confirmed");
}

/** Raw first-frame triggers: a diagnostic for how noisy the detector input is, not a product metric. */
export function vadStarts(samples: Float32Array, threshold = vadDefaults.threshold): number[] {
  return vadEvents(samples, threshold, "speech.start");
}

interface VadScore {
  confirmed: number[];
  starts: number[];
}

/** Which detector the scenarios score with — the product supports both, so the gate must too. */
interface BargeInScorer {
  kind: "energy" | "silero";
  detect(samples: Float32Array): Promise<VadScore>;
}

async function detectWith(vad: VadSegmenter, samples: Float32Array): Promise<VadScore> {
  const score: VadScore = { confirmed: [], starts: [] };
  for (let offset = 0; offset + captureFrameSamples <= samples.length; offset += captureFrameSamples) {
    const timestampMs = 1_000 * offset / captureRate;
    for (const event of await vad.push(samples.subarray(offset, offset + captureFrameSamples), timestampMs)) {
      if (event.type === "speech.confirmed") score.confirmed.push(event.timestampMs);
      else if (event.type === "speech.start") score.starts.push(event.timestampMs);
    }
  }
  return score;
}

function makeScorer(kind: "energy" | "silero"): BargeInScorer {
  if (kind === "energy") {
    return { kind, detect: samples => detectWith(new EnergyVadSegmenter(vadDefaults), samples) };
  }
  return {
    kind,
    // A fresh model per capture: the Silero RNN state is stateful and captures are
    // independent recordings, so state must never leak from one into the next.
    detect: async samples => detectWith(new SileroVadSegmenter({
      model: await loadSileroVadModel(),
      minSpeechMs: vadDefaults.minSpeechMs,
      silenceMs: vadDefaults.silenceMs,
    }), samples),
  };
}

async function startHost(voiceProcessing: boolean): Promise<HostSession> {
  if (!existsSync(helper)) fail("macOS audio host not built; run ./platforms/macos-audio/build.sh first");
  const args = voiceProcessing ? [helper] : [helper, "--no-voice-processing"];
  const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  if (!child.stdin || typeof child.stdin === "number" || !child.stdout || typeof child.stdout === "number") {
    fail("macOS audio host did not expose PCM streams");
  }
  const stdin = child.stdin;
  const stdout = child.stdout;
  const chunks: CaptureChunk[] = [];
  let logs = "";
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) logs += decoder.decode(chunk);
  })();
  const drain = (async () => {
    for await (const chunk of stdout) {
      chunks.push({ samples: decodeFloat32le(chunk as Uint8Array), arrivedAtMs: performance.now() });
    }
  })();

  // Engine start-up time varies, so wait for the host to announce itself rather
  // than sleeping a fixed interval and racing it.
  const expected = voiceProcessing ? "ready voice-processing=true" : "ready voice-processing=false";
  const deadline = performance.now() + 5_000;
  while (!logs.includes(expected)) {
    if (child.exitCode !== null) {
      await stderrDone;
      fail(`macOS audio host exited during startup: ${logs}`);
    }
    if (performance.now() > deadline) fail(`macOS audio host did not report ${expected}: ${logs}`);
    await Bun.sleep(20);
  }
  // Let the capture path settle before a scenario reads levels from it.
  await Bun.sleep(250);

  return {
    write: async (samples: Float32Array) => {
      await stdin.write(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    },
    clearPlayback: () => child.kill(clearPlaybackSignal),
    chunks,
    capability: () => (logs.match(/capability (\{.*\})/)?.[1] ?? "{}"),
    stop: async () => {
      await stdin.end();
      const exitCode = await child.exited;
      await Promise.all([drain, stderrDone]);
      if (exitCode !== 0) fail(`macOS audio host exited with status ${exitCode}: ${logs}`);
      const capture = join32(chunks.map(chunk => chunk.samples));
      // A capture that never arrived reads as digital silence, which is indistinguishable
      // from perfect cancellation: it would report a huge ERLE and zero barge-ins. Refuse
      // to hand back a capture that cannot be a real recording.
      if (capture.length < captureRate) {
        fail(`macOS audio host produced ${capture.length} capture samples; the microphone delivered nothing usable`);
      }
      return capture;
    },
  };
}

/**
 * Stream far-end audio in real time, keeping `leadMs` of audio queued in the host.
 * `onTick` runs between packets so a scenario can act while playback continues.
 */
async function playFarEnd(
  host: HostSession,
  farEnd: Float32Array,
  leadMs: number,
  onTick?: (elapsedMs: number) => boolean | void,
): Promise<void> {
  const start = performance.now();
  for (let offset = 0; offset < farEnd.length; offset += packetFrames) {
    const packet = farEnd.subarray(offset, Math.min(offset + packetFrames, farEnd.length));
    await host.write(packet.length === packetFrames ? packet : join32([packet, new Float32Array(packetFrames - packet.length)]));
    const writtenMs = packetMs * (offset / packetFrames + 1);
    for (;;) {
      const elapsed = performance.now() - start;
      if (onTick?.(elapsed) === false) return;
      if (writtenMs - elapsed <= leadMs) break;
      await Bun.sleep(5);
    }
  }
}

/** A constant-level tone complex. Used where a scenario needs an unambiguous "loud" and "silent". */
function steadyStimulus(): Float32Array {
  const samples = new Float32Array(playbackRate);
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / playbackRate;
    samples[index] = 0.3 * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t)) / 1.5;
  }
  return samples;
}

/** Synthetic far-end used only when no real TTS WAV is supplied: speech-shaped, deterministic. */
function syntheticFarEnd(seconds: number): Float32Array {
  const samples = new Float32Array(playbackRate * seconds);
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / playbackRate;
    // A syllable-rate envelope over a voiced harmonic stack. Not a substitute for
    // real speech; it exists so the harness runs without engine access.
    const envelope = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t)) ** 2;
    const voiced = Math.sin(2 * Math.PI * 130 * t) + 0.5 * Math.sin(2 * Math.PI * 260 * t)
      + 0.3 * Math.sin(2 * Math.PI * 520 * t) + 0.15 * Math.sin(2 * Math.PI * 1_040 * t);
    samples[index] = 0.25 * envelope * voiced / 1.95;
  }
  return samples;
}

async function systemVolume(): Promise<number> {
  const proc = Bun.spawn(["osascript", "-e", "output volume of (get volume settings)"], { stdout: "pipe" });
  return Number((await new Response(proc.stdout).text()).trim());
}

async function setSystemVolume(value: number): Promise<void> {
  const proc = Bun.spawn(["osascript", "-e", `set volume output volume ${value}`]);
  await proc.exited;
}

async function audioRoute(): Promise<{ output: string; input: string }> {
  const proc = Bun.spawn(["system_profiler", "SPAudioDataType", "-json"], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  const items = (JSON.parse(text).SPAudioDataType?.[0]?._items ?? []) as Record<string, string>[];
  const output = items.find(item => item.coreaudio_default_audio_output_device === "spaudio_yes");
  const input = items.find(item => item.coreaudio_default_audio_input_device === "spaudio_yes");
  return { output: output?._name ?? "unknown", input: input?._name ?? "unknown" };
}

export interface ScenarioResult {
  scenario: string;
  metrics: Record<string, number | string | boolean>;
  capture?: Float32Array;
  cues?: Cue[];
  guards?: { startMs: number; endMs: number }[];
  captureOriginMs?: number;
}

/**
 * Raising the VAD threshold is the obvious cure for self-interruption, and it buys that
 * directly at the cost of not hearing the user. Neither number means anything alone, so
 * re-score both recordings across a range of thresholds and show the trade-off. This is
 * offline analysis of audio already captured — it costs nothing to widen.
 */
function thresholdSweep(echoCapture: Float32Array, doubleTalk: ScenarioResult): ScenarioResult[] {
  const capture = doubleTalk.capture;
  const cues = doubleTalk.cues;
  const guards = doubleTalk.guards ?? [];
  const originMs = doubleTalk.captureOriginMs ?? 0;
  if (!capture || !cues) return [];
  const echo = steadyState(echoCapture, aecWarmupMs);
  const echoSeconds = echo.length / captureRate;
  return [0.005, 0.01, 0.015, 0.02, 0.03, 0.05].map(threshold => {
    const selfInterruptions = bargeIns(echo, threshold).length;
    const detections = bargeIns(capture, threshold)
      .map(value => value + originMs)
      .filter(value => !guards.some(guard => value >= guard.startMs && value <= guard.endMs));
    const score = scoreDoubleTalk(cues, detections);
    return {
      scenario: `sweep:${threshold}`,
      metrics: {
        threshold,
        thresholdDb: 20 * Math.log10(threshold),
        selfInterruptionsPerMinute: echoSeconds > 0 ? selfInterruptions * 60 / echoSeconds : 0,
        missedBargeInRate: cues.length > 0 ? score.missed / cues.length : 0,
        heard: score.detected,
        cues: cues.length,
      },
    };
  });
}

/**
 * Quiet room, no playback. This is the control for the echo run: the energy VAD fires on
 * ambient noise alone, so a false barge-in during playback only counts against the AEC if
 * it exceeds this baseline. Its duration matches the far-end so the rates are comparable.
 */
async function noiseFloor(durationMs: number, scorer: BargeInScorer): Promise<ScenarioResult> {
  console.log(`\n[noise-floor] ${(durationMs / 1_000).toFixed(0)}s 静音采集，请保持安静…`);
  const host = await startHost(true);
  await Bun.sleep(durationMs);
  const capture = await host.stop();
  const steady = steadyState(capture);
  const starts = (await scorer.detect(steady)).confirmed;
  const seconds = steady.length / captureRate;
  return {
    scenario: "noise-floor",
    capture,
    metrics: {
      capturedSeconds: seconds,
      noiseFloorDb: rmsDb(steady),
      falseBargeIns: starts.length,
      falseBargeInsPerMinute: seconds > 0 ? starts.length * 60 / seconds : 0,
    },
  };
}

/** Far-end only. With voice processing on this is residual echo; with it off, raw echo. */
async function echo(
  farEnd: Float32Array,
  voiceProcessing: boolean,
  scorer: BargeInScorer,
  warmupMs = aecWarmupMs,
): Promise<ScenarioResult> {
  const label = voiceProcessing ? "echo" : "echo-bypass";
  console.log(`\n[${label}] 扬声器播放远端语音 ${(farEnd.length / playbackRate).toFixed(1)}s，请保持安静、不要说话…`);
  const host = await startHost(voiceProcessing);
  await playFarEnd(host, farEnd, 200);
  await Bun.sleep(600); // let the tail drain through the capture path
  const capture = await host.stop();
  const steady = steadyState(capture, warmupMs);
  const score = await scorer.detect(steady);
  const seconds = steady.length / captureRate;
  return {
    scenario: label,
    capture,
    metrics: {
      voiceProcessing,
      capturedSeconds: seconds,
      echoLevelDb: rmsDb(steady),
      echoPeakFrameDb: Math.max(...frameLevelsDb(steady)),
      falseBargeIns: score.confirmed.length,
      falseBargeInsPerMinute: seconds > 0 ? score.confirmed.length * 60 / seconds : 0,
      rawVadStarts: score.starts.length,
    },
  };
}

/**
 * Time from the barge-in clear signal to the speaker actually falling silent.
 *
 * This runs with voice processing BYPASSED on purpose. The metric is a property of the
 * render path — clear the queue, stop the player, wait out device latency — and AEC lives
 * on the capture path. With AEC on, the processed microphone signal does not contain the
 * playback at all (that is the entire point of it), so the moment the speaker stops is
 * not observable there. Bypassing lets the microphone hear the real acoustic output.
 *
 * A real barge-in arrives with seconds of TTS already handed to the host, so the test
 * builds that backlog first, and stops feeding at the signal because a real barge-in
 * aborts the TTS stream.
 */
async function captureToMute(trials: number, volume: number): Promise<ScenarioResult> {
  console.log(`\n[capture-to-mute] ${trials} 次打断（旁路模式，麦克风直接听扬声器，音量 ${volume}），请保持安静…`);
  // This scenario measures the render path, so its volume does not have to match the
  // echo A/B. It is raised only so the speaker sits far enough above the unprocessed
  // microphone floor for its stopping to be unambiguous.
  await setSystemVolume(volume);
  const latencies: number[] = [];
  const invalid: string[] = [];
  let firstBufferMutes = 0;

  // One host serves every trial. The helper resumes playback after a clear, so restarting
  // it per trial only paid for engine start-up and a fresh floor measurement each time.
  const host = await startHost(false);
  // The bypass path has no noise suppression, so its floor sits far above the AEC path's.
  // "Quiet" has to be anchored to that measured floor: a fixed drop from the playing level
  // can land below it and then silence is never detectable. Use a low percentile so a
  // single transient (a fan, a keystroke) does not raise the floor.
  await Bun.sleep(1_000);
  const floorDb = percentile(host.chunks.map(chunk => rmsDb(chunk.samples)), 0.2);
  const quietDb = floorDb + 6;
  const captureBufferMs = 1_000 * (host.chunks[0]?.samples.length ?? 0) / captureRate;

  // Deliberately NOT the far-end speech. This measures when the speaker falls silent, and
  // speech has pauses: if the clear signal lands in one, the level before and after it are
  // the same and the trial says nothing. A steady stimulus makes "it stopped" unambiguous.
  // The render path does not care what it is rendering, so realism buys nothing here.
  const leadMs = 3_000;
  const signalAtElapsedMs = 1_200;
  const stream = tile(steadyStimulus(), leadMs + signalAtElapsedMs + 1_000);

  for (let trial = 0; trial < trials; trial += 1) {
    const seen = host.chunks.length;
    let signalAtMs = 0;
    // Play just long enough to establish a steady speaker level and a backlog; the lead
    // reproduces the real case of a long synthesis piece already handed to the host.
    await playFarEnd(host, stream, leadMs, elapsed => {
      if (elapsed < signalAtElapsedMs) return true;
      signalAtMs = performance.now();
      host.clearPlayback();
      return false;
    });
    await Bun.sleep(1_000);
    const chunks = host.chunks.slice(seen);

    const active = chunks.filter(chunk => chunk.arrivedAtMs >= signalAtMs - 500 && chunk.arrivedAtMs < signalAtMs);
    const activeDb = rmsDb(join32(active.map(chunk => chunk.samples)));
    if (activeDb < quietDb + 10) {
      // The speaker was not loud enough over the floor for its stopping to be visible.
      invalid.push(`trial ${trial + 1}: playing ${activeDb.toFixed(1)}dB vs floor ${floorDb.toFixed(1)}dB`);
      console.log(`  trial ${trial + 1}/${trials}: 无效（播放电平不足以与本底区分）`);
      continue;
    }

    let muteAtMs = Number.NaN;
    let runStartMs = Number.NaN;
    let quietRun = 0;
    let buffersAfterSignal = 0;
    for (const chunk of chunks) {
      if (chunk.arrivedAtMs < signalAtMs) continue;
      buffersAfterSignal += 1;
      const chunkMs = 1_000 * chunk.samples.length / captureRate;
      if (rmsDb(chunk.samples) <= quietDb) {
        if (quietRun === 0) {
          runStartMs = chunk.arrivedAtMs - chunkMs;
          // The speaker was already silent in the first buffer the microphone
          // delivered after the signal: the true latency is under one buffer.
          if (buffersAfterSignal === 1) firstBufferMutes += 1;
        }
        quietRun += chunkMs;
        if (quietRun >= 100) {
          muteAtMs = Math.max(0, runStartMs - signalAtMs);
          break;
        }
      } else quietRun = 0;
    }
    if (!Number.isNaN(muteAtMs)) latencies.push(muteAtMs);
    console.log(`  trial ${trial + 1}/${trials}: ${Number.isNaN(muteAtMs)
      ? `未观察到静音 (playing ${activeDb.toFixed(1)}dB, floor ${floorDb.toFixed(1)}dB)`
      : `${muteAtMs.toFixed(0)}ms (playing ${activeDb.toFixed(1)}dB → quiet <${quietDb.toFixed(1)}dB)`}`);
  }
  // The trials share one host, so it outlives the loop. Leaving it open holds the child's
  // stdin and the process never exits.
  await host.stop();

  return {
    scenario: "capture-to-mute",
    metrics: {
      trials,
      observed: latencies.length,
      invalidTrials: invalid.length,
      voiceProcessing: false,
      volume,
      // The endpoint delivers capture in ~100ms buffers, so that is the floor of this
      // measurement. Every trial that muted inside the first buffer is reported as such
      // rather than as a precise sub-buffer number the method cannot support.
      captureBufferMs,
      mutedWithinFirstBuffer: firstBufferMutes,
      captureToMuteP50Ms: percentile(latencies, 0.5),
      captureToMuteP95Ms: percentile(latencies, 0.95),
    },
  };
}

/**
 * Double-talk. The operator speaks on cue while far-end audio plays; the cue timeline is
 * the ground truth. A cue with no `speech.start` is a missed barge-in — the user talked and
 * the agent kept going. A `speech.start` outside every cue is the agent interrupting itself.
 */
/** A two-tone cue the operator can act on by ear, so the test does not depend on watching a terminal. */
function cueTone(): Float32Array {
  const toneMs = 120;
  const gapMs = 80;
  const tone = new Float32Array(playbackRate * (toneMs * 2 + gapMs) / 1_000);
  const toneSamples = playbackRate * toneMs / 1_000;
  const gapSamples = playbackRate * gapMs / 1_000;
  for (let index = 0; index < toneSamples; index += 1) {
    // A short raised-cosine fade keeps the tone from clicking, which would read as speech.
    const fade = Math.min(1, Math.min(index, toneSamples - index) / (playbackRate * 0.01));
    const value = 0.35 * fade * Math.sin(2 * Math.PI * 880 * index / playbackRate);
    tone[index] = value;
    tone[index + toneSamples + gapSamples] = value;
  }
  return tone;
}

/**
 * Double-talk: the operator speaks while far-end audio plays. A cue with no `speech.start`
 * is a missed barge-in — the user talked and the agent would have kept going.
 *
 * The cue is a tone rendered through the host's own playback path, not a terminal prompt.
 * That keeps the ground truth on the audio timeline (where the operator actually is) instead
 * of depending on how fast console output reaches a screen. The tone is part of the render
 * reference, so the canceller removes it like any other far-end audio; the window around it
 * is still excluded from scoring so that a residual tone cannot be mistaken for the operator.
 */
async function doubleTalk(farEnd: Float32Array, trials: number, scorer: BargeInScorer): Promise<ScenarioResult> {
  const speakMs = 2_500;
  const gapMs = 3_000;
  const leadInMs = 3_000;
  // The guard exists to discard the cue tone itself, not the operator. It reaches back
  // before the tone but only briefly past it: extending it into the speaking window would
  // throw away a fast operator's real `speech.start` and score it as a missed barge-in.
  const guardBeforeMs = 250;
  const guardAfterMs = 120;
  const tone = cueTone();
  const toneMs = 1_000 * tone.length / playbackRate;

  // Build the whole far-end stream up front, cues embedded. Every cue time is then a known
  // offset in the audio itself rather than a wall-clock guess made while the loop runs.
  const totalMs = leadInMs + trials * (toneMs + speakMs + gapMs);
  const stream = new Float32Array(Math.ceil(playbackRate * totalMs / 1_000));
  for (let index = 0; index < stream.length; index += 1) {
    stream[index] = farEnd[index % farEnd.length] as number;
  }
  const cues: Cue[] = [];
  const guards: { startMs: number; endMs: number }[] = [];
  let cursorMs = leadInMs;
  for (let trial = 0; trial < trials; trial += 1) {
    const offset = Math.round(playbackRate * cursorMs / 1_000);
    stream.set(tone, offset); // the tone replaces the far-end so it is unmistakable
    guards.push({ startMs: cursorMs - guardBeforeMs, endMs: cursorMs + toneMs + guardAfterMs });
    cues.push({ startMs: cursorMs + toneMs, endMs: cursorMs + toneMs + speakMs });
    cursorMs += toneMs + speakMs + gapMs;
  }

  console.log(`\n[double-talk] ${trials} 次提示，共 ${(totalMs / 1_000).toFixed(0)}s。`);
  console.log("  听到「哔-哔」两声就正常音量说一句话（任意内容，约 1-2 秒），其余时间保持安静。");
  console.log("  不用看屏幕。");
  await Bun.sleep(2_000);

  const host = await startHost(true);
  const playbackStartMs = performance.now();
  await playFarEnd(host, stream, 200);
  await Bun.sleep(800);
  const capture = await host.stop();

  // Put VAD detections on the same timeline as the cues. Capture sample 0 was recorded one
  // buffer before the first buffer arrived, and playback of stream offset X is heard at
  // playbackStart + X because the player drains in real time behind a fixed lead.
  const first = host.chunks[0];
  const firstBufferMs = first ? 1_000 * first.samples.length / captureRate : 0;
  const captureOriginMs = (first ? first.arrivedAtMs - firstBufferMs : playbackStartMs) - playbackStartMs;
  const detections = (await scorer.detect(capture)).confirmed.map(value => value + captureOriginMs);

  const scored = detections.filter(value => !guards.some(guard => value >= guard.startMs && value <= guard.endMs));
  const score = scoreDoubleTalk(cues, scored);
  return {
    scenario: "double-talk",
    capture,
    cues,
    guards,
    captureOriginMs,
    metrics: {
      cues: cues.length,
      detected: score.detected,
      missedBargeIns: score.missed,
      missedBargeInRate: cues.length > 0 ? score.missed / cues.length : 0,
      falseBargeIns: score.falseBargeIns,
      guardedDetections: detections.length - scored.length,
      // Latency is relative to the end of the cue tone; playback and capture buffering put
      // roughly +/-100ms of timing uncertainty on it, so it is not a precise figure.
      detectionLatencyP50Ms: percentile(score.latenciesMs, 0.5),
      detectionLatencyP95Ms: percentile(score.latenciesMs, 0.95),
    },
  };
}

export type GateStatus = "pass" | "fail" | "incomplete";

export const syntheticSource = "synthetic:v1";

/**
 * Turn the metrics into a verdict. Only one acceptance criterion is actually specified for
 * this phase — docs/duplex-audio-architecture.md targets "no self-interruption" — so that is
 * the only thing gated on. Missed barge-in has no stated target yet, so it is reported and
 * not judged; inventing a number here would manufacture a spec the product never agreed to.
 *
 * A run that did not gather the evidence is `incomplete`, never `pass`. Silence about a
 * missing measurement is how an unmeasured endpoint gets declared supported.
 */
export function evaluateGate(
  results: ScenarioResult[],
  farEndSource: string,
  quick = false,
): { status: GateStatus; reasons: string[] } {
  const find = (scenario: string): Record<string, number | string | boolean> | undefined =>
    results.find(result => result.scenario === scenario)?.metrics;
  const reasons: string[] = [];
  let failed = false;

  // A few seconds of echo cannot estimate a rate of roughly one event per minute. Quick runs
  // exist to catch a broken endpoint fast; letting one certify a route would be the whole
  // point of the gate defeated by its own convenience flag.
  if (quick) reasons.push("this was a --quick smoke run; it is too short to establish a rate");

  // The synthetic stimulus keeps the harness runnable without an engine, but cancellation
  // and an energy VAD both behave differently on real speech spectra and dynamics. It can
  // diagnose; it cannot certify a route.
  if (farEndSource === syntheticSource) {
    reasons.push("the far-end was synthetic; a supported-route claim needs real speech via --far-end");
  }

  const selfInterruption = find("self-interruption");
  if (!selfInterruption) reasons.push("self-interruption was not measured");
  else {
    const rate = selfInterruption.echoAttributablePerMinute as number;
    if (Number.isNaN(rate)) reasons.push("self-interruption has no silent baseline to subtract");
    else if (rate > 0) {
      failed = true;
      reasons.push(`self-interruption ${rate.toFixed(2)}/min; the target for this phase is none`);
    }
  }

  const mute = find("capture-to-mute");
  if (!mute) reasons.push("capture-to-mute was not measured");
  else if ((mute.observed as number) < (mute.trials as number) || (mute.invalidTrials as number) > 0) {
    reasons.push(`capture-to-mute observed ${mute.observed}/${mute.trials} trials with ${mute.invalidTrials} invalid`);
  }

  const doubleTalk = find("double-talk");
  if (!doubleTalk) reasons.push("double-talk was not measured");

  if (failed) return { status: "fail", reasons };
  return reasons.length > 0 ? { status: "incomplete", reasons } : { status: "pass", reasons };
}

async function loadFarEnd(path: string | undefined): Promise<{ samples: Float32Array; source: string }> {
  if (!path) return { samples: syntheticFarEnd(30), source: syntheticSource };
  const wav = readWav(await Bun.file(path).arrayBuffer());
  if (wav.sampleRate !== playbackRate) {
    fail(`aec-measure: --far-end must be ${playbackRate}Hz mono; ${path} is ${wav.sampleRate}Hz`);
  }
  // Synthesized speech opens and closes with near-silence. Left in, a scenario that samples
  // a fixed window can land entirely inside it and measure a speaker that was never playing.
  const samples = trimEdgeSilence(wav.samples, wav.sampleRate);
  if (samples.length === 0) fail(`aec-measure: ${path} contains no speech`);
  return { samples, source: path };
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") fail("speaker-mode AEC measurement requires macOS");
  const options = parse(process.argv.slice(2));
  const farEnd = await loadFarEnd(options.farEnd);
  const scorer = makeScorer(options.vad);
  // Level scenarios can run on a slice; capture-to-mute and double-talk build their own
  // streams. A shorter slice trades statistical power for wall clock, which is why a run
  // that used one cannot pass the gate.
  const sample = options.seconds === undefined
    ? farEnd.samples
    : farEnd.samples.subarray(0, Math.min(farEnd.samples.length, Math.round(playbackRate * options.seconds)));
  const route = await audioRoute();
  const restoreVolume = await systemVolume();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(options.outDir, stamp);
  mkdirSync(outDir, { recursive: true });

  console.log(`speaker-mode AEC measurement (VAD: ${options.vad})`);
  console.log(`  输出路由: ${route.output}`);
  console.log(`  输入路由: ${route.input}`);
  console.log(`  远端素材: ${farEnd.source} (用 ${(sample.length / playbackRate).toFixed(1)}s${options.quick ? "，quick 冒烟模式" : ""})`);
  console.log(`  系统音量: ${options.volume} (测量期间固定，结束后恢复为 ${restoreVolume})`);
  console.log(`  报告目录: ${outDir}`);

  const results: ScenarioResult[] = [];
  try {
    // Every echo number is an A/B against this one volume. Changing it mid-run
    // would make the bypass reference incomparable and the ERLE meaningless.
    await setSystemVolume(options.volume);

    let floorDb: number | undefined;
    let baselineFalsePerMinute = Number.NaN;
    if (options.scenarios.includes("noise-floor")) {
      // The floor does not involve the canceller, so a quick run keeps it short; the full
      // run matches the echo duration so the false-trigger baselines are comparable.
      const result = await noiseFloor(options.quick ? 3_000 : 1_000 * sample.length / playbackRate, scorer);
      floorDb = result.metrics.noiseFloorDb as number;
      baselineFalsePerMinute = result.metrics.falseBargeInsPerMinute as number;
      results.push(result);
    }
    if (options.scenarios.includes("echo")) {
      // Convergence with dense speech material takes ~5s (measured); a short window must
      // sit entirely past it or it reports the convergence tail as leakage.
      const processed = await echo(sample, true, scorer, options.quick ? 5_000 : aecWarmupMs);
      // The bypass arm exists for the attenuation A/B, a certification number. A smoke run
      // answers "is echo still being cancelled at all", which the processed arm alone does
      // against the noise floor — so quick skips the second 40s-class playback entirely.
      const bypass = options.quick ? undefined : await echo(sample, false, scorer);
      results.push(processed);
      if (bypass) results.push(bypass);
      const processedDb = processed.metrics.echoLevelDb as number;
      // Voice Processing applies AEC, noise suppression, and automatic gain control as one
      // unit, and none of them can be switched off individually. So this A/B measures the
      // attenuation of the whole voice-processing path, not the echo canceller in isolation:
      // part of the reduction may be suppression or gain, not adaptive cancellation. It is
      // the number that decides whether the product self-interrupts, which is what the gate
      // is about, but it must not be published as an AEC-only ERLE.
      //
      // Once the residual reaches the noise floor the measurement cannot see any further
      // attenuation, so it becomes a lower bound. Without a measured floor there is nothing
      // to make that judgement against, and the harness says so rather than inventing one.
      const atFloor = floorDb === undefined ? undefined : processedDb <= floorDb + 3;
      if (bypass) {
        const bypassDb = bypass.metrics.echoLevelDb as number;
        results.push({
          scenario: "voice-processing-attenuation",
          metrics: {
            attenuationDb: bypassDb - processedDb,
            bypassEchoDb: bypassDb,
            residualEchoDb: processedDb,
            noiseFloorDb: floorDb ?? Number.NaN,
            residualAtNoiseFloor: atFloor ?? false,
            isAecOnlyErle: false,
            note: atFloor === undefined
              ? "no noise floor was measured in this run; whether the residual is floor-limited is unknown"
              : atFloor
                ? "whole voice-processing path (AEC+NS+AGC); residual sits at the noise floor, so the true attenuation is at least this value"
                : "whole voice-processing path (AEC+NS+AGC); residual is above the noise floor, so this is a direct measurement",
          },
        });
      }
      // The energy VAD fires on ambient noise on its own. Only the excess over the silent
      // baseline is attributable to echo leaking through the canceller.
      //
      // "Barge-ins" here are confirmed ones — the provisional policy in `listen` only stops
      // playback after minSpeechMs of voiced audio, so this counts what the product would
      // actually act on. It remains a rate under continuous playback: in production the
      // first confirmed trigger stops the speaker, so read it as "how often a minute of
      // agent speech would be killed by its own echo".
      const echoPerMinute = processed.metrics.falseBargeInsPerMinute as number;
      results.push({
        scenario: "self-interruption",
        metrics: {
          withPlaybackPerMinute: echoPerMinute,
          silentBaselinePerMinute: baselineFalsePerMinute,
          echoAttributablePerMinute: Number.isNaN(baselineFalsePerMinute)
            ? Number.NaN
            : Math.max(0, echoPerMinute - baselineFalsePerMinute),
          rawVadStartsPerMinute: (processed.metrics.rawVadStarts as number) * 60
            / (processed.metrics.capturedSeconds as number),
          ...(bypass ? { bypassPerMinute: bypass.metrics.falseBargeInsPerMinute as number } : {}),
          note: "confirmed barge-in rate under continuous playback; production stops playback on the first one",
        },
      });
    }
    if (options.scenarios.includes("capture-to-mute")) {
      results.push(await captureToMute(options.trials, Math.max(options.volume, 70)));
      await setSystemVolume(options.volume);
    }
    if (options.scenarios.includes("double-talk")) {
      const result = await doubleTalk(farEnd.samples, options.trials, scorer);
      results.push(result);
      const echoCapture = results.find(value => value.scenario === "echo")?.capture;
      // The sweep varies the energy detector's RMS threshold; silero has no such knob, its
      // probability hysteresis is fixed by the model's calibration.
      if (echoCapture && options.vad === "energy") results.push(...thresholdSweep(echoCapture, result));
    }
  } finally {
    await setSystemVolume(restoreVolume);
  }

  for (const result of results) {
    if (result.capture) writeFileSync(join(outDir, `${result.scenario}.wav`), writeWav(result.capture, captureRate));
  }
  const gate = evaluateGate(results, farEnd.source, options.quick);
  const report = {
    measuredAt: new Date().toISOString(),
    endpoint: "macos-voice-processing",
    route,
    volume: options.volume,
    farEnd: farEnd.source,
    farEndSeconds: sample.length / playbackRate,
    quick: options.quick,
    vad: options.vad === "energy"
      ? { kind: "energy", ...vadDefaults }
      : { kind: "silero", model: "silero-vad-v5.1.2", startProbability: 0.5, endProbability: 0.35,
          minSpeechMs: vadDefaults.minSpeechMs, silenceMs: vadDefaults.silenceMs },
    gate,
    scenarios: results.map(result => ({ scenario: result.scenario, metrics: result.metrics })),
  };
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n=== 结果 (${route.output}) ===`);
  for (const result of results) {
    console.log(`\n${result.scenario}`);
    for (const [key, value] of Object.entries(result.metrics)) {
      // toFixed(2) collapses 0.005 and 0.015 to the same "0.01"; keep small values legible.
      const shown = typeof value === "number"
        ? Number(Math.abs(value) < 1 ? value.toPrecision(3) : value.toFixed(2))
        : value;
      console.log(`  ${key}: ${shown}`);
    }
  }
  console.log(`\n=== 判定: ${gate.status.toUpperCase()} ===`);
  for (const reason of gate.reasons) console.log(`  - ${reason}`);
  console.log(`\n报告: ${join(outDir, "report.json")}`);

  // A gate that cannot fail is a report. Anything short of a clean pass exits non-zero so a
  // caller cannot mistake "the metrics were written" for "the endpoint is supported".
  if (gate.status !== "pass") process.exitCode = 1;
}

// Guarded: importing this module for its scoring helpers must not seize the audio device.
if (import.meta.main) void main();
