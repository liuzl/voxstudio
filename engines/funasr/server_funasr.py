"""OpenAI-compatible HTTP adapter for FunASR utterance transcription.

Serves ``/v1/audio/transcriptions`` over a FunASR ``AutoModel``. The default model is
SenseVoice-Small: strong Mandarin, built for code-switched zh/en speech, and fast enough on
CPU for realtime utterances. ``FUNASR_MODEL`` selects another FunASR model id (for example
``paraformer-zh``) without code changes.

When ``FUNASR_REVISE_URL`` is set (an OpenAI-compatible transcription endpoint backed by a
stronger, slower model — e.g. Qwen3-ASR via audiocpp_server), requests carrying
``revise=true`` are forwarded there first and fall back to the local model on any error.
SenseVoice stays the low-latency draft path; revision is the accuracy tier for final text.
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
    revise_url: str = ""
    revise_model: str = "qwen3-asr"
    revise_timeout: float = 10.0

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
            revise_url=os.getenv("FUNASR_REVISE_URL", ""),
            revise_model=os.getenv("FUNASR_REVISE_MODEL", "qwen3-asr"),
            revise_timeout=float(os.getenv("FUNASR_REVISE_TIMEOUT", "10")),
        )


def revise_transcribe(settings: Settings, payload: bytes, filename: str) -> str:
    """Forward audio to the revision endpoint; raises on any failure."""
    import json
    import urllib.request
    import uuid

    boundary = uuid.uuid4().hex
    # Quotes would close the filename attribute; CR/LF would let a crafted
    # filename inject extra multipart headers. Both become underscores.
    safe_name = re.sub(r'[\r\n"]', "_", filename or "audio.wav")
    body = b"".join(
        [
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{settings.revise_model}\r\n".encode(),
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe_name}\"\r\n"
            "Content-Type: application/octet-stream\r\n\r\n".encode(),
            payload,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
    )
    request = urllib.request.Request(
        settings.revise_url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=settings.revise_timeout) as response:
        parsed = json.loads(response.read())
    text = str(parsed.get("text", "")).strip()
    if not text:
        raise RuntimeError("revision endpoint returned empty text")
    return text


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
        revise: Annotated[str | None, Form()] = None,
    ):
        if response_format not in SUPPORTED_FORMATS:
            raise HTTPException(status_code=400, detail=f"unsupported response_format {response_format}")
        payload = await file.read()
        if len(payload) > resolved.max_upload_bytes:
            raise HTTPException(status_code=413, detail="audio upload too large")
        if not payload:
            raise HTTPException(status_code=400, detail="empty audio upload")

        want_revise = (revise or "").strip().lower() in {"1", "true", "yes"}
        # One semaphore bounds both tiers: revision forwarding holds an upload
        # body and an executor thread for up to revise_timeout, so letting it
        # bypass queue_limit would turn a request burst into unbounded memory
        # and a thundering herd on the revision endpoint.
        async with semaphore:
            if want_revise and resolved.revise_url:
                try:
                    text = await asyncio.to_thread(
                        revise_transcribe, resolved, payload, file.filename or "audio.wav",
                    )
                    if response_format == "text":
                        return PlainTextResponse(text)
                    return JSONResponse({"text": text, "engine": "revise"})
                except Exception:
                    # The draft model is the availability floor: any revision failure
                    # (endpoint down, timeout, bad response) falls through silently.
                    pass

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
        return JSONResponse({"text": text, "engine": resolved.model} if want_revise else {"text": text})

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        create_app(),
        host=os.getenv("FUNASR_HOST", "127.0.0.1"),
        port=int(os.getenv("FUNASR_PORT", "18088")),
    )
