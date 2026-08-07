# Voice agent roadmap: unified conversation, execution, and multimodal input

Status: living. Opened 2026-07-28; feasibility investigations completed
2026-07-29; converted to an executable integration plan 2026-07-29; implementation
status reconciled 2026-08-07.
Machine and deployment specifics live in the internal ops repo. This document
owns product behavior, architecture, delivery order, and promotion gates.

## 1. Outcome

VoxStudio should become a voice frontend for a long-running agent without
sacrificing the properties the conversation path already has:

- low first-audio latency and sentence-level streaming;
- certified barge-in and speculative turn-taking;
- typed tools and spoken confirmation for external effects;
- no retained audio unless a deployment explicitly enables retention;
- one OpenAI-compatible gateway contract across CLI, Web, and realtime clients.

The target agent can listen, speak, and act concurrently. Those are three
different lifecycles:

```text
ears:  microphone → VAD → ASR (+ optional LLM audio understanding)
mouth: speakable text → SentenceAssembler → TTS → playback
hands: agent executor → tools → artifacts
```

No lifecycle may accidentally control another merely because they originated
from the same user turn.

## 2. Decisions already made

### 2.1 Use the existing text/tool-call dual channel

Do not put speech and actions inside one structured-JSON response. Incomplete
JSON cannot be sentence-split, so it destroys TTS streaming and first-audio
latency.

- **Text is the speakable channel**: streamed through the existing
  `SentenceAssembler` and TTS path.
- **Tool calls are the action channel**: structured, typed, and subject to the
  existing effect and confirmation policy.
- Spoken output stays short and colloquial. Code, files, tables, and long
  results go to artifacts rather than being read aloud.

### 2.2 Embed pi behind a Vox-owned adapter

The selected executor is earendil-works/pi (formerly badlogic/pi-mono). Embed
`pi-agent-core` in the gateway process, but never expose pi types across the
adapter boundary. Pin its versions; its project and npm scopes have already
migrated once.

The conversation package remains the voice frontend and owns audio, playback,
turn-taking, and spoken confirmation. The executor owns multi-step model/tool
work. The gateway composes them.

The 2026-07-29 spike proved:

- `createProvider` plus `openai-completions` works against the local
  OpenAI-compatible llama-server;
- write → read → summarize completed in three tool rounds and 6.6 seconds;
- pi exposes the needed event, steering, hook, and cancellation seams under
  Bun;
- a dummy API key is currently required for a nominally keyless local provider.

Simple tool adherence is proven; complex chains are not.

### 2.3 Keep ASR; add audio as a second input channel

LLM-native audio is not an ASR replacement. ASR remains responsible for
captions, corrected history, keyterms, and the capture-library data flywheel.
Optional audio input restores tone, hesitation, laughter, non-speech events,
accent, and code-switching.

The current user turn eventually becomes:

```text
current turn: input_audio + ASR text hint
history:      corrected text + optional compact paralinguistic summary
```

Raw audio is not copied into retained conversation history by default.
Cross-session speaker identity is a separate voiceprint-sidecar project; it is
not an LLM prompt feature.

## 3. Interaction and ownership contract

This contract must land before the executor integration.
The accepted detailed state and race contract is
[`agent-lifecycle.md`](./agent-lifecycle.md).

### 3.1 Three independent controls

| Control | User meaning | Mouth | Hands | Conversation |
|---|---|---:|---:|---:|
| `stopSpeech` | user starts speaking over playback | stop immediately | continue | accept the new utterance |
| `steerExecution` | user changes or clarifies the task | stop stale narration | continue with steering | append a user message |
| `cancelExecution` | user explicitly says stop/cancel the task | stop | abort model and cancellable tools | report cancellation |
| `endSession` | user hangs up | stop | deployment policy decides | close realtime session |

Barge-in therefore must **not** call `Agent.abort()`. It stops the mouth. The
new utterance may steer the running executor after ASR finalizes. Only an
explicit cancel intent invokes executor cancellation.

This deliberately differs from the current conversation implementation, where
one turn `AbortSignal` cancels LLM, playback, and in-flight tool handlers
together. Agent mode must split that signal into at least:

```text
speechSignal      synthesis and playback for one narration
executionSignal   agent/model execution
toolSignal        one tool invocation, derived from execution policy
sessionSignal     gateway/session shutdown
```

### 3.2 Tool cancellation and effects

Keep the existing effect classes:

- `read`: executes immediately;
- `session`: changes only this Vox session and executes immediately;
- `external`: waits for explicit spoken confirmation unless operator-trusted.

