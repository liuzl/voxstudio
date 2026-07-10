# Long-text synthesis: why chunk, and how to join

Two constants in `core/voxcore/` look arbitrary and are not. Both were measured.

## Chunk at ~15 seconds of speech, not at the token limit

VoxCPM2 accepts a long passage in one call and will happily synthesize two minutes of
audio from it. The audio degrades in a specific way: **the timbre drifts away from the
reference voice as the generation runs.**

The same 140s passage, synthesized under five chunk budgets, three times each. Every
chunk is embedded in 6s windows and compared, by cosine, against the reference audio the
voice was cloned from (ECAPA-TDNN speaker verification). `tools/measure_timbre_drift.py`
runs it; re-run it when you change the reference voice, because the drift rate belongs to
the voice as much as to the model:

| `max_seconds` | chunks | windows | mean similarity | std | trend |
|---|---|---|---|---|---|
| **15** | 12 | 80 | **0.7464** | 0.045 | −0.004 / min |
| 30 | 6 | 75 | 0.7214 | 0.047 | +0.003 / min |
| 45 | 4 | 75 | 0.7148 | 0.052 | −0.000 / min |
| 60 | 3 | 72 | 0.6999 | 0.051 | −0.013 / min |
| whole text | 1 | 70 | 0.6349 | 0.095 | **−0.121 / min** |

**Chunking resets the timbre.** Unchunked, similarity falls at −0.121/min and does not
stop. At 30s and below the trend is flat — the last chunk sounds like the first. Past 45s
the drift starts showing up inside the chunk.

Pooling every window by "seconds since this chunk began" says where the decay lives:

| since chunk began | 0–6s | 6–12s | 12–18s | 18–24s | 24–30s | 30–45s | 45–60s | 60s+ |
|---|---|---|---|---|---|---|---|---|
| mean similarity | 0.774 | 0.736 | 0.712 | 0.703 | 0.689 | 0.670 | 0.672 | 0.570 |

It starts at the first window and never stops. **There is no safe plateau to sit on**, so
a chunk's mean similarity necessarily falls with its length. Picking `max_seconds` is a
trade against seams, not a threshold below which nothing goes wrong.

The mechanism: the reference audio conditions the generation, but that conditioning is
diluted with every autoregressive step, as the model increasingly attends to the audio
it just produced. A chunk boundary re-injects the reference.

So chunking is **not** a workaround for `max_len=4096` — 675 characters never came close
to that ceiling. Chunk to hold the voice.

### Why the default is 15s and not 30s

Halving the budget buys +0.025 similarity (≈5 standard errors) and nearly doubles the
seams: 12 against 7, over a 140s passage. An earlier measurement, on a different speaker
encoder, put that gain at 0.005 and judged it not worth the joins. Both numbers are real —
**cosine scales are not comparable across encoders**; the same cloned voice scores 0.911
on the old one and 0.737 on ECAPA — but the old one made 15s look pointless and this one
does not.

Cosine cannot settle it. A listener compared the same 140s passage at both budgets, blind
to which was which, and preferred 15s: the extra seams did not bother them, and the voice
held. So the default moved.

That is **one listener, one trial, in a fixed order** (30s always played first), and the
order effect was not controlled for. It is the best evidence there is, not strong evidence.
If you disagree with it, `chunking.max_seconds: 30.0` gives back the old behaviour, and
`tools/measure_timbre_drift.py` will tell you what it costs in similarity. What the
measurement *can* settle is the shape: decay starts at the first window and never
plateaus, so there is no budget at which seams stop buying anything.

Prosody drifts too: the same text runs 15% shorter as one generation than when chunked
(125s against 145–155s). The model speeds up as it loses the reference.

### Send the chunks serially — and never send an unchunked one

The engine's peak VRAM grows with the length of a single generation, and torch's caching
allocator does not release it. Concurrent requests are the obvious hazard, but they are
not the only one:

**One long generation used to poison the process.** A 140s single-pass generation would
succeed on a freshly started engine and then make the *next identical request* fail with a
500. It was deterministic, and backing off did not help — the memory was not in flight, it
was cached. Only restarting the engine got it back.

That is fixed in `engines/voxcpm2-server`, and the fix took both halves. Measured as the
allocator's reserved pool, per second of generated audio:

