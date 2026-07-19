# Conversation etiquette

Status: Accepted, 2026-07-19. Phase 1 delivered the same day — suite green and the
live probe passed (see Phases). The three cheap adoptions from the xAI survey
([competitive-voice-agents.md](./competitive-voice-agents.md) §3), taken our way:
a welcome line, a follow-up after silence, and pronunciation overrides. The first
two share one new primitive — the **agent-initiated turn** — and the third is the
mirror twin of keyterm correction on the TTS side.

## Scope

- **Welcome**: a session may open with the agent speaking a configured line before
  any user speech. Interruptible exactly like any reply — barge-in is the existing
  machinery, not a second toggle.
- **Silence nudge**: after a completed exchange, if the user stays silent for a
  configured window, the agent speaks one short follow-up. Once per gap — a nudge
  that repeats is nagging.
- **Pronunciation overrides**: configured term → reading substitutions applied at
  the TTS boundary only. Captions and history keep the original spelling; only the
  voice changes. ASR keyterms pull misheard words back; this pushes hard words out
  right — the same conservative philosophy at the opposite edge.

Out of scope: model-generated nudge text (phase 2 — fixed text is deterministic
and free; a generated nudge needs its own measured gate), Web start-card fields
(the protocol carries the options; UI later), guardrails.

## Decisions

1. **The kernel gains one edge: `startAgentTurn()`.** From `listening` with no
   active turn, a turn is created directly in `finalizing` — no user speech
   states, no VAD. Everything downstream is untouched: `startThinking` →
   `startSpeaking` → `complete`, the same abort signal, the same timing event
   (offsets simply lack the speech points), and crucially the same barge-in path —
   `startUserSpeech` during an agent turn interrupts it like any reply. Refused in
   any other state: the agent never talks over the user.
2. **The loop speaks agent turns without ASR or LLM.** `speakAgentText(text)`
   drives the existing reply pipeline (chunking, clause fast path, players,
   audible-clock completion) with a one-delta stream. A completed agent turn
   enters history as an assistant message — the model knows it greeted or nudged;
   an interrupted one leaves no trace (the heard-only rule, unchanged).
3. **Welcome is a start option; the nudge is a timer in the frame loop.**
   `welcome` (text) speaks once at loop start. `nudgeAfterSeconds` arms after each
   audibly-completed turn, disarms on any speech start or new turn, fires at most
   once per gap, and only while the session is `listening`. Both ride
   `SessionStartOptions` (gateway) and CLI flags; both off by default — etiquette
   is opt-in, not ambience.
4. **Pronunciations are config, applied in `transformChunk`.** A top-level
   `pronunciations:` map (term → reading) resolves longest-term-first, whole
   occurrences, before `sanitizeForTts` in the conversation loop and `vox say`.
   The seam already exists precisely so TTS text can diverge from caption text.

## Phases and gates

1. **Kernel edge + loop primitives + config + CLI/gateway wiring.** Unit tests:
   the kernel refuses `startAgentTurn` outside idle listening and barge-in
   interrupts an agent turn; the welcome is synthesized before any user turn,
   enters history only when completed, and suppresses the mic in protected mode;
   the nudge fires once after synthetic silence, rearms only after the next
   exchange, and never fires disabled; pronunciations change what TTS receives
   and nothing the captions see. **Gate**: the suite green, plus a live-stack
   probe — a gateway session started with a welcome delivers reply audio before
   the client has sent a single frame, and a session with a short nudge window
   nudges exactly once through real engines.
   **Delivered 2026-07-19.** Nine new unit tests green (kernel edge, welcome
   history/interrupt rules, nudge once-per-gap, pronunciations at the TTS
   boundary only); the live probe against the local stack: the welcome turn
   started 32 ms after session start and spoke at 362 ms with zero client
   frames sent; the nudge fired at 2.5 s — the 2 s window after the welcome
   finished audibly — exactly once across a 12 s silent watch. One honest
   mechanic surfaced by the probe: the nudge ticks on incoming microphone
   frames (a muted client that stops streaming will not be nudged) — real
   endpoints stream silence continuously, so this is the intended coupling,
   recorded here rather than discovered later.
2. **Later**: model-generated nudge text with its own measured gate; Web
   start-card fields; a follow-up count knob if real use wants more than one.
