# voxstudio

Self-hosted, **multilingual voice I/O studio** with support for Chinese and other languages. ASR + LLM + TTS engines sit behind **one OpenAI-compatible contract**, with a core orchestration layer and thin apps (CLI / Web / MCP / mobile client).

> Design lineage: benchmarked against [VoxWeaver Studio](https://github.com/nicekate/VOXWEAVER-STUDIO) and [Voicebox](https://github.com/jamiepine/voicebox). Focus = **multilingual speech, fully self-hosted deployment, and one swappable engine contract**.

## Architecture

```
        ┌─ CLI          (thin client — first surface)
        ├─ Web Studio    (browser)
core service ─┼─ MCP server   (agent voice)
(orchestration)├─ desktop app  (optional)
        └─ mobile client
   │  core = I/O loop + voice profiles + long-text chunking + persona/refine
   │
   └── engines (OpenAI-compatible; hosted↔local = base-URL swap)
         ├─ ASR   SenseVoice / FunASR  realtime slot (engines/funasr)
         │        parakeet.cpp         (mudler/parakeet.cpp)
         │        moss-transcribe      longform + diarization (engines/moss-transcribe)
         ├─ TTS   VoxCPM2 PyTorch      quality first: clone + design (engines/voxcpm2-server)
         │        kokoro               conversation fast lane (engines/kokoro)
         │        VoxCPM.cpp           (liuzl/VoxCPM.cpp — offline/portable fallback)
         └─ LLM   llama.cpp (Gemma)
```

The core never talks to a specific engine — only to the OpenAI-compatible contract (`/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/chat/completions`, plus the `/v1/voices`, `/v1/design-profiles`, and `/v1/engines` extensions). Switching an engine between a remote GPU host and a local machine is a base-URL change, and engines are **named instances** in a registry — multiple per kind, assigned to product roles, routed by capability tags (clone/design/preset/fast/…) or pinned per request. See [docs/engine-registry.md](./docs/engine-registry.md).

## Layout

| Path | What |
|---|---|
| `engines/voxcpm2-server/` | Our TTS engine wrapper — FastAPI over OpenBMB VoxCPM2 |
| `engines/parakeet/` | Deployment and integration notes for the default real-time ASR engine |
| `engines/moss-transcribe/` | Evaluation notes for long-form ASR and speaker diarization |
| `engines/funasr/` | Realtime-slot ASR server (SenseVoice-Small / Paraformer, OpenAI-compatible) |
| `engines/kokoro/` | Local CPU TTS server — the conversation fast lane (fixed voice bank, ~0.2s first audio) |
| `packages/` | Shared TypeScript contracts, clients, configuration, text, audio, and orchestration |
| `packages/duplex-session/` | Platform-neutral realtime turn state, cancellation, events, and bounded playback queue |
| `packages/conversation/` | The shared conversation loop (VAD turns, barge-in policy, speculative turn-taking, streaming replies) behind `vox listen` and the gateway |
| `platforms/bun/` | Filesystem, process, recording, and playback adapters for Bun apps |
| `core/` | Transitional Python parity implementation and research-facing core |
| `apps/cli/` | Compiled TypeScript `vox` CLI plus the transitional Python fallback |
| `apps/realtime-gateway/` | Web Studio server: the duplex session protocol over WebSocket plus a credential-hiding REST facade |
| `apps/web/` | The browser studio (React + Tailwind + Zustand): conversation, generation, voice bank + design profiles, and engine settings panels |
| `docs/` | Product design docs |

The product workspace uses Bun 1.3.14. Shared packages use Web APIs and remain independent
of Bun; operating-system integration stays in `platforms/`. The Python parity code forms a
uv workspace with one light, cross-platform lock. `engines/` is excluded from it because
the TTS engine pins a CUDA torch build and resolves for x86_64 Linux only.

## Quick start

```bash
cp config.example.yaml voxstudio.yaml    # point it at your engines
bun ci
bun run build:cli

./apps/cli/dist/vox health               # probe all three engines

./apps/cli/dist/vox say -f article.txt --voice alice -o out.wav
./apps/cli/dist/vox transcribe recording.wav
./apps/cli/dist/vox transcribe meeting.wav --mode longform --json
./apps/cli/dist/vox transcribe meeting.wav --mode longform --format srt
./apps/cli/dist/vox transcribe meeting.wav --mode longform --format ass
./apps/cli/dist/vox transcribe meeting.wav --mode longform --max-new-tokens 65536 --format srt
./apps/cli/dist/vox chat "用三句话介绍一下你自己" --speak -o reply.wav
./apps/cli/dist/vox reply question.wav --language zh --system "请简短回答" --voice design-calm-clear -o answer.wav
./apps/cli/dist/vox reply question.wav --voice design-calm-clear --play -o answer.wav
./apps/cli/dist/vox reply --record 5 --language zh --voice design-calm-clear -o answer.wav
./apps/cli/dist/vox devices
./apps/cli/dist/vox listen --device "MacBook Pro microphone" --language zh --voice design-calm-clear
./platforms/macos-audio/build.sh
./apps/cli/dist/vox listen --speaker-duplex --language zh --voice design-calm-clear
./apps/cli/dist/vox voices add alice --audio sample.wav --text "参考音的逐字稿"
./apps/cli/dist/vox voices add bob --audio sample.wav --language zh  # transcript via ASR
./apps/cli/dist/vox voices add carol --record 15 --language zh       # record, ASR, register
./apps/cli/dist/vox profiles create calm --description "calm clear female voice" --anchor-text "这是锚文本。" --seed 20260711 --cfg 2 --timesteps 10
./apps/cli/dist/vox profiles reproduce calm calm-copy
./apps/cli/dist/vox profiles verify calm calm-copy
./apps/cli/dist/vox profiles batch candidates.jsonl --dry-run
./apps/cli/dist/vox profiles batch candidates.jsonl
./apps/cli/dist/vox profiles batch candidates.jsonl --rollback-on-error
./apps/cli/dist/vox profiles audition auditions --text "固定评测文本。" --seed 20260712 candidate-a candidate-b
./apps/cli/dist/vox profiles select auditions/manifest.json candidate-b --note "试听结果"
./apps/cli/dist/vox profiles audit design-calm-clear
./apps/cli/dist/vox profiles audit --all
```

Design profiles retain their description, anchor text, seed, CFG, timesteps, model identity,
and generated WAV SHA-256. `profiles reproduce` recreates the profile from those saved settings;
matching SHA-256 values verify byte-for-byte output on the same model runtime.
`profiles batch` accepts a JSONL candidate manifest, validates all candidates before generation,
and makes controlled design experiments repeatable. `--rollback-on-error` removes only profiles
created by that invocation when a later candidate fails.
`profiles audition` renders a fixed-text, fixed-seed WAV for each candidate and writes an auditable
`manifest.json` beside the WAV files for listening and human scoring. `profiles select` writes a
hash-bound `selection.json` without deleting any candidate. `profiles audit` compares a profile's
saved model identity and manifest to the current TTS runtime before use; `--all` reports drift
across the complete design-profile registry.

The build produces one standalone executable containing the Bun runtime and TypeScript
dependencies. Windows writes `apps/cli/dist/vox.exe`. Playback and microphone recording
remain optional external integrations: install FFmpeg for `ffplay` and `ffmpeg`, and pass
`--device` to select a non-default microphone.

Tagged releases provide native archives for macOS arm64, Linux x64, and Windows x64. After
extracting the archive, put `vox` (or `vox.exe`) on `PATH`, copy `config.example.yaml` to a
writable location, and point `--config` at it. Verify a downloaded archive against the
release's `SHA256SUMS` file before installing it. FFmpeg remains optional and is not bundled.

The Python CLI remains available as a migration fallback and parity oracle:

```bash
uv sync --locked
uv run vox health
```

Long text is chunked at ~15 seconds of *estimated speech* — roughly 85 Chinese
characters, or 275 English ones — and the pieces are joined by trimming each one's edge
silence and inserting a single fixed pause. Both numbers are empirical: a single TTS
generation drifts away from the reference voice as it runs, and raw concatenation
produces seams of wildly uneven length. The estimate comes from a per-script speech rate
table measured against the engine, so the budget means the same thing in every language
it speaks. See `docs/chunking.md`.

The duplex conversation architecture, including CLI speaker-mode AEC, browser
WebRTC/LiveKit transport, cancellation semantics, privacy boundaries, and
quality gates, is specified in [docs/duplex-audio-architecture.md](./docs/duplex-audio-architecture.md).
The browser studio for voxstudio.cc — panels, gateway, hosting, and delivery
phases — is specified in [docs/web-studio.md](./docs/web-studio.md).

## Model stack

| Layer | Engine |
|---|---|
| ASR (realtime slot) | SenseVoice-Small via FunASR — Mandarin-first, zh/en code-switch; parakeet.cpp (`nemotron-3.5-asr-streaming-0.6b`) as the alternative |
| ASR (longform) | moss-transcribe — timestamps + anonymous per-recording speakers |
| TTS (quality) | **VoxCPM2 PyTorch** (this repo) — 48kHz, 30 languages + 9 Chinese dialects, voice cloning + zero-shot voice design |
| TTS (fast lane) | kokoro — local CPU, fixed voice bank, ~0.2s first audio |
| LLM | Gemma (llama.cpp) |

## Status

The engine backend and compiled TypeScript CLI are verified end-to-end against live
engines. Long-text synthesis streams, and named voices support file input, microphone
recording, automatic ASR, and transcript editing. Native CI builds and executes the CLI on
macOS arm64, Linux x64, and Windows x64. Signed release artifacts, MCP, desktop, and persona
rewriting are not built yet.

The duplex conversation session kernel and the headset-oriented `vox listen` command are
implemented and tested with simulated audio. `listen` uses an energy-VAD fallback with a
provisional barge-in policy: playback stops only after `minSpeechMs` of voiced audio confirms
the interruption, and an unconfirmed trigger is recorded as a `false_barge_in` while the reply
keeps playing. It suppresses microphone input during playback by default; `--barge-in` requires
headphones or a headset. `--speaker-duplex` uses the macOS voice-processing helper, gated by a
real-hardware measurement harness (`bun run measure:aec`, see `platforms/macos-audio/`). The
gate passed on built-in MacBook speakers with real speech: zero confirmed self-interruptions
and 12/12 operator barge-ins heard. The Silero ONNX VAD (v5.1.2, pinned by SHA-256, fetched
into a verified local cache on first use) passed the same gate with faster detection and is
the default where the ONNX runtime is available; `listen` falls back loudly to the certified
energy detector otherwise. The conversation loop is shared: `packages/conversation` drives
both `vox listen` and the realtime gateway, so the certified turn-taking and barge-in
lifecycle has one implementation. The gateway (`apps/realtime-gateway`, Web Studio Phase 1)
speaks the versioned session protocol over WebSocket — binary PCM media, snapshot reconnect,
idempotent commands, an endpoint-owned audible-playback clock — plus a REST facade that
keeps engine addresses and credentials server-side, aggregates voices across engines, and
routes requests through the engine registry (named instances, role defaults, capability
tags, per-request pinning). The browser studio (`apps/web`) ships four panels on top of it:
live conversation (worklet microphone capture, gapless streamed playback, captions with turn
state and per-turn timing, the negotiated AEC capability snapshot), generation with takes,
the voice bank (file upload or in-browser recording, plus design-profile create / audit /
verify against the engine runtime), and engine settings with live health. Its real-browser
double-talk/barge-in gate, route-change handling, and release packaging of the helper and
the ONNX runtime remain separate measured delivery phases.

## Related

- Upstream C++ TTS engine (fallback): [liuzl/VoxCPM.cpp](https://github.com/liuzl/VoxCPM.cpp)
- Upstream C++ ASR engine: [mudler/parakeet.cpp](https://github.com/mudler/parakeet.cpp)

> Secrets (`.env`, upstream keys, tokens) and deployment topology are never committed to this public repo.
