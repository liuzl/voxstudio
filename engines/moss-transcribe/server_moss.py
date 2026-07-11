"""OpenAI-compatible HTTP adapter for the moss-transcribe.cpp C API."""

from __future__ import annotations

import ctypes
import os
import re
import subprocess
import tempfile
import threading
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Annotated, BinaryIO, Protocol

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse


SEGMENT = re.compile(
    r"\[([0-9]+(?:\.[0-9]+)?)\]\[(S[0-9]+)\](.*?)"
    r"\[([0-9]+(?:\.[0-9]+)?)\]",
    re.DOTALL,
)
SUPPORTED_FORMATS = {"json", "text", "verbose_json"}


@dataclass(frozen=True)
class Settings:
    max_upload_bytes: int
    max_duration_seconds: float
    queue_limit: int
    ffmpeg_timeout_seconds: float
    ffmpeg: str
    ffprobe: str

    @classmethod
    def from_env(cls) -> "Settings":
        def positive_int(name: str, default: int) -> int:
            value = int(os.getenv(name, str(default)))
            if value <= 0:
                raise RuntimeError(f"{name} must be positive")
            return value

        def positive_float(name: str, default: float) -> float:
            value = float(os.getenv(name, str(default)))
            if value <= 0:
                raise RuntimeError(f"{name} must be positive")
            return value

        return cls(
            max_upload_bytes=positive_int("MOSS_MAX_UPLOAD_BYTES", 1_073_741_824),
            max_duration_seconds=positive_float("MOSS_MAX_DURATION_SECONDS", 7_200),
            queue_limit=positive_int("MOSS_QUEUE_LIMIT", 4),
            ffmpeg_timeout_seconds=positive_float("MOSS_FFMPEG_TIMEOUT_SECONDS", 300),
            ffmpeg=os.getenv("MOSS_FFMPEG", "ffmpeg"),
            ffprobe=os.getenv("MOSS_FFPROBE", "ffprobe"),
        )


@dataclass(frozen=True)
class Segment:
    id: int
    start: float
    end: float
    speaker: str
    text: str


class AudioError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        self.message = message
        super().__init__(message)


class Admission:
    """Bound total waiting/running work and serialize a single model context."""

    def __init__(self, limit: int):
        self._limit = limit
        self._guard = threading.Lock()
        self._serial = threading.Semaphore(1)
        self._reserved = 0
        self._active = 0

    def enter(self) -> bool:
        with self._guard:
            if self._reserved >= self._limit:
                return False
            self._reserved += 1
        self._serial.acquire()
        with self._guard:
            self._active += 1
        return True

    def leave(self) -> None:
        with self._guard:
            self._active -= 1
            self._reserved -= 1
        self._serial.release()

    def snapshot(self) -> dict[str, int]:
        with self._guard:
            return {
                "capacity": self._limit,
                "active": self._active,
                "waiting": self._reserved - self._active,
            }


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


class Normalizer(Protocol):
    def normalize(self, source: Path, target: Path) -> float: ...


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

    def _configure_signatures(self) -> None:
        lib = self._library
        lib.moss_transcribe_capi_abi_version.argtypes = []
        lib.moss_transcribe_capi_abi_version.restype = ctypes.c_int
        lib.moss_transcribe_capi_load.argtypes = [ctypes.c_char_p]
        lib.moss_transcribe_capi_load.restype = ctypes.c_void_p
        lib.moss_transcribe_capi_free.argtypes = [ctypes.c_void_p]
        lib.moss_transcribe_capi_free.restype = None
        lib.moss_transcribe_capi_transcribe_path.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        lib.moss_transcribe_capi_transcribe_path.restype = ctypes.c_void_p
        lib.moss_transcribe_capi_free_string.argtypes = [ctypes.c_void_p]
        lib.moss_transcribe_capi_free_string.restype = None
        lib.moss_transcribe_capi_last_error.argtypes = [ctypes.c_void_p]
        lib.moss_transcribe_capi_last_error.restype = ctypes.c_char_p

    def transcribe(self, path: Path, max_new_tokens: int) -> str:
        result = self._library.moss_transcribe_capi_transcribe_path(self._ctx, os.fsencode(path), max_new_tokens)
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


