import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { DesignProfile, DesignProfileRequest, Voice, VoxConfig } from "@voxstudio/contracts";
import { synthesizeLong } from "@voxstudio/orchestration";
import { readTextFile, writeBytes } from "@voxstudio/platform-bun";
import { sanitizeForTts } from "@voxstudio/text";
import type { CliIo } from "../io";

export const profilesUsage = `usage: vox profiles {list,create,batch,audition,select,audit,reproduce,verify,show,rm} ...

commands:
  list
  create ID --description TEXT --anchor-text TEXT --seed N [--cfg VALUE] [--timesteps N]
  batch MANIFEST [--dry-run] [--rollback-on-error]
  audition OUT_DIR --text TEXT --seed N ID [ID ...]
  select AUDITION_MANIFEST WINNER_ID [--note TEXT]
  audit ID
  reproduce SOURCE_ID NEW_ID
  verify SOURCE_ID TARGET_ID
  show ID
  rm ID

create options:
  --cfg VALUE         classifier-free guidance value
  --timesteps N       generation timesteps

batch manifest:
  JSONL: one candidate per line with id, description, anchor_text, seed,
  and optional cfg_value and timesteps. Use --dry-run to validate without generation.
  Use --rollback-on-error to delete candidates created before a request failure.

audition:
  Generate one WAV per profile with fixed text and synthesis seed. OUT_DIR must
  not already contain candidate WAVs or manifest.json.

select:
  Record a human-selected winner in selection.json beside an audition manifest.

audit:
  Check one design profile against the current TTS runtime model and manifest.`;

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

const profileFields = new Set(["id", "description", "anchor_text", "seed", "cfg_value", "timesteps"]);
const voiceId = /^[A-Za-z0-9._-]{1,64}$/;

function parseBatchCandidate(value: unknown, location: string): DesignProfileRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`profiles batch: ${location} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!profileFields.has(field)) throw new TypeError(`profiles batch: ${location} has unknown field ${field}`);
  }
  const { id, description, anchor_text: anchorText, seed, cfg_value: cfgValue, timesteps } = record;
  if (typeof id !== "string" || !voiceId.test(id)) {
    throw new TypeError(`profiles batch: ${location}.id must match [A-Za-z0-9._-]{1,64}`);
  }
  if (typeof description !== "string" || !description.trim()) {
    throw new TypeError(`profiles batch: ${location}.description must be non-empty`);
  }
  if (typeof anchorText !== "string" || !anchorText.trim()) {
    throw new TypeError(`profiles batch: ${location}.anchor_text must be non-empty`);
  }
  if (typeof seed !== "number" || !Number.isSafeInteger(seed)) {
    throw new TypeError(`profiles batch: ${location}.seed must be a safe integer`);
  }
  if (cfgValue !== undefined && (typeof cfgValue !== "number" || !Number.isFinite(cfgValue))) {
    throw new TypeError(`profiles batch: ${location}.cfg_value must be a number`);
  }
  if (timesteps !== undefined && (typeof timesteps !== "number" || !Number.isSafeInteger(timesteps))) {
    throw new TypeError(`profiles batch: ${location}.timesteps must be a safe integer`);
  }
  return {
    id, description, anchor_text: anchorText, seed,
    ...(cfgValue === undefined ? {} : { cfg_value: cfgValue }),
    ...(timesteps === undefined ? {} : { timesteps }),
  };
}

export function parseProfileBatch(text: string): DesignProfileRequest[] {
  const candidates: DesignProfileRequest[] = [];
  const ids = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const location = `line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new TypeError(`profiles batch: ${location} is not valid JSON`);
    }
    const candidate = parseBatchCandidate(value, location);
    if (ids.has(candidate.id)) throw new TypeError(`profiles batch: duplicate id ${candidate.id}`);
    ids.add(candidate.id);
    candidates.push(candidate);
  }
  if (!candidates.length) throw new TypeError("profiles batch: manifest contains no candidates");
  return candidates;
}

