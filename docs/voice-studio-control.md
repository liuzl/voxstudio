# Voice control of the Studio: the intent layer, not the whole surface

Status: Proposed, 2026-07-24. The third consumer of the tool loop
([tool-loop.md](./tool-loop.md), [mcp-tools.md](./mcp-tools.md)): Studio
operations registered as `ConversationTool`s, so the conversation can operate
the product it lives in. Scoped by two first-principles constraints — what the
voice channel is physically good at, and what the tool surface may cost the
conversation that carries it.

## The question

The Studio's operations (synthesis, the voice bank, design profiles, the
captures library, pronunciations) are reachable today only through panels and
CLI commands. The conversation loop already routes tools with a measured gate.
Should the Studio's operations join it — and which ones?

Two facts scope the answer:

1. **Channel physics.** Voice is a high-intent, low-precision, linear channel:
   excellent for "do X with Y" in one utterance (≤2 slots), poor for
   character-level editing, side-by-side comparison, and long-text entry. The
   Studio's operations span both ends. Pushing voice into the precision end
   produces tools nobody uses; the panels stay the right surface there.
2. **The tool-surface budget.** The conversation LLM is small (gemma), and the
   tool gate's numbers (0 false triggers, no multi-turn degradation —
   [tool-loop.md](./tool-loop.md)) were measured with 4 built-ins plus a few
   MCP tools. Routing accuracy degrades as the tool list grows. The core
   conversation is the product's spine; any Studio tool that costs it a false
   trigger is net negative. Capacity is measured **before** implementation
   (phase 1), not discovered after.

So the goal is deliberately narrower than "voice controls the whole Studio":
**voice covers the Studio's intent layer** — operations whose referents live in
the conversation itself, plus one-utterance launchers. Precision, comparison,
and bulk stay in the panels.

## Scope

In scope: conversation-referent operations (the payoff GUI cannot have — "刚才
那句" exists only in conversation state), one-utterance launchers, and a
runtime pronunciation overlay with explicit persistence. The same tool
definitions exposed to agents through `vox-mcp` (one registry, two consumers —
the pattern `createBuiltinTools` already established across CLI and gateway).

Out of scope, permanently and on purpose: transcript correction by voice
(character precision), audition *selection* by voice (comparison), long-text
entry by voice, bulk/batch operations, and config editing beyond the
pronunciation table. Out of scope for this design: persona rewriting, the
Stories editor (web-studio v2).

## Decisions

1. **Operations are tiered by channel fit; only tiers 1–2 become tools.**

   | Tier | Operations | Why |
   |---|---|---|
   | 1 — conversation-referent | save the last utterance as a voice sample; re-speak the last reply (different voice / speed); remember a pronunciation | The referent ("that", "what you just said") exists only in conversation state. GUI cannot express these. Tier 1 also closes the local flywheel: hearing a mispronunciation and fixing it becomes one spoken sentence. |
   | 2 — launchers | generate a take (voice + short text); audit a design profile for drift; engine health (already built) | Voice starts it, a panel carries the result. Saves a context switch; creates nothing new. |
   | 3 — everything else | correction, audition choice, long text, bulk, deletes-for-their-own-sake | Voice is the worse channel. Explicitly renounced. |

2. **The existing ceremony is reused unchanged; effects are assigned by
   consequence.** Queries are `read` (immediate). Operations that change only
   the running session — the pronunciation overlay, re-speak — are `session`.
   Anything that **persists or destroys** — registering a voice sample,
   persisting a pronunciation to config — is `external` and gets the spoken
   confirmation flow for free ([mcp-tools.md](./mcp-tools.md) §3): the agent
   restates ("要把刚才那句注册成音色 alice，确认吗？"), `confirm_action`
   executes, anything else drops it. No new safety machinery.

3. **`createStudioTools(deps)` beside `createBuiltinTools`, capabilities
   injected.** One definition in `packages/conversation`; each surface injects
   what it actually has — the gateway its capture library (`/promote` already
   exists) and union voice bank, the CLI its single-engine registry and
   utterance buffer. A surface that lacks a capability (no `--library`, no
   retained utterance yet) omits the dep and the tool answers a structured
   `{ error }` the model can relay ("没有可保存的语音 — 素材库未开启"), not a
   crash and not silence.

4. **Registration is contextual, not global — the structural answer to the
   tool-surface budget.** The 4 built-ins ride every conversation; Studio tools
   enter only when the surface opts in (`vox listen --studio-tools`, a Web
   conversation toggle). Demo mode (`--demo`) never registers them, exactly as
   it refuses MCP — an anonymous visitor must not write the voice bank by
   talking at it. The tool list becomes a function of context, so the everyday
   conversation keeps the small surface its gate certified.

5. **Pronunciations gain a runtime overlay; persistence is a separate,
   confirmed act.** Today `pronunciations` is config-load-time. The overlay is
   a session-scoped map consulted by the same TTS-boundary substitution;
   `remember_pronunciation` writes it (`session`, effective from the next
   reply). Persisting to the user's config file is a distinct `external` tool —
   the confirmation flow is the write barrier. This is the one piece of
   non-glue engineering in the design.

6. **The same registry serves agents.** `vox-mcp` today exposes
   speak/transcribe/list_voices; the Studio tools extend it so an MCP client
   can curate voices and run reproducible design experiments programmatically —
   with `external` mapped to MCP's annotation conventions (no `readOnlyHint`),
   so an agent-side confirmation stays possible where the host wants one.

## Tool inventory (initial)

| Tool | Effect | Referent / slots |
|---|---|---|
| `save_last_utterance_as_voice` | external | last finalized capture; slot: voice id |
| `redo_last_reply` | session | last reply text; slots: voice?, speed? |
| `remember_pronunciation` | session | slots: term, reading |
| `persist_pronunciations` | external | the session overlay |
| `generate_take` | session | slots: text (short), voice? |
| `audit_profile` | read | slot: profile id |

Descriptions are written once, in the model's working language, and become
gate constants — changing them means re-running the gate, the same rule the
prompt strings already obey.

## Phases and gates

1. **Capacity first: the gate decides whether the design proceeds.** Add the
   six tool *descriptions* (no handlers) to the `measure:tools` suite and run
   the enlarged surface against live gemma. Pass requires: every original
   case still passes (no false triggers on chat, `set_voice` still routes,
   multi-turn stable) **and** the new intents route to the right names with
   usable arguments. Fail → the fallback is a two-stage router (one `studio`
   meta-tool that narrows intent before dispatch), designed only if this
   measurement demands it — complexity is not pre-paid.
2. **Tier 1 trio + the overlay.** `save_last_utterance_as_voice` (library
   promote path), `redo_last_reply`, `remember_pronunciation` with the
   session overlay at the TTS boundary. Unit tests with a scripted LLM;
   **gate**: the three flows land by voice against the live stack — a
   mispronounced term is corrected mid-conversation and the next reply says it
   right; the promote asks aloud and executes only on "确认".
3. **Persistence + launchers.** `persist_pronunciations` (config write behind
   confirmation), `generate_take`, `audit_profile`; Web reflection — a spoken
   `generate_take` appears in the Generate panel's takes via the existing
   event path.
4. **The agent door.** The same tools exported through `vox-mcp`; the
   agent-voice gate grows the curation cases.