An aborted read tool should stop when supported. An external tool that has
already crossed its commit point may be non-cancellable; cancellation then
means “stop waiting and report the eventual outcome,” not pretending the side
effect was undone.

Every side-effecting tool needs a stable invocation ID. Reconnect, retry, and
steering must never execute the same confirmed action twice.

### 3.3 Speech sources and priority

There are initially two speech sources:

1. executor text deltas for the current direct answer;
2. system-generated milestone narration through `queueAgentSpeech`.

Do **not** expose a model-visible `speak` tool in the first integration. It
overlaps both existing channels and can duplicate sentences. Add it later only
if a measured workflow requires the model to control an explicit mid-execution
utterance.

Milestone narration rules:

- speak only transitions meaningful to the user, not every tool event;
- coalesce repeated events and rate-limit progress speech;
- never speak secrets, raw tool arguments, paths, or long content;
- a newer update may replace queued but not-yet-audible progress;
- barge-in clears stale queued narration without cancelling execution.

### 3.4 Disconnect and shutdown

Phase 1 agent execution is session-scoped:

- transient WebSocket reconnect keeps the executor alive within the existing
  reattach window;
- explicit `endSession` cancels execution after bounded cleanup;
- gateway shutdown aborts execution and waits for a bounded drain;
- durable jobs that survive process restart are out of scope until a job store,
  ownership model, and artifact retention policy exist.

Hosted deployments additionally require per-user concurrency and operation
quotas. A task is always owned by the authenticated user that created it.

## 4. Internal executor boundary

Define a Vox-owned interface before adding pi:

```ts
interface AgentExecutor {
  start(input: AgentInput, context: AgentContext): AgentRun;
}

interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  steer(input: AgentInput): Promise<void>;
  cancel(reason: string): Promise<void>;
  close(): Promise<void>;
}

type AgentEvent =
  | { type: "text.delta"; text: string }
  | { type: "text.final"; text: string }
  | { type: "tool.started"; invocationId: string; name: string }
  | { type: "tool.progress"; invocationId: string; summary: string }
  | { type: "tool.completed"; invocationId: string; ok: boolean }
  | { type: "artifact.created"; artifact: ArtifactRef }
  | { type: "run.completed" }
  | { type: "run.failed"; code: string; message: string };
```

The exact TypeScript may change during implementation; the invariants may not:

- pi is replaceable without changing conversation or gateway protocols;
- every event belongs to a run and every tool event to an invocation;
- executor events contain display-safe summaries separately from raw data;
- cancellation has an observable terminal result;
- fake executors can deterministically test every composite state.

## 5. Artifact contract

Agent mode needs a destination for content that should not be spoken.
Introduce an artifact contract before broad tool access:

- immutable ID, owner, MIME type, size, creation time, and short description;
- bounded gateway storage with the same explicit-retention posture as the
  capture library;
- authenticated list/read/download/delete routes;
- Web conversation events carry references, never large artifact bodies;
- Web Studio renders safe previews and download links;
- tool output is not automatically retained unless promoted to an artifact.

Filesystem, shell, and arbitrary network tools remain disabled until workspace
isolation and artifact ownership are implemented.
The accepted execution boundary and isolation baseline is
[`agent-execution-sandbox.md`](./agent-execution-sandbox.md).

## 6. Multimodal input contract

The 2026-07-29 offline evaluation used 202 real captures plus known TTS
fixtures. Results:

| Task | Result |
|---|---|
| Clean audio + typo hint | single wrong character corrected perfectly |
| Real domain-term error | audio did not recover 过拟合/欠拟合; Qwen3-ASR revision later solved it at the ASR layer |
| Same/different speaker, 8 pairs | 7/8 correct, 1–2.5 seconds per pair |
| Tone/paralinguistics | useful qualitative descriptions |

Engineering constraints:

1. audio at or below one second is silently ignored by the tested Gemma path;
   pad only the LLM-bound copy with silence to at least two seconds;
2. audio costs about 27 tokens/second;
3. mmproj and MTP coexist, but draft acceptance fell from about 95% to 19% on
   audio turns, eliminating the useful speculative speedup.

Implementation requirements:

- extend `ChatMessage.content` from string-only to typed text/audio parts;
- serialize the same contract through `LlmClient` and the OpenAI-compatible
  facade;
- advertise an `audio-input` LLM capability and reject incompatible engines;
- add a session-level `audioUnderstanding` rollout flag, off by default;
- keep ASR, capture-library, VAD, and voice-registration audio unpadded;
- place only the current turn’s audio in the LLM request; history keeps text
  and, if useful, a compact derived paralinguistic summary;
