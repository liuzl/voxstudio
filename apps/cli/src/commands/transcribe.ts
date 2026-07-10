import { AsrClient, type Fetch } from "@voxstudio/clients";
import type { VoxConfig } from "@voxstudio/contracts";
import { engine } from "@voxstudio/config";
import { readFileBlob } from "@voxstudio/platform-bun";
import type { CliIo } from "../io";

interface TranscribeArgs {
  audio: string;
  language: string;
  json: boolean;
}

function parse(args: string[]): TranscribeArgs {
  let audio: string | undefined;
  let language = "auto";
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--language") {
      language = args[++index] as string;
      if (!language) throw new TypeError("transcribe: --language requires a value");
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new TypeError(`transcribe: unknown option ${arg}`);
    } else if (audio === undefined) {
      audio = arg;
    } else {
      throw new TypeError("transcribe: expected one audio file");
    }
  }
  if (!audio) throw new TypeError("transcribe: audio file is required");
  return { audio, language, json };
}

export async function runTranscribe(
  args: string[],
  config: VoxConfig,
  io: CliIo,
  fetch: Fetch = globalThis.fetch,
): Promise<number> {
  const options = parse(args);
  const audio = await readFileBlob(options.audio);
  const asr = new AsrClient(engine(config, "asr"), fetch);
  const result = await asr.transcribe(audio, options.audio.split(/[\\/]/).pop() ?? "audio", options.language);
  io.out(options.json ? JSON.stringify(result) : result.text);
  return 0;
}
