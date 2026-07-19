# OpenAI Realtime adapter

Status: Accepted, 2026-07-19. Phase 1 delivered the same day — the gate passed with
the official `openai` SDK against the live engine stack (see Phases). Implements the
subset adapter promoted to roadmap work in
[duplex-audio-architecture.md](./duplex-audio-architecture.md) §OpenAI Realtime
compatibility, plus the tool-event mapping that became possible when the tool loop
landed ([tool-loop.md](./tool-loop.md) phase 3).

## Scope

A translation layer that lets clients written for the OpenAI Realtime API — the
official `openai` SDKs, the realtime console, tooling written for xAI's
wire-identical endpoint — connect to this gateway by changing only their base URL.
The adapter speaks the **GA wire shape** (`response.output_audio.delta`, not the
beta names): it is the shape xAI adopted verbatim, which is what made this an
ecosystem play rather than single-client support.

Subset boundaries, unchanged from the evaluation:

- **WS only** — no WebRTC, no ephemeral tokens. The browser remote path stays LiveKit.
- **`server_vad` only** — `none` and `semantic_vad` turn detection are rejected.
- **Audio conversation + function tools** — text-only conversation items and
  history injection stay out; `function_call_output` items are in, because tools
  are the point of doing this now.
- **`GatewaySession` semantics unchanged** — the adapter is a sink-side translator;
  the one extension is an `extraTools` injection point (below), which the native
  protocol simply does not use.

## Decisions

1. **Same path, dialect detection at upgrade.** The OpenAI SDKs derive the WS URL
   from `baseURL` as `<base>/realtime?model=...` — the path is not configurable, so
   compatibility requires sharing `/v1/realtime` with the native protocol. The two
   dialects are distinguished per connection at upgrade time: a `model` query
   parameter, an `openai-beta` header, or an explicit `?protocol=openai` selects the
   adapter; everything else is native. Native clients never send `?model=`, and the
   native server never speaks first while the OpenAI server always opens with
   `session.created` — so the choice must be (and is) made before the first frame.
2. **The adapter is an `EventSink`.** It wraps a `GatewaySession` exactly where a
   WebSocket normally sits: native JSON events arrive as strings and are translated
   to OpenAI events; binary reply frames are resampled to PCM16@24kHz and emitted as
   base64 `response.output_audio.delta`. The session neither knows nor cares.
3. **Lazy session start.** OpenAI clients configure by `session.update` after
   connect; the native session needs its options at start. The adapter answers
   `session.created` immediately, folds updates into pending options, and starts the
   `GatewaySession` on the first `input_audio_buffer.append`. Later `session.update`s
   that only touch mappable fields are acknowledged; fields the running session
   cannot change reply with a non-fatal `error` event.
4. **Audio is transcoded at the boundary, honestly.** Input: base64 PCM16@24kHz →
   float32 → `LinearResampler` 24k→16k → `pushAudio`. Output: float32 at the
   engine's announced rate → 24kHz → PCM16 → base64. The `LinearResampler` moves
   from `apps/web` into `@voxstudio/audio` with its tests; the web client re-imports
   it. Only `pcm16` at 24kHz (the GA default) is accepted in `session.update` audio
   formats — `g711_ulaw`/`g711_alaw` are rejected rather than silently mis-decoded.
5. **Client tools ride the tool loop as first-class `ConversationTool`s.**
   `session.update.tools` (type `function`) are registered into the loop via the new
   `extraTools` option at lazy start. The handler is the round-trip: emit
   `response.function_call_arguments.done` + a `function_call` output item + complete
   the response, then await the client's `conversation.item.create` with a matching
   `function_call_output` (the client's follow-up `response.create` is acknowledged
   as the trigger it is in the OpenAI flow; the loop's refeed provides the
   continuation). A client that never answers resolves the handler with a structured
   timeout error after 15s — the model says so instead of hanging the turn. Client
   tool names colliding with the built-in session tools are rejected at update time.
   Mid-session tool list changes are not supported in the subset (the loop binds
   tools at start) and reply with an `error` event.
