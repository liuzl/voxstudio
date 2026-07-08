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
| POST | `/v1/voices` | register a reusable voice — multipart `{id, text, audio}` → metadata (201) |
| GET | `/v1/voices` | list registered voices |
| GET | `/v1/voices/{id}` | voice metadata |
| DELETE | `/v1/voices/{id}` | remove a voice |

### Named voices

`voice` accepts `clone` (default reference), `design` (zero-shot — prefix `input` with an `(English description)`), or **a registered voice id**. Register once with `POST /v1/voices` (uploads a reference sample, transcoded to 16k mono), then synthesize with `voice="<id>"` — the caller no longer manages reference-audio files. Mirrors the [VoxCPM.cpp `voxcpm-server`](https://github.com/liuzl/VoxCPM.cpp) contract so the two TTS backends are drop-in interchangeable. Registry dir is `VOXCPM2_VOICES` (default `$VOXCPM2_BASE/voices`), one `<id>/{ref.wav,meta.json}` per voice.

```bash
curl -F id=alice -F 'text=参考音的逐字稿' -F audio=@sample.wav http://<host>:8880/v1/voices
curl http://<host>:8880/v1/audio/speech -H 'Content-Type: application/json' \
     -d '{"input":"你好","voice":"alice","response_format":"wav"}' -o out.wav
```

## Config (env, no hard-coded paths)

| Var | Default |
|---|---|
| `VOXCPM2_BASE` | `~/tts-eval-voxcpm2` |
| `VOXCPM2_MODEL` | `$VOXCPM2_BASE/pretrained_models/VoxCPM2` |
| `VOXCPM2_REF` | `$VOXCPM2_BASE/voice.wav` (default clone voice) |

## Run

Dependencies live in `pyproject.toml`; [uv](https://docs.astral.sh/uv/) manages the environment. `ffmpeg` must be on `PATH` (reference-audio transcoding) — install it with your system package manager.

```bash
uv run uvicorn server_voxcpm2:app --host 0.0.0.0 --port 8880
```

`uv run` creates `.venv/` and installs on first use, so there is no separate install step. To reuse an environment that already holds a multi-GB torch build, point uv at it and skip the sync:

```bash
UV_PROJECT_ENVIRONMENT=~/tts-eval-voxcpm2/.venv uv run --no-sync uvicorn server_voxcpm2:app --port 8880
```

Pin the resolution with `uv lock` if you want byte-identical installs across hosts; without a lockfile `uv` resolves fresh each sync.

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
