# Competitive notes: hosted voice-agent platforms

Status: living document. Purpose: track the hosted competition well enough to keep
VoxStudio's positioning honest — what they do better, what we deliberately do
differently, and which of their ideas are cheap to adopt. Surveys are product
walkthroughs on the stated date; capabilities may have moved since.

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

## Comparison

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
| Latency | unpublished (telephony path; needs measurement) | fully local p50 ≈ 2.1 s, every hop measurable |

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
   **Not worth chasing**: PSTN telephony — that is their moat, not our battlefield.
   Ours is self-hosting + swappable engines + reproducibility, and the comparison
   table says that positioning is real.
