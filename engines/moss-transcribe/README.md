# moss-transcribe.cpp

Evaluation and deployment notes for
[mudler/moss-transcribe.cpp](https://github.com/mudler/moss-transcribe.cpp), a C++17/ggml
inference port of OpenMOSS
[MOSS-Transcribe-Diarize 0.9B](https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize).

## Role in voxstudio

MOSS complements rather than replaces the existing Parakeet ASR engine:

| Profile | Engine | Intended workload |
|---|---|---|
| Real-time ASR | parakeet.cpp | Voice input, interactive conversation, low-latency streaming |
| Long-form ASR | moss-transcribe.cpp | Meetings, interviews, calls, podcasts, and subtitle generation |

MOSS emits transcription, timestamps, and anonymous per-recording speaker labels in one
autoregressive stream. Its parsed JSON contains `{start, end, speaker, text}` segments. It
is therefore useful when the structure of a multi-speaker recording matters more than
streaming latency.

The engine is still young. Keep it behind a separate `asr_longform` profile until its
quality and operational behavior have been evaluated on representative recordings.

## Validated configuration

The initial smoke test used:

- Apple M3 Max with 64 GB unified memory
- macOS 26.5.1
- upstream commit `92a923dca88a41a34e47a364d55ee25731a9a0a2`
- ggml submodule `eced84c86f8b012c752c016f7fe789adea168e1e` (v0.15.3)
- `moss-transcribe-q5_k.gguf` (618 MB)
- CPU with 8 threads and the Metal backend

Q5_K is the current evaluation default: it is small enough for portable deployment while
upstream reports byte-identical output to the reference model on its parity sample. This
claim still needs independent validation on the voxstudio corpus.

## Build on Apple Silicon

Install Git, CMake, a C/C++ compiler, and optionally ccache. Then build the CLI and tests:

```bash
git clone --recursive https://github.com/mudler/moss-transcribe.cpp
cd moss-transcribe.cpp

cmake -S . -B build-metal \
  -DMT_GGML_METAL=ON \
  -DMT_BUILD_TESTS=ON \
  -DGGML_NATIVE=ON
cmake --build build-metal -j 8
ctest --test-dir build-metal --output-on-failure
```

Tests that require model baselines skip when those fixtures are not configured. In the
initial build, the four standalone audio/parser/subtitle tests passed and nine model tests
skipped as designed.

Download the published Q5_K model:

```bash
mkdir -p models
curl -fL --retry 3 \
  -o models/moss-transcribe-q5_k.gguf \
  https://huggingface.co/mudler/moss-transcribe.cpp-gguf/resolve/main/moss-transcribe-q5_k.gguf
```

Model weights retain their upstream Apache-2.0 license. The C++ port is MIT licensed.

## Run

On the validated macOS configuration, disable Metal residency sets as described under
Known issues:

```bash
GGML_METAL_NO_RESIDENCY=1 \
build-metal/moss-transcribe transcribe \
  models/moss-transcribe-q5_k.gguf \
  input.wav \
  --format json
```

Force CPU inference when comparing backends:

```bash
MTD_DEVICE=cpu MTD_THREADS=8 \
build-metal/moss-transcribe transcribe \
  models/moss-transcribe-q5_k.gguf \
  input.wav \
  --format json
```

The CLI also supports raw text, SRT, and ASS output. Audio is loaded as WAV and resampled to
the model's 16 kHz mono input when necessary.

Example JSON:

```json
[
  {
    "id": "seg_0001",
    "start": 0.28,
    "end": 2.32,
    "speaker": "S01",
    "text": "And so, my fellow Americans,"
  }
]
```

Speaker identifiers are relative to one recording. They do not identify a real person and
must not be treated as stable identities across files.

## OpenAI-compatible service

This directory includes a FastAPI adapter over the upstream C ABI v1. The model is loaded
once at process startup and reused; inference is serialized because a model context is not
safe for concurrent calls.

Build the upstream shared library:

```bash
cmake -S . -B build-shared \
  -DMT_SHARED=ON \
  -DMT_BUILD_CLI=ON
cmake --build build-shared -j
```

Install and run the adapter from this directory:

```bash
uv sync --locked

MOSS_LIBRARY=/path/to/libmoss-transcribe.so \
MOSS_MODEL=/path/to/moss-transcribe-q5_k.gguf \
MOSS_MODEL_NAME=moss-transcribe-diarize \
.venv/bin/python -m uvicorn server_moss:app --host 0.0.0.0 --port 18087
```

On macOS, use the generated `.dylib` path and retain
`GGML_METAL_NO_RESIDENCY=1` on affected ggml versions.

Endpoints:

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Model process readiness |
| POST | `/v1/audio/transcriptions` | Multipart OpenAI-compatible transcription |

The transcription endpoint supports `json`, `text`, and `verbose_json`. The verbose result
adds MOSS's `speaker` field to each timestamped segment. `language` is accepted as an
OpenAI client compatibility hint but MOSS detects language itself. C ABI v1 does not expose
custom prompts or sampling, so non-empty `prompt` and non-zero `temperature` fail clearly
instead of being silently ignored.

```bash
curl -F file=@meeting.wav \
  -F model=moss-transcribe-diarize \
  -F response_format=verbose_json \
  http://127.0.0.1:18087/v1/audio/transcriptions
```

The included `moss-transcribe.service` is a path-parameterized user-systemd template.
Adjust its working directory, library, and model paths for the host before enabling it.

For macOS, copy `com.voxstudio.moss-transcribe.plist.example`, replace its
`@SERVER_DIR@`, `@MOSS_LIBRARY@`, `@MOSS_MODEL@`, and `@LOG_DIR@` placeholders, then install
it as a user LaunchAgent:

```bash
plutil -lint com.voxstudio.moss-transcribe.plist
cp com.voxstudio.moss-transcribe.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.voxstudio.moss-transcribe.plist
launchctl kickstart -k gui/$(id -u)/com.voxstudio.moss-transcribe
```

The template binds loopback by default. Change the host only when a trusted network and
an authentication boundary are already in place.

## Initial measurements

These are smoke-test measurements, not a general benchmark. They include model loading and
were taken on an otherwise lightly loaded machine.

| Audio | Backend | Wall time | Peak memory | Result |
|---:|---|---:|---:|---|
| 11 s English | CPU, 8 threads | 4.66 s | 1.07 GB | Structured JSON |
| 11 s English | Metal | 1.09 s | 1.02 GB | Byte-identical to CPU |
| 44 s English | Metal | 3.75 s | 1.04 GB | 12 timestamped segments |
| 20.28 s Chinese | Metal | 1.18 s | 1.03 GB | One timestamped speaker segment |

The Chinese smoke test was intelligible but contained errors around a proper name and the
phrase `开放权重`. Treat this as proof that the path works, not evidence of production
accuracy.

## Known issues

### Metal residency-set assertion on process exit

With ggml v0.15.3 on the validated macOS release, inference completed and wrote correct
JSON, but process cleanup could abort at:

```text
GGML_ASSERT([rsets->data count] == 0) failed
```

Set `GGML_METAL_NO_RESIDENCY=1`. The workaround produced a clean exit and output identical
to CPU in the smoke test. Re-test this when upgrading ggml; remove the workaround once the
upstream cleanup issue is fixed.

### Long input cost

The model encodes 30-second audio chunks and performs autoregressive decoding over a context
that grows with the recording and transcript. Real-time factor can therefore worsen on
hour-long inputs. Short-sample performance must not be extrapolated to long meetings.

### Adapter concurrency

The adapter serializes inference through one resident model context. This is deliberate and
safe for the initial deployment, but it provides no batching. Put a bounded request queue
and admission control in front of the service before exposing it to multiple tenants.

## Integration plan

Completed in the initial integration:

- shared transcription segments with `start`, `end`, `speaker`, and `text`;
- optional `asr_longform` profile without changing the default real-time ASR;
- OpenAI-compatible resident C-API adapter;
- `vox transcribe --mode longform --json` in both CLI implementations.

Remaining work is subtitle rendering, streaming progress, production admission control, and
promotion after the benchmark below passes agreed quality thresholds.

## Benchmark before promotion

Use consented, non-sensitive fixtures and retain a human-reviewed reference transcript.
Cover:

- Mandarin meetings with two, three, and five or more speakers
- Chinese/English code-switching and domain-specific hotwords
- rapid speaker turns, interruptions, overlap, silence, and background noise
- 10-, 30-, and 60-minute inputs
- Q5_K versus Q4_K quality and timestamp drift
- cold/warm latency, real-time factor, peak memory, and failure recovery
- character/word error rate, speaker-attributed error, speaker count, and timestamp error

Record benchmark methodology and aggregate results in this directory. Do not commit private
audio, machine names, addresses, credentials, or deployment topology.
