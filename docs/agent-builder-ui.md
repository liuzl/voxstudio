# Agent Builder UI and experiential voice surfaces

Status: Accepted living product requirement, 2026-08-01; implementation status
reconciled 2026-08-02. This document expands the Web scope of
[agents.md](./agents.md). It records reference behavior, delivered slices, and
the remaining implementation order; it does not make either reference site's
information architecture part of VoxStudio.

## Decision summary

The visual-list mock has become a real saved-object workflow. The immediate
priority is now to complete that workflow: expose the remaining configuration,
validation, preview, and version lifecycle, then add deployment and inspection
of conversations served by one Agent.

The animated, experiential voice surface observed on StreamCore is useful, but
it comes after the Agent object and builder are real. The same Vox-owned voice
stage should eventually serve two contexts:

1. a future public Portal homepage that demonstrates the product immediately;
2. the Agent Builder's **Try it live** / preview surface.

The two reference lineages have different jobs:

- the authenticated xAI Voice Agent Builder informs the management workflow,
  configuration grouping, draft/publish lifecycle, and preview placement;
- the public StreamCore demo informs the focused voice-stage presentation and
  stateful audio visualization.

VoxStudio keeps its own navigation, terminology, runtime contracts, privacy
defaults, engine routing, and self-hosted deployment model.

## Current implementation state

The placeholder-object gap that motivated this document is closed. As of
2026-08-02:

- `@voxstudio/agents` owns the validated Agent specification, owner-scoped YAML
  registry, conditional revisions, immutable published snapshots, hashes,
  resolution, and audit;
- the gateway exposes owner-scoped CRUD, publish, audit, and version-list routes;
- templates create distinct persisted Agents rather than renaming a singleton;
- the Web list searches, opens, and deletes real registry records;
- `/agents/:agentId/configuration` and `/agents/:agentId/speech` are durable
  section URLs (with `/agents/:agentId` resolving to Configuration);
- the Builder edits and revision-safely saves identity, instructions, welcome,
  engine routes, MCP allowlists, voice, language, pronunciation overrides, ASR
  keyterms, turn-taking controls, maximum duration, and Studio tools;
- structural and live runtime-dependency checks block invalid saves, previews,
  or publishes as appropriate and identify unavailable engines, voices, and MCP
  bindings;
- Publish creates an immutable version; the Builder lists every snapshot, can
  restore one into a new mutable draft, and exposes duplicate, YAML export,
  audit, and delete actions;
- Try it live is a desktop drawer/mobile full-screen surface that explicitly
  selects either the revision-pinned draft or an exact immutable published
  version through the ordinary authenticated realtime path.

The Builder is nevertheless only partially delivered. Configuration, Speech,
Deployment, version lifecycle, and the core preview shell are implemented, but
preview text input, settings, feedback, and the complete failure matrix remain.
Agent-scoped conversation history, statistics, `VoiceStage`, and Portal reuse
have not started. Deployment currently covers immutable published identity,
runtime/auth status, and native plus OpenAI-compatible connection examples;
telephony attachment remains future work.

## References inspected

### xAI Voice Agent Builder

An authenticated console walkthrough was performed on 2026-08-01. The inspected
detail page used one stable Agent header and five sections:

- **Configuration**: instructions, guardrails, timezone, model, welcome message,
  opening-message interruption, tools, connectors, and file collections;
- **Speech**: voice, pronunciation overrides, ASR keyterms, language, speaking
  speed, and follow-up after silence;
- **Deployment**: phone-number attachment and realtime API integration examples;
- **Conversations**: retention notice, id/date/duration filters, and conversation
  rows;
- **Statistics**: live-call count, volume, minutes, cost, tool calls, duration,
  time to first audio, error rate, and transfer rate.

The header keeps Agent identity, live/draft state, last-published information,
**Try it live**, and **Publish** visible while moving between sections. Blocking
configuration problems are shown as a page-level actionable alert rather than
being buried inside the relevant form.

On desktop, Try it live opens as a right-side drawer without losing builder
context. On a narrow viewport it becomes a full-screen conversation surface.
The preview includes reset, close, voice settings, text input, microphone state,
start/stop controls, and response feedback.

