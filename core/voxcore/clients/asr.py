"""ASR engine client: `/v1/audio/transcriptions`."""

import re
from pathlib import Path
from typing import NamedTuple

from ..config import EngineCfg
from ..http import build_client, raise_for_status

# The engine leaks a language tag into the transcript -- once at the tail for
# Chinese, once per sentence for English.
LANG_TAG = re.compile(r"\s*<[a-z]{2}-[A-Z]{2}>")
FIRST_LANG = re.compile(r"<([a-z]{2})-[A-Z]{2}>")


class Transcription(NamedTuple):
    text: str
    lang: str | None


def parse_transcript(raw: str) -> Transcription:
    """Strip the leaked tags, and read the language from the first one.

    `verbose_json.language` is hardcoded to "en" by the engine and must not be used.
    The inline tag is the only real language detection available.
    """
    match = FIRST_LANG.search(raw)
    return Transcription(LANG_TAG.sub("", raw).strip(), match.group(1) if match else None)


class ASRClient:
    def __init__(self, cfg: EngineCfg):
        self.cfg = cfg
        self._client = build_client(cfg)

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def transcribe(self, audio_path: str | Path, *, language: str = "auto") -> Transcription:
        path = Path(audio_path)
        with path.open("rb") as fh:
            response = self._client.post(
                "/v1/audio/transcriptions",
                data={"model": self.cfg.model, "language": language, "response_format": "json"},
                files={"file": (path.name, fh)},
            )
        return parse_transcript(raise_for_status(response).json().get("text", ""))
