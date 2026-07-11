# parakeet.cpp

Integration and deployment notes for
[mudler/parakeet.cpp](https://github.com/mudler/parakeet.cpp), a C++17/ggml inference port
of NVIDIA Parakeet speech-recognition models.

## Role in voxstudio

Parakeet is voxstudio's default ASR engine for voice input and interactive workloads. It
complements the long-form MOSS engine:

| Profile | Engine | Intended workload |
|---|---|---|
| Real-time ASR | parakeet.cpp | Voice input, interactive conversation, short recordings |
| Long-form ASR | moss-transcribe.cpp | Meetings, interviews, speaker diarization, subtitles |

The configured model is `nvidia/nemotron-3.5-asr-streaming-0.6b`. It supports more than 40
locales, including Mandarin, and can run both offline and with cache-aware streaming. Do
not substitute `parakeet-tdt-0.6b-v3`: despite its multilingual name, that model covers 25
European languages and does not provide the required Mandarin path.

The current voxstudio client sends a complete audio file to the OpenAI-compatible HTTP
endpoint. The model and upstream CLI support streaming, but voxstudio does not yet expose
streaming audio transport or partial transcripts.

## Contract used by voxstudio

The client sends multipart form data to:

```text
POST /v1/audio/transcriptions
```

Fields:

| Field | Current value | Notes |
|---|---|---|
| `file` | uploaded audio | Upstream example server currently accepts WAV |
| `model` | configured model name | Kept for OpenAI client compatibility |
| `language` | locale or `auto` | `auto` is the voxstudio default |
| `response_format` | `json` | voxstudio currently consumes the `text` field |

Example:

```bash
curl -F file=@speech.wav \
  -F model=nemotron-asr \
  -F language=auto \
  -F response_format=json \
  http://127.0.0.1:8080/v1/audio/transcriptions
```

Upstream also supports `text`, `verbose_json`, and word timestamp granularity. These are
not yet represented in the shared voxstudio `Transcription` contract.

## Model selection

Use the Nemotron model for voxstudio's multilingual default:

```text
nvidia/nemotron-3.5-asr-streaming-0.6b
```

Relevant upstream alternatives have different product boundaries:

| Model | Languages | Mode | Suitable here? |
|---|---|---|---|
| `nemotron-3.5-asr-streaming-0.6b` | 40+ locales | Offline and streaming RNNT | Yes; default |
| `parakeet_realtime_eou_120m-v1` | English | Streaming RNNT with EOU detection | English-only specialized option |
| `parakeet-tdt-0.6b-v3` | 25 European languages | Offline TDT | No Mandarin |
| Other Parakeet CTC/RNNT/TDT checkpoints | Primarily English | Offline | Not the multilingual default |

GGUF builds are published in the
[`mudler/parakeet-cpp-gguf`](https://huggingface.co/mudler/parakeet-cpp-gguf)
collection in F16, Q8_0, Q6_K, Q5_K, and Q4_K variants. Pin the exact model filename or
checksum in a production deployment rather than relying on a moving alias.

## Run the upstream server

The upstream build includes `parakeet-server`, a small OpenAI-compatible example server.
It serves one model and processes one request at a time, so it is appropriate for local
development and initial validation rather than an exposed multi-tenant deployment.

The simplest container smoke test is:

```bash
docker run --rm -p 8080:8080 \
  ghcr.io/mudler/parakeet.cpp-server:latest \
  --model nemotron-3.5-asr-streaming-0.6b
```

Use the CUDA image on a compatible NVIDIA host:

```bash
docker run --rm --gpus all -p 8080:8080 \
  ghcr.io/mudler/parakeet.cpp-server:latest-cuda \
  --model nemotron-3.5-asr-streaming-0.6b
```

For production, mount a pre-fetched GGUF read-only instead of downloading on first boot.
Add authentication and TLS at the service boundary, and use a supervisor with explicit
resource, timeout, and restart policy. LocalAI is the upstream recommendation when
concurrency, batching, authentication, metrics, or multi-model serving is required.

## Build from source

Clone with the ggml submodule and build the CLI, server, and tests:

```bash
git clone --recursive https://github.com/mudler/parakeet.cpp
cd parakeet.cpp

cmake -B build \
  -DPARAKEET_BUILD_TESTS=ON \
  -DGGML_NATIVE=ON
cmake --build build -j
ctest --test-dir build --output-on-failure
```

GPU backend flags include:

```bash
# Apple Metal
cmake -B build-metal -DPARAKEET_GGML_METAL=ON

# NVIDIA CUDA
cmake -B build-cuda -DPARAKEET_GGML_CUDA=ON

# Vulkan
cmake -B build-vulkan -DPARAKEET_GGML_VULKAN=ON
```

Use `-DGGML_NATIVE=OFF` for portable release or CI builds. Build the shared C API with
`-DPARAKEET_SHARED=ON` when embedding the engine in a resident service.

The resulting binaries are normally:

```text
build/examples/cli/parakeet-cli
build/examples/server/parakeet-server
```

## CLI validation

Inspect a GGUF and transcribe a WAV:

```bash
parakeet-cli info model.gguf
parakeet-cli transcribe \
  --model model.gguf \
  --input speech.wav \
  --lang zh-CN \
  --json
```

Force CPU execution when comparing a GPU backend:

```bash
PARAKEET_DEVICE=cpu parakeet-cli transcribe \
  --model model.gguf \
  --input speech.wav \
  --lang zh-CN \
  --json
```

The cache-aware streaming CLI path is available only for compatible streaming models:

```bash
parakeet-cli transcribe \
  --model model.gguf \
  --input speech.wav \
  --lang zh-CN \
  --stream
```

## Language-tag compatibility

The currently integrated Nemotron service can include locale tags such as `<zh-CN>` or
`<en-US>` inside `text`. English output may repeat the tag per sentence, while Chinese
output may place it at the tail. In addition, the tested `verbose_json.language` value was
not reliable.

Both TypeScript and transitional Python clients therefore:

1. derive the detected language from the first inline locale tag;
2. remove all inline locale tags from the user-facing transcript;
3. ignore `verbose_json.language` for detection.

Re-test this behavior before removing the compatibility parser. A future server version
may return clean text and a trustworthy structured language field.

## Configuration

The repository example config uses:

```yaml
engines:
  asr:
    base_url: http://127.0.0.1:18086
    model: nemotron-asr
    api_key: ${VOXSTUDIO_ASR_API_KEY}
```

The model string is a deployment alias, not necessarily the GGUF filename. The core only
depends on the OpenAI-compatible endpoint, so changing the hosting implementation should
not require an application change.

## Validation status

The existing deployment has two independent tiers:

| Role | Hardware class | Model | Backend | Observed resources/performance |
|---|---|---|---|---|
| Primary | Ada-generation NVIDIA GPU | Nemotron 0.6B F16 | CUDA | About 2 GB host RAM and 1.5 GB VRAM; sub-second short requests |
| Fallback | 32-thread desktop/server CPU | Nemotron 0.6B Q8_0 | CPU, 8 threads | 1.01 GB peak RSS; 5.2 s Mandarin audio in 0.59 s (RTF 0.11) |

Both tiers run `parakeet-server` as a supervised user service and expose the same
OpenAI-compatible contract. The CPU fallback consumes no VRAM, allowing it to coexist with
unrelated GPU workloads. Routing and failover live outside this public repository.

The 2026-06-23 validation covered:

- Mandarin input with character-level agreement after punctuation normalization;
- matching F16 CUDA and Q8_0 CPU fallback output on the Mandarin smoke sample;
- English regression transcription;
- stable supervised service state with no process restarts during the check;
- direct HTTP transcription over the private service network.

The following client integration behavior is covered in this repository:

- multipart upload to `/v1/audio/transcriptions`;
- model, language, and response-format fields;
- JSON text extraction;
- locale-tag cleanup and language detection;
- CLI transcription and automatic reference-audio transcription workflows.

These numbers are deployment smoke tests, not a corpus benchmark. The historical record
did not preserve the exact upstream and ggml commit hashes alongside every measurement.
Future runs must capture those hashes, the GGUF filename and checksum, backend, thread
count, host class, and whether timings include model loading.

## Operational notes

- The service is deliberately single-model. Put bounded concurrency, retry, authentication,
  and metrics in the serving or gateway layer.
- A CPU Q8_0 fallback is viable: it remains comfortably faster than real time without
  competing for GPU memory.
- Treat a failed `/v1/models` request as inconclusive. The evaluated example server only
  implemented transcription, so that route returned 404 even while ASR was healthy. A
  production wrapper should expose an explicit health endpoint.
- The server accepts WAV only. Normalize uploads to PCM WAV before forwarding them.
- Keep service-manager paths and machine-specific library search paths in private
  operations configuration, not in this repository.

## Benchmark before changing the default

Use consented, non-sensitive fixtures with human-reviewed references. Cover:

- quiet and noisy Mandarin speech;
- Chinese/English code-switching and proper names;
- short commands and 1-, 5-, and 15-minute recordings;
- automatic versus explicit locale selection;
- offline versus cache-aware streaming output;
- F16, Q8_0, Q5_K, and Q4_K accuracy and resource usage;
- CPU and available GPU backends;
- cold/warm latency, real-time factor, peak memory, and concurrent requests;
- character/word error rate, first-partial latency, finalization latency, and EOU accuracy.

Do not commit private audio, machine names, addresses, credentials, or deployment topology.