| | in flight | left behind |
|---|---|---|
| stock | 1x | 1x |
| `+ torch.cuda.empty_cache()` after each generation | 1x | **1/40** |
| `+ PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` | **1/10** | 1/37 |

`empty_cache()` runs *after* a generation, so it hands back what was cached but cannot
bound the peak while the generation is running — and that peak is what returns the 500.
Expandable segments map and unmap on demand rather than reserving fixed-size blocks, which
is what collapses the peak. Neither alone is enough.

Verified end to end against a live engine sharing its GPU with a resident LLM: a two-minute
single-pass generation completes, and the co-tenant never restarts. Before, it did.

Chunk anyway. The peak is bounded now, but a 140s single generation still drifts away from
the reference voice, still runs 15% fast, and still cannot start playing until it finishes.

## The budget is seconds, and a character is not a second

Everything above was measured on Mandarin, where 160 characters happen to be ~30s. That
coincidence is not a rule. VoxCPM2 speaks thirty languages, and the same 160 characters
are 28 seconds of Chinese, 9 seconds of English, and 10 seconds of Greek. A character
budget silently means a different constraint in every script — and the constraint that
actually matters is **duration**, because that is what the timbre drifts with.

So `chunk_text` budgets in estimated seconds. The estimate is a per-script speech rate,
fitted by `tools/measure_speech_rates.py` against the live engine, on paragraphs of
roughly a full chunk's length. (Short utterances run measurably faster — they contain no
inter-sentence pauses — so sentences would have fitted the wrong regime.) Each paragraph
is generated five times and reduced by its **median**; rates are then pooled as
`total_chars / total_seconds`, not averaged per paragraph, because the question is how
long *N characters* take. The next section explains why five, and why the median.

| script | chars/sec | | script | chars/sec |
|---|---|---|---|---|
| Latin | 18.3 | | Khmer | 13.6 |
| Greek | 16.4 | | Hebrew | 12.5 |
| Cyrillic | 16.1 | | Arabic | 11.0 |
| Myanmar | 15.2 | | Hangul | 7.9 |
| Lao | 14.6 | | Kana | 6.3 |
| Devanagari | 14.4 | | Han | 5.7 |
| Thai | 14.0 | | *(unknown)* | 5.7 |

The table is keyed on **script, not language**, because a bare string carries nothing
else. It survives that approximation because rate is dominated by how much phonetic
content one character holds — an ideograph is a syllable, a Latin letter is a phoneme or
less. English, German, Vietnamese and Indonesian all measure within 4% of the pooled
Latin rate. Characters with no script of their own — spaces, digits, punctuation — are
charged at the rate of the script running before them.

Japanese is the one script that could not be pooled. Its text interleaves kanji with
kana, and the estimator charges the kanji at the Han rate, so the kana rate is solved for
under that assumption rather than read off the paragraph. It therefore inherits Han's
error on top of its own, and it is the least stable number in the table — four fits put
it at 5.1, 6.0, 5.3 and 6.3.

### The engine is not reproducible, and that floors the whole exercise

Synthesize the same paragraph six times, same voice, same `cfg_value` and `timesteps`.
The durations spread **13% to 25%** peak-to-peak:

| script | chars | six generations (s) | mean | spread |
|---|---|---|---|---|
| Han | 87 | 15.16 15.28 16.42 15.43 15.45 14.46 | 15.37 | 12.8% |
| Cyrillic | 254 | 13.65 13.97 14.24 16.26 14.77 14.57 | 14.58 | 17.9% |
| Latin | 297 | 15.31 14.07 14.77 16.58 18.09 16.44 | 15.88 | 25.3% |

The outliers are **one-sided**. A run comes back twice as long as its siblings, never half
as long — the engine's own `retry_badcase` check silently re-synthesizes a generation it
judges bad, and the retry lands in the audio. One such run in four drags a mean by 20% and
a median by nothing, which is why `tools/measure_speech_rates.py` reduces its repeats by
the median.

Three things follow, and they matter more than any digit in the table above.

**A rate measured from one generation per paragraph is mostly noise.** The first fit did
exactly that. Re-running it moved Han from 5.4 to 5.9 and Cyrillic from 18.3 to 15.0
without a line of code changing — and a *second* four-repeat fit put Cyrillic back at 17.2.
Two honest fits of the same voice, disagreeing by 15%.

