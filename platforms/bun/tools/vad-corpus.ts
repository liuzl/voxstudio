/**
 * The deterministic corpus pieces shared by the VAD A/B gate (measure-vad.ts) and
 * the silero regression tests: non-speech negatives are pure functions of their
 * parameters — no randomness, no files — so a false-confirm regression reproduces
 * exactly, anywhere.
 */

export const sampleRate = 16_000;
/** 20ms — the mic worklet's frame. */
export const frameSamples = 320;

/** Deterministic pseudo-noise in [-1, 1] (the classic sin-hash; no Math.random). */
function noise(index: number): number {
  const x = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
}

/** Keyboard-like transient train: 6ms decaying bursts every 70ms at the given peak. */
export function clickTrain(seconds: number, peak: number): Float32Array {
  const out = new Float32Array(seconds * sampleRate);
  for (let start = 0; start < out.length; start += Math.floor(0.07 * sampleRate)) {
    for (let index = 0; index < 0.006 * sampleRate && start + index < out.length; index += 1) {
      out[start + index] = peak * noise(start + index) * Math.exp(-index / 30);
    }
  }
  return out;
}

/** Steady broadband noise (fan / street) at the given RMS. */
export function steadyNoise(seconds: number, level: number): Float32Array {
  const out = new Float32Array(seconds * sampleRate);
  for (let index = 0; index < out.length; index += 1) out[index] = level * 1.73 * noise(index);
  return out;
}

/** Tonal hum with beat modulation (appliance-like) at the given RMS. */
export function hum(seconds: number, level: number): Float32Array {
  const out = new Float32Array(seconds * sampleRate);
  for (let index = 0; index < out.length; index += 1) {
    const t = index / sampleRate;
    out[index] = level * 1.41 * Math.sin(2 * Math.PI * 120 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
  }
  return out;
}

/** Linear-resample a decoded WAV to the corpus rate. */
export function synthesizeClip(wav: { samples: Float32Array; sampleRate: number }): Float32Array {
  if (wav.sampleRate === sampleRate) return wav.samples;
  const ratio = wav.sampleRate / sampleRate;
  const out = new Float32Array(Math.floor(wav.samples.length / ratio));
  for (let index = 0; index < out.length; index += 1) {
    const position = index * ratio;
    const low = Math.floor(position);
    const high = Math.min(low + 1, wav.samples.length - 1);
    out[index] = (wav.samples[low] as number) * (1 - (position - low)) + (wav.samples[high] as number) * (position - low);
  }
  return out;
}