class FfmpegNormalizer:
    def __init__(self, settings: Settings):
        self.settings = settings

    def _run(self, command: list[str]) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=self.settings.ffmpeg_timeout_seconds,
            )
        except FileNotFoundError as exc:
            raise AudioError(503, "ffmpeg_unavailable", "FFmpeg or ffprobe is not installed") from exc
        except subprocess.TimeoutExpired as exc:
            raise AudioError(422, "audio_normalization_timeout", "audio normalization timed out") from exc

    def normalize(self, source: Path, target: Path) -> float:
        probe = self._run([
            self.settings.ffprobe, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(source),
        ])
        if probe.returncode != 0:
            raise AudioError(422, "audio_probe_failed", "could not read audio or video duration")
        try:
            duration = float(probe.stdout.strip())
        except ValueError as exc:
            raise AudioError(422, "audio_probe_failed", "could not determine audio or video duration") from exc
        if duration <= 0:
            raise AudioError(422, "invalid_audio_duration", "audio or video duration must be positive")
        if duration > self.settings.max_duration_seconds:
            raise AudioError(
                413,
                "audio_too_long",
                f"audio duration exceeds {self.settings.max_duration_seconds:g} seconds",
            )
        conversion = self._run([
            self.settings.ffmpeg, "-nostdin", "-v", "error", "-y", "-i", str(source),
            "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(target),
        ])
        if conversion.returncode != 0 or not target.exists() or target.stat().st_size == 0:
            raise AudioError(422, "audio_normalization_failed", "could not extract and normalize audio")
        return duration


def save_upload(source: BinaryIO, target: Path, max_bytes: int) -> None:
    size = 0
    with target.open("wb") as output:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise AudioError(413, "upload_too_large", f"upload exceeds {max_bytes} bytes")
            output.write(chunk)


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def load_engine() -> MossCapi:
    return MossCapi(_required_env("MOSS_LIBRARY"), _required_env("MOSS_MODEL"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings.from_env()
    engine = load_engine()
    app.state.settings = settings
    app.state.normalizer = FfmpegNormalizer(settings)
    app.state.admission = Admission(settings.queue_limit)
    app.state.engine = engine
    try:
        yield
    finally:
        engine.close()


app = FastAPI(title="moss-transcribe-server", version="0.2.0", lifespan=lifespan)
app.state.settings = Settings.from_env()
app.state.normalizer = FfmpegNormalizer(app.state.settings)
app.state.admission = Admission(app.state.settings.queue_limit)


def error(status: int, code: str, message: str, *, headers: dict[str, str] | None = None) -> HTTPException:
    return HTTPException(status, detail={"error": {"code": code, "message": message}}, headers=headers)


@app.get("/health")
def health(request: Request) -> dict[str, object]:
    return {
        "status": "ok",
        "ready": hasattr(request.app.state, "engine"),
        "engine": "moss-transcribe.cpp",
        "model": os.getenv("MOSS_MODEL_NAME", "moss-transcribe-diarize"),
        "queue": request.app.state.admission.snapshot(),
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
    del language
    if response_format not in SUPPORTED_FORMATS:
        raise error(400, "unsupported_response_format", f"response_format must be one of {sorted(SUPPORTED_FORMATS)}")
    if prompt:
        raise error(400, "unsupported_prompt", "custom prompts are not exposed by moss-transcribe C ABI v1")
    if temperature != 0:
        raise error(400, "unsupported_temperature", "moss-transcribe.cpp currently supports deterministic decoding only")
    if max_new_tokens < 0:
        raise error(400, "invalid_max_new_tokens", "max_new_tokens must be zero or positive")

    admission: Admission = request.app.state.admission
    if not admission.enter():
        raise error(429, "queue_full", "long-form transcription queue is full", headers={"Retry-After": "5"})
    source: Path | None = None
    normalized: Path | None = None
    source_duration = 0.0
    try:
        suffix = Path(file.filename or "upload").suffix or ".bin"
        with tempfile.NamedTemporaryFile(prefix="moss-upload-", suffix=suffix, delete=False) as output:
            source = Path(output.name)
        save_upload(file.file, source, request.app.state.settings.max_upload_bytes)
        with tempfile.NamedTemporaryFile(prefix="moss-normalized-", suffix=".wav", delete=False) as output:
            normalized = Path(output.name)
        source_duration = request.app.state.normalizer.normalize(source, normalized)
        raw = request.app.state.engine.transcribe(normalized, max_new_tokens)
    except AudioError as exc:
        raise error(exc.status, exc.code, exc.message) from exc
    except RuntimeError as exc:
        raise error(500, "transcription_failed", str(exc)) from exc
    finally:
        file.file.close()
        if source is not None:
            source.unlink(missing_ok=True)
        if normalized is not None:
            normalized.unlink(missing_ok=True)
        admission.leave()

    segments = parse_transcript(raw)
    text = visible_text(segments, raw)
    if response_format == "text":
        return PlainTextResponse(text)
    if response_format == "json":
        return JSONResponse({"text": text})
    return JSONResponse({
        "task": "transcribe",
        "language": None,
        "duration": source_duration,
        "text": text,
        "model": model,
        "segments": [asdict(segment) for segment in segments],
    })
