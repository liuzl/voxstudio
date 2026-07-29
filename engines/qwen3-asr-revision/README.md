# Qwen3-ASR revision tier (audio.cpp)

The accuracy tier behind the funasr adapter's `revise=true` bypass
(`engines/funasr/`). Runs [audio.cpp](https://github.com/0xShug0/audio.cpp)'s
`audiocpp_server` with **Qwen3-ASR-0.6B q8_0** (GGUF): an LLM-decoder ASR whose
language prior fixes exactly the domain-term errors a fast acoustic model makes
("机器学习中的过拟合" instead of "继续学习中的过你荷"). Measured on an M3 Max
(Metal build): ~0.5 s per utterance server-resident, RTF ≈ 0.15.

This directory holds deployment templates only; audio.cpp itself is cloned and
built outside this repo (upstream C++ engine sources stay out of voxstudio).

## Build (macOS, Metal)

```bash
git clone https://github.com/0xShug0/audio.cpp.git
cd audio.cpp
cmake -S . -B build/macos-metal-release -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DENGINE_ENABLE_METAL=ON -DGGML_METAL_EMBED_LIBRARY=OFF \
  -DAUDIOCPP_MODEL_SET=custom -DAUDIOCPP_MODELS=qwen3_asr
cmake --build build/macos-metal-release --target audiocpp_server -j
```

(`GGML_METAL_EMBED_LIBRARY=OFF` compiles shaders at runtime, so the Xcode Metal
toolchain is not required — Command Line Tools are enough. Their
`scripts/build_metal.sh` insists on the full toolchain.)

Model: `Qwen3-ASR-0.6B-GGUF/qwen3-asr-0.6b-q8_0.gguf` from
[audio-cpp/audio.cpp-gguf](https://huggingface.co/audio-cpp/audio.cpp-gguf)
(~1.1 GB).

## Configure

`server.qwen3.json.example` — fill in the model path and port, keep the server
bound to localhost. Point the funasr adapter at it via `FUNASR_REVISE_URL`.

## Deploy

`com.voxstudio.qwen3asr.plist.example` (launchd, macOS): fill in paths. Plist
changes need `launchctl bootout` + `bootstrap`; `kickstart -k` restarts with the
cached definition. Machine-specific values and operational events stay in the
internal ops repo.

## Contract

OpenAI-compatible `POST /v1/audio/transcriptions` (multipart `model` + `file`),
plus `GET /health`. The response carries `text` and a `timing` block.
