import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const agentIdPattern = /^[A-Za-z0-9._-]{1,64}$/;
const ownerId = "owner";

export interface AgentSpec {
  instructions?: string;
  voice?: string;
  language?: string;
  welcome?: string;
  nudgeAfterSeconds?: number;
  pronunciations?: Record<string, string>;
  keyterms?: string[];
  asrEngine?: string;
  llmEngine?: string;
  ttsEngine?: string;
  studioTools?: boolean;
  mcpServers?: string[];
  turnTaking?: "conservative" | "speculative";
  reopenMs?: number;
  vad?: "energy" | "silero";
  threshold?: number;
  silenceMs?: number;
  minSpeechMs?: number;
  maxSessionSeconds?: number;
}

export interface AgentPublishedPointer {
  version: number;
  hash: string;
  publishedAt: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  spec: AgentSpec;
  revision: number;
  createdAt: string;
  updatedAt: string;
  published?: AgentPublishedPointer;
}

export interface AgentPublishedVersion extends AgentPublishedPointer {
  id: string;
  spec: AgentSpec;
}

export interface AgentAudit {
  status: "unpublished" | "current" | "drifted" | "missing_snapshot";
  draftHash: string;
  publishedHash?: string;
  version?: number;
}

export interface CreateAgentInput {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  spec?: AgentSpec;
}

export interface UpdateAgentInput {
  revision: number;
  name?: string;
  description?: string | null;
  avatar?: string | null;
  spec?: AgentSpec;
}

export type AgentResolveSource =
  | { type: "draft"; revision?: number }
  | { type: "published"; version?: number };

