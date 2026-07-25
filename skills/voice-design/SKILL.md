---
name: voice-design
description: Run reproducible voice-design experiments on a voxstudio deployment through the vox CLI — create seeded design profiles, audition candidates on fixed text, record hash-bound selections, verify byte-for-byte reproducibility, and audit for engine drift before reuse. Use when asked to design, compare, reproduce, or audit TTS voices on voxstudio, or to manage its clone-voice bank.
---

# Reproducible voice design with the vox CLI

voxstudio treats a designed voice as an **auditable artifact**: its description,
anchor text, seed, sampler settings, model identity, and generated-audio SHA-256
are all recorded at creation, so any claim about a voice can be re-derived
instead of trusted. This skill is the discipline for operating that system
without corrupting its guarantees.

## Prerequisites

- `vox` on PATH (or a repo checkout: `./apps/cli/dist/vox`), with a config
  reaching the engines (`voxstudio.yaml`, or `--config PATH` before the
  subcommand).
- `vox health` exits 0 and the `tts` line is `ok` — the quality-line engine
  (VoxCPM2) is required; the fast lane (kokoro) cannot design or clone.
- Treat every generation as costly: designs run on a GPU that serializes, and
  a full audition sweep is minutes, not seconds. Run requests serially.

## The lifecycle, in order

```bash
# 1. Create — every knob explicit. The seed is what makes the artifact yours.
vox profiles create calm --description "calm clear female voice" \
  --anchor-text "这是锚文本。" --seed 20260711 --cfg 2 --timesteps 10

# 2. Compare candidates — SAME text, SAME seed across all of them, or the
#    comparison measures the sampler, not the voices.
vox profiles audition auditions --text "固定评测文本。" --seed 20260712 calm-a calm-b calm-c

# 3. Record the winner — hash-bound, non-destructive. Never delete the losers
#    as part of selecting; the manifest is the experiment's record.
vox profiles select auditions/manifest.json calm-b --note "更稳的中低音"

# 4. Audit BEFORE any reuse or reproduction claim. It compares the profile's
#    saved model identity + manifest SHA-256 against the live runtime.
vox profiles audit calm-b        # or: vox profiles audit --all  (drift sweep)

# 5. Reproduce + verify — the strong claim. Byte-for-byte equality holds only
#    on the same model runtime; audit first, then:
vox profiles reproduce calm-b calm-b-copy
vox profiles verify calm-b calm-b-copy   # compares generated-audio SHA-256

# 6. Batch experiments — validate the whole manifest before spending GPU.
vox profiles batch candidates.jsonl --dry-run
vox profiles batch candidates.jsonl --rollback-on-error
```

Clone voices (from reference audio rather than a description) follow the same
registry:

```bash
vox voices add alice --audio sample.wav --text "参考音的逐字稿"
vox voices add bob --audio sample.wav --language zh   # transcript via ASR
vox voices list
```

## Rules that protect the numbers

1. **The engine is not reproducible run to run.** The same text, voice, and
   settings vary 13–25% in duration between runs. Never conclude anything from
   a single generation; never tune a constant to a second significant figure —
   you would be fitting the sampler, not the voice.
2. **`verify` PASS means byte-for-byte on the current runtime.** After an
   engine or model update it is expected to fail; that is the feature working.
   Re-audit, then re-create if the profile must live on the new runtime.
3. **`audit` is cheap; drift is not.** Any workflow that reuses a profile
   (auditions, reproduction, production synthesis with similarity claims)
   starts with an audit. `not ok` means stop and report, not proceed.
4. **Selections never delete.** `select` writes `selection.json` beside the
   audition manifest. Deleting candidates is a separate, deliberate `rm`.
5. **Ids are `[A-Za-z0-9._-]{1,64}`.** Pick namespaced ids for experiments
   (`exp-YYYYMMDD-*`) so cleanup is a listable prefix, and remove what you
   created when the experiment ends.

## Reporting results

State: the ids, the seed(s), the audit status, and — for any comparative
claim — the audition manifest path. A conclusion without its manifest is an
anecdote. Audio SHA-256 values from `profiles show ID` are the citation format
for "this exact sound".
