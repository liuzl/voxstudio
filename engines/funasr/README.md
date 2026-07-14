# FunASR utterance transcription server

OpenAI-compatible `/v1/audio/transcriptions` over a FunASR `AutoModel`, targeted at the
realtime conversation slot: short utterances, Mandarin-first, code-switched zh/en speech.

The default model is **SenseVoice-Small** (`iic/SenseVoiceSmall`): strong Mandarin,
explicit zh/en/yue/ja/ko code-switch support, non-autoregressive and fast on CPU.
`FUNASR_MODEL=paraformer-zh` selects Paraformer-large for a Mandarin-only comparison.
Model weights download into the FunASR cache on first start; nothing is committed here.

## Run

```sh
uv sync --locked
FUNASR_PORT=18088 uv run python server_funasr.py
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `FUNASR_MODEL` | `iic/SenseVoiceSmall` | any FunASR model id |
| `FUNASR_DEVICE` | `cpu` | `cuda:0` on a GPU host |
| `FUNASR_HOST` / `FUNASR_PORT` | `127.0.0.1` / `18088` | bind address |
| `FUNASR_QUEUE_LIMIT` | `8` | concurrent transcriptions admitted |
| `FUNASR_MAX_UPLOAD_BYTES` | 64 MiB | upload cap |

Point the product at it by editing the `asr` engine in `voxstudio.yaml`:

```yaml
engines:
  asr:
    base_url: http://<host>:18088
    model: sensevoice-small
```

## Contract

- `POST /v1/audio/transcriptions` — multipart `file`, optional `language` hint
  (`zh|en|yue|ja|ko|auto`; anything else degrades to `auto`), `response_format`
  `json` (default) or `text`. SenseVoice's `<|zh|>`-style tags are stripped server-side.
- `GET /healthz` — `{status, model}`.

## Deploy (systemd template)

`funasr-asr.service` is a template: fill in the user, paths, and port; keep the service
bound to localhost or a private network. Do not commit machine-specific values here —
operational events belong in the internal ops repo.

## Evaluation

`tools/compare_asr.py` (repo root) transcribes the same WAVs against multiple ASR
endpoints and reports CER against reference texts. Collect real utterances with
`vox listen --save-utterances DIR` (explicit opt-in), write one `.ref.txt` per WAV with
the corrected transcript, then run the comparison before switching the `asr` slot.
