# Tool loop

Status: Accepted, 2026-07-18. Phase 1 delivered the same day — the tool gate passed against the live engine and the by-voice demo ran (see Phases).

## Scope

The conversation gains the ability to *do* things: the LLM may invoke typed tools
mid-turn, results feed back into the same turn, and the reply is spoken as usual.
The loop lives in `packages/conversation`, so `vox listen` and the realtime gateway
gain it identically. It is also groundwork for two roadmap items: an MCP surface
(tools are the unit MCP speaks), and the OpenAI Realtime compatibility adapter
(whose tool events become mappable instead of stubbed — see
[duplex-audio-architecture.md](./duplex-audio-architecture.md)).

This document covers the tool contract, the cycle inside the streaming reply
pipeline, side-effect semantics, and the first tool set. It does not add any
external integrations.

## Spike evidence (2026-07-18)

Measured against the production conversation LLM (gemma4-12B-qat on a source-built
`llama-server`, OpenAI `tools` API, temperature 0), 16 voice-scenario cases in four
categories:

| Metric | Result |
|---|---|
| Explicit commands (switch voice / set speed / engine status / hang up) | **7/7**, arguments exact — including the implicit "说慢一点" → `rate: 0.8` |
| False triggers on plain chat (incl. the "你的声音真好听" decoy) | **0/5** |
| Edge cases (vague commands; requests with no matching tool) | **4/4** — no invented tool names |
| Malformed JSON / unknown tools across 32 responses | **0 / 0** |
| Tool-call turn latency | 0.5–1.3 s end-to-end — cheaper than a long text answer |
| Result round-trip | tool result → clean spoken confirmation, no spurious re-call |

Two systematic failures appeared with a bare prompt and were fixed by two hard
prompt rules (retested: no new false triggers):

1. **Farewells must call `end_call`** — otherwise the model says goodbye in words
   and leaves the session open.
2. **Claiming an action requires calling its tool** — otherwise the model answers
   "好的，我调慢一点" without calling `set_speed`: a state-change lie.

Honest limits at spike time: single-turn, temperature 0, 16 cases. Both were
measured off on 2026-07-18 (phase 2 below): the suite holds at turn 9 without
degradation, and compound commands land both tools through the loop's rounds.

## Decisions

1. **Tools are typed capabilities registered with the loop, not free-form.** A tool
   is `{ name, description, parameters (JSON schema), effect, handler }`; handlers
   are injected per surface (the CLI and the gateway provide implementations), the
   loop owns invocation, timeout, and result serialization. Handlers receive the
   turn's `AbortSignal` — a barge-in cancels an in-flight tool like everything else.
2. **The cycle lives in the reply pipeline's LLM stage.** `chatStream` carries the
   tool declarations; when the model returns tool calls, the loop executes them,
   appends the results, and re-requests — bounded (3 rounds per turn) so a
   confused model cannot loop. Text deltas keep streaming into sentence TTS exactly
   as today; a turn that opens with a tool call delays first audio by that round
   (measured sub-second locally).
3. **Side effects are declared, not guessed.** `effect: "read" | "session" |
   "external"`. `read` (status queries) and `session` (voice, speed, end_call —
   scoped to this session, trivially reversible) execute immediately. `external`
   tools require a spoken confirmation flow — deferred at writing, delivered
   2026-07-19 with the first external tools ([mcp-tools.md](./mcp-tools.md)) —
   and the field existed from day one so the boundary is structural, not
   remembered.
4. **The two spike rules are part of the certified prompt.** They ride with the
   loop's system prompt in `packages/conversation`, not per-surface improvisation;
   changing them means re-running the tool gate.
5. **The first tool set is self-referential** — zero external dependencies, the
   shortest possible loop from "say it" to "hear it done":
   - `set_voice(voice)` — validated against the live union bank; an unknown id
     returns a tool error the model relays in words.
   - `set_speed(rate)` — honest per-engine capability: the result says so when the
     active TTS engine does not support rate control.
   - `get_engine_status()` — the `/v1/engines` health surface, summarized.
   - `end_call()` — ends the session through the existing lifecycle.
6. **Tool activity is visible.** The gateway emits new, backwards-compatible v1
   events (`tool.call`, `tool.result` with name, arguments, and outcome) so the
   Web captions can show what happened ("已切换音色 → zliu"); the CLI prints the
   same. Tool calls and results enter conversation history under the existing
   heard-only rule: turns that were interrupted or superseded leave no trace.

## Non-goals

- External side-effect tools (mail, purchases, anything beyond the session) in
  phase 1 — and no confirmation UX until they exist to need it.
- MCP integration; the contract is shaped so an MCP client can later present
  MCP tools through the same registration, but none of it is built now.
- Parallel tool execution. Sequential, bounded, cancellable.
- Tools that mutate configuration beyond the session (registry edits, defaults).

## Phases and gates

1. **Contract + loop + the four session tools**, wired through `vox listen` and
   the gateway, with Web caption chips. Unit tests drive the cycle with a scripted
   LLM (call → result → reply, abort mid-tool, round bound). **Gate**: the spike's
   16-case suite promoted to a repeatable measurement against the live engine —
   thresholds 7/7 explicit, 0 false triggers, 0 invented tools — plus a live
   conversation demonstrating voice-switch and hang-up by voice.
   **Delivered 2026-07-18.** `bun run measure:tools` PASS on live gemma (explicit
   8/8, false triggers 0/5, edge 3/3, zero malformed/invented); live demo green —
   ASR heard "ZF001", the model normalized it to `zf_001` and switched, and a
   spoken farewell hung up only after it finished audibly. Two findings folded
   back into the design: a handler returning `{ error }` reports as a failed
   invocation while the model still reads the structured refusal (measured live:
   the model relayed a voice-not-found error and listed alternatives), and a
   server-side hangup releases the browser microphone — an ended session with a
   live capture is a privacy bug, not a UI nit.
2. **Multi-turn hardening**: measure tool reliability inside real multi-turn
   histories (does the 16-case suite hold at turn 8?); design the spoken
   confirmation flow for `external` tools on the `effect` field.
   **Measured 2026-07-18.** The gate gained two phases: the 16 cases asked at
   turn 9 of a realistic 8-exchange history that deliberately contains an
   earlier voice-switch conversation — 8/8 explicit, 0/5 false triggers, 3/3
   edge, identical to single-turn (the vague "换一个声音" even improved into a
   clarifying question citing example ids); and three compound commands driven
   through the loop's execute-and-refeed rounds — both tools landed every time,
   including `set_voice` → `end_call` sequencing, with zero malformed JSON or
   invented tools across all phases. The external-tool confirmation flow stays
   deferred until an external tool exists to need it.
3. **Consumers**: the OpenAI Realtime adapter maps its tool events onto this loop;
   an MCP surface presents MCP tools through the same registration.
   **Both delivered 2026-07-19**: client-declared Realtime functions ride the loop
   as bridged tools ([openai-realtime-adapter.md](./openai-realtime-adapter.md)),
   and MCP servers' tools join with the `external` effect and the spoken
   confirmation flow the `effect` field was holding a place for
   ([mcp-tools.md](./mcp-tools.md)).

No phase creates empty directories; each lands with its first tested module.
