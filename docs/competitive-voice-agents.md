# Competitive notes: hosted voice-agent platforms

Status: living document. Purpose: track the hosted competition well enough to keep
VoxStudio's positioning honest — what they do better, what we deliberately do
differently, and which of their ideas are cheap to adopt. Surveys are product
walkthroughs on the stated date; capabilities may have moved since.

Identity note: the OIDC-first position recorded in the 2026-07-26 survey was
superseded by [auth.md](./auth.md). The public self-serve entrance now uses
product-owned Better Auth accounts; OIDC remains a future enterprise plugin and
Cloudflare Access remains an option for private deployments.

## xAI Voice Agents (Beta) — surveyed 2026-07-17

**Form**: fully hosted agent-as-configuration on Grok. An agent is a console-edited
bundle of instructions + guardrails + speech settings; publish/try-live from the
console. No visibility into the internal stack (whether cascaded ASR/LLM/TTS or
speech-to-speech), and none of it is swappable.

**Console surface** (four tabs):

- **Configuration**: instructions (system prompt) with guardrails and a timezone; a
  welcome-message toggle plus a separate "caller can interrupt the welcome" toggle;
  **tools** (`end_call` built in, custom tools addable); **connectors** (OAuth
  integrations, e.g. Gmail); **file collections** (RAG corpus attachable to the
  agent).
- **Speech**: built-in or custom voices; pronunciation overrides; *keyterms* (brand
  and product names to bias recognition); language hint (**auto-detect default** —
  the same conclusion our start card reached by measurement); speaking speed; a
  "follow-up after silence" nudge.
- **Deployment**: **telephony is first-class** — phone numbers provisioned by xAI
  directly (or brought from other providers) and attached to the agent; plus a
  realtime WebSocket API (below).
- **Conversations**: call log (time / id / duration) with **30-day retention** on
  their infrastructure.

**Protocol observation (the important one)**: the code-integration sample connects to
`wss://api.x.ai/v1/realtime?agent_id=…` and speaks the **OpenAI Realtime wire shape
verbatim** — `conversation.item.create`, `response.create`,
`response.output_audio_transcript.delta`, `response.output_audio.delta` with
base64-encoded audio. The OpenAI Realtime protocol is consolidating into the
de-facto realtime-voice wire standard across vendors.

### Re-survey 2026-07-25 — logged-in console walkthrough

The Voice Agent Builder left waitlist for open beta (announced 2026-07-01); this
pass was a hands-on tour of a live account, not a product page. Deltas against
the 07-17 survey:

- **Two-stage tool disclosure is production practice.** Connected apps are not
  flattened into the tool list: the agent template instructs
  `search_connected_tools` first, then `call_connected_tool` with the exact
  name returned — a meta-tool router over a large tool surface. This is the
  strongest external evidence yet for the capacity-gate fallback in
  [voice-studio-control.md](./voice-studio-control.md) (phase 1): the pattern
  our design holds in reserve is what they ship.
- **The stock instructions encode our gate's failure modes as prompt law.**
  "Never claim you transferred… unless a tool in your tool list just returned
  success" is claiming-without-calling; "Call tools by exact name. Do not
  invent tools" is the invented-tool check. Independent convergence on the
  same two failures the tool-loop gate measures.
- **The etiquette surface has fully converged.** Their Speech tab is our five
  knobs one-for-one: pronunciation overrides, keyterms, language auto-detect,
  speaking speed, follow-up-after-silence — plus the interruptible welcome
  toggle. This area is now table stakes, not differentiation, in either
  direction.
- **Observability is their strength worth borrowing.** Per-conversation trace:
  full-call waveform, per-turn transcripts with timestamps and **per-utterance
  audio replay**, a raw-events view, download/share. 30-day retention on their
  infra (the privacy inversion of our opt-in library stands). The per-turn
  replay + raw-events viewer is a cheap, high-value UI idea for our captures
  library / conversation panel — the event stream already exists.
- **Their realtime sessions accept text.** The integration sample sends
  `conversation.item.create` with an `input_text` item. When voxstudio grows
  text turns, supporting `input_text` in the OpenAI dialect aligns us with
  clients written for their endpoint.