**Only the first significant figure of a rate is real.** Han ≈ 6, Hangul ≈ 8, Arabic ≈ 11,
Latin ≈ 18. That is enough — the ratios the budget depends on (an ideograph costs three
times a Latin letter) tower over the noise. Do not tune the second digit; you would be
fitting the sampler.

**No estimator can predict a given generation's length**, because the engine will not
produce the same length twice. The budget must therefore leave room for a chunk that
happens to come out 25% long. It does: 15s becomes 19s, and the decay curve above is still
almost flat there.

Against held-out paragraphs the committed table lands within **±15.6%**, and every error
larger than 5% sits inside the engine's own spread on that same paragraph. That is the
floor: the fit cannot be shown to be better than the noise it was measured through. The
bias is deliberately toward over-estimating — a chunk that runs short costs one seam, a
chunk that runs long costs speaker similarity.

### What the estimate cannot know

A rare letter sequence gets spelled out, and a pronounceable one does not. Measured in a
fixed Chinese carrier sentence, seconds per character:

| probe | s/char | read as |
|---|---|---|
| `banana` | 0.060 | a word |
| `NASA` | 0.098 | a word |
| `voxcpm` | 0.205 | v-o-x-c-p-m |
| `TTS` | 0.203 | t-t-s |

Case is not the signal — `NASA` is uppercase and read as a word, `voxcpm` is lowercase
and spelled out. Telling the two apart needs a lexicon or a phonotactic model, which a
chunker has no business carrying, so **this is left unmodelled**. Normal prose is
unaffected: `banana` at 0.060 s/char is exactly the 18.3 chars/sec Latin rate. The error
concentrates in short chunks dense in acronyms, where a 25% overshoot is 0.7 seconds and
nothing drifts. A full-length chunk dilutes them; the shorter the budget, the less it does,
which is one more reason not to drive `max_seconds` far below 15.

Re-measure the table if you change the reference voice. Speaking rate is a property of
the voice as much as of the script.

### One pass over the text, not one per cut

The whole document is priced once, into a cumulative duration table, and every cut after
that is a bisect into it. This is not premature optimisation: `vox say -f` accepts a file
of any size, and a document that offers no sentence enders — one long Thai paragraph, a
wall of unpunctuated Chinese — gives the splitter nothing but its own tail to chew on. An
earlier revision re-priced that shrinking tail on every cut, which is quadratic: 10k
characters took 0.4s, 50k took 11s, and 100k took 45s **before the first TTS request**,
so the CLI simply appeared to hang. It is now linear, at ~0.35M characters/sec.

Pricing the document in one pass also means a character with no script of its own is
resolved by the text around it rather than by the chunk it lands in. A lone `।` at the
head of a chunk is charged at the Devanagari rate that follows it, not at the
unknown-script fallback. The one place this shows: a chunk's *leading* punctuation is
charged at the rate of the script that ran before the cut, so it can be off by up to
0.14s — under 1% of a 15s budget, and only where scripts change mid-sentence.

One consequence worth keeping: the per-chunk estimates sum exactly to the estimate for the
whole text.

## Where to cut

A chunk boundary inserts a pause and re-conditions the voice, so it should land where a
listener already expects one. In order of preference:

1. **After a sentence ender.** `。！？；` and `!?;`, plus the marks the other scripts use:
   the Devanagari danda `।`, the Arabic question mark `؟`, the Khmer khan `។`, the Myanmar
   `။`, the Greek question mark `;` (U+037E, not the ASCII semicolon it resembles).
2. **After a clause mark**, when one sentence alone overruns a whole chunk: `，、,：:—…`
   and the Arabic comma `،`.
3. **At a space**, which is the only break Thai and Lao offer — neither writes a
   sentence-ending mark, so rule 1 almost never fires for them.
4. **Anywhere**, for Chinese, Japanese and Khmer, which write no spaces at all. The cut is
   nudged off the inside of a grapheme cluster so a combining mark never leads a chunk.

Rules 2 and 3 only take a break in the back half of what fits. A comma near the start of a
long sentence would otherwise strand a two-word chunk and leave the rest still oversized.

