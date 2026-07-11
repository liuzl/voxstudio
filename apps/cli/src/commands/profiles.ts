import { TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";
import type { CliIo } from "../io";

export const profilesUsage = `usage: vox profiles {list,create,show,rm} ...

commands:
  list
  create ID --description TEXT --anchor-text TEXT --seed N
  show ID
  rm ID`;

export async function runProfiles(args: string[], config: VoxConfig, io: CliIo, fetch: Fetch = globalThis.fetch): Promise<number> {
  const operation = args.shift();
  const tts = new TtsClient(engine(config, "tts"), fetch);
  if (operation === "list") {
    if (args.length) throw new TypeError("profiles list: no arguments expected");
    const profiles = (await tts.listVoices()).filter(voice => "design_profile" in voice);
    for (const profile of profiles) io.out(JSON.stringify(profile));
    return 0;
  }
  if (operation === "show") {
    if (args.length !== 1) throw new TypeError("profiles show: one ID is required");
    io.out(JSON.stringify(await tts.getVoice(args[0] as string)));
    return 0;
  }
  if (operation === "rm") {
    if (args.length !== 1) throw new TypeError("profiles rm: one ID is required");
    await tts.deleteVoice(args[0] as string);
    io.out(`deleted ${args[0]}`);
    return 0;
  }
  if (operation !== "create") throw new TypeError("profiles: expected list, create, show, or rm");
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