export class AgentRegistryError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "already_exists" | "conflict" | "not_published",
    message: string,
  ) {
    super(message);
    this.name = "AgentRegistryError";
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, max = 4_096): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new AgentRegistryError("invalid", `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max = 4_096): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new AgentRegistryError("invalid", `${field} must be a string of at most ${max} characters`);
  }
  return value;
}

function optionalNonNegative(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgentRegistryError("invalid", `${field} must be a non-negative finite number`);
  }
  return value;
}

function optionalPositive(value: unknown, field: string): number | undefined {
  const parsed = optionalNonNegative(value, field);
  if (parsed === 0) {
    throw new AgentRegistryError("invalid", `${field} must be a positive finite number`);
  }
  return parsed;
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim() === "")) {
    throw new AgentRegistryError("invalid", `${field} must be a list of non-empty strings`);
  }
  return [...new Set(value as string[])];
}

function stringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.entries(value).some(([key, item]) => key === "" || typeof item !== "string" || item === "")) {
    throw new AgentRegistryError("invalid", `${field} must map non-empty terms to non-empty strings`);
  }
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;
}

export function validateAgentId(id: string): string {
  if (!agentIdPattern.test(id)) {
    throw new AgentRegistryError("invalid", "agent id must match [A-Za-z0-9._-]{1,64}");
  }
  return id;
}

export function parseAgentSpec(value: unknown): AgentSpec {
  if (!isRecord(value)) throw new AgentRegistryError("invalid", "spec must be an object");
  const turnTaking = value.turnTaking;
  if (turnTaking !== undefined && turnTaking !== "conservative" && turnTaking !== "speculative") {
    throw new AgentRegistryError("invalid", "spec.turnTaking must be conservative or speculative");
  }
  const vad = value.vad;
  if (vad !== undefined && vad !== "energy" && vad !== "silero") {
    throw new AgentRegistryError("invalid", "spec.vad must be energy or silero");
  }
  if (value.studioTools !== undefined && typeof value.studioTools !== "boolean") {
    throw new AgentRegistryError("invalid", "spec.studioTools must be a boolean");
  }
  const spec: AgentSpec = {};
  for (const key of ["instructions", "voice", "language", "welcome", "asrEngine", "llmEngine", "ttsEngine"] as const) {
    const parsed = optionalString(value[key], `spec.${key}`, key === "instructions" ? 32_768 : 4_096);
    if (parsed !== undefined) spec[key] = parsed;
  }
  const nudge = optionalNonNegative(value.nudgeAfterSeconds, "spec.nudgeAfterSeconds");
  const reopen = optionalNonNegative(value.reopenMs, "spec.reopenMs");
  const threshold = optionalNonNegative(value.threshold, "spec.threshold");
  const silence = optionalNonNegative(value.silenceMs, "spec.silenceMs");
  const minSpeech = optionalNonNegative(value.minSpeechMs, "spec.minSpeechMs");
  const maxSession = optionalPositive(value.maxSessionSeconds, "spec.maxSessionSeconds");
  if (nudge !== undefined) spec.nudgeAfterSeconds = nudge;
  if (reopen !== undefined) spec.reopenMs = reopen;
  if (threshold !== undefined) spec.threshold = threshold;
  if (silence !== undefined) spec.silenceMs = silence;
  if (minSpeech !== undefined) spec.minSpeechMs = minSpeech;
  if (maxSession !== undefined) spec.maxSessionSeconds = maxSession;
  const pronunciations = stringMap(value.pronunciations, "spec.pronunciations");
  const keyterms = stringList(value.keyterms, "spec.keyterms");
  const mcpServers = stringList(value.mcpServers, "spec.mcpServers");
  if (pronunciations !== undefined) spec.pronunciations = pronunciations;
  if (keyterms !== undefined) spec.keyterms = keyterms;
  if (mcpServers !== undefined) spec.mcpServers = mcpServers;
  if (value.studioTools !== undefined) spec.studioTools = value.studioTools;
  if (turnTaking !== undefined) spec.turnTaking = turnTaking;
  if (vad !== undefined) spec.vad = vad;
  return spec;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function agentSpecHash(spec: AgentSpec): string {
  return createHash("sha256").update(JSON.stringify(canonical(parseAgentSpec(spec)))).digest("hex");
}

function parsePointer(value: unknown): AgentPublishedPointer | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Number.isInteger(value.version) || (value.version as number) < 1
      || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash)
      || typeof value.publishedAt !== "string") {
    throw new AgentRegistryError("invalid", "published pointer is malformed");
  }
  return { version: value.version as number, hash: value.hash, publishedAt: value.publishedAt };
}

function parseRecord(value: unknown): AgentRecord {
  if (!isRecord(value)) throw new AgentRegistryError("invalid", "agent file must contain an object");
  const id = validateAgentId(requiredString(value.id, "id", 64));
  const revision = value.revision;
  if (!Number.isInteger(revision) || (revision as number) < 1) {
    throw new AgentRegistryError("invalid", "revision must be a positive integer");
  }
  const record: AgentRecord = {
    id,
    name: requiredString(value.name, "name", 160),
    spec: parseAgentSpec(value.spec ?? {}),
    revision: revision as number,
    createdAt: requiredString(value.createdAt, "createdAt", 64),
    updatedAt: requiredString(value.updatedAt, "updatedAt", 64),
  };
  const description = optionalString(value.description, "description", 4_096);
  const avatar = optionalString(value.avatar, "avatar", 512);
  const published = parsePointer(value.published);
  if (description !== undefined) record.description = description;
  if (avatar !== undefined) record.avatar = avatar;
  if (published !== undefined) record.published = published;
  return record;
}

function parseVersion(value: unknown): AgentPublishedVersion {
  if (!isRecord(value)) throw new AgentRegistryError("invalid", "published snapshot must contain an object");
  const pointer = parsePointer(value);
  if (!pointer) throw new AgentRegistryError("invalid", "published snapshot is malformed");
  const spec = parseAgentSpec(value.spec ?? {});
  if (agentSpecHash(spec) !== pointer.hash) throw new AgentRegistryError("invalid", "published snapshot hash does not match its spec");
  return { id: validateAgentId(requiredString(value.id, "id", 64)), spec, ...pointer };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function atomicYaml(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  await writeFile(temp, `${Bun.YAML.stringify(value)}\n`, { mode: 0o600 });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function immutableYaml(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  await writeFile(temp, `${Bun.YAML.stringify(value)}\n`, { mode: 0o600 });
  try {
    await link(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

function ownerDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class AgentRegistry {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  ownerDirectory(userId: string): string {
    return userId === ownerId ? this.root : join(this.root, ".owners", ownerDigest(userId));
  }

  private draftPath(userId: string, id: string): string {
    return join(this.ownerDirectory(userId), `${validateAgentId(id)}.yaml`);
  }

  private versionPath(userId: string, id: string, version: number): string {
    if (!Number.isInteger(version) || version < 1) throw new AgentRegistryError("invalid", "version must be a positive integer");
    return join(this.ownerDirectory(userId), ".published", validateAgentId(id), `${version}.yaml`);
  }

  private async exclusive<T>(userId: string, id: string, action: () => Promise<T>): Promise<T> {
    const key = `${userId}\0${validateAgentId(id)}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.queues.set(key, tail);
    await previous;
    try {
      const lockDirectory = join(this.ownerDirectory(userId), ".locks");
      const lockPath = join(lockDirectory, `${validateAgentId(id)}.lock`);
      await mkdir(lockDirectory, { recursive: true });
      const deadline = Date.now() + 5_000;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      while (handle === undefined) {
        try {
          handle = await open(lockPath, "wx", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const age = Date.now() - (await stat(lockPath).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
          if (age > 30_000) {
            await rm(lockPath, { force: true });
            continue;
          }
          if (Date.now() >= deadline) throw new AgentRegistryError("conflict", `agent ${id} is busy`);
          await new Promise<void>(resolve => { setTimeout(resolve, 10); });
        }
      }
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
        return await action();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } finally {
      release();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  private async readDraft(userId: string, id: string): Promise<AgentRecord | undefined> {
    const path = this.draftPath(userId, id);
    if (!await exists(path)) return undefined;
    return parseRecord(Bun.YAML.parse(await readFile(path, "utf8")));
  }

  private async requireDraft(userId: string, id: string): Promise<AgentRecord> {
    const found = await this.readDraft(userId, id);
    if (!found) throw new AgentRegistryError("not_found", `agent ${id} was not found`);
    return found;
  }

  async list(userId: string): Promise<AgentRecord[]> {
    const directory = this.ownerDirectory(userId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(names
      .filter(name => name.endsWith(".yaml") && agentIdPattern.test(name.slice(0, -5)))
      .map(name => this.readDraft(userId, name.slice(0, -5))));
    return records.filter((record): record is AgentRecord => record !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async get(userId: string, id: string): Promise<AgentRecord | undefined> {
    return this.readDraft(userId, id);
  }

  async create(userId: string, input: CreateAgentInput): Promise<AgentRecord> {
    return this.exclusive(userId, input.id, async () => {
      validateAgentId(input.id);
      if (await this.readDraft(userId, input.id)) {
        throw new AgentRegistryError("already_exists", `agent ${input.id} already exists`);
      }
      const now = new Date().toISOString();
      const record: AgentRecord = {
        id: input.id,
        name: requiredString(input.name, "name", 160),
        spec: parseAgentSpec(input.spec ?? {}),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const description = optionalString(input.description, "description", 4_096);
      const avatar = optionalString(input.avatar, "avatar", 512);
      if (description !== undefined) record.description = description;
      if (avatar !== undefined) record.avatar = avatar;
      await atomicYaml(this.draftPath(userId, input.id), record);
      return record;
    });
  }

  async update(userId: string, id: string, input: UpdateAgentInput): Promise<AgentRecord> {
    return this.exclusive(userId, id, async () => {
      const current = await this.requireDraft(userId, id);
      if (current.revision !== input.revision) {
        throw new AgentRegistryError("conflict", `agent ${id} is at revision ${current.revision}, not ${input.revision}`);
      }
      const updated: AgentRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        ...(input.name === undefined ? {} : { name: requiredString(input.name, "name", 160) }),
        ...(input.spec === undefined ? {} : { spec: parseAgentSpec(input.spec) }),
      };
      if (input.description === null) delete updated.description;
      else if (input.description !== undefined) updated.description = optionalString(input.description, "description", 4_096) as string;
      if (input.avatar === null) delete updated.avatar;
      else if (input.avatar !== undefined) updated.avatar = optionalString(input.avatar, "avatar", 512) as string;
      await atomicYaml(this.draftPath(userId, id), updated);
      return updated;
    });
  }

  async remove(userId: string, id: string, revision: number): Promise<void> {
    await this.exclusive(userId, id, async () => {
      const current = await this.requireDraft(userId, id);
      if (current.revision !== revision) {
        throw new AgentRegistryError("conflict", `agent ${id} is at revision ${current.revision}, not ${revision}`);
      }
      await rm(this.draftPath(userId, id));
      await rm(dirname(this.versionPath(userId, id, 1)), { recursive: true, force: true });
    });
  }

  async publish(userId: string, id: string, revision: number): Promise<{ record: AgentRecord; version: AgentPublishedVersion }> {
    return this.exclusive(userId, id, async () => {
      const current = await this.requireDraft(userId, id);
      if (current.revision !== revision) {
        throw new AgentRegistryError("conflict", `agent ${id} is at revision ${current.revision}, not ${revision}`);
      }
      const publishedAt = new Date().toISOString();
      const hash = agentSpecHash(current.spec);
      let versionNumber = (current.published?.version ?? 0) + 1;
      let version: AgentPublishedVersion;
      while (true) {
        const candidate: AgentPublishedVersion = { id, version: versionNumber, hash, publishedAt, spec: current.spec };
        try {
          await immutableYaml(this.versionPath(userId, id, versionNumber), candidate);
          version = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // A crash can leave the immutable payload behind before the mutable draft
          // pointer advances. Adopt an identical payload; otherwise preserve it as a
          // valid historical version and publish the current behavior at the next slot.
          const existing = parseVersion(Bun.YAML.parse(await readFile(this.versionPath(userId, id, versionNumber), "utf8")));
          if (existing.id !== id || existing.version !== versionNumber) {
            throw new AgentRegistryError("invalid", `published version ${versionNumber} identity does not match its path`);
          }
          if (existing.hash === hash) {
            version = existing;
            break;
          }
          versionNumber += 1;
        }
      }
      const record: AgentRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: version.publishedAt,
        published: { version: version.version, hash: version.hash, publishedAt: version.publishedAt },
      };
      await atomicYaml(this.draftPath(userId, id), record);
      return { record, version };
    });
  }

  async versions(userId: string, id: string): Promise<AgentPublishedVersion[]> {
    await this.requireDraft(userId, id);
    const directory = dirname(this.versionPath(userId, id, 1));
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const versions = await Promise.all(names.filter(name => /^\d+\.yaml$/.test(name)).map(async name =>
      parseVersion(Bun.YAML.parse(await readFile(join(directory, name), "utf8")))));
    return versions.sort((a, b) => b.version - a.version);
  }

  async resolve(userId: string, id: string, source: AgentResolveSource = { type: "published" }): Promise<AgentRecord | AgentPublishedVersion> {
    if (source.type === "draft") {
      const record = await this.requireDraft(userId, id);
      if (source.revision !== undefined && source.revision !== record.revision) {
        throw new AgentRegistryError("conflict", `agent ${id} is at revision ${record.revision}, not ${source.revision}`);
      }
      return record;
    }
    const record = await this.requireDraft(userId, id);
    const version = source.version ?? record.published?.version;
    if (version === undefined) throw new AgentRegistryError("not_published", `agent ${id} has no published version`);
    const path = this.versionPath(userId, id, version);
    if (!await exists(path)) throw new AgentRegistryError("not_found", `published agent ${id} version ${version} was not found`);
    return parseVersion(Bun.YAML.parse(await readFile(path, "utf8")));
  }

  async audit(userId: string, id: string): Promise<AgentAudit> {
    const record = await this.requireDraft(userId, id);
    const draftHash = agentSpecHash(record.spec);
    if (!record.published) return { status: "unpublished", draftHash };
    let snapshot: AgentPublishedVersion;
    try {
      snapshot = await this.resolve(userId, id, { type: "published", version: record.published.version }) as AgentPublishedVersion;
    } catch (error) {
      if (error instanceof AgentRegistryError && error.code === "not_found") {
        return { status: "missing_snapshot", draftHash, publishedHash: record.published.hash, version: record.published.version };
      }
      throw error;
    }
    return {
      status: draftHash === snapshot.hash ? "current" : "drifted",
      draftHash,
      publishedHash: snapshot.hash,
      version: snapshot.version,
    };
  }
}
