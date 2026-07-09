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

## Join with a trimmed edge and one fixed pause

Seams carry no click. Every chunk begins and ends in silence, so the waveform is already
continuous across a join — measured sample discontinuity stays under 0.0008 of full scale.
The entire artifact is **pause length**.

Each chunk arrives with its own edge silence: 100–300ms at the head, 40–320ms at the tail,
and it varies chunk to chunk. Three ways to join five chunks of the same passage:

| method | resulting seams | verdict |
|---|---|---|
| raw concatenation | 640 / 170 / 570 / 490 ms | sums two edges; wildly uneven, the narration's rhythm twitches |
| 40ms equal-power crossfade | 40 / 50 / 50 / 50 ms | sentences collide, no breath — crossfade is for music, not sentence boundaries |
| **trim + fixed 290ms pause** | 290 / 290 / 310 / 290 ms | indistinguishable from a sentence break inside a chunk |

Uneven is worse than uniformly long. A 640ms gap exceeds the model's own longest natural
pause (470ms), and the 170ms one is too short — the listener hears the rhythm stumble
rather than a consistent style.

290ms is the **median of the model's own inter-sentence pauses** (IQR 240–377ms), measured
inside a single-pass generation. It depends on the reference voice and its speaking rate,
so `chunking.join_pause_ms` is configurable. If you swap the reference voice, re-measure
rather than inheriting this number.

## A note on `timesteps`

Lowering `timesteps` below the default of 10 does not speed up the PyTorch backend. Fewer
diffusion steps degrade the output enough to trip the engine's own `retry_badcase` check
(`audio_text_ratio > 6.0`), which silently re-synthesizes up to three times. Measured on a
GPU host, `timesteps=2` ran 3–7× *slower* than `timesteps=10`, with high variance. The
"use timesteps=6 in production" advice comes from the CPU C++ build and does not transfer.
