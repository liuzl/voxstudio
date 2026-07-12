import { basename } from "node:path";
import { AsrClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";
import { readFileBlob, recordAudio, removeRecording } from "@voxstudio/platform-bun";
import { runChatPrompt } from "./chat";
import type { CliIo } from "../io";

export const replyUsage = `usage: vox reply (AUDIO | --record [SECONDS]) [--device NAME] [--language LANG]
                 [--system TEXT] [--max-tokens N] [--voice VOICE] [--play] [-o OUTPUT]

Transcribe one audio file or microphone recording, generate one LLM reply, and synthesize the reply to WAV.`;

export interface ReplyPlatform {
  recordAudio(duration: number, device: string | undefined, status: (message: string) => void): Promise<string>;
  removeRecording(path: string): Promise<void>;
}

const defaultPlatform: ReplyPlatform = { recordAudio, removeRecording };

function required(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new TypeError(`reply: ${option} requires a value`);
  return value;
}

function parse(args: string[]): { audio?: string; record?: number; device?: string; language: string; chatArgs: string[] } {
  let audio: string | undefined;
  let record: number | undefined;
  let device: string | undefined;
  let language = "auto";
  const chatArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--language") language = required(args, ++index, arg);
    else if (arg === "--record") {
      const candidate = args[index + 1];
      if (candidate !== undefined && (!candidate.startsWith("-") || Number.isFinite(Number(candidate)))) {
        record = Number(candidate);
        if (!Number.isFinite(record) || record < 0) throw new TypeError("reply: --record must be a non-negative number");
        index += 1;
      } else record = 0;
    } else if (arg === "--device") device = required(args, ++index, arg);
    else if (arg === "--play") chatArgs.push(arg);
    else if (["--system", "--max-tokens", "--voice", "-o", "--output"].includes(arg)) {
      chatArgs.push(arg, required(args, ++index, arg));
    } else if (arg.startsWith("-")) throw new TypeError(`reply: unknown option ${arg}`);
    else if (audio === undefined) audio = arg;
    else throw new TypeError("reply: expected one audio file");
  }
  if ((audio === undefined) === (record === undefined)) {
    throw new TypeError("reply: exactly one of AUDIO or --record is required");
  }
  if (device !== undefined && record === undefined) throw new TypeError("reply: --device requires --record");
  return {
    language, chatArgs,
    ...(audio === undefined ? {} : { audio }),
    ...(record === undefined ? {} : { record }),
    ...(device === undefined ? {} : { device }),
  };
}

export async function runReply(
  args: string[],
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch = globalThis.fetch,
  platform: ReplyPlatform = defaultPlatform,
): Promise<number> {
  const options = parse(args);
  let recording: string | undefined;
  let completed = false;
  try {
    recording = options.record === undefined
      ? undefined
      : await platform.recordAudio(options.record, options.device, io.err);
    const audioPath = recording ?? options.audio as string;
    const audio = await readFileBlob(audioPath);
    const transcript = (await new AsrClient(engine(config, "asr"), fetch).transcribe(
      audio, basename(audioPath), options.language,
    )).text.trim();
    if (!transcript) throw new TypeError("reply: ASR returned empty text");
    io.out(`transcript: ${transcript}`);
    const exitCode = await runChatPrompt(transcript, [...options.chatArgs, "--speak"], config, io, fetch);
    completed = exitCode === 0;
    return exitCode;
  } finally {
    if (recording) {
      if (completed) await platform.removeRecording(recording);
      else io.err(`recording kept at ${recording}`);
    }
  }
}
