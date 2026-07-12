import { TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { DesignProfile, Voice, VoxConfig } from "@voxstudio/contracts";
import type { CliIo } from "../io";

export const profilesUsage = `usage: vox profiles {list,create,reproduce,verify,show,rm} ...

commands:
  list
  create ID --description TEXT --anchor-text TEXT --seed N [--cfg VALUE] [--timesteps N]
  reproduce SOURCE_ID NEW_ID
  verify SOURCE_ID TARGET_ID
  show ID
  rm ID

create options:
  --cfg VALUE         classifier-free guidance value
  --timesteps N       generation timesteps`;

type ProfileVoice = Voice & { design_profile: DesignProfile };

function requireProfile(voice: Voice): ProfileVoice {
  if (!voice.design_profile) throw new TypeError(`profiles: ${voice.id} is not a design profile`);
  return voice as ProfileVoice;
}

function reproducibilityRecord(voice: Voice) {
  const profile = requireProfile(voice);
  if (!profile.prompt_text) throw new TypeError(`profiles: ${profile.id} has no anchor text`);
  if (!profile.design_profile.audio_sha256) throw new TypeError(`profiles: ${profile.id} has no audio fingerprint`);
  if (!profile.design_profile.model_manifest_sha256) {
    throw new TypeError(`profiles: ${profile.id} has no model manifest fingerprint`);
  }
  return {
    prompt_text: profile.prompt_text,
    description: profile.design_profile.description,
    seed: profile.design_profile.seed,
    cfg_value: profile.design_profile.cfg_value,
    timesteps: profile.design_profile.timesteps,
    model: profile.design_profile.model,
    model_manifest_sha256: profile.design_profile.model_manifest_sha256,
    audio_sha256: profile.design_profile.audio_sha256,
  };
}

export async function runProfiles(args: string[], config: VoxConfig, io: CliIo, fetch: Fetch = globalThis.fetch): Promise<number> {
  const operation = args.shift();
  const tts = new TtsClient(engine(config, "tts"), fetch);
  if (operation === "list") {
    if (args.length) throw new TypeError("profiles list: no arguments expected");
    const profiles = (await tts.listVoices()).filter(voice => voice.design_profile !== undefined);
    for (const profile of profiles) io.out(JSON.stringify(profile));
    return 0;
  }
  if (operation === "show") {
    if (args.length !== 1) throw new TypeError("profiles show: one ID is required");
    io.out(JSON.stringify(requireProfile(await tts.getVoice(args[0] as string))));
    return 0;
  }
  if (operation === "rm") {
    if (args.length !== 1) throw new TypeError("profiles rm: one ID is required");
    const profile = requireProfile(await tts.getVoice(args[0] as string));
    await tts.deleteVoice(profile.id);
    io.out(`deleted ${profile.id}`);
    return 0;
  }
  if (operation === "reproduce") {
    if (args.length !== 2) throw new TypeError("profiles reproduce: source ID and new ID are required");
    const source = requireProfile(await tts.getVoice(args[0] as string));
    if (!source.prompt_text) throw new TypeError(`profiles reproduce: ${source.id} has no anchor text`);
    const profile = source.design_profile;
    io.out(JSON.stringify(await tts.createDesignProfile({
      id: args[1] as string,
      description: profile.description,
      anchor_text: source.prompt_text,
      seed: profile.seed,
      cfg_value: profile.cfg_value,
      timesteps: profile.timesteps,
    })));
    return 0;
  }
  if (operation === "verify") {
    if (args.length !== 2) throw new TypeError("profiles verify: source ID and target ID are required");
    const source = reproducibilityRecord(await tts.getVoice(args[0] as string));
    const target = reproducibilityRecord(await tts.getVoice(args[1] as string));
    for (const field of Object.keys(source) as Array<keyof typeof source>) {
      if (source[field] !== target[field]) throw new TypeError(`profiles verify: mismatch in ${field}`);
    }
    io.out(`verified ${args[0]} ${args[1]} ${source.audio_sha256}`);
    return 0;
  }
  if (operation !== "create") throw new TypeError("profiles: expected list, create, reproduce, verify, show, or rm");
  const id = args.shift();
  let description: string | undefined, anchorText: string | undefined, seed: number | undefined;
  let cfgValue: number | undefined, timesteps: number | undefined;
  while (args.length) {
    const option = args.shift();
    if (option !== "--description" && option !== "--anchor-text" && option !== "--seed"
      && option !== "--cfg" && option !== "--timesteps") {
      throw new TypeError(`profiles: unknown option ${option}`);
    }
    const value = args.shift();
    if (!value) throw new TypeError(`profiles: ${option} requires a value`);
    if (option === "--description") description = value;
    else if (option === "--anchor-text") anchorText = value;
    else if (option === "--seed") {
      if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new TypeError("profiles: --seed must be a safe integer");
      }
      seed = Number(value);
    } else if (option === "--cfg") {
      cfgValue = Number(value);
      if (!Number.isFinite(cfgValue)) throw new TypeError("profiles: --cfg must be a number");
    } else {
      if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new TypeError("profiles: --timesteps must be a safe integer");
      }
      timesteps = Number(value);
    }
  }
  if (!id || !description || !anchorText || seed === undefined) throw new TypeError("profiles create: ID, --description, --anchor-text, and --seed are required");
  io.out(JSON.stringify(await tts.createDesignProfile({
    id, description, anchor_text: anchorText, seed,
    ...(cfgValue === undefined ? {} : { cfg_value: cfgValue }),
    ...(timesteps === undefined ? {} : { timesteps }),
  })));
  return 0;
}
