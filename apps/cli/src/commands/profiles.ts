import { TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";
import type { CliIo } from "../io";

export const profilesUsage = `usage: vox profiles create ID --description TEXT --anchor-text TEXT --seed N

Create a reusable Design Profile. Inspect or remove it with vox voices show/rm ID.`;

export async function runProfiles(args: string[], config: VoxConfig, io: CliIo, fetch: Fetch = globalThis.fetch): Promise<number> {
  if (args.shift() !== "create") throw new TypeError("profiles: expected create");
  const id = args.shift();
  let description: string | undefined, anchorText: string | undefined, seed: number | undefined;
  while (args.length) {
    const option = args.shift(); const value = args.shift();
    if (!value) throw new TypeError(`profiles: ${option} requires a value`);
    if (option === "--description") description = value;
    else if (option === "--anchor-text") anchorText = value;
    else if (option === "--seed" && /^[+-]?\d+$/.test(value)) seed = Number(value);
    else throw new TypeError(`profiles: unknown option ${option}`);
  }
  if (!id || !description || !anchorText || seed === undefined) throw new TypeError("profiles create: ID, --description, --anchor-text, and --seed are required");
  io.out(JSON.stringify(await new TtsClient(engine(config, "tts"), fetch).createDesignProfile({ id, description, anchor_text: anchorText, seed })));
  return 0;
}
