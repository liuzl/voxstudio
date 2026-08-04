# voxcpm2-server

FastAPI HTTP wrapper over **OpenBMB VoxCPM2** (48kHz high-fidelity Chinese TTS). This is voxstudio's **quality-first TTS engine** — chosen over the C++ [VoxCPM.cpp](https://github.com/liuzl/VoxCPM.cpp) build for full-precision output on a GPU. Runs on any CUDA GPU host.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | service status, sample rate, and active continuation-session count |
| POST | `/v1/audio/speech` | OpenAI-compatible batch WAV or continuation streaming: `{input, voice, response_format, seed?, prosody_prompt?, continuation_id?, continuation_end?, stream?}` — `voice=clone` (default ref) / `design` (zero-shot, prefix `input` with `(English description)`) / a registered id |
| POST | `/tts` | JSON `{text, voice, ref_path?, cfg_value?, timesteps?}` |
| POST | `/tts_form` | multipart, upload `ref_file` to clone from an arbitrary reference voice |
| GET | `/` | minimal Web UI |
| POST | `/v1/voices` | register a reusable voice — multipart `{id, text, audio}` → metadata (201) |
| POST | `/v1/design-profiles` | materialize `{id, description, anchor_text, seed, cfg_value?, timesteps?}` as a reusable registered voice; metadata includes its WAV and model-manifest SHA-256 |
| GET | `/v1/voices` | list registered voices |
| GET | `/v1/voices/{id}` | voice metadata |
| DELETE | `/v1/voices/{id}` | remove a voice |

### Named voices

`voice` accepts `clone` (default reference), `design` (zero-shot — prefix `input` with an `(English description)`), or **a registered voice id**. Register once with `POST /v1/voices` (uploads a reference sample, transcoded to 16k mono), then synthesize with `voice="<id>"` — the caller no longer manages reference-audio files. Mirrors the [VoxCPM.cpp `voxcpm-server`](https://github.com/liuzl/VoxCPM.cpp) contract so the two TTS backends are drop-in interchangeable. Registry dir is `VOXCPM2_VOICES` (default `$VOXCPM2_BASE/voices`), one `<id>/{ref.wav,meta.json,prompt_cache.*.pt}` per voice. `ref.wav` is the portable source of truth; prompt-cache files are model-bound derived data and can always be rebuilt.

For `design`, pass an integer `seed` to reproduce the same request on the same locked
model/runtime. The service serializes generation while applying that seed, because VoxCPM
sets Torch's process-global RNG. A seed makes a candidate replayable; it does not make
independent long-text chunks share a voice identity.

Long-text callers can send one `continuation_id` for every segment and set
`continuation_end=true` on the final one. The server retains the acoustic cache only for
that session, removes it on the final segment, expires idle sessions after 15 minutes, and
caps concurrent sessions at eight.

Set `stream=true` together with a `continuation_id` to receive audio while generation is
still running. `response_format=opus` returns Ogg/Opus; every other streaming format returns
raw mono float32 PCM with `X-Sample-Rate` and `X-Sample-Format` headers. A non-streaming
request returns a complete WAV. `prosody_prompt=true` also conditions generation on the
registered voice's reference transcript.

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
| `VOXCPM2_VOICES` | `$VOXCPM2_BASE/voices` |
| `VOXCPM2_MODEL_MANIFEST_SHA256` | unset; deployment-pinned SHA-256 of the full model directory manifest |
| `VOXCPM2_PROMPT_CACHE_CAPACITY` | `16` in-memory prompt-cache entries |
| `VOXCPM2_LOCK_TIMEOUT` | `120` seconds before a busy generation pipeline returns 503 |
| `VOXCPM2_OPUS_BITRATE` | `96k` |

## Run

Dependencies live in `pyproject.toml` and are pinned in `uv.lock`; [uv](https://docs.astral.sh/uv/) manages the environment. `ffmpeg` must be on `PATH` (reference-audio transcoding) — install it with your system package manager.

```bash
uv sync --frozen                                          # exact, hash-verified install
.venv/bin/python -m uvicorn server_voxcpm2:app --host 0.0.0.0 --port 8880
```

`--frozen` installs precisely what `uv.lock` records and never re-resolves, so every host gets the same environment. To place the environment somewhere other than `./.venv`, set `UV_PROJECT_ENVIRONMENT` during sync.

**uv installs; it does not launch.** `uv run` works interactively, but under systemd it swallows the child process's stdout and stderr — uvicorn's access log and any traceback vanish. Invoke the interpreter directly in a service.

The lock resolves for **x86_64 Linux only** — this engine runs on CUDA hosts, and resolving for macOS too would drag the solution down to that platform's lowest common denominator. `torch`/`torchaudio` are pinned to the validated versions; the default PyPI linux wheel is already a CUDA 13 build, so no `download.pytorch.org` index is needed. `numpy` is capped below 2.5 because old `numba` releases declare no numpy upper bound and an unconstrained resolve pairs them disastrously.

Changing a dependency means editing `pyproject.toml`, running `uv lock`, and committing the new `uv.lock`.

## Deploy (systemd --user)

Adjust `voxcpm2-tts.service` paths/env for your host, then:

```bash
systemctl --user enable --now voxcpm2-tts
systemctl --user status voxcpm2-tts
journalctl --user -u voxcpm2-tts -n 50 --no-pager
```

Notes:

- Binds `0.0.0.0:8880`.
- Single GPU model; a `threading.Lock` serializes generation and times out with a structured
  503 instead of queueing forever. Streaming disconnect cleanup releases the same lock.
- ~7G VRAM resident, so it can comfortably share a typical 24GB GPU with another model. It
  **stays** that way: `_generate` returns the allocator's cache after each generation, and
  the unit sets `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` so a long generation does
  not ratchet the reserved pool up and keep it there. Without both, one long generation
  raises the pool ~10x and never gives it back. See `docs/chunking.md`.
- Ordinary and continuation synthesis reuse a per-voice **prompt cache**
  (`prompt_caches.py`): building one encodes the reference audio through the VAE — measured
  at ~3s of fixed latency per request. Registration prewarms a memory + disk snapshot, so
  later requests and service restarts avoid that cost. Content-addressed keys plus the
  model id and deployment manifest hash invalidate caches after re-registration or a model
  change. Invalid/corrupt caches rebuild from `ref.wav` and never make a voice unusable.
- Streaming uses upstream `generate_with_prompt_cache_streaming`, so first audio leaves
  before the reply is complete. The server can send raw float32 PCM or encode Ogg/Opus for
  lower-bandwidth links; continuation caches preserve the acoustic context across chunks.
