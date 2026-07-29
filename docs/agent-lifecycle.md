# Agent lifecycle and interruption semantics

Status: Accepted for Phase A, 2026-07-29. This is the behavioral contract for
agent mode. `docs/duplex-audio-architecture.md` remains authoritative for
ordinary conversation mode.

## Problem

The current conversation loop treats a user turn as one cancellation domain.
Confirmed barge-in aborts that turn, which correctly stops its LLM, TTS,
playback, and tool handler. A long-running agent cannot use that ownership
model: speaking over a progress update must not destroy useful work.

Agent mode separates four scopes:

| Scope | Owns | Ends when |
|---|---|---|
| session | realtime attachment and authenticated owner | hang-up, expiry, or gateway shutdown |
| execution | one agent task and its model loop | complete, fail, explicit cancel, or session policy |
| invocation | one tool call | tool terminal result or execution policy |
| speech | one direct answer or progress narration | audible completion, replacement, or barge-in |

Signals flow down this hierarchy only when the policy says so. Speech never
owns execution.

## Controls

### `stopSpeech`

Triggered immediately after the existing provisional barge-in gate confirms
real speech.

- abort current synthesis/playback;
- clear queued narration that is now stale;
- keep execution and committed tool calls alive;
- begin capturing the new user utterance.

This control does not wait for ASR or intent classification.

### `steerExecution`

Triggered after the interrupting utterance is transcribed and classified as a
clarification, correction, or new direction for the current task.

- append one user input to the existing run;
- let the executor decide whether uncommitted model/tool work is superseded;
- do not retry or undo committed side effects;
- reject steering after the run reaches a terminal state.

Steering inputs are ordered and processed at most once. A reconnect may resend
the client command, so the gateway command idempotency key remains required.

### `cancelExecution`

Triggered by a deterministic UI command or a structured cancel intent. Free
text from the model is never sufficient evidence that cancellation happened.

- stop current and queued speech;
- abort executor/model work;
- abort cancellable invocations;
- preserve committed invocations and report their eventual outcome;
- emit one observable terminal cancellation event.

The first implementation recognizes cancellation through an explicit protocol
command and Web control. Voice intent is added only with a measured classifier
and a conservative ambiguity rule: ambiguous phrases stop speech and steer,
but do not cancel hands.

Examples:

| Utterance | Control |
|---|---|
| “别说了，继续做” | `stopSpeech`, then steering if it changes the task |
| “改成只处理今天的数据” | `stopSpeech`, then `steerExecution` |
| “算了，不做了” | `stopSpeech`, then `cancelExecution` |
| “停一下” | `stopSpeech`; ask or wait for clarification, no task cancel |

### `endSession`

- stop speech and reject new user input;
- Phase A policy cancels the session-scoped execution with bounded cleanup;
- wait up to the gateway drain deadline for terminal events;
- close remaining resources without claiming uncommitted effects were undone.

Durable jobs that survive session or process lifetime are a later product with
a persistent job store.

## State model

Execution and speech are orthogonal:

```text
execution: idle → running ↔ steering → cancelling → cancelled
                         └────────────→ completed
                         └────────────→ failed

speech:    silent ↔ speaking
```

`waiting_confirmation` and `tool_running` are run details, not mutually
exclusive top-level states: an executor may have one tool running while
another call waits for confirmation.

Terminal execution states are immutable. Events arriving after terminal state
are stale and must be ignored and logged without changing user-visible state.

## Races

### Tool completes while the user barges in

The speech scope stops. The invocation result remains valid and enters the run.
Any queued narration about an earlier milestone is replaced by a current
summary.

### Steering arrives while a tool is running

The invocation continues unless it is explicitly cancellable and the executor
decides it has not crossed its commit point. Steering never automatically
replays the invocation.

### Cancellation races with commit

The tool broker serializes the transition. Before `committed`, cancellation
may abort. At or after `committed`, the result becomes `completed`, `failed`,
or `outcome_unknown`; it cannot be labelled `cancelled`.

### Reconnect races with commands

Session reattach does not create a new run. All mutating commands and tool
invocations carry stable IDs. Duplicate steering, confirmation, and cancel
commands return their prior outcome.

## Speech scheduling

Direct answer text has priority over milestone narration. Milestones:

- are sanitized separately from raw tool arguments/results;
- are coalesced by run and stage;
- wait at least five seconds between audible progress updates by default;
- may be replaced until playback begins;
- are cleared by `stopSpeech` when they describe superseded state;
- never delay a confirmation question or terminal failure.

There is no model-visible `speak` tool in Phase C. Executor text deltas and
gateway-produced milestones are the only sources.

## Promotion gates

- confirmed barge-in stops audible playback within 150 ms;
- barge-in leaves the fake execution signal un-aborted;
- explicit cancellation produces exactly one terminal event;
- steering is ordered, at-most-once, and rejected after terminal state;
- a committed tool is never reported as cancelled;
- no late event mutates a terminal run;
- reconnect reattaches to the same run;
- bounded shutdown leaves no live run or child process.
