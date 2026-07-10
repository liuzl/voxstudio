import { basename } from "node:path";
import { AsrClient, TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";
import {
  editText,
  readFileBlob,
  recordAudio,
  removeRecording,
} from "@voxstudio/platform-bun";
import type { CliIo } from "../io";

interface AddOptions {
  operation: "add";
  id: string;
  audio?: string;
  record?: number;
  device?: string;
  text?: string;
  language: string;
  edit: boolean;
  dryRun: boolean;
}

type VoiceOptions =
  | AddOptions
  | { operation: "list" }
  | { operation: "show" | "rm"; id: string };

export interface VoicePlatform {
  editText(text: string): Promise<string>;
  recordAudio(duration: number, device: string | undefined, status: (message: string) => void): Promise<string>;
  removeRecording(path: string): Promise<void>;
}

const defaultPlatform: VoicePlatform = { editText, recordAudio, removeRecording };

export const voicesUsage = `usage: vox voices {list,add,show,rm} ...

Manage named voices.

commands:
  list                         list registered voices
  add ID --audio PATH          register from an audio file
  add ID --record [SECONDS]    register from microphone input
  show ID                      show one voice
  rm ID                        delete one voice

add options:
  --device NAME       ffmpeg input device (only with --record)
  --text TEXT         reference transcript; omitted uses ASR
  --language LANG     ASR language (default: auto)
  --edit              edit transcript with $VISUAL or $EDITOR
  --dry-run           print transcript without registering`;

function value(args: string[], index: number, option: string): string {
  const result = args[index];
  if (!result) throw new TypeError(`voices: ${option} requires a value`);
  return result;
}

function parseAdd(args: string[]): AddOptions {
  let id: string | undefined;
  let audio: string | undefined;
  let record: number | undefined;
  let device: string | undefined;
  let text: string | undefined;
  let language = "auto";
  let edit = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--audio") audio = value(args, ++index, arg);
    else if (arg === "--record") {
      const candidate = args[index + 1];
      if (candidate !== undefined && (!candidate.startsWith("-") || Number.isFinite(Number(candidate)))) {
        record = Number(candidate);
        if (!Number.isFinite(record)) throw new TypeError("voices: --record must be a number");
        index += 1;
      } else record = 0;
    } else if (arg === "--device") device = value(args, ++index, arg);
    else if (arg === "--text") text = value(args, ++index, arg);
    else if (arg === "--language") language = value(args, ++index, arg);
    else if (arg === "--edit") edit = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("-")) throw new TypeError(`voices: unknown option ${arg}`);
    else if (id === undefined) id = arg;
    else throw new TypeError("voices add: expected one voice ID");
  }
  if (!id) throw new TypeError("voices add: voice ID is required");
  if ((audio === undefined) === (record === undefined)) {
    throw new TypeError("voices add: exactly one of --audio or --record is required");
  }
  if (device !== undefined && record === undefined) throw new TypeError("--device requires --record");
  if (record !== undefined && record < 0) throw new TypeError("--record duration must be non-negative");
  return {
    operation: "add", id, language, edit, dryRun,
    ...(audio === undefined ? {} : { audio }),
    ...(record === undefined ? {} : { record }),
    ...(device === undefined ? {} : { device }),
    ...(text === undefined ? {} : { text }),
  };
}

function parse(args: string[]): VoiceOptions {
  const operation = args.shift();
  if (operation === "list") {
    if (args.length) throw new TypeError("voices list: no arguments expected");
    return { operation };
  }
  if (operation === "add") return parseAdd(args);
  if (operation === "show" || operation === "rm") {
    if (args.length !== 1) throw new TypeError(`voices ${operation}: one voice ID is required`);
    return { operation, id: args[0] as string };
  }
  throw new TypeError("voices: expected list, add, show, or rm");
}

export async function runVoices(
  args: string[],
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch = globalThis.fetch,
  platform: VoicePlatform = defaultPlatform,
): Promise<number> {
  const options = parse([...args]);
  if (options.operation === "add") {
    let recording: string | undefined;
    let completed = false;
    try {
      recording = options.record === undefined
        ? undefined
        : await platform.recordAudio(options.record, options.device, io.err);
      const audioPath = recording ?? options.audio as string;
      let audio: Blob | undefined;
      let transcript: string;
      if (options.text !== undefined) transcript = options.text.trim();
      else {
        audio = await readFileBlob(audioPath);
        const result = await new AsrClient(engine(config, "asr"), fetch)
          .transcribe(audio, basename(audioPath), options.language);
        transcript = result.text.trim();
        io.err(`ASR transcript (${result.lang ?? "unknown"}): ${transcript}`);
      }
      if (options.edit) transcript = await platform.editText(transcript);
      if (!transcript) throw new TypeError("reference transcript is empty");
      if (options.dryRun) io.out(transcript);
      else {
        audio ??= await readFileBlob(audioPath);
        const voice = await new TtsClient(engine(config, "tts"), fetch)
          .createVoice(options.id, transcript, audio, basename(audioPath));
        io.out(JSON.stringify(voice));
      }
      completed = true;
      return 0;
    } finally {
      if (recording) {
        if (completed) await platform.removeRecording(recording);
        else io.err(`recording kept at ${recording}`);
      }
    }
  }

  const tts = new TtsClient(engine(config, "tts"), fetch);
  if (options.operation === "list") {
    const voices = await tts.listVoices();
    if (!voices.length) io.out("(no registered voices)");
    for (const voice of voices) {
      io.out(`${voice.id.padEnd(20)} ${voice.prompt_audio_length ?? "?"}s  ${voice.created_at ?? ""}`);
    }
  } else if (options.operation === "show") {
    io.out(JSON.stringify(await tts.getVoice(options.id)));
  } else {
    await tts.deleteVoice(options.id);
    io.out(`deleted ${options.id}`);
  }
  return 0;
}
