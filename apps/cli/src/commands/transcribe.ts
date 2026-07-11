import { AsrClient, type Fetch } from "@voxstudio/clients";
import type { TranscriptionSegment, VoxConfig } from "@voxstudio/contracts";
import { engine } from "@voxstudio/config";
import { readFileBlob } from "@voxstudio/platform-bun";
import type { CliIo } from "../io";

interface TranscribeArgs {
  audio: string;
  language: string;
  format: "text" | "json" | "srt" | "ass";
  mode: "realtime" | "longform";
  maxNewTokens?: number;
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

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const wholeSeconds = Math.floor((centiseconds % 6_000) / 100);
  const cents = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(cents).padStart(2, "0")}`;
}

function renderAss(segments: TranscriptionSegment[]): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,60,60,36,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];
  const events = segments.map((segment) => {
    const prefix = segment.speaker ? `[${segment.speaker}] ` : "";
    const text = `${prefix}${segment.text}`.replaceAll("\n", "\\N").replaceAll("\r", "");
    return `Dialogue: 0,${assTime(segment.start)},${assTime(segment.end)},Default,,0,0,0,,${text}`;
  });
  return [...header, ...events].join("\n");
}

function parse(args: string[]): TranscribeArgs {
  let audio: string | undefined;
  let language = "auto";
  let format: "text" | "json" | "srt" | "ass" = "text";
  let mode: "realtime" | "longform" = "realtime";
  let maxNewTokens: number | undefined;
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
      if (value !== "text" && value !== "json" && value !== "srt" && value !== "ass") {
        throw new TypeError("transcribe: --format must be text, json, srt, or ass");
      }
      if (format !== "text") throw new TypeError("transcribe: --format cannot be combined with --json");
      format = value;
    } else if (arg === "--mode") {
      const value = args[++index];
      if (value !== "realtime" && value !== "longform") {
        throw new TypeError("transcribe: --mode must be realtime or longform");
      }
      mode = value;
    } else if (arg === "--max-new-tokens") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError("transcribe: --max-new-tokens must be a positive integer");
      }
      maxNewTokens = value;
    } else if (arg.startsWith("-")) {
      throw new TypeError(`transcribe: unknown option ${arg}`);
    } else if (audio === undefined) {
      audio = arg;
    } else {
      throw new TypeError("transcribe: expected one audio file");
    }
  }
  if (!audio) throw new TypeError("transcribe: audio file is required");
  if ((format === "srt" || format === "ass") && mode !== "longform") {
    throw new TypeError(`transcribe: --format ${format} requires --mode longform`);
  }
  if (maxNewTokens !== undefined && mode !== "longform") {
    throw new TypeError("transcribe: --max-new-tokens requires --mode longform");
  }
  return {
    audio,
    language,
    format,
    mode,
    ...(maxNewTokens === undefined ? {} : { maxNewTokens }),
  };
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
    {
      responseFormat: options.mode === "longform" ? "verbose_json" : "json",
      ...(options.maxNewTokens === undefined ? {} : { maxNewTokens: options.maxNewTokens }),
    },
  );
  if (options.format === "json") io.out(JSON.stringify(result));
  else if (options.format === "srt" || options.format === "ass") {
    if (!result.segments?.length) throw new Error(`transcribe: longform engine returned no segments for ${options.format.toUpperCase()}`);
    io.out(options.format === "srt" ? renderSrt(result.segments) : renderAss(result.segments));
  } else io.out(result.text);
  return 0;
}
