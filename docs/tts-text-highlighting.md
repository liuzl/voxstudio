# TTS-synchronized text highlighting

Status: Proposed, 2026-08-02. This document records the design boundary and
rollout plan; no highlighting or alignment protocol described here is
implemented yet.

## Scope

VoxStudio should be able to highlight the part of an assistant reply that is
currently audible. The design must serve both realtime conversation, where
text and audio arrive incrementally and playback may be interrupted, and
generated takes, where the complete text and WAV already exist.

The feature has two useful fidelity levels:

1. **Phrase highlighting** follows the text chunks already used to feed TTS.
   It adds no model dependency and must not delay first audio.
2. **Fine alignment** follows Chinese characters or words in whitespace-based
   languages, using native TTS timing when available or forced alignment as a
   fallback.

The first level is the required baseline. Fine alignment is an optional engine
capability and must degrade to phrase highlighting without failing synthesis
or playback.

## Non-goals

- Estimating production word timing by dividing audio duration evenly across
  characters. Speech rate, punctuation, pauses, numbers, and mixed-language
  readings make that visibly drift.
- Using wall-clock event timestamps as the audible playback clock.
- Making forced alignment a detector for extra, missing, or hallucinated TTS
  speech. An aligner assumes the supplied transcript is correct; round-trip
  ASR is the more direct quality check.
- Delaying every realtime reply until a complete turn has been synthesized
  and aligned.
- Coupling the realtime protocol to VoxCPM, Qwen, FunASR, or one UI framework.

## Current path and missing information

The realtime gateway sends reply text as `response.text.delta|final`, announces
the output sample rate with `playback.format`, and then sends raw float32 PCM in
binary WebSocket frames. A binary frame has no turn, synthesis-chunk, text, or
content-offset metadata of its own; its association is implicit in the current
playback stream.

The conversation pipeline assembles model deltas into sentence or clause
chunks and then transforms each chunk before TTS. Conversation chunks currently
start with a roughly 1.2-second clause target, cap the first chunk at 2.5
estimated seconds, and cap later chunks at 8 seconds. A streaming engine can
emit several arbitrary PCM pieces for one text chunk, but the shared
orchestration output is only `PcmAudio`, so the text-chunk identity is lost
before the gateway player sees it.

Displayed and spoken text can also differ. Pronunciation entries are applied
only at the TTS boundary, and unspeakable characters are removed afterward.
For example, a displayed product name may be replaced by a Chinese reading.
An audio timestamp against the transformed string therefore cannot safely be
used as an offset into the displayed reply.

Finally, the browser schedules every received PCM piece on an `AudioContext`
timeline. It starts with a 0.7-second lead and inserts a new 0.7-second cushion
after an underrun. Consequently, `first playback time + content offset` ceases
to be correct after a rebuffer gap. The browser is the only component that
knows when each piece is actually audible.

## Decisions

1. Alignment positions are expressed in **turn-relative audio sample offsets**,
   not server timestamps or estimated wall time.
2. Text positions are expressed in **grapheme offsets into displayed text**.
   The pipeline preserves an explicit mapping from spoken units back to those
   display spans.
3. The orchestration boundary preserves synthesis-chunk identity across every
   PCM piece. Network framing may remain binary, but control metadata must make
   the cumulative audio range unambiguous.
4. The endpoint that schedules playback maps content samples onto its actual
   playback clock. Rebuffer gaps, suspension, cancellation, and barge-in are
   endpoint facts and must not be guessed by the gateway.
5. Phrase timing is always available. Fine alignment may arrive later and may
   be unavailable; it refines future highlighting without rewriting playback.
6. Alignment is revision-scoped. Events for an interrupted or superseded
   revision are ignored, and the active highlight clears immediately when its
   audio stops.
7. Native TTS timing and external forced alignment implement the same internal
   capability contract. Callers do not branch on model names.

## Text and audio model

The string-only `TextChunk`/`transformChunk` boundary should evolve toward a
structure equivalent to:

```ts
interface SpokenChunk {
  chunkId: string;
  displayText: string;
  spokenText: string;
  displayStartGrapheme: number;
  displayEndGrapheme: number;
  last: boolean;
}

interface AudioPiece {
  chunkId: string;
  samples: Float32Array;
  sampleRate: number;
  chunkStartSample: number;
}
```

`displayText` is the model reply shown in captions and retained in history.
`spokenText` is the pronunciation- and sanitation-adjusted TTS input. The text
transform must return a mapping rather than only a replacement string. Each
fine alignment unit can then point to a display span even when its spoken form
has a different length.

Grapheme offsets avoid splitting emoji, combining characters, and other user-
visible clusters. The protocol must define them independently of UTF-8 byte or
JavaScript UTF-16 offsets. Endpoints may build a grapheme boundary table once
per reply, using `Intl.Segmenter` in the web client.

