"""ASR engine client: `/v1/audio/transcriptions`."""

import re
from pathlib import Path
from typing import Any, NamedTuple

from ..config import EngineCfg
from ..http import build_client, raise_for_status

# The engine leaks a language tag into the transcript -- once at the tail for
# Chinese, once per sentence for English.
LANG_TAG = re.compile(r"\s*<[a-z]{2}-[A-Z]{2}>")
FIRST_LANG = re.compile(r"<([a-z]{2})-[A-Z]{2}>")


class TranscriptionSegment(NamedTuple):
    start: float
    end: float
    text: str
    speaker: str | None = None
    id: str | int | None = None


class Transcription(NamedTuple):
    text: str
    lang: str | None
    duration: float | None = None
    segments: tuple[TranscriptionSegment, ...] | None = None


def parse_transcript(raw: str) -> Transcription:
    """Strip the leaked tags, and read the language from the first one.

    `verbose_json.language` is hardcoded to "en" by the engine and must not be used.
    The inline tag is the only real language detection available.
    """
    match = FIRST_LANG.search(raw)
    return Transcription(LANG_TAG.sub("", raw).strip(), match.group(1) if match else None)


def parse_response(payload: Any) -> Transcription:
    if not isinstance(payload, dict):
        return parse_transcript("")
    raw = payload.get("text", "")
    result = parse_transcript(raw if isinstance(raw, str) else "")
    parsed = []
    items = payload.get("segments")
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        if not isinstance(item.get("start"), (int, float)) or not isinstance(item.get("end"), (int, float)):
            continue
        if not isinstance(item.get("text"), str):
            continue
        parsed.append(TranscriptionSegment(
            start=float(item["start"]),
            end=float(item["end"]),
            text=item["text"],
            speaker=item.get("speaker") if isinstance(item.get("speaker"), str) else None,
            id=item.get("id") if isinstance(item.get("id"), (str, int)) else None,
        ))
    duration = payload.get("duration")
    return Transcription(
        result.text,
        result.lang,
        float(duration) if isinstance(duration, (int, float)) else None,
        tuple(parsed) if isinstance(items, list) else None,
    )


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

    def transcribe(
        self,
        audio_path: str | Path,
        *,
        language: str = "auto",
        structured: bool = False,
        max_new_tokens: int | None = None,
    ) -> Transcription:
        path = Path(audio_path)
        with path.open("rb") as fh:
            data = {
                "model": self.cfg.model,
                "language": language,
                "response_format": "verbose_json" if structured else "json",
            }
            if max_new_tokens is not None:
                data["max_new_tokens"] = str(max_new_tokens)
            response = self._client.post(
                "/v1/audio/transcriptions",
                data=data,
                files={"file": (path.name, fh)},
            )
        return parse_response(raise_for_status(response).json())
