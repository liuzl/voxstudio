# Agents: the session options, reified

Status: Proposed, 2026-07-25. The competitive gap the console walkthroughs made
concrete ([competitive-voice-agents.md](./competitive-voice-agents.md)): xAI's
product object is the *agent* — a named, saved, publishable bundle with its own
list, templates, and Try-live lifecycle — while voxstudio has one conversation
loop and a pile of start options. This design closes that gap the cheap way,
because in voxstudio the runtime Agent already exists in pieces: **every field of
`AgentSpec` resolves through an existing session, configuration-overlay, or tool
policy boundary.** A registry record adds identity and publish metadata around
that spec; it does not send presentation or lifecycle fields into the
conversation loop.

Web scope update, 2026-08-01: the minimum panel described here is expanded into
the full Agent Builder, preview, and later Portal reuse requirements in
[agent-builder-ui.md](./agent-builder-ui.md). The registry and resolution
decisions below remain the prerequisite; the Web UI must edit that object rather
than introduce a browser-only Agent model.

Implementation update, 2026-08-02: the Phase 1 runtime and first Web Builder
slice are implemented. The shared
`@voxstudio/agents` package now owns the validated spec/record model, canonical
behavior hash, owner-scoped YAML drafts, cross-process revision locking, immutable
published snapshots, resolution, and audit. The gateway exposes owner-scoped CRUD,
publish/audit/version routes and native `session.start { agent }`; ordinary starts
resolve the latest published snapshot, while an explicit draft revision is available
for Builder preview. The Web Agents list now reads this registry, and its responsive
Builder edits, saves, publishes, and runs Try it live against a revision-pinned draft.
CLI Agent subcommands, advanced MCP/engine controls, version restore, and the complete
Builder delivery described in [agent-builder-ui.md](./agent-builder-ui.md) remain next.

## The question

What is an agent, where does it live, and how does a session start as one —
without forking the conversation loop, weakening the deployment guardrails, or
blocking later shared ownership?

## Scope

In scope: the agent object and its registry, CLI CRUD, `session.start` by
agent id (native protocol), the OpenAI dialect's `?agent=`, per-agent
guardrails, pronunciation layering, existing Better Auth owner scoping, and the
Web delivery specified in [agent-builder-ui.md](./agent-builder-ui.md). Out of
scope, designed-for but not built here: organizations and multi-principal Agent
sharing, and knowledge attachments (RAG hangs off `AgentSpec` later).

## Decisions

1. **The runtime `AgentSpec` is a bundle of existing options — nothing else.**

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
   `AgentSpec` is resolved into the same `SessionStartOptions` the gateway already
   consumes. `AgentRecord` wraps the spec with id, name, optional presentation
   metadata, draft revision, and published-version metadata. Those wrapper fields
   are registry/UI concerns and never reach the loop. Speaking speed is omitted
   from `AgentSpec` until it exists in the versioned start contract.

2. **The registry keeps one mutable YAML draft plus immutable published
   snapshots.** `~/.config/voxstudio/agents/<id>.yaml` (or `--agents DIR`) is the
   human-editable, git-able draft. Publishing canonicalizes the behavior-affecting
   `AgentSpec`, writes `agents/.published/<id>/<version>.yaml` atomically, and
   updates the draft's published version/hash/time pointer only after that write
   succeeds. Editing the draft cannot rewrite the version currently serving
   callers. `vox agents audit` compares canonical draft and snapshot hashes;
   a hash is evidence, not a substitute for the published payload. Templates are
   seed files shipped in the repo (`agents/templates/`).

   Under hosted accounts, the registry is keyed by `(userId, id)` and owner
   directories use the full hexadecimal SHA-256 digest of Better Auth's `userId`;
   raw account ids never become path components. The self-hosted `owner` keeps the
   flat layout above. `auth.db` remains Better Auth-owned and stores no Agents.

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

   Normal callers resolve the latest immutable published version. An authenticated
   owner may explicitly name an exact published version or the current draft; the
   Web Studio uses that explicit form for Try it live. This preserves the existing
   parity between a hosted browser session and one of the owner's API keys and also
   works inside the self-hosted single-owner trust boundary. Draft preview still
   passes the same deployment ceilings, quota, capacity, tool confirmation, and
   sandbox policy. It is not a separate privileged endpoint.

5. **Pronunciations become three layers: config → agent → session overlay.**
   The phase-3 overlay machinery generalizes: the TTS boundary reads one
   merged map, `remember_pronunciation` writes the session layer, and
   `persist_pronunciations` targets the agent file when the session runs as
   an agent (the config file otherwise) — corrections taught to 客服 belong
   to 客服.

6. **Per-account ownership is present scope; shared tenancy is later.** The
   gateway already resolves hosted cookie sessions and API keys to the same
   `AuthContext.userId`, while self-hosted sessions resolve to `owner`. Every
   Agent operation and session lookup receives that id; another owner's Agent
   reads as unknown. Ids stay `[A-Za-z0-9._-]{1,64}` and are unique only inside
   an owner namespace. Organizations, shared Agents, roles, and enterprise OIDC
   widen the identity source later without changing `AgentSpec` (see
   [auth.md](./auth.md)). A saved voice Agent is an owned resource, not a Better
   Auth account, API key, or separately metered principal.

## Phases and gates

1. **The object, the registry, the native wire.** `AgentRecord`/`AgentSpec`
   schema + resolution (with the guardrail tightening rule), the owner-scoped
   YAML registry with immutable publish snapshots,
   `vox agents {list,create,show,publish,audit,rm}`,
   and `session.start { agent }` on the gateway. Unit tests: precedence
   (config < agent < explicit), guardrails refusing to loosen, hash
   stability across key order, immutable-version resolution, same-id isolation
   across owners, conditional-write conflicts, concurrent publish serialization,
   and unknown/cross-owner rejection. **Gate**: a live session
   started by agent id comes up with the published version's voice, welcome, and
   tool policy — asserted through the existing event stream, no new machinery.
2. **The dialect and the demo.** `?agent=` on the OpenAI adapter (gate: the
   official SDK connects to a named agent with only a URL change);
   `--demo-agent` pinning to an immutable published version, folded into
   `measure:guardrails`.
3. **Surfaces.** Web: the Agent Builder delivery in
   [agent-builder-ui.md](./agent-builder-ui.md), including real list and detail
   routes, create-from-template, edit, draft/publish, and Try it live; the
   conversation trace viewer ties call history to the agent that served it.
   CLI listen: `--agent ID`.
4. **Later**: organizations and multi-principal sharing; knowledge attachments
   per agent; agent switching mid-call as a session tool, if real usage asks for
   it.
