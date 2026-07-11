import { AsrClient, type Fetch } from "@voxstudio/clients";
import type { TranscriptionSegment, VoxConfig } from "@voxstudio/contracts";
import { engine } from "@voxstudio/config";
import { readFileBlob } from "@voxstudio/platform-bun";
import type { CliIo } from "../io";

interface TranscribeArgs {
  audio: string;
  language: string;
  format: "text" | "json" | "srt";
  mode: "realtime" | "longform";
}

function srtTime(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function renderSrt(segments: TranscriptionSegment[]): string {
  return segments.map((segment, index) => [
    String(index + 1),
    `${srtTime(segment.start)} --> ${srtTime(segment.end)}`,
    `${segment.speaker ? `[${segment.speaker}] ` : ""}${segment.text}`,
  ].join("\n")).join("\n\n");
}

function parse(args: string[]): TranscribeArgs {
  let audio: string | undefined;
  let language = "auto";
  let format: "text" | "json" | "srt" = "text";
  let mode: "realtime" | "longform" = "realtime";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--language") {
      language = args[++index] as string;
      if (!language) throw new TypeError("transcribe: --language requires a value");
    } else if (arg === "--json") {
      if (format !== "text") throw new TypeError("transcribe: --json cannot be combined with --format");
      format = "json";
    } else if (arg === "--format") {
      const value = args[++index];
      if (value !== "text" && value !== "json" && value !== "srt") {
        throw new TypeError("transcribe: --format must be text, json, or srt");
      }
      if (format !== "text") throw new TypeError("transcribe: --format cannot be combined with --json");
      format = value;
    } else if (arg === "--mode") {
      const value = args[++index];
      if (value !== "realtime" && value !== "longform") {
        throw new TypeError("transcribe: --mode must be realtime or longform");
      }
      mode = value;
    } else if (arg.startsWith("-")) {
      throw new TypeError(`transcribe: unknown option ${arg}`);
    } else if (audio === undefined) {
      audio = arg;
    } else {
      throw new TypeError("transcribe: expected one audio file");
    }
  }
  if (!audio) throw new TypeError("transcribe: audio file is required");
  if (format === "srt" && mode !== "longform") {
    throw new TypeError("transcribe: --format srt requires --mode longform");
  }
  return { audio, language, format, mode };
}

export async function runTranscribe(
  args: string[],
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch = globalThis.fetch,
): Promise<number> {
  const options = parse(args);
  const audio = await readFileBlob(options.audio);
  const profile = options.mode === "longform" ? "asr_longform" : "asr";
  const asr = new AsrClient(engine(config, profile), fetch);
  const result = await asr.transcribe(
    audio,
    options.audio.split(/[\\/]/).pop() ?? "audio",
    options.language,
    { responseFormat: options.mode === "longform" ? "verbose_json" : "json" },
  );
  if (options.format === "json") io.out(JSON.stringify(result));
  else if (options.format === "srt") {
    if (!result.segments?.length) throw new Error("transcribe: longform engine returned no segments for SRT");
    io.out(renderSrt(result.segments));
  } else io.out(result.text);
  return 0;
}
