# voxstudio

Self-hosted, **Chinese-first voice I/O studio**. ASR + LLM + TTS engines behind **one OpenAI-compatible contract**, with a core orchestration layer and thin surfaces (CLI / Web / MCP / mobile client).

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
| `core/` | Core orchestration layer *(planned)* |
| `surfaces/` | Thin clients — `cli/` first, then web / MCP *(planned)* |
| `docs/` | Product design docs |

## Model stack

| Layer | Engine |
|---|---|
| ASR | parakeet.cpp (`nemotron-3.5-asr-streaming-0.6b`, Mandarin-capable) |
| TTS | **VoxCPM2 PyTorch** (this repo) — 48kHz, strong Chinese, voice cloning + zero-shot voice design |
| LLM | Gemma (llama.cpp) |

## Status

Early. The engine backend (ASR→LLM→TTS) is verified end-to-end; the core layer and surfaces are not built yet.

## Related

- Upstream C++ TTS engine (fallback): [liuzl/VoxCPM.cpp](https://github.com/liuzl/VoxCPM.cpp)
- Upstream C++ ASR engine: [mudler/parakeet.cpp](https://github.com/mudler/parakeet.cpp)

> Secrets (`.env`, upstream keys, tokens) and deployment topology are never committed to this public repo.
