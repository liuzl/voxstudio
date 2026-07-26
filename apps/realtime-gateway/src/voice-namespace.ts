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

/** The engine-side id contract every voice name must satisfy, prefix included. */
const voiceIdPattern = /^[A-Za-z0-9._-]{1,64}$/;

export function voicePrefix(userId: string): string {
  return `u${createHash("sha256").update(userId).digest("hex").slice(0, 12)}.`;
}

/**
 * Display name → engine id, or null when the name may not be used at all. Null covers
 * three refusals, and callers turn every one of them into the same 400: a name outside
 * the engine id contract, a name that would not fit its account prefix, and — for every
 * caller including the self-hosted owner — a name shaped like the reserved namespace
 * (`u<12 hex>.`). That last one is what stops a raw engine id from being presented as a
 * display name to reach into somebody else's bank (adversarial review 2026-07-26).
 */
export function toEngineVoiceId(userId: string, displayName: string): string | null {
  if (!voiceIdPattern.test(displayName)) return null;
  if (namespaced.test(displayName)) return null;
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