interface AuditionOptions {
  outputDir: string;
  text: string;
  seed: number;
  ids: string[];
}

function parseAudition(args: string[]): AuditionOptions {
  const outputDir = args.shift();
  let text: string | undefined;
  let seed: number | undefined;
  const ids: string[] = [];
  while (args.length) {
    const arg = args.shift() as string;
    if (arg === "--text") {
      text = args.shift();
      if (!text) throw new TypeError("profiles audition: --text requires a value");
    } else if (arg === "--seed") {
      const raw = args.shift();
      if (!raw) throw new TypeError("profiles audition: --seed requires a value");
      if (!/^[+-]?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new TypeError("profiles audition: --seed must be a safe integer");
      }
      seed = Number(raw);
    } else if (arg.startsWith("-")) {
      throw new TypeError(`profiles audition: unknown option ${arg}`);
    } else {
      ids.push(arg);
    }
  }
  if (!outputDir) throw new TypeError("profiles audition: output directory is required");
  if (!text?.trim()) throw new TypeError("profiles audition: --text is required");
  if (seed === undefined) throw new TypeError("profiles audition: --seed is required");
  if (!ids.length) throw new TypeError("profiles audition: at least one profile ID is required");
  for (const id of ids) {
    if (!voiceId.test(id)) throw new TypeError(`profiles audition: invalid profile ID ${id}`);
  }
  if (new Set(ids).size !== ids.length) throw new TypeError("profiles audition: profile IDs must be unique");
  return { outputDir, text, seed, ids };
}

interface AuditionCandidate {
  id: string;
  wav_sha256: string;
}

function parseAuditionSelection(args: string[]): { manifestPath: string; winnerId: string; note?: string } {
  const manifestPath = args.shift();
  const winnerId = args.shift();
  let note: string | undefined;
  while (args.length) {
    const option = args.shift();
    if (option !== "--note") throw new TypeError(`profiles select: unknown option ${option}`);
    note = args.shift();
    if (!note) throw new TypeError("profiles select: --note requires a value");
  }
  if (!manifestPath) throw new TypeError("profiles select: audition manifest path is required");
  if (!winnerId) throw new TypeError("profiles select: winner ID is required");
  return { manifestPath, winnerId, ...(note === undefined ? {} : { note }) };
}

