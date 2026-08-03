# Occasional TTS voice outliers in Live test

Status: Measured, 2026-08-03. This note records the diagnosis only; none of the
mitigations below is implemented yet.

## Symptom

In Web Studio Live test, an otherwise consistent reply occasionally contains one
sentence that sounds like a different speaker from the reference voice. This is distinct
from the gradual within-generation timbre drift documented in [chunking.md](chunking.md):
the whole short sentence can be an outlier from its first audible words.

## Runtime path checked

The test used the self-hosted gateway on `127.0.0.1:8790` and the VoxCPM2 service on
`sz-ws` (`voxcpm@2.0.3.post22+g616d3d3e6`, 48 kHz). At diagnosis time the
`customer-support` draft had neither `voice` nor `ttsEngine`, so Live test inherited the
deployment default `voice=clone`. That resolves to the engine host's 18.03-second default
reference WAV, not to a registered voice such as `zliu`.

The request path was inspected end to end:

- every conversation chunk explicitly carries the effective voice; it is not omitted
  intermittently;
- each reply uses a unique continuation id, and every anchored chunk is conditioned on
  the immutable reference cache rather than the preceding generated chunk;
- only one TTS engine was configured, so there was no fallback to a different engine;
- the deployed server source and model manifest matched the local repository.

These checks rule out Web Studio display state, missing request parameters, stale rolling
continuations, engine fallback, and a deployment-version mismatch as causes.

## Reproduction and measurements

The same short sentence was synthesized repeatedly with `voice=clone`, `cfg_value=2`,
`timesteps=10`, and the same continuation shape used by Live test. SpeechBrain ECAPA-TDNN
embeddings compared each result with its reference audio. Scores are useful only relative
to other arms in this run; they are not a universal human-perception threshold.

| arm | n | minimum | median | maximum |
|---|---:|---:|---:|---:|
| Chinese, batch, random seed | 4 | 0.783 | 0.803 | 0.867 |
| Chinese, streaming, random seed | 8 | **0.591** | 0.782 | 0.842 |
| English, batch, random seed | 4 | 0.514 | 0.527 | 0.543 |
| English, streaming, random seed | 8 | 0.537 | 0.578 | 0.677 |

The `0.591` Chinese sample reproduces the reported whole-sentence voice change. It was
2.88 seconds long, so it was not the existing "audio too long" bad case.

Streaming itself is not the cause. Twelve fixed seeds were rendered through both batch
and streaming paths. Their minimum/median/maximum scores were respectively
`0.674/0.768/0.851` and `0.674/0.768/0.852`; the mean absolute paired difference was
only `0.0002`, and durations matched seed by seed.

An accurate registered reference does not eliminate the sampler's variance. With the
registered `zliu` voice and its reference transcript enabled, random streaming results
still reached `0.607`; a fixed-seed sweep at cfg 2 reached `0.584`. Cross-language
generation is an additional risk: against the default Chinese reference, English medians
were about `0.56`, compared with `0.77-0.79` for Chinese in the tested sentences.

CFG is voice-specific rather than a safe global knob. For the default `clone`, cfg 3
raised the Chinese eight-seed minimum from `0.674` to `0.776`. For `zliu`, cfg 3 instead
lowered the Chinese eight-seed minimum from `0.584` to `0.544`. A global change from cfg
2 to cfg 3 is therefore not justified.

## Conclusion

When no seed is supplied, VoxCPM2 materializes a new random Torch seed for every synthesis
request. A Live test reply consists of several independently sampled sentence or clause
requests. Reference conditioning usually holds the speaker identity, but some text/seed
combinations are speaker-similarity outliers. Fixed-seed batch and streaming parity shows
that transport and incremental decoding are not introducing the change.

The upstream `retry_badcase` option does not solve this failure mode. It retries only when
the generated audio-feature length reaches the configured audio/text ratio threshold; it
does not measure speaker identity. The reproduced voice outlier was shorter than its
siblings and would pass that check.

## Recommended mitigation order

1. Pin every production Agent to its intended registered voice and TTS engine. This
   removes ambiguity between a selected reference and the deployment's `clone` default,
   but does not by itself eliminate stochastic outliers.
2. Log the effective voice, cfg, actual materialized seed, language, duration, and retry
   outcome for every synthesis chunk. A reported bad sentence must be replayable before
   tuning policy.
3. Calibrate cfg and candidate seeds per voice and language over a multi-sentence corpus.
   A fixed seed can reduce observed variance, but the four-sentence sweep showed that seed
   rankings change with the text, so seed pinning alone is not a guarantee.
4. For a hard product guarantee, add an engine-side speaker-similarity gate: buffer a
   sentence or an initial audio prefix, compare it with the cached reference embedding,
   and retry with another seed below a voice-specific threshold. Full-sentence gating is
   simpler but adds roughly the measured 1-2 seconds of synthesis time to first audio;
   prefix gating retains more streaming benefit but requires separate threshold and
   latency validation.

The first three steps can remain internal configuration and observability work. The
existing speech API already accepts `seed`; no public API change is required unless seed,
quality mode, or thresholds are exposed as Agent-level controls.
