import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PcmAudio } from "@voxstudio/audio";
import type { PcmSink } from "./audio-sinks";
import type { CapturedAudioFrame, PcmCapture } from "./voice-tools";

const captureRate = 16_000;
const playbackRate = 48_000;
// Bun.spawn().kill() accepts a numeric POSIX signal. Passing the string
// "SIGUSR1" in Bun 1.3.2 sends signal 10 (SIGBUS) on macOS instead.
const clearPlaybackSignal = 30;

function hostPath(): string {
  return process.env.VOXSTUDIO_MACOS_AUDIO_HOST
    ?? join(process.cwd(), "platforms", "macos-audio", "dist", "vox-audio-host");
}

function decodeFloat32le(bytes: Uint8Array): Float32Array {
  const values = new Float32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < values.length; index += 1) values[index] = view.getFloat32(index * 4, true);
  return values;
}

export interface MacosAudioHost {
  capture: PcmCapture;
  player: PcmSink & { abort(): Promise<void> };
  close(): Promise<void>;
}

export async function startMacosAudioHost(): Promise<MacosAudioHost> {
  if (process.platform !== "darwin") throw new TypeError("speaker duplex is currently supported on macOS only");
  const executable = hostPath();
  if (!existsSync(executable)) {
    throw new TypeError(`macOS audio host not built; run ./platforms/macos-audio/build.sh or set VOXSTUDIO_MACOS_AUDIO_HOST`);
  }
  const child = Bun.spawn([executable], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  if (!child.stdin || typeof child.stdin === "number" || !child.stdout || typeof child.stdout === "number") {
    throw new TypeError("macOS audio host did not expose PCM streams");
  }
  const stdin = child.stdin;
  const stdout = child.stdout;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await stdin.end();
    const exitCode = await child.exited;
    // SIGINT from the terminal reaches both the CLI and its child process.
    // Treat the conventional signal exit code as a normal user shutdown.
    if (exitCode !== 0 && exitCode !== 130) {
      throw new TypeError(`macOS audio host exited with status ${exitCode}`);
    }
  };
  const frames = (async function* (): AsyncGenerator<CapturedAudioFrame> {
    const reader = stdout.getReader();
    const frameBytes = 320 * 4;
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let timestampMs = Date.now();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const bytes = new Uint8Array(pending.length + result.value.length);
        bytes.set(pending);
        bytes.set(result.value, pending.length);
        pending = bytes;
        while (pending.length >= frameBytes) {
          const frame = pending.slice(0, frameBytes);
          pending = pending.slice(frameBytes);
          yield { samples: decodeFloat32le(frame), sampleRate: captureRate, timestampMs };
          timestampMs += 20;
        }
      }
      if (!closed && await child.exited !== 0) throw new TypeError("macOS audio host stopped unexpectedly");
    } finally {
      reader.releaseLock();
    }
  })();
  const player: MacosAudioHost["player"] = {
    write: async (audio: PcmAudio) => {
      if (audio.sampleRate !== playbackRate) throw new TypeError(`speaker duplex requires ${playbackRate}Hz TTS audio`);
      await stdin.write(new Uint8Array(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength));
    },
    close: async () => {},
    abort: async () => { child.kill(clearPlaybackSignal); },
  };
  return { capture: { frames, close }, player, close };
}
