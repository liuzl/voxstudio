# Local conversation LLM — llama-server + Gemma

The conversation LLM slot served locally: llama.cpp's `llama-server` with the Gemma 12B
QAT gguf, model alias `gemma4-12b-qat` so switching between this and a remote instance
is a `base_url` change only.

Measured on an M3 Max (Q4_0, Metal, reasoning off, source-built master): **first token
~166ms**, ~60 chars/s — first-token beats a cross-border RTX host, and generation is an
order of magnitude above speech rate, which is what conversation needs. `llama.cpp >=
b9960` is required for the `gemma4` architecture; a source build of master was measurably
faster than the brew bottle (265ms → 166ms first token). Context is sized for
conversation (16k), thinking disabled (`--reasoning-budget 0`), vision projector omitted.

```sh
brew install llama.cpp          # or upgrade: architecture support moves fast
sed -e "s|%LLAMA_SERVER%|$(which llama-server)|" \
    -e "s|%MODEL_GGUF%|$HOME/models/gemma-4-12B-it-qat.gguf|" \
    com.voxstudio.gemma-llm.plist.example > ~/Library/LaunchAgents/com.voxstudio.gemma-llm.plist
launchctl load ~/Library/LaunchAgents/com.voxstudio.gemma-llm.plist
```

```yaml
engines:
  llm:
    base_url: http://127.0.0.1:18094
    model: gemma4-12b-qat
```

**Leave the Gemma MTP draft off on Apple Silicon** (`--spec-type draft-mtp` +
`mtp-gemma-4-12B-it.gguf`): measured end-to-end it is a net slowdown here (60 → 19
chars/s) even though the draft accepts a healthy ~2.7 tokens per verification round —
Metal's speculation overhead exceeds the gain at chat-time acceptance. The same
configuration is a systematically-verified 3x+ win on a CUDA host (100 → 307-375 tok/s
in the 2026-06-12 benchmark): speculation's payoff is a property of the backend, not of
the model pair, and each host needs its own A/B.
