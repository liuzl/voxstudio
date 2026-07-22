// The VAD A/B gate: energy vs silero through the PRODUCT segmentation path
// (both segmenters, default options, 20ms frames), promoted from the 2026-07-22
// probe that quantified why silero is the default.
//
// What it measures:
//   - sensitivity on real speech (live TTS positives at 0 / −12 / −24 dB — the
//     −24 dB tier sits below the shared 0.01 RMS level floor and BOTH detectors
//     must miss it: the floor is the certified echo defense, not a defect);
//   - confirm latency on the positives both detectors hit;
//   - specificity on deterministic non-speech negatives (keyboard-like click
//     trains, steady broadband noise, appliance hum) — the differentiator: a
//     false confirm during playback kills the reply.
//
// PASS requires: silero hits every positive at or above the level floor, misses
// everything below it, confirms zero negatives, and its median confirm latency
// is within 50ms of energy's. Energy's false confirms are reported, not judged —
// it is the loud fallback, and its indifference to speech-likeness is exactly
// what this gate exists to show.
//
//   bun run measure:vad          (needs the live TTS engine for the positives)
import { EnergyVadSegmenter, SileroVadSegmenter, type VadSegmentEvent, type VadSegmenter } from "@voxstudio/duplex-session";
import { loadConfig, loadSileroVadModel } from "@voxstudio/platform-bun";
import { readWav } from "@voxstudio/audio";
import { synthesizeClip, clickTrain, steadyNoise, hum, frameSamples, sampleRate } from "./vad-corpus";

const config = await loadConfig();
const resolved = config.engines[config.roles.tts ?? "tts"];
if (!resolved) throw new Error("measure:vad needs a configured TTS engine for the speech positives");
const tts = resolved;

async function speech(text: string): Promise<Float32Array> {
  const response = await fetch(new URL("/v1/audio/speech", tts.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(tts.apiKey ? { authorization: `Bearer ${tts.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: tts.model, input: text, voice: config.ttsDefaults.voice, response_format: "wav" }),
  });
  if (!response.ok) throw new Error(`tts ${response.status}: ${await response.text()}`);
  return synthesizeClip(readWav(await response.arrayBuffer()));
}

function scaled(samples: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(samples.length);
  for (let index = 0; index < out.length; index += 1) out[index] = (samples[index] as number) * factor;
  return out;
}

function onsetOf(samples: Float32Array): number {
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index] as number) > 0.02) return 1_000 * index / sampleRate;
  }
  return 0;
}

interface ClipResult { confirmed: number; dropped: number; confirmLatencyMs?: number }

async function run(segmenter: VadSegmenter, samples: Float32Array, onsetMs?: number): Promise<ClipResult> {
  segmenter.reset();
  const result: ClipResult = { confirmed: 0, dropped: 0 };
  for (let offset = 0; offset < samples.length; offset += frameSamples) {
    const frame = samples.subarray(offset, Math.min(offset + frameSamples, samples.length));
    const events: VadSegmentEvent[] = await segmenter.push(frame, 1_000 * offset / sampleRate);
    for (const event of events) {
      if (event.type === "speech.confirmed") {
        result.confirmed += 1;
        if (onsetMs !== undefined && result.confirmLatencyMs === undefined) result.confirmLatencyMs = event.timestampMs - onsetMs;
      }
      if (event.type === "speech.dropped") result.dropped += 1;
    }
  }
  return result;
}

const texts = ["今天的部署一切顺利吗？", "帮我看看素材库还有多少空间。", "明天上午十点提醒我开会。"];
const synthetic = await Promise.all(texts.map(speech));

interface Clip { name: string; samples: Float32Array; tier: "audible" | "below_floor" | "negative"; onsetMs?: number }
const clips: Clip[] = [];
for (const [index, clean] of synthetic.entries()) {
  const onsetMs = onsetOf(clean);
  clips.push({ name: `synth-${index} 0dB`, samples: clean, tier: "audible", onsetMs });
  clips.push({ name: `synth-${index} -12dB`, samples: scaled(clean, 0.25), tier: "audible", onsetMs });
  clips.push({ name: `synth-${index} -24dB`, samples: scaled(clean, 0.063), tier: "below_floor", onsetMs });
}
const negativeSeconds = 30;
clips.push({ name: "clicks peak 0.30", samples: clickTrain(negativeSeconds, 0.3), tier: "negative" });
clips.push({ name: "clicks peak 0.10", samples: clickTrain(negativeSeconds, 0.1), tier: "negative" });
clips.push({ name: "steady noise rms 0.05", samples: steadyNoise(negativeSeconds, 0.05), tier: "negative" });
clips.push({ name: "steady noise rms 0.02", samples: steadyNoise(negativeSeconds, 0.02), tier: "negative" });
clips.push({ name: "hum 120Hz rms 0.05", samples: hum(negativeSeconds, 0.05), tier: "negative" });

const energy = new EnergyVadSegmenter({ sampleRate });
const silero = new SileroVadSegmenter({ model: await loadSileroVadModel(line => console.error(line)) });

const failures: string[] = [];
const latencies = { energy: [] as number[], silero: [] as number[] };
let energyFalse = 0;
let sileroFalse = 0;
let negativeMinutes = 0;

console.log("clip".padEnd(26), "| energy conf/drop lat".padEnd(24), "| silero conf/drop lat");
console.log("-".repeat(80));
for (const clip of clips) {
  const e = await run(energy, clip.samples, clip.onsetMs);
  const s = await run(silero, clip.samples, clip.onsetMs);
  const fmt = (r: ClipResult) => `${r.confirmed}/${r.dropped}${r.confirmLatencyMs !== undefined ? ` ${Math.round(r.confirmLatencyMs)}ms` : ""}`;
  console.log(clip.name.padEnd(26), "|", fmt(e).padEnd(22), "|", fmt(s));
  if (clip.tier === "audible") {
    if (s.confirmed === 0) failures.push(`${clip.name}: silero missed an audible positive`);
    if (e.confirmed > 0 && e.confirmLatencyMs !== undefined) latencies.energy.push(e.confirmLatencyMs);
    if (s.confirmed > 0 && s.confirmLatencyMs !== undefined) latencies.silero.push(s.confirmLatencyMs);
  } else if (clip.tier === "below_floor") {
    // The shared level floor is certified echo defense: a "hit" here means the
    // floor moved, which must be an explicit decision, never drift.
    if (s.confirmed > 0 || e.confirmed > 0) failures.push(`${clip.name}: a detector confirmed speech below the level floor`);
  } else {
    negativeMinutes += clip.samples.length / sampleRate / 60;
    energyFalse += e.confirmed;
    sileroFalse += s.confirmed;
    if (s.confirmed > 0) failures.push(`${clip.name}: silero confirmed non-speech`);
  }
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
const energyMedian = median(latencies.energy);
const sileroMedian = median(latencies.silero);
if (!(sileroMedian <= energyMedian + 50)) {
  failures.push(`silero median confirm latency ${Math.round(sileroMedian)}ms exceeds energy ${Math.round(energyMedian)}ms by more than 50ms`);
}

console.log("-".repeat(80));
console.log(`confirm latency median: energy ${Math.round(energyMedian)}ms, silero ${Math.round(sileroMedian)}ms`);
console.log(`false confirms over ${negativeMinutes.toFixed(1)} min of negatives: energy ${energyFalse} (${(energyFalse / negativeMinutes).toFixed(1)}/min), silero ${sileroFalse}`);
if (failures.length > 0) {
  console.log("FAIL");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log("PASS");
