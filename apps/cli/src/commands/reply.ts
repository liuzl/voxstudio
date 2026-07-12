import { AsrClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";
import { readFileBlob } from "@voxstudio/platform-bun";
import { runChatPrompt } from "./chat";
import type { CliIo } from "../io";

export const replyUsage = `usage: vox reply AUDIO [--language LANG] [--system TEXT] [--max-tokens N]
                 [--voice VOICE] [-o OUTPUT]

Transcribe one audio file, generate one LLM reply, and synthesize the reply to WAV.`;

function required(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new TypeError(`reply: ${option} requires a value`);
  return value;
}

function parse(args: string[]): { audio: string; language: string; chatArgs: string[] } {
  let audio: string | undefined;
  let language = "auto";
  const chatArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--language") language = required(args, ++index, arg);
    else if (["--system", "--max-tokens", "--voice", "-o", "--output"].includes(arg)) {
      chatArgs.push(arg, required(args, ++index, arg));
    } else if (arg.startsWith("-")) throw new TypeError(`reply: unknown option ${arg}`);
    else if (audio === undefined) audio = arg;
    else throw new TypeError("reply: expected one audio file");
  }
  if (!audio) throw new TypeError("reply: audio file is required");
  return { audio, language, chatArgs };
}

export async function runReply(
  args: string[],
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch = globalThis.fetch,
): Promise<number> {
  const options = parse(args);
  const audio = await readFileBlob(options.audio);
  const transcript = (await new AsrClient(engine(config, "asr"), fetch).transcribe(
    audio,
    options.audio.split(/[\\/]/).pop() ?? "audio",
    options.language,
  )).text.trim();
  if (!transcript) throw new TypeError("reply: ASR returned empty text");
  io.out(`transcript: ${transcript}`);
  return runChatPrompt(transcript, [...options.chatArgs, "--speak"], config, io, fetch);
}
