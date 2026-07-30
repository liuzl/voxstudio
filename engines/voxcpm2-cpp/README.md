# VoxCPM2 C++ server — the local clone/long-form line

Deployment entry for the **C++** `voxcpm-server` from
[liuzl/VoxCPM.cpp](https://github.com/liuzl/VoxCPM.cpp) (fork of bluryar/VoxCPM.cpp):
pure C++/ggml inference, no Python runtime, one GGUF file. Per the repo boundary in
`CLAUDE.md`, the engine source stays in that repo — this folder only holds how to build,
run, and point the product at it.

Measured on an M3 Max (q4_k LM + f16 AudioVAE, Metal backend, 6 timesteps): full-pipeline
**RTF ≈ 0.41**, first streamed audio in **~0.5s**, still real-time (RTF ≈ 0.9) while a
12B llama.cpp model generates on the same GPU. At the quality tier (`timesteps: 10`)
RTF ≈ 0.51. The trade against the Python engine (`engines/voxcpm2-server/`): identical
request surface for registered and design voices, but raw-PCM streaming only (fine on
loopback; use the Python engine's Opus streaming across a WAN).

## Build

```sh
git clone https://github.com/liuzl/VoxCPM.cpp && cd VoxCPM.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release   # Metal is on by default on macOS; -DGGML_CUDA=ON for NVIDIA
cmake --build build -j --target voxcpm-server
```

## Run

```sh
build/examples/voxcpm-server \
  --model-path /path/to/voxcpm2-q4_k-audiovae-f16.gguf \
  --model-name voxcpm2 \
  --voice-dir ~/.voxcpm/voices \
  --host 127.0.0.1 --port 18085 \
  --backend metal --threads 12 --inference-timesteps 6 \
  --api-key YOUR_KEY        # or --disable-auth on loopback
```

| Flag | Meaning |
|---|---|
| `--backend {cpu,metal,cuda,vulkan,auto}` | compute backend |
| `--inference-timesteps N` | default diffusion steps; requests may override per call |
| `--max-queue N` | synthesis waiting-queue bound (one active synthesis at a time) |
| `--output-sample-rate HZ` | optional resample before encoding |

Env: `VOXCPM_VAE_ON_CPU=1` routes AudioVAE graphs to a dedicated CPU backend without a
rebuild — the escape hatch if a Metal regression in the audio decoder ever reappears.

Point the product at it in `voxstudio.yaml` — note `health_path`, the C++ server serves
`/healthz`:

```yaml
engines:
  tts:
    base_url: http://127.0.0.1:18085
    model: voxcpm2
    health_path: /healthz
    capabilities: [clone, design, streaming]
```

## Contract

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | `{"status":"ok"}` |
| POST | `/v1/audio/speech` | synthesis; see fields below |
| GET | `/v1/voices` | `{"voices":[...]}`, registered voices sorted by id |
| POST | `/v1/voices` | register a voice (multipart: `id`, `text`, `audio`) |
| POST | `/v1/design-profiles` | generate and persist a reusable design voice |
| GET/DELETE | `/v1/voices/{id}` | inspect / remove one voice |

`/v1/audio/speech` fields: `model`, `input`, `voice` (a registered id, or `design`
for reference-free synthesis steered by a parenthesized style prefix),
`response_format` (`wav`/`mp3`/…), `speed`,
`cfg_value` (0,16], `timesteps` [1,100], `seed` (non-negative → reproducible output),
`stream` (bool), `stream_format` (`sse` for base64 events), `max-attempts`.

- **Streaming**: `stream: true` answers `audio/pcm` (f32le) with an `X-Sample-Rate`
  header, chunks leaving while synthesis runs — the contract `TtsClient.speechStream`
  expects. First audio arrives after prefill plus one decode window.
- `continuation_id` / `continuation_end` / `prosody_prompt` are accepted and validated
  for protocol parity but carry no state: since its 2026-07-16 policy change the Python
  server conditions chunks 2..N of a session on the voice anchor alone, which for
  registered voices is identical to independent requests with the same voice — and
  registered voices here always condition on the reference transcript
  (`prosody_prompt=true` behavior). A design profile first generates its anchor
  without reference conditioning, then persists that anchor as a reusable registered
  voice.

## Service templates

- macOS launchd: `com.voxstudio.voxcpm2-cpp.plist.example`
- Linux systemd: `voxcpm2-cpp.service`

Both use placeholders; machine-specific values stay out of this public repo.
