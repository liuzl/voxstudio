import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { readWav } from "@voxstudio/audio";

export type HostSystem = "Darwin" | "Linux" | "Windows";

export interface CapturedAudioFrame {
  samples: Float32Array;
  sampleRate: number;
  timestampMs: number;
}

export interface PcmCapture {
  frames: AsyncIterable<CapturedAudioFrame>;
  close(): Promise<void>;
}

function hostSystem(): HostSystem {
  if (process.platform === "darwin") return "Darwin";
  if (process.platform === "linux") return "Linux";
  if (process.platform === "win32") return "Windows";
  throw new TypeError(`microphone recording is not supported on ${process.platform}`);
}

export function recordCommand(
  output: string,
  duration: number,
  device?: string,
  system: HostSystem = hostSystem(),
): string[] {
  const command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"];
  if (system === "Darwin") {
    command.push("-f", "avfoundation", "-i", `:${(device ?? "default").replace(/^:/, "")}`);
  } else if (system === "Linux") {
    command.push("-f", "pulse", "-i", device ?? "default");
  } else {
    command.push("-f", "dshow", "-i", `audio=${device ?? "default"}`);
  }
  if (duration > 0) command.push("-t", String(duration));
  command.push("-ac", "1", "-ar", "16000", output);
  return command;
}

export function captureCommand(
  device?: string,
  sampleRate = 16_000,
  system: HostSystem = hostSystem(),
): string[] {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new TypeError("capture sampleRate must be a positive integer");
  }
  const command = ["ffmpeg", "-hide_banner", "-loglevel", "error"];
  if (system === "Darwin") {
    command.push("-f", "avfoundation", "-i", `:${(device ?? "default").replace(/^:/, "")}`);
  } else if (system === "Linux") {
    command.push("-f", "pulse", "-i", device ?? "default");
  } else {
    command.push("-f", "dshow", "-i", `audio=${device ?? "default"}`);
  }
  command.push("-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "pipe:1");
  return command;
}

export function decodePcm16le(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 2 !== 0) throw new TypeError("PCM16 input must have an even byte length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return samples;
}

function appendBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.length === 0) return right;
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

export async function capturePcm(
  device?: string,
  sampleRate = 16_000,
  frameSamples = 320,
): Promise<PcmCapture> {
  if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
    throw new TypeError("capture frameSamples must be a positive integer");
  }
  if (!Bun.which("ffmpeg")) {
    throw new TypeError("ffmpeg not found on PATH; install ffmpeg to use microphone capture");
  }
  const child = Bun.spawn(captureCommand(device, sampleRate), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  if (!child.stdout || typeof child.stdout === "number") {
    await child.exited;
    throw new TypeError("ffmpeg capture did not expose stdout");
  }
  const stdout = child.stdout;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (child.stdin && typeof child.stdin !== "number") {
      child.stdin.write("q\n");
      await child.stdin.end();
    }
    await child.exited;
  };
  const frames = (async function* (): AsyncGenerator<CapturedAudioFrame> {
    const reader = stdout.getReader();
    const frameBytes = frameSamples * 2;
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let timestampMs = Date.now();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        pending = appendBytes(pending, result.value);
        while (pending.length >= frameBytes) {
          const frame = pending.slice(0, frameBytes);
          pending = pending.slice(frameBytes);
          yield { samples: decodePcm16le(frame), sampleRate, timestampMs };
          timestampMs += frameSamples * 1_000 / sampleRate;
        }
      }
      if (!closed) {
        const exitCode = await child.exited;
        if (exitCode !== 0) throw new TypeError(`ffmpeg capture exited with status ${exitCode}`);
      }
    } finally {
      reader.releaseLock();
      await close();
    }
  })();
  return { frames, close };
}

export function hasAudibleAudio(samples: Float32Array, threshold = 0.001): boolean {
  return samples.some(sample => Math.abs(sample) >= threshold);
}

export async function recordAudio(
  duration: number,
  device?: string,
  status: (message: string) => void = () => {},
): Promise<string> {
  if (!Number.isFinite(duration) || duration < 0) {
    throw new TypeError("--record duration must be a non-negative number");
  }
  if (!Bun.which("ffmpeg")) {
    throw new TypeError("ffmpeg not found on PATH; install ffmpeg to use --record");
  }

  const directory = await mkdtemp(join(tmpdir(), "voxstudio-voice-"));
  const output = join(directory, "recording.wav");
  const command = recordCommand(output, duration, device);
  try {
    const child = Bun.spawn(command, {
      stdin: duration > 0 ? "ignore" : "pipe",
      stdout: "ignore",
      stderr: "inherit",
    });
    if (duration > 0) {
      status(`recording for ${duration}s...`);
    } else {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        await terminal.question("recording... press Enter to stop\n").catch(() => "");
      } finally {
        terminal.close();
        if (child.stdin && typeof child.stdin !== "number") {
          child.stdin.write("q\n");
          await child.stdin.end();
        }
      }
    }
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new TypeError(`ffmpeg exited with status ${exitCode}`);
    if ((await stat(output)).size <= 44) throw new TypeError("recording produced no audio");
    if (!hasAudibleAudio(readWav(await readFile(output)).samples)) {
      throw new TypeError("recording is silent; select a microphone with --device");
    }
    status(`recorded ${output}`);
    return output;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new TypeError(`recording failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function removeRecording(path: string): Promise<void> {
  await rm(dirname(path), { recursive: true, force: true });
}

export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | "\"" | null = null;
  let started = false;
  const input = command.trim();
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] as string;
    if (character === "\\" && quote !== "'") {
      const next = input[index + 1];
      if (next !== undefined && (/\s/.test(next) || next === "\\" || next === quote || (!quote && (next === "'" || next === "\"")))) {
        word += next;
        index += 1;
      } else {
        word += character;
      }
      started = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else word += character;
      started = true;
    } else if (character === "'" || character === "\"") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) throw new TypeError("editor command has unmatched quoting");
  if (started) words.push(word);
  return words;
}

export async function editText(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const editor = env.VISUAL || env.EDITOR;
  if (!editor) throw new TypeError("--edit requires $VISUAL or $EDITOR");
  const command = splitCommand(editor);
  if (!command.length) throw new TypeError("editor command is empty");
  const directory = await mkdtemp(join(tmpdir(), "voxstudio-edit-"));
  const path = join(directory, "transcript.txt");
  try {
    await writeFile(path, text && !text.endsWith("\n") ? `${text}\n` : text, "utf8");
    const child = Bun.spawn([...command, path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new TypeError(`editor exited with status ${exitCode}`);
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    throw new TypeError(`editor failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
