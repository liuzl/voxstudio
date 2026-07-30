# Agents: the session options, reified

Status: Proposed, 2026-07-25. The competitive gap the console walkthroughs made
concrete ([competitive-voice-agents.md](./competitive-voice-agents.md)): xAI's
product object is the *agent* — a named, saved, publishable bundle with its own
list, templates, and Try-live lifecycle — while voxstudio has one conversation
loop and a pile of start options. This design closes that gap the cheap way,
because in voxstudio the agent already exists in pieces: **every field of the
bundle is a session option we ship today.** Reify the bundle; invent nothing.

## The question

What is an agent, where does it live, and how does a session start as one —
without forking the conversation loop, weakening the deployment guardrails, or
blocking the later tenant story?

## Scope

In scope: the agent object and its registry, CLI CRUD, `session.start` by
agent id (native protocol), the OpenAI dialect's `?agent=`, per-agent
guardrails, and the pronunciation layering. Out of scope, designed-for but not
built here: tenant ownership of agents (the scoping lands with multi-tenancy),
knowledge attachments (RAG hangs off the agent object later), and the Web
agents panel beyond the minimum (list + pick at conversation start).

## Decisions

1. **An agent is a bundle of existing options — nothing else.**

   | Field group | Already exists as |
   |---|---|
   | instructions | `system` |
   | voice (clone or design profile) | `voice` (+ design profiles' SHA-256 identity) |
   | etiquette | `welcome`, `nudgeAfterSeconds`, pronunciations |
   | tool policy | `studioTools`, MCP server subset, `trust` |
   | engine routing | `asrEngine` / `llmEngine` / `ttsEngine` |
   | turn-taking | `turnTaking`, `reopenMs`, VAD parameters |
   | guardrails | `maxSessionSeconds` (deployment-level today) |

   The loop, the tool machinery, and the protocol semantics do not change; an
   agent is resolved into the same `SessionStartOptions` the gateway already
   consumes.

2. **The registry is a directory of YAML files, hash-stamped on publish.**
   `~/.config/voxstudio/agents/<id>.yaml` (or `--agents DIR`); one file, one
   agent, human-editable and git-able — the config culture, not a database.
   `vox agents publish <id>` stamps the file with the bundle's content SHA-256
   and a version counter, exactly the role `selection.json` and design-profile
   fingerprints play elsewhere: "this agent, version 3" is a citable artifact,
   and drift between the stamp and the live file is detectable (`vox agents
   audit`, same verb, same meaning). Drafts are files without a current stamp.
   Templates are seed files shipped in the repo (`agents/templates/`).

3. **Resolution order: config < agent < explicit session options — except
   guardrails, which only tighten.** An agent supplies defaults the way the
   config file does; a client that explicitly sets `voice` in `session.start`
   wins, preserving today's behavior for agent-less sessions unchanged. The
   exception is deliberate: per-agent `maxSessionSeconds` and the tool policy
   are ceilings, and a session may narrow them but never widen — the same
   fail-closed posture as the demo guardrails, because an agent published for
   a purpose must not be loosened by whoever connects to it.

4. **Wire shape: `session.start { agent: "客服" }` natively; `?agent=` on the
   OpenAI dialect.** The dialect form mirrors xAI's `?agent_id=` verbatim-in-
   spirit — a client written for their endpoint carries the same mental model
   here. Unknown agent id → the existing structured rejection path, before
   any engine is touched. Demo mode composes instead of conflicting: a demo
   deployment may pin one published agent (`--demo-agent ID`), which is the
   public-demo persona story ([public-demo.md](./public-demo.md)) getting its
   missing noun.

5. **Pronunciations become three layers: config → agent → session overlay.**
   The phase-3 overlay machinery generalizes: the TTS boundary reads one
   merged map, `remember_pronunciation` writes the session layer, and
   `persist_pronunciations` targets the agent file when the session runs as
   an agent (the config file otherwise) — corrections taught to 客服 belong
   to 客服.

6. **Tenancy is a later scoping, not a rework.** Agents are files today; the
   tenant story adds an owner dimension (per-tenant agent directories or an
   owner column when the registry outgrows files). Ids stay
   `[A-Za-z0-9._-]{1,64}`; nothing here assumes a single operator except the
   storage path, which is already a flag. The gateway now resolves a hosted
   `AuthContext` through product-owned accounts while self-hosted sessions keep
   their zero-auth or optional-token shape; when the agent registry lands, its
   resources scope to that same owner identity. Organizations and enterprise
   OIDC widen the identity source later without changing the agent schema (see
   [auth.md](./auth.md)).

## Phases and gates

1. **The object, the registry, the native wire.** Bundle schema + resolution
   (with the guardrail tightening rule), the YAML registry with
   publish/audit stamps, `vox agents {list,create,show,publish,audit,rm}`,
   and `session.start { agent }` on the gateway. Unit tests: precedence
   (config < agent < explicit), guardrails refusing to loosen, hash
   stability across key order, unknown-id rejection. **Gate**: a live
   session started by agent id comes up with the agent's voice, welcome,
   and tool policy — asserted through the existing event stream, no new
   machinery.
2. **The dialect and the demo.** `?agent=` on the OpenAI adapter (gate: the
   official SDK connects to a named agent with only a URL change);
   `--demo-agent` pinning, folded into `measure:guardrails`.
3. **Surfaces.** Web: agent picker at conversation start, then the panel
   (list / create-from-template / edit / Try) as its own delivery; the
   conversation trace viewer ties call history to the agent that served
   it. CLI listen: `--agent ID`.
4. **Later**: tenant ownership; knowledge attachments per agent; agent
   switching mid-call as a session tool, if real usage asks for it.
