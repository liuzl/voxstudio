# voxcpm2-server

FastAPI HTTP wrapper over **OpenBMB VoxCPM2** (48kHz high-fidelity Chinese TTS). This is voxstudio's **quality-first TTS engine** — chosen over the C++ [VoxCPM.cpp](https://github.com/liuzl/VoxCPM.cpp) build for full-precision output on a GPU. Runs on any CUDA GPU host.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{"status":"ok","sample_rate":48000}` |
| POST | `/v1/audio/speech` | OpenAI-compatible: `{input, voice, response_format}` — `voice=clone` (default ref) / `design` (zero-shot, prefix `input` with `(English description)`) |
| POST | `/tts` | JSON `{text, voice, ref_path?, cfg_value?, timesteps?}` |
| POST | `/tts_form` | multipart, upload `ref_file` to clone from an arbitrary reference voice |
| GET | `/` | minimal Web UI |

> **Named voices (`/v1/voices` CRUD)** — planned. Mirrors the [VoxCPM.cpp `voxcpm-server`](https://github.com/liuzl/VoxCPM.cpp) contract so the core can register a voice once and reference it by id, instead of managing reference-audio files itself.

## Config (env, no hard-coded paths)

| Var | Default |
|---|---|
| `VOXCPM2_BASE` | `~/tts-eval-voxcpm2` |
| `VOXCPM2_MODEL` | `$VOXCPM2_BASE/pretrained_models/VoxCPM2` |
| `VOXCPM2_REF` | `$VOXCPM2_BASE/voice.wav` (default clone voice) |

## Run

```bash
pip install -r requirements.txt          # voxcpm, fastapi, uvicorn, soundfile, pydantic (+ ffmpeg on PATH)
uvicorn server_voxcpm2:app --host 0.0.0.0 --port 8880
```

## Deploy (systemd --user)

Adjust `voxcpm2-tts.service` paths/env for your host, then:

```bash
systemctl --user enable --now voxcpm2-tts
systemctl --user status voxcpm2-tts
journalctl --user -u voxcpm2-tts -n 50 --no-pager
```

Notes:

- Binds `0.0.0.0:8880`.
- Single GPU model; a `threading.Lock` serializes generation.
- ~7G VRAM resident, so it can comfortably share a typical 24GB GPU with another model.