- account for audio tokens in context limits and quota estimates;
- never log or retain base64 audio payloads by accident.

A separate multimodal LLM instance is preferred operationally, selected through
the engine registry. This avoids forcing mmproj and its memory cost onto the
default text-only path.

## 7. Delivery plan

### Phase A — lifecycle ADR and state-model tests

Deliver:

- formal `stopSpeech`, `steerExecution`, `cancelExecution`, `endSession`
  transitions;
- signal ownership and tool commit-point rules;
- reconnect, hang-up, and gateway-shutdown behavior;
- state-model tests with fake speech and fake execution.

Promotion gates:

- confirmed barge-in stops audible playback within 150 ms;
- barge-in never aborts the fake executor;
- explicit cancel reaches a terminal cancelled state;
- no superseded narration is heard after steering;
- no zombie event mutates a completed or cancelled run.

Status: contract, pure state-model tests, initial broker race tests, and the
gateway/player composition controller have landed. The composition controller
(`apps/realtime-gateway/src/agent-run-controller.ts`) composes one executor run
with the lifecycle and a speech sink under deterministic tests over fake speech
and fake execution; it enforces the promotion gates at the seam: barge-in stops
speech without aborting execution, steering is ordered and at-most-once, explicit
cancel is terminal and reported exactly once, milestones coalesce and are
preempted by direct answers, late events never mutate a finished run, and events
that race an explicit cancel are dropped in favor of the cancellation outcome.
The gateway speech-sink wiring has landed too
(`apps/realtime-gateway/src/agent-speech-sink.ts`): `speak` maps to
`queueAgentSpeech`, `cancelQueued` to a new `clearQueuedAgentSpeech` conversation
seam, and `stop` clears the queue and interrupts playback — verified end to end
with the fake executor narrating through the real conversation channel. The
measured 150 ms audible-stop gate on real playback remains before Phase A is
complete. Session-level executor integration and protocol events have since
landed in Phase B; Web UI state remains.

### Phase B — executor adapter with a fake backend

Deliver:

- Vox-owned executor types;
- gateway/session integration behind `agentMode: false` by default;
- deterministic fake executor covering text, progress, tools, artifacts,
  steering, failure, and cancellation;
- protocol events and Web UI state for run progress.

Promotion gates:

- existing non-agent conversation tests and latency gates do not regress;
- reconnect attaches to the same run exactly once;
- a run cannot leak across authenticated users or sessions;
- bounded shutdown drains or aborts every run.

Status: the zero-dependency `@voxstudio/agent-executor` boundary, fake
executor, fake `ToolRunner`, policy validator, and invocation ledger have
landed, and gateway/session integration now runs behind `agentMode: false` by
default. A session-scoped run starts on the first finalized user turn (audio or
typed), later turns steer it, `agent.cancel` cancels deterministically, barge-in
stops only narration, hang-up cancels with bounded cleanup, and run progress is
surfaced as `agent.run.*` protocol events. Web UI state for run progress and the
Web cancel/steer controls remain. This autonomous mode is separate from the
shipped saved voice-Agent runtime: naming a saved Agent resolves its conversation
configuration but must not implicitly set `agentMode: true`.

### Phase C — minimal pi backend

Deliver:

- pinned pi packages behind the adapter;
- local OpenAI-compatible provider configuration;
- executor text deltas into the existing speakable pipeline;
- `beforeToolCall` mapped to the Vox effect/confirmation policy;
- milestone events mapped to rate-limited `queueAgentSpeech`;
- only a small allowlisted tool set: one read tool, one session tool, and one
  test external-effect tool.

Promotion gates:

- a multi-step chain completes through voice end to end;
- zero external effects occur before spoken confirmation;
- a confirmed invocation executes at most once across retry/reconnect;
- barge-in stops speech but the chain continues;
- explicit cancellation aborts cancellable work within a defined timeout;
- simple chains meet or beat the measured 6.6-second spike baseline within an
  agreed tolerance.

### Phase D — artifacts and broader tools

Deliver artifact storage, routes, Web UI, retention quota, workspace isolation,
and only then expand the tool allowlist.

Promotion gates:

- artifact access is owner-scoped;
- path traversal and cross-user access tests pass;
- quota eviction cannot remove in-flight or explicitly retained work;
- secrets and raw tool payloads never enter narration or public events.

### Phase E — multimodal phase B