Reference: [xAI Console](https://console.x.ai/) and the dated product notes in
[competitive-voice-agents.md](./competitive-voice-agents.md). Account, team, and
Agent identifiers are intentionally not recorded here.

### StreamCore public voice demo

The public [StreamCore voice demo](https://streamcore.ai/) was inspected on
desktop and at a 390 x 844 viewport on 2026-08-01. Its useful pattern is a
single-purpose voice stage:

- near-black full-viewport background;
- one organic animated audio object as the visual center;
- a single primary conversation action;
- restrained white/gray hierarchy with a blue-to-violet active accent;
- mobile reflow that keeps the complete experience in one viewport.

This is a presentation reference, not a complete console reference. Its small
mobile header targets, low-contrast secondary copy, hidden operational state,
and dependence on an animated canvas should not be copied.

## Target information architecture

```text
Agents list
  -> Agent detail
       |-- Configuration
       |-- Speech
       |-- Deployment
       |-- Conversations
       `-- Statistics
             |
             `-- Try it live (persistent drawer / mobile full screen)

Shared VoiceStage
  |-- Agent Try it live
  `-- future Portal homepage demo
```

Agent detail routes must be durable URLs, not only in-memory tabs. The target
shape is:

```text
/studio/agents
/studio/agents/:agentId/configuration
/studio/agents/:agentId/speech
/studio/agents/:agentId/deployment
/studio/agents/:agentId/conversations
/studio/agents/:agentId/statistics
```

The final route names may follow the existing lightweight router, but refreshing,
back/forward navigation, and direct links must preserve both Agent and section.
The `/studio/*` prefix is deliberate: it leaves `/` available for the future
public Portal without putting the Portal behind the Studio's account gate. After
that route migration and before the Portal ships, `/` will redirect to
`/studio/agents` in both deployment modes. The delivered interim routes remain
`/` and `/agents/:agentId` as recorded above.

## Agent detail shell

Every Agent section shares one header:

- Back to Agents;
- Agent avatar, editable name, id copy action, and optional description;
- explicit `Draft`, `Published`, `Drifted`, or `Invalid` status;
- last-published version, content hash, and timestamp when available;
- Try it live;
- Publish, enabled only when the draft is valid and differs from the published
  version;
- overflow actions for duplicate, export YAML, audit, and delete.

Validation or dependency failures appear directly below the header. Examples
include an unavailable engine, an invalid voice, an unauthenticated MCP server,
a missing file collection, or a guardrail that conflicts with deployment policy.
Each alert must identify the affected section and provide a direct action.

Desktop sections use a single readable form column with bounded width; they
should not become a dashboard of equal-size cards. Mobile keeps identity and
primary actions visible, makes the section tabs horizontally scrollable, and
uses one-column fields. The two-row wrapped tab treatment observed in the xAI
mobile page is not a target.

## Section requirements

### Configuration

Required for the first usable builder:

- instructions editor with dirty, saving, saved, and validation states;
- structured guardrails that can only tighten deployment policy;
- model/engine route summary with access to explicit ASR, LLM, and TTS routing;
- welcome-message enablement and exact or automatic greeting;
- welcome playback follows the Agent's ordinary barge-in policy — there is no
  second welcome-only interruption toggle;
- built-in tools and the allowed MCP tool/server subset;
- maximum session duration and other existing session ceilings.

Instructions remain plain text/Markdown. An AI rewrite action may be added later,
but it must produce a visible diff and never overwrite the draft silently.
Timezone is also deferred until a versioned runtime or tool-context consumer
exists; copying the xAI field before anything can honor it would create dead
configuration.

Knowledge/file collections are shown only after a Vox-owned attachment contract
exists. A disabled row may explain the future capability; it must not pretend
that the current capture library is already Agent RAG.

### Speech

- voice selection across the union voice bank, with engine ownership visible;
- voice audition without changing the draft;
- pronunciation overrides using the existing config -> Agent -> session layering;
- ASR keyterms;
- language hint with auto-detect as the default;
- speaking speed only after `speed` is added to the versioned
  `SessionStartOptions` contract; until then the builder omits the control rather
  than persisting an option the gateway cannot receive;
- follow-up-after-silence enablement and delay;
- advanced turn-taking controls behind a disclosure, not in the primary form.

Unsupported controls must be capability-gated. The UI must not save a speed,
language, or pronunciation option that the selected runtime cannot honor.

### Deployment

The first release provides self-hosted integration rather than copying xAI's
phone-number provisioning:

- published Agent id and version/hash;
- native realtime connection example;
- OpenAI-compatible realtime example using the Agent query parameter;
- copyable TypeScript, Python, and `curl`/WebSocket snippets where applicable;
- demo pinning status and the effective public-demo guardrails;
- API authentication and origin requirements without exposing credentials.

SIP/Twilio or other deployment-owner telephony adapters may appear here after an
adapter is implemented. VoxStudio does not promise carrier provisioning.

### Conversations

- Agent-scoped session rows with time, id, duration, outcome, and runtime version;
- filters for id, time range, duration, and status;
- a detail view with turn transcript, timing, barge-in/reopen events, tool calls,
  raw protocol events, and per-utterance replay when retained audio exists;
- explicit retention state and deletion controls.

The page must respect VoxStudio's privacy inversion. Conversation persistence is
disabled until a deployment explicitly configures a trace store. Retention is
classified rather than reduced to an audio toggle:

| Class | Examples | Default |
|---|---|---|
| operational aggregates | counts and latency distributions without content | in-memory only |
| session metadata | id, Agent version, times, duration, outcome | not persisted |
| conversation content | transcripts, tool arguments/results, raw events | not persisted |
| audio | per-utterance input/output replay | not persisted |

Enabling one class does not enable another. Every persisted row carries the
owner id internally, cross-owner reads return not found, and deletion, time/byte
limits, and startup reconciliation are part of the store contract. Demo mode and
the future public Portal keep content and audio persistence off regardless of
operator defaults. The UI reports the deployment's effective policy and never
copies a hosted vendor's fixed retention period.

### Statistics

Only measured fields are shown:

- active sessions and completed conversations;
- total and percentile duration;
- end-of-speech to first audible audio;
- interruption, false-barge-in, reconnect, and error rates;
- tool-call counts and outcomes;
- engine-route and Agent-version breakdowns;
- resource or quota usage when the deployment provides it.

Cost is omitted until VoxStudio owns a trustworthy pricing/metering input. Empty
states say that no observations exist; they do not render zeros that look like
measured success.

## Agent object and API prerequisites

The builder edits the same runtime specification used by CLI and realtime
session start, wrapped in registry metadata rather than pretending every UI field
is a session option:

```text
AgentRecord
  metadata   id, name, optional description, avatar seed/reference
  spec       options that resolve into SessionStartOptions and tool policy
  lifecycle  draft revision, published version/hash/time, audit state
```

`AgentSpec` contains behavior (instructions, welcome and silence follow-up),
speech (voice, language, pronunciation, keyterms and turn policy), runtime
routes, abilities, and guardrail ceilings. It resolves through the existing
session, configuration-overlay, and tool-policy boundaries; it does not require
every field to become a wire option. Presentation metadata and lifecycle fields
never enter `SessionStartOptions`. The publish hash covers the canonical
behavior-affecting `AgentSpec`, not the display name, avatar, timestamps, or
owner id.

The Web facade needs owner-scoped equivalents of:

```text
GET    /v1/agents
POST   /v1/agents
GET    /v1/agents/:id
PATCH  /v1/agents/:id
DELETE /v1/agents/:id
POST   /v1/agents/:id/publish
POST   /v1/agents/:id/audit
GET    /v1/agents/:id/versions
```

Patch, delete, and publish requests include the draft revision or ETag. Concurrent
edits fail with a conflict response instead of silently replacing a newer file.
The shared CLI/REST registry serializes mutations per `(userId, agentId)`; publish
allocates a version and validates the expected revision inside that critical
section, atomically writes an immutable published snapshot, then conditionally
updates the current-version pointer. Editing the mutable draft afterward does not
alter or erase that snapshot. Audit recomputes the draft and published snapshot
hashes independently; a hash alone is never treated as a recoverable published
version.

Self-hosted YAML remains the source of truth described in [agents.md](./agents.md):
one mutable draft plus immutable version snapshots. The REST facade is an editor
over that registry, not a browser-only database.

### Better Auth and owner scoping

The existing gateway identity seam is the integration contract. Better Auth is
loaded only for hosted account deployments and resolves browser sessions and API
keys to the same `AuthContext { userId, via }`. Self-hosted requests resolve to
the fixed `owner` user id. Agent code receives only `userId`; Better Auth cookies,
keys, sessions, schema, and types do not enter the registry or shared packages.

The registry's real key is `(userId, agentId)`:

- self-hosted `owner` keeps the readable flat Agent directory;
- hosted deployments place records below an owner namespace derived from a
  full SHA-256 digest of `userId`, never a raw user id path component;
- the same Agent id may exist for different owners;
- list, get, patch, delete, publish, audit, version reads, session start, and
  reconnect all receive the resolved owner explicitly;
- another owner's Agent reads as not found, matching capture and session behavior;
- cookie and API-key callers see the same Agent resources for their owner.

New Agent routes must be declared in the gateway's route catalog so dispatch,
OpenAPI discovery, demo refusal, and quota documentation cannot drift. CRUD and
hash-only audit perform no engine work and are uncharged. Realtime preview is
charged by the existing session-start and per-turn ledger; it must not add a
second REST charge. An audit mode that contacts an engine must be a separately
declared charged operation. Demo mode refuses create, patch, delete, publish, and
any audit that writes; it can expose only the deployment's pinned immutable
published Agent.

Better Auth protects its own `/v1/auth/*` mutations, not product REST routes.
After identity resolution, every Agent mutation whose `AuthContext.via` is
`session` must therefore pass the same exact hosted-Origin policy as the
realtime upgrade. API-key callers continue to authenticate explicitly by header
and do not need a browser Origin. This check belongs at the gateway boundary,
not inside the registry.

`auth.db` remains entirely owned by Better Auth. Agent records do not become
Better Auth tables, and a saved voice Agent is an owned product resource rather
than an account, credential, or independently metered principal. The proposed
operator ban is not implemented yet; before launch it must be verified to block
both cookie sessions and API keys, while leaving the account's Agents intact.
Account deletion remains unavailable until captures, voices, Agents, traces, and
keys have one explicit data-lifecycle policy.

## Try it live / preview

Try it live is bound to the current Agent and must never fall through to an
unscoped generic session.

It uses the existing authenticated realtime WebSocket and session creation path,
not a privileged preview endpoint. `session.start` names the Agent and explicitly
requests either the current draft revision or an immutable published version.
Ordinary API clients default to the latest published version; an authenticated
owner must opt in explicitly to request a draft revision. This is available to
the owner's hosted cookie session or API key, matching today's full-authority key
model, and to the self-hosted single owner. Both sources still pass deployment
ceilings, Agent guardrail tightening, capacity admission, quota charging, tool
confirmation, MCP policy, and the execution sandbox. Demo mode cannot preview
drafts.

Desktop behavior:

- opens a 380-440 px right-side drawer over the current section;
- preserves unsaved draft fields;
- clearly selects `Draft` or `Published` as the preview source;
- shows transcript, tool progress, timing, connection state, mute/talk, and stop;
- may expand into a larger focused stage without losing the builder route.

Mobile behavior:

- opens full screen;
- uses a 48 px minimum primary control height and 44 px minimum icon targets;
- keeps close/reset visible and places secondary settings in a bottom sheet;
- uses `100dvh` with safe-area padding and no accidental page scroll;
- returns to the same Agent section and draft after closing.

The preview uses a shared `VoiceStage` visual rather than the current static
waveform badge. State is never encoded by animation alone:

| State | Visual behavior | Required text/event truth |
|---|---|---|
| idle | almost still, neutral | Ready / not started |
| connecting | slow pulse | Connecting or reconnecting |
| listening | input-reactive, restrained | Listening + mic state |
| thinking | slow internal motion | Thinking + tool progress when applicable |
| speaking | output-reactive motion | Speaking + live transcript |
| interrupted | quick settle into listening | Interrupted/reopened turn event |
| error | motion stops | Specific recoverable or terminal error |

The component must support `prefers-reduced-motion`, a non-WebGL fallback, low
power mode, and deterministic state tests. Decorative motion cannot own session
truth; the existing event protocol does.

## Future Portal homepage

The future Portal homepage may use the same `VoiceStage` as a direct product
demonstration. It is deliberately not the first implementation target.

On a hosted public deployment, `/` is the Portal and `/studio/*` is the
authenticated application. `AuthGate` wraps only the Studio branch. Direct
Studio links preserve the requested path through sign-in, and Better Auth social
sign-in callbacks return to that validated same-origin Studio path instead of the
public root. A self-hosted deployment bypasses the account card as it does today
and redirects `/` directly to `/studio/agents` unless its operator enables the
Portal.

This route split is one coordinated authentication migration, not only a router
change. The Auth UI already preserves a validated same-origin requested URL
through social sign-in and fails closed when `/healthz` cannot determine the
deployment mode. `AuthGate` still wraps the entire React root. Portal delivery
must move that gate to `/studio/*` and constrain the preserved callback to the
Studio branch. The product APIs remain server-authenticated regardless of which
static shell route is visible.

Portal-specific requirements:

- one curated, published demo Agent pinned by deployment configuration;
- immediate explanation of what VoxStudio is before microphone permission;
- explicit start action and microphone disclosure;
- optional text input when microphone access is unavailable;
- public-demo duration, quota, tool, and retention guardrails;
- no retained visitor audio by default;
- clear transition from demonstration to sign-in, documentation, or self-hosting;
- graceful static fallback for unsupported browsers and low-power devices.

The Portal may use a dark immersive presentation. The authenticated management
console remains the restrained light VoxStudio shell. Sharing the underlying
stage component does not require sharing the entire page theme.

## Delivery order

1. **Agent domain and registry — delivered 2026-08-03**: `AgentRecord`/`AgentSpec`, owner-scoped YAML registry, immutable
   published snapshots, resolution, CRUD, publish/audit, and native session start
   by Agent id, CLI Agent commands, and `vox listen --agent` are implemented.
2. **Builder foundation — delivered 2026-08-02**: the real
   list, template creation, durable section routes, shared header, revision-safe
   saving, publish, runtime-dependency alerts, and advanced Configuration/Speech
   controls are implemented, together with duplicate, YAML export, audit,
   delete, immutable version history, and restore-as-draft.
3. **Try it live — core preview shell delivered 2026-08-02**: revision-pinned
   draft or exact published-version start, transcript, connection truth, mute,
   stop reply, restart, and end use existing session events in a desktop drawer
   or mobile full-screen surface. Text input, settings, feedback, and the
   complete failure matrix remain.
4. **VoiceStage — not started**: state-driven visual, reduced-motion/fallback
   paths, and preview integration. This is the first implementation of the
   StreamCore-inspired presentation.
5. **Deployment delivered; history not started**: the durable Deployment route shows
   the published version/hash, public origin, authentication/demo truth, native CLI
   and WebSocket examples, and OpenAI-compatible TypeScript/Python examples. Agent-scoped
   conversation traces, retention truth, and only then measured statistics remain.
6. **Portal reuse — not started**: curated public Agent and hardened demo
   experience after the preview component has passed desktop/mobile and
   real-browser gates.

## Acceptance gates

- two Agents can persist different instructions, voices, routes, welcome text,
  and tool policy across reloads;
- a template creates a new Agent rather than renaming a singleton placeholder;
- list, detail, direct URL, browser back/forward, duplicate, rename, and delete
  operate on the registry;
- conflicting browser/file edits are detected;
- simultaneous CLI/Web publishes cannot reuse a version or move the published
  pointer from an unexpected draft revision;
- publish produces a stable immutable version/hash, editing the draft cannot
  alter the published behavior, and audit detects post-publish drift;
- a session started by Agent id resolves the expected effective options and
  refuses unknown, invalid, or cross-owner ids;
- Try it live can explicitly exercise draft and published versions without
  losing unsaved builder context;
- Try it live uses the same owner, capacity, quota, guardrail, confirmation, and
  sandbox path as an ordinary realtime session;
- desktop and mobile preview expose the same session truth and recover cleanly
  from microphone denial, disconnect, reconnect, interruption, and stop;
- metadata, content, events, and audio remain unpersisted unless their individual
  deployment policies enable them; demo and Portal content retention stays off;
- motion-off and non-WebGL modes remain fully usable.

## Non-goals

- copying xAI's global sidebar, wording, carrier business, or hosted retention;
- replacing the VoxStudio console with StreamCore's dark landing-page treatment;
- implementing fake connectors, knowledge, telephony, cost, or analytics rows
  before their runtime contracts exist;
- creating a second browser-only Agent schema;
- making Portal work block the Agent Builder.

## Related records

- [agents.md](./agents.md) — Agent object, registry, resolution, and publish model
- [web-studio.md](./web-studio.md) — existing Web architecture and delivered panels
- [competitive-voice-agents.md](./competitive-voice-agents.md) — xAI product survey
- [duplex-audio-architecture.md](./duplex-audio-architecture.md) — realtime events,
  reconnect, interruption, and audible playback ownership
- [conversation-etiquette.md](./conversation-etiquette.md) — welcome, silence nudge,
  pronunciation, keyterms, and language behavior
- [mcp-tools.md](./mcp-tools.md) — Vox connector/tool direction
- [agent-execution-sandbox.md](./agent-execution-sandbox.md) — tool security boundary
- [public-demo.md](./public-demo.md) — public-session guardrails and retention boundary
- [auth.md](./auth.md) — Better Auth identity seam, ownership, quota, and account
  lifecycle boundary
- [StreamCore server survey](../research/reports/2026-08-01-streamcore-server-survey.md)
  — media-edge relationship and evidence limits
