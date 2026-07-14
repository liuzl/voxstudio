# Kokoro TTS server — the local conversation fast lane

OpenAI-compatible `/v1/audio/speech` over Kokoro-82M-v1.1-zh: 103 Mandarin voices from a
fixed bank, synthesized at CPU speed. Measured on an Apple-Silicon laptop: **RTF ≈ 0.07**
(14× realtime), first audio for a conversational sentence in **~0.2–0.4s**, no GPU, no
network. The trade against the VoxCPM2 engine is deliberate: no voice cloning, less
expressive prosody. Conversation wants this; long-form reading and cloned identities stay
on VoxCPM2.

## Run

```sh
uv sync --locked
KOKORO_PORT=18089 uv run python server_kokoro.py
```

Model weights (~330 MB) download from HuggingFace on first start. Behind a slow HF route,
set `HF_ENDPOINT=https://hf-mirror.com`.

| Variable | Default | Meaning |
|---|---|---|
| `KOKORO_REPO` | `hexgrad/Kokoro-82M-v1.1-zh` | model repo |
| `KOKORO_DEFAULT_VOICE` | `zf_001` | used when the request has no voice |
| `KOKORO_OUTPUT_RATE` | `48000` | resample target; the macOS speaker-duplex helper needs 48k. `24000` = native |
| `KOKORO_DEVICE` | `cpu` | CPU is fast enough by design |
| `KOKORO_HOST` / `KOKORO_PORT` | `127.0.0.1` / `18089` | bind address |

Point the product at it in `voxstudio.yaml`:

```yaml
engines:
  tts:
    base_url: http://127.0.0.1:18089
    model: kokoro
```

Then `vox listen --voice zf_001 ...` — list the bank with `vox voices` or `/v1/voices`.

## Contract

- `POST /v1/audio/speech` — same request shape as the VoxCPM2 engine. `stream: true`
  returns chunked f32le PCM with `X-Sample-Rate`; without it, one WAV. Continuation and
  prosody fields are accepted and ignored — Kokoro is stateless, and each request stands
  alone.
- `GET /v1/voices`, `GET /healthz`, and `GET /health` (the product's identity shape).

## Deploy on macOS (launchd)

`com.voxstudio.kokoro-tts.plist.example` runs the server as a user agent. Fill in the
checkout path, then:

```sh
cp com.voxstudio.kokoro-tts.plist.example ~/Library/LaunchAgents/com.voxstudio.kokoro-tts.plist
launchctl load ~/Library/LaunchAgents/com.voxstudio.kokoro-tts.plist
```
