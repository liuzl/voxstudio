# Lip-sync bridge: voxstudio as the voice of a desktop character

Status: proof of concept, measured working 2026-07-22. The counterpart code
lives in the [liuzl/pocket-character](https://github.com/liuzl/pocket-character)
fork (`local` branch); this gateway needed **no changes** — the experiment is
one flag and one script on the character side, against the stock engine
contract.

## The question

[pocket-character](https://github.com/pocket-stack/pocket-character) renders a
VRM desktop companion (airi's stage as one native process — ~118 MB RSS, ~4%
of a core) and marks lip sync "inert without an AI/TTS stack" in its parity
table. voxstudio is exactly that stack. Can the two meet with a minimal
bridge — this gateway as the voice, that widget as the face?

## What was built

```
voxstudio gateway ── POST /v1/audio/speech?engine=<clone-engine>  (cloned voice, WAV)
        │
speak-driver.ts ──── afplay (speakers)
        │ 20 ms RMS envelope, on the audio clock
        ▼
/tmp/pc-mouth ────── one float 0..1, rewritten per hop
        ▲
pocket-character ─── --mouth-file /tmp/pc-mouth   (fork patch, ~10 lines)
                     read per tick → apply_expression("a", weight)
```

- **Character side** (fork patch): `--mouth-file PATH` — each widget tick
  reads a `0..1` float from the file and lands it on the model's `"a"` viseme
  through its existing expression path. A file is the whole channel.
- **Driver** (`scripts/speak-driver.ts` in the fork): synthesize a line
  through this gateway's facade (any registered voice; the POC used a cloned
  voice on the remote quality-line engine), play it, and stream the amplitude
  envelope into the mouth file on the audio clock — RMS per 20 ms hop,
  95th-percentile normalization, `^0.6` gamma so quiet syllables still move
  the mouth, fast-attack/slow-release smoothing. Silence writes `0`.

## Measured

Five sentences through the full chain (M3 Max widget + remote GPU TTS over
the WAN link):

| Shape | Audio | Synthesis wall time |
|---|---|---|
| greeting / self-intro | 8.3 s | 9.3 s |
| plain statement | 6.1 s | 37.2 s |
| minimal ("短句测试。") | 1.3 s | 3.4 s |
| long sentence with comma/period pauses | 14.4 s | 23.5 s |
| digits + English mixed | 7.0 s | 6.8 s |

On screen: syllable-rate open/close, half-close at commas, full close at
periods. Amplitude→"a" reads as "talking", not phoneme-accurate speech —
the known ceiling of envelope lip-sync.

The synthesis wall-time variance (37 s vs 7 s for same-order audio) is not
the engine — it is the **batch** endpoint shipping whole 48 kHz WAV
(~100 KB/s to sustain realtime) over the link the duplex doc measured at
30–65 KB/s. This product already solved that problem for conversation:
streamed Opus at ~12 KB/s, ~1 s to first audio. The POC's bottleneck is
precisely the path the realtime session exists to replace.

## What the production version looks like

1. **Streamed, not batch**: the widget attaches to `/v1/realtime` instead of
   the batch endpoint — chunks play (and move the mouth) as they arrive, and
   the character becomes the face of a live conversation, mouth closing
   instantly on barge-in. The protocol already carries everything needed
   (`playback.format`, binary audio frames, turn state).
2. **Visemes, not amplitude**: VRM models carry the full `a/i/u/e/o` preset
   set; phoneme timing from the TTS side (or forced alignment through the ASR
   reference workflow) drives five mouths instead of one.
3. **A real channel, not a file**: stdin or a socket, surfaced to the
   widget's policy layer as tick facts — the shape an upstream PR takes.

## References

- [duplex-audio-architecture.md](./duplex-audio-architecture.md) — the
  realtime session contract and the WAN/Opus measurements cited above.
- [liuzl/pocket-character](https://github.com/liuzl/pocket-character) —
  the fork carrying `--mouth-file` and `scripts/speak-driver.ts`.
