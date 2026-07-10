# tools

Measurement scripts. They talk to a **live TTS engine** and take minutes to run, so they
are not tests — nothing in CI touches them. They exist so the constants in `core/` can be
re-derived rather than trusted.

| script | fits | re-run when |
|---|---|---|
| `measure_speech_rates.py` | `voxcore.text._CPS`, the per-script chars/sec table | you change the default reference voice, or the TTS model |
| `probe_spelled_out.py` | nothing — it documents a rule deliberately left unimplemented | same, if you want to re-check that decision |

Both read `voxstudio.yaml` like the CLI does, and both send their requests serially: the
engine's peak VRAM grows with the length of a single generation and torch does not hand it
back, so overlapping requests can walk a shared GPU into an out-of-memory 500.

```bash
uv run python tools/measure_speech_rates.py            # ~3 minutes, 39 generations
uv run python tools/measure_speech_rates.py Han Latin  # or just the scripts you care about
uv run python tools/probe_spelled_out.py               # ~30 seconds
```

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
