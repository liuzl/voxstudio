import { createHash } from "node:crypto";
import { OWNER_USER_ID } from "./auth/auth-context";

/**
 * Gateway-side voice namespacing (docs/auth.md phase 2). Engines keep their
 * [A-Za-z0-9._-]{1,64} id contract and never learn about users; the gateway maps a
 * user's chosen display name onto an engine-local id deterministically —
 * `u<12 hex of sha256(userId)>.<name>` — so same-named voices from different account
 * holders neither collide nor overwrite each other. The self-hosted owner keeps
 * today's bare names untouched: a single-owner deployment notices nothing.
 *
 * `u<12 hex>.` is thereby a reserved namespace. An owner voice named to look like it
 * would drop out of the owner's bank view — pathological, and preferable to letting
 * bare names shadow an account holder's entries.
 */
const namespaced = /^u[0-9a-f]{12}\./;

export function voicePrefix(userId: string): string {
  return `u${createHash("sha256").update(userId).digest("hex").slice(0, 12)}.`;
}

/** Display name → engine id. Null when the name cannot fit the engine contract prefixed. */
export function toEngineVoiceId(userId: string, displayName: string): string | null {
  if (userId === OWNER_USER_ID) return displayName;
  const engineId = `${voicePrefix(userId)}${displayName}`;
  return engineId.length <= 64 ? engineId : null;
}

/** Engine id → display name, or null when the entry is not visible to this user. */
export function fromEngineVoiceId(userId: string, engineId: string): string | null {
  if (userId === OWNER_USER_ID) return namespaced.test(engineId) ? null : engineId;
  const prefix = voicePrefix(userId);
  return engineId.startsWith(prefix) ? engineId.slice(prefix.length) : null;
}
