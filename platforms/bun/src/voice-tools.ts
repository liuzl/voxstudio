import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

export type HostSystem = "Darwin" | "Linux" | "Windows";

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
    command.push("-f", "avfoundation", "-i", `:${(device ?? "0").replace(/^:/, "")}`);
  } else if (system === "Linux") {
    command.push("-f", "pulse", "-i", device ?? "default");
  } else {
    command.push("-f", "dshow", "-i", `audio=${device ?? "default"}`);
  }
  if (duration > 0) command.push("-t", String(duration));
  command.push("-ac", "1", "-ar", "16000", output);
  return command;
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