- **Pricing anchor**: realtime audio $0.05/min ($3.00/hr), TTS $15/1M chars,
  STT $0.10/hr batch / $0.20/hr streaming; voices included, cloning from
  ≤120s reference clips; phone numbers provisioned free. $3/hr is the first
  concrete number a self-hosting TCO story can be told against.
- Connectors remain proprietary OAuth (Gmail "Log in" per agent) — the fork
  against our MCP route (07-19 conclusion) persists. Guardrails are
  first-class config; agents have a draft → Try-it-live → Publish lifecycle
  and five persona templates.

## OpenAI: GPT-Live + the unified ChatGPT desktop — surveyed 2026-07-24

Two launches in one week reshaped the reference landscape:

- **GPT-Live (2026-07-08)** replaces Advanced Voice Mode outright with a
  **native full-duplex** speech model: simultaneous listening/speaking,
  backchannels, mid-sentence interruption, and simultaneous translation.
  Architecture is two layers — a continuous interaction layer for the live
  back-and-forth, and a **delegation layer that hands harder questions to
  GPT-5.5 in the background**. Live-1 for paid tiers, Live-1 mini free.
  **No API at launch**; developers stay on GPT-Realtime via the Realtime API.
- **Unified desktop app (2026-07-09)**: Chat / Work / Codex as three surfaces
  of one app, all plans. Notably, **voice is not wired into the agentic
  surfaces** — GPT-Live lives in Chat only.

What this means for the positioning:

1. **The turn-based cascade's ceiling is now visible.** Interruption, overlap
   and backchannels become model-native; a cascade cannot match that feel.
   But voxstudio's bet is the *contract*, not the cascade: when open-weight
   full-duplex speech models arrive (the Moshi lineage points there), a
   duplex-speech engine is one more registry kind — the session protocol,
   gateway, and surfaces survive; only part of the turn state machine
   dissolves. **Watch item (re-check quarterly): open-weight full-duplex
   speech models.**
2. **GPT-Live's delegation layer validates our fast-path shape** — a fast
   mouth backed by a slower thinker is exactly the clause fast path and the
   planned agent-delegation pattern, at larger scale.
3. **Voice × agentic-surface integration is still nobody's shipped product**
   — OpenAI has all the pieces in one app and has not connected them. The
   voice-studio-control direction competes with an empty slot, not a leader.
4. Their data boundary (audio on their infra, no API, hosted only) leaves the
   self-hosted/measurable/reproducible position untouched.

## Comparison

Snapshot of 2026-07-17; the 07-25 re-survey above amends two cells: their
latency claim is now published ("sub-second", telephony path), and the
etiquette portion of the agent-abilities gap has fully converged both ways.

| Axis | xAI Voice Agents | VoxStudio |
|---|---|---|
| Hosting | fully hosted, zero ops; agent = config | fully self-hosted; engines, orchestration, surfaces all owned |
| Model stack | Grok, integrated and opaque | three swappable stages behind one contract (registry roles/capabilities) |
| Reach | **PSTN phone numbers**, WS API | browser studio, CLI, single binary; no telephony |
| Wire protocol | OpenAI Realtime de-facto shape (base64-in-JSON) | custom v1 (raw binary PCM, idempotent reconnect, endpoint-owned audible clock) — stronger semantics, isolated ecosystem |
| Agent abilities | **tools, OAuth connectors, RAG file collections, guardrails** — mature | typed tool loop shipped 2026-07-18 (4 session tools, by-voice demo, measured gate: 0 false triggers, multi-turn stable — [tool-loop.md](./tool-loop.md)); connectors/RAG not yet |
| Voices | built-in + custom, pronunciation/keyterm tuning; cloning depth unknown | cloning + zero-shot design + **SHA-256 reproducibility auditing** |
| Barge-in / turns | an interrupt toggle; quality not observable | certified gates with numbers (0 self-interruptions, 12/12 barge-ins, 574 ms p50 detection) |
| Data boundary | audio on their infra; 30-day conversation retention | in-memory by default; retention only by explicit action |
| Latency | unpublished (telephony path; needs measurement) | fully local, end of speech → first audio ≈ 1.0 s on long answers (clause fast path, 2026-07-19), every hop measurable |

## Positioning conclusions

