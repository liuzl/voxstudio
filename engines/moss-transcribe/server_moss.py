"""OpenAI-compatible HTTP adapter for the moss-transcribe.cpp C API."""

from __future__ import annotations

import ctypes
import os
import re
import tempfile
import threading
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Annotated, Protocol

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse


SEGMENT = re.compile(
    r"\[([0-9]+(?:\.[0-9]+)?)\]\[(S[0-9]+)\](.*?)"
    r"\[([0-9]+(?:\.[0-9]+)?)\]",
    re.DOTALL,
)
SUPPORTED_FORMATS = {"json", "text", "verbose_json"}


@dataclass(frozen=True)
class Segment:
    id: int
    start: float
    end: float
    speaker: str
    text: str


def parse_transcript(raw: str) -> list[Segment]:
    """Parse the model's `[start][Sxx]text[end]` stream."""
    return [
        Segment(
            id=index,
            start=float(match.group(1)),
            end=float(match.group(4)),
            speaker=match.group(2),
            text=match.group(3).strip(),
        )
        for index, match in enumerate(SEGMENT.finditer(raw))
    ]


def visible_text(segments: list[Segment], raw: str) -> str:
    return " ".join(segment.text for segment in segments).strip() or raw.strip()


class Transcriber(Protocol):
    def transcribe(self, path: Path, max_new_tokens: int) -> str: ...

    def close(self) -> None: ...


class MossCapi:
    """A serialized, resident wrapper over moss-transcribe.cpp C ABI v1."""

    def __init__(self, library: str | Path, model: str | Path):
        self._library = ctypes.CDLL(str(library))
        self._configure_signatures()
        abi = self._library.moss_transcribe_capi_abi_version()
        if abi != 1:
            raise RuntimeError(f"unsupported moss-transcribe C ABI {abi}; expected 1")
        self._ctx = self._library.moss_transcribe_capi_load(os.fsencode(model))
        if not self._ctx:
            raise RuntimeError(f"failed to load MOSS model: {model}")
        self._lock = threading.Lock()

    def _configure_signatures(self) -> None:
        lib = self._library
        lib.moss_transcribe_capi_abi_version.argtypes = []
        lib.moss_transcribe_capi_abi_version.restype = ctypes.c_int
        lib.moss_transcribe_capi_load.argtypes = [ctypes.c_char_p]
        lib.moss_transcribe_capi_load.restype = ctypes.c_void_p
        lib.moss_transcribe_capi_free.argtypes = [ctypes.c_void_p]
        lib.moss_transcribe_capi_free.restype = None
        lib.moss_transcribe_capi_transcribe_path.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.c_int,
        ]
        lib.moss_transcribe_capi_transcribe_path.restype = ctypes.c_void_p
        lib.moss_transcribe_capi_free_string.argtypes = [ctypes.c_void_p]
        lib.moss_transcribe_capi_free_string.restype = None
        lib.moss_transcribe_capi_last_error.argtypes = [ctypes.c_void_p]
        lib.moss_transcribe_capi_last_error.restype = ctypes.c_char_p

    def transcribe(self, path: Path, max_new_tokens: int) -> str:
        with self._lock:
            result = self._library.moss_transcribe_capi_transcribe_path(
                self._ctx,
                os.fsencode(path),
                max_new_tokens,
            )
            if not result:
                detail = self._library.moss_transcribe_capi_last_error(self._ctx)
                message = detail.decode("utf-8", errors="replace") if detail else "transcription failed"
                raise RuntimeError(message)
            try:
                return ctypes.string_at(result).decode("utf-8")
            finally:
                self._library.moss_transcribe_capi_free_string(result)

    def close(self) -> None:
        if self._ctx:
            self._library.moss_transcribe_capi_free(self._ctx)
            self._ctx = None


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def load_engine() -> MossCapi:
    return MossCapi(_required_env("MOSS_LIBRARY"), _required_env("MOSS_MODEL"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine = load_engine()
    app.state.engine = engine
    try:
        yield
    finally:
        engine.close()


app = FastAPI(title="moss-transcribe-server", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health(request: Request) -> dict[str, str]:
    return {
        "status": "ok",
        "engine": "moss-transcribe.cpp",
        "model": os.getenv("MOSS_MODEL_NAME", "moss-transcribe-diarize"),
    }


@app.post("/v1/audio/transcriptions")
def transcriptions(
    request: Request,
    file: Annotated[UploadFile, File()],
    model: Annotated[str, Form()] = "moss-transcribe-diarize",
    language: Annotated[str | None, Form()] = None,
    response_format: Annotated[str, Form()] = "json",
    prompt: Annotated[str | None, Form()] = None,
    temperature: Annotated[float, Form()] = 0.0,
    max_new_tokens: Annotated[int, Form()] = 0,
):
    del language  # Accepted for OpenAI client compatibility; the model detects language.
    if response_format not in SUPPORTED_FORMATS:
        raise HTTPException(400, detail={"error": {
            "code": "unsupported_response_format",
            "message": f"response_format must be one of {sorted(SUPPORTED_FORMATS)}",
        }})
    if prompt:
        raise HTTPException(400, detail={"error": {
            "code": "unsupported_prompt",
            "message": "custom prompts are not exposed by moss-transcribe C ABI v1",
        }})
    if temperature != 0:
        raise HTTPException(400, detail={"error": {
            "code": "unsupported_temperature",
            "message": "moss-transcribe.cpp currently supports deterministic decoding only",
        }})
    if max_new_tokens < 0:
        raise HTTPException(400, detail={"error": {
            "code": "invalid_max_new_tokens",
            "message": "max_new_tokens must be zero or positive",
        }})

    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix="moss-upload-", suffix=suffix, delete=False) as output:
            path = Path(output.name)
            while chunk := file.file.read(1024 * 1024):
                output.write(chunk)
        raw = request.app.state.engine.transcribe(path, max_new_tokens)
    except RuntimeError as exc:
        raise HTTPException(500, detail={"error": {
            "code": "transcription_failed",
            "message": str(exc),
        }}) from exc
    finally:
        file.file.close()
        if path is not None:
            path.unlink(missing_ok=True)

    segments = parse_transcript(raw)
    text = visible_text(segments, raw)
    if response_format == "text":
        return PlainTextResponse(text)
    if response_format == "json":
        return JSONResponse({"text": text})
    duration = max((segment.end for segment in segments), default=0.0)
    return JSONResponse({
        "task": "transcribe",
        "language": None,
        "duration": duration,
        "text": text,
        "model": model,
        "segments": [asdict(segment) for segment in segments],
    })