function parseAuditionCandidates(raw: string): AuditionCandidate[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("profiles select: audition manifest is not valid JSON");
  }
  if (typeof value !== "object" || value === null || !Array.isArray((value as { candidates?: unknown }).candidates)) {
    throw new TypeError("profiles select: audition manifest has no candidates");
  }
  const candidates = (value as { candidates: unknown[] }).candidates.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null
      || typeof (candidate as { id?: unknown }).id !== "string"
      || typeof (candidate as { wav_sha256?: unknown }).wav_sha256 !== "string") {
      throw new TypeError(`profiles select: invalid candidate at index ${index}`);
    }
    return candidate as AuditionCandidate;
  });
  if (!candidates.length) throw new TypeError("profiles select: audition manifest has no candidates");
  return candidates;
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
  if (operation === "batch") {
    const manifest = args.shift();
    let dryRun = false;
    let rollbackOnError = false;
    for (const option of args) {
      if (option === "--dry-run") dryRun = true;
      else if (option === "--rollback-on-error") rollbackOnError = true;
      else throw new TypeError(`profiles batch: unknown option ${option}`);
    }
    if (!manifest) throw new TypeError("profiles batch: manifest path is required");
    const candidates = parseProfileBatch(await readTextFile(manifest));
    if (dryRun) {
      for (const candidate of candidates) io.out(JSON.stringify(candidate));
      return 0;
    }
    const created: string[] = [];
    try {
      for (const candidate of candidates) {
        const profile = await tts.createDesignProfile(candidate);
        created.push(profile.id);
        io.out(JSON.stringify(profile));
      }
    } catch (error) {
      if (rollbackOnError) {
        const failedDeletes: string[] = [];
        for (const id of [...created].reverse()) {
          try {
            await tts.deleteVoice(id);
          } catch {
            failedDeletes.push(id);
          }
        }
        if (failedDeletes.length) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed for ${failedDeletes.join(", ")}`);
        }
      }
      throw error;
    }
    return 0;
  }
  if (operation === "audition") {
    const options = parseAudition(args);
    const sanitized = sanitizeForTts(options.text);
    if (!sanitized.text.trim()) throw new TypeError("profiles audition: text has no speakable content");
    const candidates = await Promise.all(options.ids.map(async (id) => ({
      id,
      profile: reproducibilityRecord(await tts.getVoice(id)),
    })));
    const outputs = candidates.map(({ id }) => join(options.outputDir, `${id}.wav`));
    const manifestPath = join(options.outputDir, "manifest.json");
    for (const path of [...outputs, manifestPath]) {
      if (await Bun.file(path).exists()) throw new TypeError(`profiles audition: output already exists: ${path}`);
    }
    await mkdir(options.outputDir, { recursive: true });
    const results: Array<{ id: string; wav_sha256: string; profile: ReturnType<typeof reproducibilityRecord> }> = [];
    for (const [index, candidate] of candidates.entries()) {
      const wav = await synthesizeLong(tts, sanitized.text, {
        chunking: config.chunking,
        ttsDefaults: config.ttsDefaults,
        voice: candidate.id,
        seed: options.seed,
        prosodyPrompt: true,
        continuationId: crypto.randomUUID(),
      });
      const wavSha256 = createHash("sha256").update(wav).digest("hex");
      await writeBytes(outputs[index] as string, wav);
      results.push({ id: candidate.id, wav_sha256: wavSha256, profile: candidate.profile });
      io.out(JSON.stringify({ id: candidate.id, output: outputs[index], wav_sha256: wavSha256 }));
    }
    const manifest = {
      text: sanitized.text,
      seed: options.seed,
      tts: { cfg_value: config.ttsDefaults.cfgValue, timesteps: config.ttsDefaults.timesteps },
      candidates: results,
    };
    await writeBytes(manifestPath, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
    io.out(JSON.stringify({ manifest: manifestPath }));
    return 0;
  }
  if (operation === "select") {
    const options = parseAuditionSelection(args);
    const raw = await readTextFile(options.manifestPath);
    const candidates = parseAuditionCandidates(raw);
    const winner = candidates.find(candidate => candidate.id === options.winnerId);
    if (!winner) throw new TypeError(`profiles select: ${options.winnerId} is not in the audition manifest`);
    const selectionPath = join(dirname(options.manifestPath), "selection.json");
    if (await Bun.file(selectionPath).exists()) {
      throw new TypeError(`profiles select: selection already exists: ${selectionPath}`);
    }
    const selection = {
      audition_manifest_sha256: createHash("sha256").update(raw).digest("hex"),
      selected_at: new Date().toISOString(),
      winner,
      ...(options.note === undefined ? {} : { note: options.note }),
    };
    await writeBytes(selectionPath, new TextEncoder().encode(`${JSON.stringify(selection, null, 2)}\n`));
    io.out(JSON.stringify({ selection: selectionPath, winner: winner.id }));
    return 0;
  }
  if (operation === "audit") {
    if (args.length !== 1) throw new TypeError("profiles audit: one profile ID is required");
    const profile = reproducibilityRecord(await tts.getVoice(args[0] as string));
    const runtime = await tts.runtimeIdentity();
    if (profile.model !== runtime.model) throw new TypeError("profiles audit: model differs from current TTS runtime");
    if (profile.model_manifest_sha256 !== runtime.model_manifest_sha256) {
      throw new TypeError("profiles audit: model manifest differs from current TTS runtime");
    }
    io.out(JSON.stringify({ id: args[0], status: "ok", model: runtime.model,
      model_manifest_sha256: runtime.model_manifest_sha256, audio_sha256: profile.audio_sha256 }));
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
  if (operation !== "create") throw new TypeError("profiles: expected list, create, batch, audition, select, audit, reproduce, verify, show, or rm");
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
