import { AgentRegistry, type AgentSpec, type CreateAgentInput } from "@voxstudio/agents";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "../io";

export const agentsUsage = `usage: vox agents [--dir DIR] {list,create,show,publish,audit,rm} ...

Manage the self-hosted Agent registry without starting the Studio.

commands:
  list
  create ID --name NAME [--description TEXT] [--instructions TEXT] [--from FILE]
  show ID [--version N]
  publish ID [--revision N]
  audit ID
  rm ID [--revision N]

options:
  --dir DIR       Agent registry directory
                  (default ~/.config/voxstudio/agents; VOX_GATEWAY_AGENTS)
  --from FILE     YAML or JSON containing an AgentSpec, AgentRecord, or {spec: ...}

publish and rm use the current draft revision unless --revision is supplied.`;

function required(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new TypeError(`agents: ${option} requires a value`);
  return value;
}

function positiveInteger(raw: string, option: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`agents: ${option} must be a positive integer`);
  }
  return value;
}

function registryOptions(args: string[]): { root: string; args: string[] } {
  const remaining: string[] = [];
  let root = process.env.VOX_GATEWAY_AGENTS ?? join(homedir(), ".config", "voxstudio", "agents");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--dir") root = required(args, ++index, arg);
    else remaining.push(arg);
  }
  if (!root) throw new TypeError("agents: registry directory cannot be empty");
  return { root, args: remaining };
}

function asObject(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`agents create: ${source} must contain an object`);
  }
  return value as Record<string, unknown>;
}

async function specFromFile(path: string): Promise<AgentSpec> {
  let value: unknown;
  try {
    value = Bun.YAML.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new TypeError(`agents create: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = asObject(value, path);
  return asObject(object.spec ?? object, path) as AgentSpec;
}

function emit(io: CliIo, value: unknown): void {
  io.out(JSON.stringify(value));
}

/** Local CLI operations use the self-hosted owner namespace by design. */
export async function runAgents(rawArgs: string[], io: CliIo): Promise<number> {
  const parsed = registryOptions(rawArgs);
  const args = parsed.args;
  const operation = args.shift();
  const registry = new AgentRegistry(parsed.root);
  const owner = "owner";

  if (operation === "list") {
    if (args.length) throw new TypeError("agents list: no arguments expected");
    for (const record of await registry.list(owner)) emit(io, record);
    return 0;
  }

  if (operation === "create") {
    const id = args.shift();
    if (!id) throw new TypeError("agents create: ID is required");
    let name: string | undefined;
    let description: string | undefined;
    let instructions: string | undefined;
    let source: string | undefined;
    while (args.length) {
      const option = args.shift() as string;
      if (option === "--name") name = args.shift() ?? required(args, 0, option);
      else if (option === "--description") description = args.shift() ?? required(args, 0, option);
      else if (option === "--instructions") instructions = args.shift() ?? required(args, 0, option);
      else if (option === "--from") source = args.shift() ?? required(args, 0, option);
      else throw new TypeError(`agents create: unknown option ${option}`);
    }
    if (!name) throw new TypeError("agents create: --name is required");
    const fileSpec = source === undefined ? {} : await specFromFile(source);
    const spec = { ...fileSpec, ...(instructions === undefined ? {} : { instructions }) };
    const input: CreateAgentInput = {
      id,
      name,
      spec,
      ...(description === undefined ? {} : { description }),
    };
    emit(io, await registry.create(owner, input));
    return 0;
  }

  if (operation === "show") {
    const id = args.shift();
    if (!id) throw new TypeError("agents show: ID is required");
    let version: number | undefined;
    while (args.length) {
      const option = args.shift() as string;
      if (option === "--version") version = positiveInteger(args.shift() ?? required(args, 0, option), option);
      else throw new TypeError(`agents show: unknown option ${option}`);
    }
    if (version !== undefined) {
      emit(io, await registry.resolve(owner, id, { type: "published", version }));
      return 0;
    }
    const record = await registry.get(owner, id);
    if (!record) throw new TypeError(`agents show: agent ${id} was not found`);
    emit(io, record);
    return 0;
  }

  if (operation === "publish" || operation === "rm") {
    const id = args.shift();
    if (!id) throw new TypeError(`agents ${operation}: ID is required`);
    let revision: number | undefined;
    while (args.length) {
      const option = args.shift() as string;
      if (option === "--revision") revision = positiveInteger(args.shift() ?? required(args, 0, option), option);
      else throw new TypeError(`agents ${operation}: unknown option ${option}`);
    }
    const record = await registry.get(owner, id);
    if (!record) throw new TypeError(`agents ${operation}: agent ${id} was not found`);
    const expected = revision ?? record.revision;
    if (operation === "publish") emit(io, await registry.publish(owner, id, expected));
    else {
      await registry.remove(owner, id, expected);
      io.out(`deleted ${id}`);
    }
    return 0;
  }

  if (operation === "audit") {
    if (args.length !== 1) throw new TypeError("agents audit: one ID is required");
    emit(io, await registry.audit(owner, args[0] as string));
    return 0;
  }

  throw new TypeError("agents: expected list, create, show, publish, audit, or rm");
}
