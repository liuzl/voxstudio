"""OpenAI-compatible HTTP adapter for FunASR utterance transcription.

Serves ``/v1/audio/transcriptions`` over a FunASR ``AutoModel``. The default model is
SenseVoice-Small: strong Mandarin, built for code-switched zh/en speech, and fast enough on
CPU for realtime utterances. ``FUNASR_MODEL`` selects another FunASR model id (for example
``paraformer-zh``) without code changes.
"""

from __future__ import annotations

import asyncio
import os
import re
import tempfile
import threading
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Protocol

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

SUPPORTED_FORMATS = {"json", "text"}
# SenseVoice decorates raw output with token tags: <|zh|><|NEUTRAL|><|Speech|>...
TAG = re.compile(r"<\|[^|]*\|>")


@dataclass(frozen=True)
class Settings:
    model: str
    device: str
    hub: str
    max_upload_bytes: int
    queue_limit: int

    @classmethod
    def from_env(cls) -> "Settings":
        queue_limit = int(os.getenv("FUNASR_QUEUE_LIMIT", "8"))
        max_upload = int(os.getenv("FUNASR_MAX_UPLOAD_BYTES", str(64 * 1024 * 1024)))
        if queue_limit <= 0 or max_upload <= 0:
            raise RuntimeError("FUNASR_QUEUE_LIMIT and FUNASR_MAX_UPLOAD_BYTES must be positive")
        return cls(
            model=os.getenv("FUNASR_MODEL", "iic/SenseVoiceSmall"),
            device=os.getenv("FUNASR_DEVICE", "cpu"),
            # "ms" = ModelScope, "hf" = HuggingFace — the same models live on both hubs,
            # and which one is reachable at speed depends on where the host sits.
            hub=os.getenv("FUNASR_HUB", "ms"),
            max_upload_bytes=max_upload,
            queue_limit=queue_limit,
        )


class Recognizer(Protocol):
    def transcribe(self, path: str, language: str) -> str: ...


class FunAsrRecognizer:
    """One AutoModel instance behind a lock: FunASR contexts are not thread-safe."""

    def __init__(self, settings: Settings):
        from funasr import AutoModel

        self._lock = threading.Lock()
        self._model = AutoModel(
            model=settings.model,
            device=settings.device,
            hub=settings.hub,
            disable_update=True,
        )

    def transcribe(self, path: str, language: str) -> str:
        with self._lock:
            results = self._model.generate(
                input=path,
                language=language or "auto",
                use_itn=True,
            )
        if not results:
            return ""
        return str(results[0].get("text", ""))


def clean_language(value: str | None) -> str:
    # OpenAI's field is a free-form hint; FunASR wants one of its own labels.
    known = {"zh", "en", "yue", "ja", "ko", "auto"}
    lowered = (value or "auto").strip().lower()
    return lowered if lowered in known else "auto"


def create_app(recognizer: Recognizer | None = None, settings: Settings | None = None) -> FastAPI:
    resolved = settings or Settings.from_env()
    semaphore = asyncio.Semaphore(resolved.queue_limit)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.recognizer = recognizer or FunAsrRecognizer(resolved)
        yield

    app = FastAPI(lifespan=lifespan)

    @app.get("/healthz")
    async def health() -> JSONResponse:
        return JSONResponse({"status": "ok", "model": resolved.model})

    @app.get("/health")
    async def health_compat() -> JSONResponse:
        # The product health probe expects this path.
        return JSONResponse({"status": "ok", "model": resolved.model})

    @app.post("/v1/audio/transcriptions")
    async def transcribe(
        file: Annotated[UploadFile, File()],
        language: Annotated[str | None, Form()] = None,
        response_format: Annotated[str, Form()] = "json",
    ):
        if response_format not in SUPPORTED_FORMATS:
            raise HTTPException(status_code=400, detail=f"unsupported response_format {response_format}")
        payload = await file.read()
        if len(payload) > resolved.max_upload_bytes:
            raise HTTPException(status_code=413, detail="audio upload too large")
        if not payload:
            raise HTTPException(status_code=400, detail="empty audio upload")
        async with semaphore:
            with tempfile.NamedTemporaryFile(suffix=".wav") as handle:
                handle.write(payload)
                handle.flush()
                raw = await asyncio.to_thread(
                    app.state.recognizer.transcribe, handle.name, clean_language(language),
                )
        # Tag stripping lives here, not in the recognizer, so every model's decorations are
        # cleaned the same way.
        text = TAG.sub("", raw).strip()
        if response_format == "text":
            return PlainTextResponse(text)
        return JSONResponse({"text": text})

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        create_app(),
        host=os.getenv("FUNASR_HOST", "127.0.0.1"),
        port=int(os.getenv("FUNASR_PORT", "18088")),
    )
