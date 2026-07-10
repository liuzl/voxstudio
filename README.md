# voxstudio

Self-hosted, **Chinese-first voice I/O studio**. ASR + LLM + TTS engines behind **one OpenAI-compatible contract**, with a core orchestration layer and thin apps (CLI / Web / MCP / mobile client).

> Design lineage: benchmarked against [VoxWeaver Studio](https://github.com/nicekate/VOXWEAVER-STUDIO) and [Voicebox](https://github.com/jamiepine/voicebox). Focus = **strong Chinese engines, fully self-hosted, one swappable engine contract**.

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
         ├─ ASR   parakeet.cpp        (mudler/parakeet.cpp)
         ├─ TTS   VoxCPM2 PyTorch     (this repo: engines/voxcpm2-server)  ← quality-first
         │        VoxCPM.cpp          (liuzl/VoxCPM.cpp — offline/portable fallback)
         └─ LLM   llama.cpp (Gemma)
```

The core never talks to a specific engine — only to the OpenAI-compatible contract (`/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/chat/completions`, plus a `/v1/voices` extension). Switching an engine between a remote GPU host and a local machine is a base-URL change.

## Layout

| Path | What |
|---|---|
| `engines/voxcpm2-server/` | Our TTS engine wrapper — FastAPI over OpenBMB VoxCPM2 |
| `core/` | `voxcore` — engine clients, chunking, long-text synthesis, voice profiles |
| `apps/cli/` | `voxcli` — the `vox` command line |
| `docs/` | Product design docs |

`core/` and `apps/cli/` form a uv workspace and share one light, cross-platform lock.
`engines/` is excluded from it: the TTS engine pins a CUDA torch build and resolves for
x86_64 Linux only, and a shared lock would have to satisfy that and a laptop at once.

## Quick start

```bash
cp config.example.yaml voxstudio.yaml    # point it at your engines
uv sync
uv run vox health                        # probe all three engines

uv run vox say -f article.txt --voice alice -o out.wav
uv run vox transcribe recording.wav
uv run vox chat "用三句话介绍一下你自己" --speak -o reply.wav
uv run vox voices add alice --audio sample.wav --text "参考音的逐字稿"
uv run vox voices add bob --audio sample.wav --language zh  # transcript via ASR
uv run vox voices add carol --record 15 --language zh       # record, transcribe, register
```

Microphone recording requires `ffmpeg`; pass `--device` to select a non-default input.

Long text is chunked at ~15 seconds of *estimated speech* — roughly 85 Chinese
characters, or 275 English ones — and the pieces are joined by trimming each one's edge
silence and inserting a single fixed pause. Both numbers are empirical: a single TTS
generation drifts away from the reference voice as it runs, and raw concatenation
produces seams of wildly uneven length. The estimate comes from a per-script speech rate
table measured against the engine, so the budget means the same thing in every language
it speaks. See `docs/chunking.md`.

## Model stack

| Layer | Engine |
|---|---|
| ASR | parakeet.cpp (`nemotron-3.5-asr-streaming-0.6b`, Mandarin-capable) |
| TTS | **VoxCPM2 PyTorch** (this repo) — 48kHz, 30 languages + 9 Chinese dialects, voice cloning + zero-shot voice design |
| LLM | Gemma (llama.cpp) |

## Status

The engine backend, the core layer, and the CLI app are all verified end-to-end
against live engines. Long-text synthesis streams: chunks are played and written as
they finish, so `vox say` starts speaking on the first one. Web / MCP / desktop
apps are not built yet, and neither is persona rewriting or a duplex
conversation loop.

## Related

- Upstream C++ TTS engine (fallback): [liuzl/VoxCPM.cpp](https://github.com/liuzl/VoxCPM.cpp)
- Upstream C++ ASR engine: [mudler/parakeet.cpp](https://github.com/mudler/parakeet.cpp)

> Secrets (`.env`, upstream keys, tokens) and deployment topology are never committed to this public repo.
