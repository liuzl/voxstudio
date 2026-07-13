# macOS audio host

`vox-audio-host` owns microphone capture and speaker playback in one
`AVAudioEngine` with Voice Processing enabled. It reads 48 kHz mono `f32le`
playback PCM from stdin and writes AEC-processed 16 kHz mono `f32le` microphone
PCM to stdout. `SIGUSR1` clears queued playback without stopping capture.

Build locally:

```sh
./platforms/macos-audio/build.sh
```

Run the local hardware smoke test after changes to this host. It verifies voice
processing startup, five seconds of playback, queue clearing, capture output,
and clean shutdown. It needs microphone permission and may emit a short tone.

```sh
bun run test:macos-audio
```

The binary is intentionally not committed. Release packaging must bundle the
matching signed helper beside the compiled CLI.

## Speaker-mode gate

`vox listen --speaker-duplex` cannot be declared supported on a route until it is
measured on that route. `aec-measure.ts` runs that gate against real hardware. It
drives this helper over its real IPC and scores the capture with the CLI's own
`EnergyVadSegmenter` at the CLI's own thresholds, so the numbers describe the
product path and not a detector invented for the test.

```sh
bun run measure:aec --far-end path/to/real-speech-48k-mono.wav --trials 12
```

For the edit loop there is a smoke mode that finishes in under 20 seconds:

```sh
bun run measure:aec --quick --far-end path/to/real-speech-48k-mono.wav
```

`--quick` shortens every scenario, skips the bypass A/B and double-talk, and uses a
longer convergence trim (dense speech converges the canceller in ~5s, and a short
measurement window must sit entirely past that). It exists to catch a broken endpoint
fast; it can never produce a `pass` verdict.

Barge-ins are scored at `speech.confirmed` — the CLI interrupts playback only after
`minSpeechMs` of voiced audio, so a transient echo spike is recorded as a
`false_barge_in` while the reply keeps playing. `bargeIns()` counts what the product
acts on; `vadStarts()` reports raw first-frame triggers as a diagnostic.

The room must be quiet, and the operator speaks when they hear the two-tone cue.
The run writes `report.json`, the per-scenario captures, and a verdict to
`outputs/aec/<timestamp>/`, and **exits non-zero unless the verdict is `pass`** —
an incomplete measurement must never read as a supported endpoint.

What it measures, and what each number is not:

- **Voice-processing attenuation** — an A/B between a run with voice processing
  and a run with `--no-voice-processing`. That flag exists only for this: Voice
  Processing I/O is a black box and does not expose the pre-AEC microphone
  signal, so the un-cancelled echo has to come from a second run. Because the OS
  applies AEC, noise suppression, and gain control as one unit, this is the
  attenuation of the whole path. It is **not** an AEC-only ERLE and must not be
  published as one. Once the residual reaches the noise floor the measurement is
  floor-limited and the value becomes a lower bound, which the report says.
- **Self-interruption** — how often residual echo alone trips the VAD, measured
  against a silent baseline of the same length, since the energy VAD also fires
  on room noise. It is a detector trigger rate: in production the first trigger
  aborts the turn and stops playback, so it means "how often a minute of agent
  speech would be killed by its own echo", not a count of interruptions a user
  would sit through.
- **Capture-to-mute** — measured with voice processing *bypassed*, on purpose.
  With AEC on, the processed microphone signal does not contain the playback at
  all, so the instant the speaker stops is not observable there. Bypassing lets
  the microphone hear the real acoustic output. Resolution is bounded by the
  ~100 ms capture buffer this endpoint delivers.
- **Missed barge-in** — the operator speaks on cue; a cue with no `speech.start`
  means the product would not have heard them. The detector cannot separate near-end
  speech from residual echo, so a self-interruption landing inside a cue window is
  credited to the operator: the rate is a lower bound, not an exact figure.
- **Threshold sweep** — re-scores the captured audio offline across VAD
  thresholds, because raising the threshold to stop self-interruption buys that
  directly at the cost of not hearing the user, and neither number means anything
  without the other.

A synthetic far-end is available so the harness runs without engine access, but a
run that used it cannot pass: cancellation and an energy VAD both behave
differently on real speech.