1. **The OpenAI Realtime wire format is becoming the de-facto standard** — xAI
   adopted its event names wholesale. This raised the priority of our deferred
   compatibility adapter from "support one concrete client" to "join an ecosystem":
   one subset adapter makes every client and tool written for OpenAI or xAI realtime
   endpoints pointable at the VoxStudio gateway. Recorded in
   [duplex-audio-architecture.md](./duplex-audio-architecture.md) (the OpenAI
   Realtime compatibility section, update 2026-07-17).
2. **The agent-ability gap (tools / connectors / RAG) is a product gap, not a
   speech-technology gap.** Our loop is harder engineering where it counts
   (certified barge-in, reproducibility, measured latency), but "does things for
   you" was empty when surveyed. *Update 2026-07-18*: the tool loop shipped the
   next day ([tool-loop.md](./tool-loop.md)) — typed tools with declared effects,
   a measured gate (0 false triggers, no multi-turn degradation, compound
   commands landing both tools), and by-voice switch/hang-up demos on both
   surfaces. The remaining gap narrows to connectors (OAuth integrations) and
   RAG file collections — both `external`-effect territory awaiting the
   confirmation-flow design.
3. **Cheap adoptions worth taking**: the welcome-message toggle (with its own
   interruptibility), the follow-up-after-silence nudge, and pronunciation/keyterm
   hints (both are really engine-level parameters our engine layer can carry).
   *Update 2026-07-19*: all three taken —
   [conversation-etiquette.md](./conversation-etiquette.md) (welcome as an
   interruptible agent turn, one nudge per silence gap, pronunciations at the
   TTS boundary); ASR keyterms had landed 07-18 as engine-agnostic transcript
   correction. The connectors gap closed differently than xAI built it: MCP
   ([mcp-tools.md](./mcp-tools.md)) instead of proprietary OAuth integrations.
   **Not worth chasing**: PSTN telephony — that is their moat, not our battlefield.
   Ours is self-hosting + swappable engines + reproducibility, and the comparison
   table says that positioning is real.
   *Refined 2026-07-26*: the moat is the **carrier relationship** (numbers
   provisioned in-console), and that part stands unchallenged. But "no
   telephony" overreached: a self-hosted deployment terminating calls through
   **its own SIP trunk or Twilio account** is fully compatible with the
   positioning — an adapter, not an infrastructure. Deprioritized, not
   renounced.

## Positioning clarifications — what self-hosting does and does not exclude (2026-07-26)

Recorded because the boundary was mis-drawn twice in planning discussions
before it was drawn right, and the error has a repeatable shape: taking the
one true constraint — **we do not operate a hosted service that holds other
people's voice data** — and over-extending it to adjacent capabilities that
are orthogonal to who runs the servers.

| Capability | Verdict |
|---|---|
| **Multi-tenancy** (workspaces, isolation, per-tenant quotas) | Compatible — the natural growth path of a self-hosted install (the GitLab/Nextcloud shape). An org running one instance for many teams strengthens the data-boundary pitch: *your organization's voice data never leaves your machines, and the whole organization can use it.* |
| **A user system** (accounts, roles, identity) | Compatible and now delivered for individual hosted accounts through Better Auth, owner scoping, and per-account quotas. Organizations and roles remain future work; OIDC is reserved for enterprise SSO rather than the public entrance. |
| **Compliance features** (audit logs, retention controls, encryption) | Aligned, not merely compatible — organizations choose self-hosting *because* of compliance; the software's job is to be compliance-ready, certification belongs to the deployment. |
| **Usage accounting** | Split it: metering-for-billing external customers is the hosted business; internal quotas and chargeback are multi-tenant features. |
| **Telephony** | See the refinement above: no carrier infrastructure of our own; SIP/Twilio adapters are fair game. |
| **Operating voxstudio.cc with accounts** | Compatible while accounts hold identity + quota + downloads. The line is crossed only when visitor **voice assets** (recordings, cloned voices) persist on infrastructure we operate — that is a distinct business decision with retention, consent, and trust costs, not a side effect of adding login. |

The revised ladder is: zero-auth or optional-token self-hosting → individual
hosted accounts with product-owned identity and owner-scoped resources (delivered)
→ organizations and roles → enterprise SSO where justified. Agents
([agents.md](./agents.md)) gain the same owner dimension when their registry lands.