## Realtime protocol

The exact envelope should follow the existing versioned gateway event shape.
The proposed payload is:

```ts
type PlaybackAlignment = {
  type: "playback.alignment";
  turnId: string;
  revision: number;
  chunkId: string;
  sampleRate: number;
  // Absolute content position in the turn's concatenated reply audio.
  audioStartSample: number;
  fidelity: "phrase" | "word" | "character";
  units: Array<{
    startSample: number;
    endSample: number;
    displayStartGrapheme: number;
    displayEndGrapheme: number;
    text: string;
  }>;
};
```

`startSample` and `endSample` are relative to `audioStartSample`. Sample
positions remain stable across transport latency and browser scheduling. The
gateway already serializes audio writes, so it can stamp every chunk with the
cumulative number of reply samples preceding it.

Phrase metadata can be emitted as soon as a chunk begins. Initially its end is
the start of the next phrase or the end of the chunk's audio. If the duration
is not yet known, a start marker followed by a closing marker is preferable to
inventing a duration.

Fine alignment may arrive after some PCM from the chunk. The event refines only
the portion that has not yet played. Late data is still useful for transcripts,
generated takes, replay, and lip-sync, but the realtime UI must never jump
backward to replay missed highlights.

Protocol tests must cover event ordering, partial binary frames, a sample-rate
change, stale revisions, reconnect snapshots, and an alignment event arriving
after `playback.ended` or `playback.interrupted`.

## Browser playback mapping

`SpeakerOutput.enqueue` should record one scheduled span per PCM piece:

```ts
interface ScheduledAudioSpan {
  turnId: string;
  revision: number;
  contentStartSample: number;
  contentEndSample: number;
  contextStartTime: number;
  contextEndTime: number;
}
```

The scheduling call already computes `contextStartTime`. Keeping that value
alongside cumulative sample positions preserves the exact mapping when the
timeline inserts a rebuffer gap.

While visible and playing, one `requestAnimationFrame` loop reads
`AudioContext.currentTime`, finds the scheduled span containing that time,
converts it to a turn-relative content sample, and selects the matching
alignment unit. No timer is created per word. If current time falls inside a
rebuffer gap, no new unit becomes active; the UI may retain the last completed
span in a subdued style or show no active highlight.

This design also handles background throttling: when rendering resumes, the UI
derives the current unit from the audio clock instead of replaying queued timer
callbacks.

On interruption, revision change, session reset, or `AudioContext` close, the
client removes scheduled spans and active alignment state for that playback.
The existing `playback.complete` acknowledgement remains the whole-turn audible
completion signal; alignment does not replace it.

## UI behavior

The reply remains selectable and copyable plain text. Rendering divides it
into stable spans derived from grapheme offsets, without changing the stored
reply string.

- Completed text uses normal foreground color.
- The active unit uses an accessible background and foreground combination;
  color is not the only state cue.
- Future text remains visible and is not dimmed enough to hurt readability.
- An interrupted turn clears the active unit and keeps the existing interrupted
  treatment.
- With `prefers-reduced-motion`, color may change but animated transitions are
  disabled.
- Chinese and Japanese default to character-level units when the aligner
  supports them. Whitespace-based languages default to words. Phrase mode uses
  the existing TTS chunks for every language.

The generated-take panel is the simplest fine-alignment proving ground: the
whole WAV is already available, and `HTMLMediaElement.currentTime` can drive
the same unit selection. Realtime conversation remains the stricter test
because it adds incremental text, stream underruns, and barge-in.

## Alignment capability

The internal service boundary should resemble:

```ts
interface AlignmentEngine {
  align(input: {
    audio: Float32Array;
    sampleRate: number;
    spokenText: string;
    language?: string;
    granularity: "word" | "character";
  }, signal?: AbortSignal): Promise<AlignedUnit[]>;
}
```

Selection order:

1. Native timing returned by the selected TTS engine, when the engine can bind
   it to the exact generated audio.
2. `Qwen3-ForcedAligner-0.6B` as the preferred multilingual self-hosted
   baseline. It accepts a known audio/text pair and returns word- or
   character-level times for eleven languages, including Chinese and English.
3. FunASR `fa-zh`/Paraformer timestamp prediction as a lighter Mandarin-only
   option when multilingual coverage is unnecessary.
4. Phrase timing when alignment is unavailable, times out, or fails validation.

The existing SenseVoice ASR service is not itself a fine-alignment source.
Adding `fa-zh` or Qwen forced alignment is a distinct deployment role and must
not silently change the configured conversation ASR engine.

