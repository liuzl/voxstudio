import { LlmClient, TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { ChatMessage, VoxConfig } from "@voxstudio/contracts";
import { synthesizeLong } from "@voxstudio/orchestration";
import { readStdinText, writeBytes } from "@voxstudio/platform-bun";
import { sanitizeForTts } from "@voxstudio/text";
import type { CliIo } from "../io";

export const chatUsage = `usage: vox chat [PROMPT | -] [--system TEXT] [--max-tokens N]
                [--speak] [--voice VOICE] [-o OUTPUT]

Read a prompt from the argument or standard input, then run one LLM turn.`;

interface ChatArgs {
  prompt?: string;
  system?: string;
  maxTokens?: number;
  speak: boolean;
  output: string;
  voice?: string;
}

function required(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new TypeError(`chat: ${option} requires a value`);
  return value;
}

function parse(args: string[]): ChatArgs {
  const options: ChatArgs = { speak: false, output: "reply.wav" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--system") options.system = required(args, ++index, arg);
    else if (arg === "--max-tokens") {
      const raw = required(args, ++index, arg);
      if (!/^[+-]?\d+$/.test(raw)) throw new TypeError("chat: --max-tokens must be an integer");
      options.maxTokens = Number(raw);
    } else if (arg === "--speak") options.speak = true;
    else if (arg === "-o" || arg === "--output") options.output = required(args, ++index, arg);
    else if (arg === "--voice") options.voice = required(args, ++index, arg);
    else if (arg.startsWith("-") && arg !== "-") throw new TypeError(`chat: unknown option ${arg}`);
    else if (options.prompt === undefined) options.prompt = arg;
    else throw new TypeError("chat: expected one prompt");
  }
  return options;
}

export async function runChat(
  args: string[],
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch = globalThis.fetch,
): Promise<number> {
  const options = parse(args);
  const prompt = options.prompt && options.prompt !== "-" ? options.prompt : await readStdinText();
  return completeChat(prompt, options, config, io, fetch);
}

export async function runChatPrompt(
  prompt: string,
  args: string[],
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch = globalThis.fetch,
): Promise<number> {
  const options = parse(args);
  if (options.prompt !== undefined) throw new TypeError("chat: prompt must be supplied separately");
  return completeChat(prompt, options, config, io, fetch);
}

async function completeChat(
  prompt: string,
  options: ChatArgs,
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch,
): Promise<number> {
  const messages: ChatMessage[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  messages.push({ role: "user", content: prompt });

  const llm = new LlmClient(engine(config, "llm"), fetch);
  const reply = await llm.chat(messages, options.maxTokens);
  if (!reply.trim()) throw new TypeError("model returned empty content (try a larger --max-tokens)");
  io.out(reply);

  if (options.speak) {
    const sanitized = sanitizeForTts(reply);
    if (sanitized.dropped.length) {
      const unique = [...new Set(sanitized.dropped)].sort().join("");
      io.err(`dropped ${sanitized.dropped.length} unspeakable character(s): ${unique}`);
    }
    const tts = new TtsClient(engine(config, "tts"), fetch);
    const voice = options.voice ?? config.ttsDefaults.voice;
    const wav = await synthesizeLong(tts, sanitized.text, {
      chunking: config.chunking,
      ttsDefaults: config.ttsDefaults,
      voice,
      ...(voice === "clone" || voice === "design" ? {} : { prosodyPrompt: true }),
      continuationId: crypto.randomUUID(),
    });
    await writeBytes(options.output, wav);
    io.err(`wrote ${options.output} (${(wav.byteLength / 1e6).toFixed(1)} MB)`);
  }
  return 0;
}
