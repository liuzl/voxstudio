# tools

Measurement scripts. They talk to a **live TTS engine** and take minutes to run, so they
are not tests — nothing in CI touches them. They exist so the constants in `core/` can be
re-derived rather than trusted.

| script | fits | re-run when |
|---|---|---|
| `measure_speech_rates.py` | `voxcore.text._CPS`, the per-script chars/sec table | you change the default reference voice, or the TTS model |
| `measure_timbre_drift.py` | `chunking.max_seconds` — how fast the voice drifts within one generation | same |
| `probe_spelled_out.py` | nothing — it documents a rule deliberately left unimplemented | same, if you want to re-check that decision |
| `benchmark_longform_asr.py` | private long-form ASR quality/performance report | before promoting or changing MOSS |

All three read `voxstudio.yaml` like the CLI does, and all three send their requests
serially: the engine's peak VRAM grows with the length of a single generation, so
overlapping requests can still walk a shared GPU into an out-of-memory 500.

```bash
uv run python tools/measure_speech_rates.py            # ~15 minutes, 195 generations
uv run python tools/measure_speech_rates.py Han Latin  # or just the scripts you care about
uv run python tools/probe_spelled_out.py               # ~30 seconds
```

`measure_timbre_drift.py` is the odd one out: it needs a speaker-verification encoder,
which the workspace lock does not carry. Run it in a throwaway environment, **on the engine
host** — it moves half an hour of audio, and there is no reason to pull that across a
network. Give the encoder the CPU; the GPU is holding the TTS model.

```bash
CUDA_VISIBLE_DEVICES= uv run --with speechbrain --with torch --with torchaudio \
  python tools/measure_timbre_drift.py --reference ref.wav --voice alice
uv run python tools/measure_timbre_drift.py --out drift.jsonl --report-only  # re-analyse
```

## Long-form ASR benchmark

`benchmark_longform_asr.py` posts every fixture to a live OpenAI-compatible MOSS endpoint
with `response_format=verbose_json`. It records end-to-end wall time, RTF, normalized CER,
predicted speaker/segment counts, and—when reference segments have the same cardinality—the
ordinal timestamp-boundary MAE. The latter is deliberately not reported across different
segmentations, where it would be misleading.

Keep the manifest, audio, reference transcripts, and report outside this public repository.
The manifest is JSONL; audio paths are relative to the manifest:

```json
{"id":"meeting-02","audio":"audio/meeting-02.m4a","reference_text":"人工核对全文","reference_segments":[{"start":0.3,"end":2.1,"speaker":"A","text":"人工核对片段"}]}
```

Run it serially against a protected endpoint:

```bash
uv run python tools/benchmark_longform_asr.py \
  /private/benchmark/manifest.jsonl \
  --base-url http://127.0.0.1:18087 \
  --out /private/benchmark/moss-q5k-report.json
```

Use `--dry-run` to validate the manifest and FFprobe duration discovery without sending
audio. The output contains fixture ids and metrics but never copies media or transcripts;
still treat it as private because ids and quality data can be sensitive.

The report's `summary` aggregates CER, RTF, timestamp-boundary MAE, and speaker-count
delta as mean/median/p95 where the applicable reference data exists. Compare like with like:
the same private manifest, token budget, endpoint, and cold/warm policy must be used for
every quantization or backend under comparison.

Its `whole` arm — one unchunked generation of the whole passage — used to 500 partway
through its repeats, because one long generation raised the engine's peak VRAM permanently
and the next identical request failed until a restart. `engines/voxcpm2-server` now calls
`empty_cache()` after each generation and runs under `expandable_segments` (see
`docs/chunking.md`), which holds the peak flat. Against an engine without those, expect the
500 — every window is appended as it is measured, so a re-run resumes.

`measure_speech_rates.py` prints a `_CPS = {...}` literal to paste into
`core/voxcore/text.py`, and, before it, the error against a held-out paragraph per script
that fitted nothing, beside the engine's own spread on that same paragraph. **Read both
before pasting.** An error smaller than the spread beside it says nothing at all.

## The engine is not reproducible

The same paragraph, voice and sampler settings give durations that vary 13–25% peak to
peak. So:

- **Never fit from a single generation per paragraph.** `--repeats` defaults to 3 for this
  reason, and the script warns below that. An early revision sampled once; re-running it
  moved Han from 5.4 to 5.9 chars/sec with no code change.
- **Only the first significant figure of a rate is real.** Han ≈ 5, Hangul ≈ 8, Arabic ≈
  11, Latin ≈ 18. Do not tune the second digit — you would be fitting the sampler. The
  ratios the chunk budget depends on are an order of magnitude larger than the noise.
- If a re-fit moves a rate by less than ~10%, that is not evidence the voice changed.

## Why the rate table is a property of the voice

Speaking rate belongs to the voice as much as to the script. The committed table was fitted
on the default `clone` reference audio at `cfg_value=2.0`, `timesteps=10`. A slower or more
deliberate reference voice shifts every number, and `chunk_text` budgets in seconds — so a
stale table silently means a different chunk duration, which is the timbre drift the budget
exists to prevent.

## Known weaknesses of the current fit

Written down so nobody mistakes these numbers for physical constants:

- **Two fit paragraphs per script**, times `--repeats`. Still small against a sampler that
  swings 25%.
- **The table is keyed on script, not language.** A bare string carries nothing else.
  German and Vietnamese share the Latin bucket. They happen to agree within 4%, which is
  what makes the approximation defensible, not what makes it exact.
- **Register is unmodelled.** The sample paragraphs are plain expository prose.
- **Letter runs the model spells out are unmodelled.** See `probe_spelled_out.py`.

See `docs/chunking.md` for what the numbers are used for and how much error the budget can
absorb.
