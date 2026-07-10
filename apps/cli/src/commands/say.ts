import type { PcmAudio } from "@voxstudio/audio";
import { writeWav } from "@voxstudio/audio";
import { TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";
import { streamLong } from "@voxstudio/orchestration";
import {
  FfplaySink,
  readStdinText,
  readTextFile,
  TeeSink,
  WavFileSink,
  writeBytes,
} from "@voxstudio/platform-bun";
import { estSeconds, sanitizeForTts } from "@voxstudio/text";
import type { CliIo } from "../io";

interface SayArgs {
  text?: string;
  file?: string;
  output?: string;
  play: boolean;
  voice?: string;
  design?: string;
  cfgValue?: number;
  timesteps?: number;
  quiet: boolean;
}

function required(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new TypeError(`say: ${option} requires a value`);
  return value;
}

function floatValue(raw: string, option: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new TypeError(`say: ${option} must be a number`);
  return value;
}

function parse(args: string[]): SayArgs {
  const options: SayArgs = { play: false, quiet: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "-f" || arg === "--file") options.file = required(args, ++index, arg);
    else if (arg === "-o" || arg === "--output") options.output = required(args, ++index, arg);
    else if (arg === "--play") options.play = true;
    else if (arg === "--voice") options.voice = required(args, ++index, arg);
    else if (arg === "--design") options.design = required(args, ++index, arg);
    else if (arg === "--cfg") options.cfgValue = floatValue(required(args, ++index, arg), arg);
    else if (arg === "--timesteps") {
      const raw = required(args, ++index, arg);
      if (!/^[+-]?\d+$/.test(raw)) throw new TypeError("say: --timesteps must be an integer");
      options.timesteps = Number(raw);
    } else if (arg === "-q" || arg === "--quiet") options.quiet = true;
    else if (arg.startsWith("-") && arg !== "-") throw new TypeError(`say: unknown option ${arg}`);
    else if (options.text === undefined) options.text = arg;
    else throw new TypeError("say: expected one text argument");
  }
  if (options.output === undefined && !options.play) options.output = "-";
  return options;
}

function concatenate(pieces: PcmAudio[]): PcmAudio {
  if (!pieces.length) throw new TypeError("engine returned no audio");
  const sampleRate = pieces[0]?.sampleRate as number;
  const samples = new Float32Array(pieces.reduce((total, piece) => total + piece.samples.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    samples.set(piece.samples, offset);
    offset += piece.samples.length;
  }
  return { samples, sampleRate };
}

export async function runSay(
  args: string[],
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch = globalThis.fetch,
): Promise<number> {
  const options = parse(args);
  let text = options.file
    ? await readTextFile(options.file)
    : options.text && options.text !== "-" ? options.text : await readStdinText();
  if (!text.trim()) throw new TypeError("no text to speak");

  const sanitized = sanitizeForTts(text);
  text = sanitized.text;
  if (sanitized.dropped.length && !options.quiet) {
    io.err(`dropped ${sanitized.dropped.length} unspeakable character(s): ${[
      ...new Set(sanitized.dropped),
    ].sort().join("")}`);
  }
  let voice = options.voice;
  let promptPrefix: string | undefined;
  if (options.design) {
    promptPrefix = `(${options.design})`;
    voice = "design";
  }

  const toStdout = options.output === "-";
  const sink = new TeeSink(
    options.play ? new FfplaySink() : null,
    options.output && !toStdout ? new WavFileSink(options.output) : null,
  );
  const buffered: PcmAudio[] = [];
  const started = performance.now();
  let firstAudio: number | null = null;
  const tts = new TtsClient(engine(config, "tts"), fetch);
  try {
    for await (const piece of streamLong(tts, text, {
      chunking: config.chunking,
      ttsDefaults: config.ttsDefaults,
      ...(voice === undefined ? {} : { voice }),
      ...(options.cfgValue === undefined ? {} : { cfgValue: options.cfgValue }),
      ...(options.timesteps === undefined ? {} : { timesteps: options.timesteps }),
      ...(promptPrefix === undefined ? {} : { promptPrefix }),
      ...(options.quiet ? {} : {
        onChunk: (index: number, total: number, chunk: string) => {
          io.err(`  [${index + 1}/${total}] ${Array.from(chunk).length} chars, ~${estSeconds(chunk).toFixed(1)}s`);
        },
      }),
    })) {
      firstAudio ??= performance.now() - started;
      await sink.write(piece);
      if (toStdout) buffered.push(piece);
    }
  } finally {
    await sink.close();
  }

  if (toStdout) {
    const audio = concatenate(buffered);
    await writeBytes("-", writeWav(audio.samples, audio.sampleRate));
  } else if (!options.quiet && options.output) {
    io.err(`wrote ${options.output}`);
  }
  if (!options.quiet && firstAudio !== null) {
    io.err(`first audio after ${(firstAudio / 1000).toFixed(1)}s, done in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
  return 0;
}
