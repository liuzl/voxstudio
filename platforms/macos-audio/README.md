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