`.` is in the ender set but is never trusted on sight: not before a digit (`3.14`), not
after a single letter (`J. Smith`), not inside an acronym (`U.S.`), and not after a known
abbreviation (`Dr.`). Every one of those rules fails toward *not* splitting, because a
missed split falls through to rule 2 or 3, while a false split puts a 210ms pause and a
fresh voice conditioning in the middle of a name.

## What gets dropped before synthesis

`sanitize_for_tts` filters by Unicode category, not by script. Control codes, format
characters, private-use and unassigned code points, emoji and variation selectors have no
pronunciation and corrupt the audio; every letter, mark, digit and punctuation mark
survives. A script whitelist would have been wrong — the engine speaks thirty of them.

Two exceptions, both learned the hard way:

- **Newlines and tabs** are control characters. Dropping them welds the words on either
  side into one.
- **ZWJ and ZWNJ** are format characters, and so nominally droppable — but between two
  letters they are orthography, and Devanagari, Khmer and Myanmar spell with them. They
  are kept there and dropped elsewhere, which also strips the joiner left behind by a
  removed emoji sequence.

Variation selectors are the trap: `U+FE0F`, the character that turns `☂` into an emoji, is
categorised as a nonspacing **mark**, not a format character, so a category filter keeps it
unless you name it.

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

**The opening chunk sets the latency.** Nothing is heard until it exists.
`first_max_seconds` (default 8) caps it. The original 4.5s budget minimized first-audio
latency, but it also created context-starved chunks in mixed Chinese/English narration.
In one observed paragraph, a clause beginning near `next-token` became an independent
request and changed voice noticeably. Raising the opening budget kept the term in Chinese
context, reduced five requests to three, moved first audio from 1.6s to 2.4s, and reduced
total generation time from 10.7s to 8.3s. The 8s default keeps the latency ramp while
giving the model enough linguistic context to stabilize delivery.

**Every chunk must play for longer than the next one takes to make.** Synthesis runs at
0.33–0.40x realtime, so a chunk can afford to be about 2.5–3x its predecessor before the
listener catches up to the generator. `growth` (default 2.0) leaves margin. A uniformly
short opening chunk starts fast and then stalls — measured, chunk 1 gave 5s of audio while
chunk 2 needed 10s to synthesize.

### The ramp hangs off the previous chunk, not off the chunk count

Read "its predecessor" above literally. The obvious implementation — cap chunk *k* at
`first_max_seconds * growth ** k` — is wrong, and it underran on real text. A cap is an
upper bound, not a lower one: a chunk ends early whenever the next sentence will not fit
beside it. Then the count-based cap hands its successor the full ramped budget, which the
successor happily fills. Simulated over a Chinese passage at `max_seconds=30`, the chunks ran

```
3.3  2.6  17.2  21.9  27.0  ...
```

— chunk 2 stopped at 2.6s because the 9.7s sentence after it did not fit under `4.5×2=9.0`,
and chunk 3 then took `4.5×2²=18` and produced 17.2s of audio. That is 6.6x its predecessor.
The buffer went dry by 0.97s at that seam, and it went dry at every budget of 20s and up,
across the whole 0.33–0.40x range: the stall is governed by the ramp, so raising or lowering
`max_seconds` did not move it at all.

So the cap on each chunk is `growth ×` **what the previous chunk actually turned out to be**.
Two things follow, both of which the count-based version got wrong:

- The cap has to be re-read after every chunk is closed. Closing one lowers the cap for the
  next, and a sentence already measured against the old cap may no longer fit under the new
  one — that is how a sentence twice the new cap used to slip through whole.
- A short chunk now ramps back up from where it landed. After a 0.4s opening sentence the
  chunks go 0.4, 0.7, 1.4, 2.8, … and a few land mid-sentence. Those extra seams are the
  price of never stalling, and they fall in the first seconds of playback, where a pause is
  least conspicuous.

With the ramp on the previous chunk, no budget from 15s to 45s underruns at any rate in
0.33–0.40x, and the thinnest margin is +1.12s. First-audio latency is untouched: the
opening chunk is capped by `first_max_seconds`, which this changes nothing about. If that
first seam ever stalls anyway — a busy GPU, or the engine's `retry_badcase` firing — raise
`first_max_seconds` or lower `growth`.

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
