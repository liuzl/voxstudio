# Long-text synthesis: why chunk, and how to join

Two constants in `core/voxcore/` look arbitrary and are not. Both were measured.

## Chunk at ~160 characters, not at the token limit

VoxCPM2 accepts a long passage in one call and will happily synthesize two minutes of
audio from it. The audio degrades in a specific way: **the timbre drifts away from the
reference voice as the generation runs.** Measuring speaker-embedding cosine similarity
against the reference audio, in 6s windows:

| chunking | chunk length | mean similarity | std | trend |
|---|---|---|---|---|
| 80 chars | 6–15s | 0.9113 | 0.018 | −0.002 / min |
| **160 chars** | 19–28s | 0.9064 | **0.016** | −0.001 / min |
| 240 chars | 38–43s | 0.8945 | 0.019 | −0.015 / min |
| 320 chars | 18–55s | 0.8772 | 0.030 | −0.003 / min |
| whole text | 119s | 0.8639 | 0.036 | **−0.060 / min** |

The single-pass curve falls monotonically — 0.90 at the start, 0.77 by the two-minute
mark. It is not noise. Pooling every arm by "seconds since this chunk began" shows the
decay starts immediately and steepens past ~30s; there is no safe plateau to sit on.

The mechanism: the reference audio conditions the generation, but that conditioning is
diluted with every autoregressive step, as the model increasingly attends to the audio
it just produced. A chunk boundary re-injects the reference. It resets the timbre.

So chunking is **not** a workaround for `max_len=4096` — 675 characters never came close
to that ceiling. Chunk to hold the voice. 160 characters buys a flat curve with half the
seams of an 80-character split; the 0.005 similarity the smaller chunks gain isn't worth
doubling the joins.

Prosody drifts too: the same text runs 13% shorter as one generation than as five
chunks. The model speeds up as it loses the reference.

Send the chunks **serially**. The engine's peak VRAM grows with the length of a single
generation and torch's caching allocator does not release it, so overlapping requests can
walk a shared GPU into an out-of-memory 500.

## Join with a trimmed edge, matched loudness, and one fixed pause

Seams carry no click. Every chunk begins and ends in silence, so the waveform is already
continuous across a join — measured sample discontinuity stays under 0.0008 of full scale.
Three things go wrong instead, and all three are audible.

**Pause length.** Each chunk arrives with its own edge silence, and raw concatenation sums
two of them into every seam:

| method | resulting seams | verdict |
|---|---|---|
| raw concatenation | 640 / 170 / 570 / 490 ms | wildly uneven; the narration's rhythm twitches |
| 40ms equal-power crossfade | 40 / 50 / 50 / 50 ms | sentences collide, no breath — crossfade is for music, not sentence boundaries |
| **trim + fixed pause** | 210 / 210 / 210 / 210 ms | matches a sentence break inside a chunk |

Uneven is worse than uniformly long. Measure the gap the way a listener perceives it —
audio below 25dB under the *speech* level, not below the *peak* — and the model's own
median inter-sentence pause is **210ms**. (An earlier revision used 290ms here. That number
came from a peak-relative gate, and applying it to a perceptually-gated position made every
seam about 80ms too long. Two different rulers.)

**Trailing decay.** A chunk often trails off into a quiet fade that sits well above a
peak-relative gate. Gate against the speech level instead, or the audible gap runs far
longer than the pause you inserted: one seam measured 580ms of perceived silence where
290ms was intended.

**Loudness.** Chunks are generated independently and their speech levels land up to 4dB
apart. Across a silent seam that step reads as the narrator leaning toward the microphone.
Level every chunk to the first one.

### Do not trim to the first loud frame

Unvoiced consonants — the aspiration in `ch`, `sh`, `t`, `k` — carry almost no energy and
decide which syllable a listener hears. Cutting to the first frame that clears an energy
gate shaves them off, and the chunk opens on a bare vowel that sounds slurred. Keep
`edge_pad_ms` (default 40ms) of sub-gate audio on each side.

That padding is part of the gap the listener hears, so the silence actually inserted is
`join_pause_ms - 2 * edge_pad_ms`. `join_pause_ms` is what you tune; it is the perceived
gap. It depends on the reference voice and speaking rate — re-measure when you swap voices
rather than inheriting 210.

## Streaming: ramp the chunks up

Chunks are synthesized serially, so the first one can play while the rest are still being
made. Two things decide whether that works.

**The opening chunk sets the latency.** Nothing is heard until it exists. `first_max_chars`
(default 24) caps it, buying a first-audio latency of ~1.7s instead of ~11s, at the cost of
one extra seam.

**Every chunk must play for longer than the next one takes to make.** Synthesis runs at
roughly 0.33x realtime, so a chunk can afford to be about 3x its predecessor before the
listener catches up to the generator. `growth` (default 2.0) leaves margin. A uniformly
short opening chunk starts fast and then stalls — measured, chunk 1 gave 5s of audio while
chunk 2 needed 10s to synthesize.

Measured on a live engine with the ramp: first audio at 1.72s, and the buffer never ran dry.
The margin is thinnest at the very first seam (+0.67s) and grows from there (+4s, +17s,
+30s…). If that first seam ever stalls — a busy GPU, or the engine's `retry_badcase` firing
— raise `first_max_chars` or lower `growth`.

**The player must not block the producer.** `ffplay` drains its stdin at playback speed and
the pipe holds well under a second of audio. Writing to it from the synthesis loop makes
generation wait for playback: measured end-to-end RTF went from 0.33 to 1.04, and the buffer
was underrun at every seam. Pipe from a background thread (`sinks.PlayerSink` does).

## A note on `timesteps`

Lowering `timesteps` below the default of 10 does not speed up the PyTorch backend. Fewer
diffusion steps degrade the output enough to trip the engine's own `retry_badcase` check
(`audio_text_ratio > 6.0`), which silently re-synthesizes up to three times. Measured on a
GPU host, `timesteps=2` ran 3–7× *slower* than `timesteps=10`, with high variance. The
"use timesteps=6 in production" advice comes from the CPU C++ build and does not transfer.