Deliver typed content parts, LLM audio ingestion, short-audio padding,
capability routing, and the opt-in session switch.

Promotion gates:

- the clean typo-correction fixture remains exact;
- the 8-pair speaker comparison does not regress below 7/8;
- sub-one-second speech becomes perceptible after LLM-copy-only padding;
- text-only sessions have no latency or memory regression;
- audio is absent from retained history and logs by default;
- MTP behavior on audio and text turns is measured in the production topology.

Phase E can proceed in parallel after Phase A. It must not block the executor
adapter and must not be required for agent mode.

## 8. Ecosystem decisions and watchlist

The 2026-07-29 audio.cpp evaluation produced these decisions:

- **Adopted**: Qwen3-ASR-0.6B as the final-pass revision tier. It was
  character-perfect on the Mandarin gold transcript and fixed the
  过拟合/欠拟合 failure at about 0.5 seconds per utterance, RTF 0.15. The
  FunASR adapter forwards `revise=true` and falls back to SenseVoice.
- **No TTS engine change**: audio.cpp VoxCPM2 measured RTF 1.46 and Qwen3-TTS
  1.18 versus VoxStudio’s 0.41–0.63. The Metal conv-transpose occupancy fix was
  contributed upstream as 0xShug0/audio.cpp#149 (merged 2026-07-29; maintainer
  measured exact WAV parity and 49–61% end-to-end reduction across VoxCPM2
  paths). Post-merge retest 2026-07-31 on yutu (upstream `f32876c`,
  voxcpm2-q8_0, offline voice-design): RTF 0.79–0.84 — AudioVAE decode is now
  ~0.10 RTF and the AR generator (~0.69 RTF) dominates, so the 0.7 re-eval
  trigger was not met and this decision stands.
- **Mandarin streaming ASR remains open**: Nemotron measured about 6% CER and
  missed domain terms; Voxtral substituted, truncated, and omitted
  punctuation. Neither clears the speculative-turn-taking bar.
- **No VAD change**: VoxStudio already embeds Silero v5 in-process with an
  energy fallback.
- **Forced alignment is not the primary TTS bad-case detector**: Qwen3 forced
  alignment compressed a ghost sentence rather than flagging it; ASR
  round-trip comparison is more direct.
- **No deep audio.cpp fork**: cherry-pick needed pieces and contribute fixes
  upstream.

Voice design is a VoxCPM2 prompt convention, not a separate engine capability:
the `(style description)` prefix works after making the server’s `voice`
parameter optional (liuzl/VoxCPM.cpp `9c5733c`).

Moonshine remains watch-only: Mandarin CER measured 25.76% and it has no
Mandarin streaming path.

Re-evaluate when:

- audio.cpp or another engine gains production-quality Mandarin streaming ASR;
- audio.cpp VoxCPM2 on Metal drops below RTF 0.7 (retested 2026-07-31 after
  the merged occupancy fix: 0.79–0.84, not triggered; the remaining gap is in
  the AR generator, so only a generator-side speedup would re-open this);
- a voiceprint sidecar is justified by a concrete cross-session identity
  product requirement.

## 9. Current state

| Item | State |
|---|---|
| Multimodal offline evaluation | done; viable with known padding/history/MTP constraints |
| pi feasibility spike | done; adopt behind a Vox adapter |
| Existing typed tools and spoken confirmation | shipped |
| Qwen3-ASR final revision tier | shipped |
| Executor lifecycle contract | accepted; pure state model and race tests landed |
| Sandbox/tool-broker security baseline | accepted; real isolated runner remains Phase D |
| Gateway/player composition controller | landed (`agent-run-controller.ts` + `agent-speech-sink.ts`; fake-executor run narrates through the real conversation channel); real-playback 150 ms promotion measurement pending |
| Vox executor adapter | types, fake executor, fake ToolRunner, and invocation ledger landed |
| Gateway/session executor integration | landed (session wiring behind `agentMode: false`; `agent.run.*` events, steer, `agent.cancel`, barge-in, hang-up); Web UI run state pending |
| pi production dependency | not added |
| Artifact contract and UI | not started |
| Dual-channel conversation input | not started |
| Voiceprint sidecar | separate future project |

The next autonomous-executor implementation change is the Phase B Web support:
consume `agent.run.*` as run progress and add Web cancel/steer commands under
deterministic tests. This support remains dormant unless a caller explicitly selects
autonomous mode; the existing Agent Builder Try it live flow must not infer
`agentMode: true` from a saved Agent id. pi is not installed, so no ordinary product
surface should advertise autonomous execution as available yet.