Forced alignment needs a complete audio/text pair. With streamed TTS there is
therefore an unavoidable policy choice:

- **Latency-first:** play PCM immediately, use phrase highlighting, and apply
  fine markers only if they arrive before their audio is heard.
- **Accuracy-first:** collect and align a complete synthesis chunk before
  scheduling it, adding alignment wall time to playback latency.
- **Hybrid (recommended):** keep the first chunk latency-first and allow a
  bounded lookahead buffer for later chunks. Never hold audio beyond a
  configured deadline merely to wait for alignment.

The aligner must be benchmarked beside the production TTS topology before an
accuracy-first policy is enabled. Model size alone does not establish that it
will meet the marker deadline under GPU contention.

## Failure and quality boundaries

- If pronunciation replacement changes one displayed term into several spoken
  units, those units may share one display span. The UI must not manufacture
  subranges that do not exist in the displayed text.
- Punctuation may receive no acoustic duration. Attach it to the preceding
  display span or leave it unhighlighted; do not force a fake spoken interval.
- Extra TTS speech has no corresponding display span. Forced aligners can
  compress such audio into neighboring transcript units instead of reporting
  an error, so low-confidence or implausibly long/short spans fall back to the
  phrase unit. Round-trip ASR remains the bad-case detector.
- A sample-rate mismatch invalidates the alignment event unless positions are
  converted explicitly at the gateway.
- Alignment failure never cancels audible speech.
- Alignment audio and transient text follow the same retention policy as the
  conversation: do not persist them by default.

## Delivery plan

### Phase 1: phrase highlighting and clock correctness

- Preserve display ranges and chunk IDs through `streamReply` and
  `synthesizeChunks`.
- Add phrase alignment events with turn-relative sample offsets.
- Record scheduled audio spans in the browser.
- Render active phrase spans in conversation and generated-take views.
- Test normal playback, underrun/rebuffer, tab suspension, reconnect, and
  manual or voice barge-in.

This phase must not regress time-to-first-audio or require another model.

### Phase 2: fine-alignment benchmark

- Expose a separate self-hosted alignment endpoint and adapter.
- Benchmark Qwen3 ForcedAligner on representative Mandarin, English, mixed
  language, numbers, punctuation, and pronunciation-map fixtures.
- Record alignment RTF and p50/p95 wall time, marker lead time relative to
  audible playback, onset/offset error against a small manually labelled set,
  GPU memory under concurrent TTS/LLM load, and fallback rate.
- Prototype first in generated takes, where complete audio removes the realtime
  deadline.

Suggested product targets to validate, not upstream model claims: median onset
error below 80 ms, p95 below 180 ms, and no visible backward jumps.

### Phase 3: bounded realtime refinement

- Enable fine events for future audio when the aligner meets its deadline.
- Add a configurable lookahead ceiling for later TTS chunks.
- Keep phrase markers as the permanent fallback and expose alignment timing in
  developer diagnostics.
- Reuse the same sample timeline for phoneme/viseme events when a production
  avatar path is added.

## Acceptance criteria

The feature is ready for default phrase highlighting when:

- highlighted text follows what is actually audible through a forced rebuffer;
- interruption clears the highlight within the same UI frame as audio stop;
- stale revisions cannot highlight a newer reply;
- pronunciation mappings highlight the displayed term rather than its hidden
  reading;
- copying a reply returns exactly the original reply text;
- disabling or failing alignment has no effect on synthesis and playback; and
- automated tests exercise both continuous and starved playback timelines.

Fine alignment remains opt-in until its deployment benchmark demonstrates that
the chosen latency policy meets both first-audio and visual-drift targets.

## Related documents and upstream references

- [duplex-audio-architecture.md](./duplex-audio-architecture.md) — endpoint-
  owned playback clock, turn cancellation, and realtime media transport.
- [chunking.md](./chunking.md) — synthesis chunk policy and seam handling.
- [conversation-etiquette.md](./conversation-etiquette.md) — caption versus
  spoken-text transformations and pronunciation memory.
- [lipsync-bridge.md](./lipsync-bridge.md) — future viseme timing can share the
  sample timeline introduced here.
- [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM) — the current TTS engine's
  public streaming API yields audio chunks without a speech-mark contract.
- [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) — official forced-aligner
  interface and supported languages.
- [FunASR](https://github.com/modelscope/FunASR) — Mandarin timestamp-prediction
  alternative.
- [Amazon Polly speech marks](https://docs.aws.amazon.com/polly/latest/dg/output.html)
  and [Azure WordBoundary events](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-speech-synthesis)
  — established examples of audio offsets paired with source-text spans.
- [AudioBufferSourceNode.start](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start)
  — browser scheduling in the `AudioContext` time coordinate system.