6. **Built-in session tools stay invisible on the OpenAI wire.** `set_voice` /
   `end_call` activity has no faithful OpenAI representation — a `function_call`
   event would invite the client to answer it. Their effects are audible; their
   events are native-protocol-only.
7. **Barge-in defaults on.** The OpenAI ecosystem assumes echo-cancelled endpoints
   and interrupt-on-speech (`interrupt_response` defaults true in GA); the adapter
   maps that to `bargeIn: true` unless `turn_detection.interrupt_response` is
   explicitly false. `playbackAck` stays off — the protocol has no audible clock.

## Event mapping

| Native | OpenAI (GA) |
|---|---|
| — (WS open) | `session.created` |
| — (`session.update` received) | `session.updated` |
| `turn.started` | `input_audio_buffer.speech_started` |
| `vad.end` | `input_audio_buffer.speech_stopped`, `input_audio_buffer.committed`, `conversation.item.added` (user audio item) |
| `transcript.final` | `conversation.item.input_audio_transcription.completed` |
| `session.state → thinking` | `response.created`, `response.output_item.added`, `response.content_part.added` |
| `response.text.delta` | `response.output_audio_transcript.delta` |
| `response.text.final` | `response.output_audio_transcript.done` |
| binary reply frame | `response.output_audio.delta` (base64 PCM16@24k) |
| `turn.completed` | `response.output_audio.done`, `response.content_part.done`, `response.output_item.done`, `response.done` (completed) |
| `turn.interrupted` | `response.done` (cancelled) |
| tool call (client-declared) | `response.function_call_arguments.done`, `response.output_item.done` (function_call), `response.done` |
| `error` | `error` |

Client → native: `input_audio_buffer.append` → resample + `pushAudio`;
`response.cancel` → `turn.interrupt` on the tracked turn; `session.update` →
pending options / non-fatal errors; `conversation.item.create(function_call_output)`
→ resolves the awaiting tool handler; `input_audio_buffer.clear` → acknowledged
(`input_audio_buffer.cleared`) with no kernel equivalent — the VAD has already
consumed the audio; anything else → `error` (unsupported in subset).

## Phases and gates

1. **Adapter + dialect routing + resampler promotion**, with unit tests driving the
   translator on scripted native event streams (exact OpenAI event sequences,
   audio round-trip within tolerance, tool round-trip incl. timeout, dialect
   detection). **Gate**: the official `openai` npm SDK's realtime WS client,
   configured with nothing but a base URL, completes against live engines: a spoken
   fixture in → `speech_started/stopped`, a transcription, audio deltas that decode
   to audible PCM at 24kHz, `response.done`; and a declared `function` tool that the
   model calls, the client answers, and the model speaks the result. The SDK is the
   "concrete client" the evaluation required.
   **Delivered 2026-07-19.** `bun run measure:openai` PASS against the live stack
   (kokoro/sensevoice/gemma): the SDK connected with only a base URL; the GA
   choreography arrived in order; the transcription was verbatim; the reply decoded
   to 8.2s of audible 24kHz PCM (turn ≈4.4s end-to-end); the model called the
   declared `get_current_time`, took the client's `{"time":"14:05"}`, and spoke
   "现在是下午两点零五分。" Two findings folded back into the design: RFC 6455
   requires echoing an offered subprotocol and Bun's upgrade does it automatically —
   adding the header manually duplicates it and fails the SDK handshake with a 1002;
   and the SDK hardwires `wss:` in its URL builder, so a plaintext loopback gateway
   needs the SDK's own `onURL` hook (the gate does this) or TLS in front.
2. **Ecosystem widening (later)**: the realtime console as a manual demo client;
   text conversation items and history injection if a real client needs them —
   priced as product features in `packages/conversation`, not adapter fidelity.
