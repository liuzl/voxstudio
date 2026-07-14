"""OpenAI-compatible HTTP adapter for Kokoro TTS — the local conversation fast lane.

Kokoro-82M-v1.1-zh synthesizes Mandarin from a fixed bank of voices at CPU speed: first
audio in tens of milliseconds, no GPU, no network. It complements — not replaces — the
VoxCPM2 engine: no voice cloning, 24 kHz native, less expressive. Point the `tts` engine
slot at this server when reply latency matters more than a cloned identity.

The contract mirrors the VoxCPM2 server where it can: `/v1/audio/speech` with optional
`stream: true` returning chunked f32le PCM (`X-Sample-Rate` header), `/v1/voices`, and
`/healthz`. Continuation fields are accepted and ignored — Kokoro has no session state.
Output is resampled to 48 kHz by default so the macOS speaker-duplex helper can consume
it unchanged; set KOKORO_OUTPUT_RATE=24000 for the native rate.
"""

from __future__ import annotations

import io
import os
import threading
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Iterator, Protocol

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

NATIVE_RATE = 24_000


@dataclass(frozen=True)
class Settings:
    repo: str
    default_voice: str
    output_rate: int
    device: str

    @classmethod
    def from_env(cls) -> "Settings":
        output_rate = int(os.getenv("KOKORO_OUTPUT_RATE", "48000"))
        if output_rate <= 0:
            raise RuntimeError("KOKORO_OUTPUT_RATE must be positive")
        return cls(
            repo=os.getenv("KOKORO_REPO", "hexgrad/Kokoro-82M-v1.1-zh"),
            default_voice=os.getenv("KOKORO_DEFAULT_VOICE", "zf_001"),
            output_rate=output_rate,
            device=os.getenv("KOKORO_DEVICE", "cpu"),
        )


class Synthesizer(Protocol):
    def voices(self) -> list[str]: ...
    def synthesize(self, text: str, voice: str, speed: float) -> Iterator["object"]: ...


class KokoroSynthesizer:
    """One pipeline behind a lock; Kokoro segments text and yields audio per segment."""

    def __init__(self, settings: Settings):
        from huggingface_hub import list_repo_files
        from kokoro import KModel, KPipeline

        self._lock = threading.Lock()
        model = KModel(repo_id=settings.repo).to(settings.device).eval()
        # zh voices use the Chinese G2P pipeline; the model itself is language-agnostic.
        self._pipeline = KPipeline(lang_code="z", repo_id=settings.repo, model=model)
        self._voices = sorted(
            name.removeprefix("voices/").removesuffix(".pt")
            for name in list_repo_files(settings.repo)
            if name.startswith("voices/") and name.endswith(".pt")
        )

    def voices(self) -> list[str]:
        return self._voices

    def synthesize(self, text: str, voice: str, speed: float):
        with self._lock:
            for result in self._pipeline(text, voice=voice, speed=speed):
                audio = result.audio
                if audio is None:
                    continue
                yield audio.detach().cpu()


class SpeechRequest(BaseModel):
    input: str
    voice: str = ""
    model: str | None = None
    response_format: str = "wav"
    speed: float = 1.0
    stream: bool = False
    # Accepted for contract compatibility with the VoxCPM2 engine; Kokoro is stateless.
    cfg_value: float | None = None
    timesteps: int | None = None
    seed: int | None = None
    prosody_prompt: bool | None = None
    continuation_id: str | None = None
    continuation_end: bool | None = None


def create_app(synthesizer: Synthesizer | None = None, settings: Settings | None = None) -> FastAPI:
    resolved = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.synthesizer = synthesizer or KokoroSynthesizer(resolved)
        yield

    app = FastAPI(lifespan=lifespan)

    def resample(samples):
        import torch
        import torchaudio.functional as functional

        if resolved.output_rate == NATIVE_RATE:
            return samples
        tensor = samples if samples.dim() > 1 else samples.unsqueeze(0)
        return functional.resample(tensor.to(torch.float32), NATIVE_RATE, resolved.output_rate).squeeze(0)

    def pieces(request: SpeechRequest):
        voice = request.voice or resolved.default_voice
        known = app.state.synthesizer.voices()
        if known and voice not in known:
            raise HTTPException(400, {"error": {"code": "voice_not_found",
                "message": f"unknown voice {voice}; see /v1/voices",
                "type": "invalid_request_error"}})
        if not request.input.strip():
            raise HTTPException(400, {"error": {"code": "invalid_request",
                "message": "input must not be empty", "type": "invalid_request_error"}})
        for audio in app.state.synthesizer.synthesize(request.input, voice, request.speed):
            yield resample(audio)

    @app.get("/healthz")
    async def health() -> JSONResponse:
        return JSONResponse({
            "status": "ok",
            "model": resolved.repo,
            "sample_rate": resolved.output_rate,
            "voices": len(app.state.synthesizer.voices()),
        })

    @app.get("/health")
    async def health_compat() -> JSONResponse:
        # The product health probe expects the VoxCPM2 identity shape.
        return JSONResponse({
            "status": "ok",
            "model": f"kokoro@{resolved.repo}",
            "model_manifest_sha256": None,
            "sample_rate": resolved.output_rate,
        })

    @app.get("/v1/voices")
    async def voices() -> JSONResponse:
        return JSONResponse({"voices": [{"id": name} for name in app.state.synthesizer.voices()]})

    @app.post("/v1/audio/speech")
    async def speech(request: SpeechRequest):
        if request.stream:
            def pcm():
                for piece in pieces(request):
                    yield piece.numpy().astype("<f4").tobytes()
            return StreamingResponse(pcm(), media_type="audio/pcm",
                                     headers={"X-Sample-Rate": str(resolved.output_rate),
                                              "X-Sample-Format": "f32le"})
        import numpy
        import soundfile

        collected = [piece.numpy() for piece in pieces(request)]
        if not collected:
            raise HTTPException(500, {"error": {"code": "no_audio",
                "message": "synthesis produced no audio", "type": "server_error"}})
        buffer = io.BytesIO()
        soundfile.write(buffer, numpy.concatenate(collected), resolved.output_rate, format="WAV")
        return Response(buffer.getvalue(), media_type="audio/wav")

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        create_app(),
        host=os.getenv("KOKORO_HOST", "127.0.0.1"),
        port=int(os.getenv("KOKORO_PORT", "18089")),
    )
