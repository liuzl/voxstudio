"""Long-text synthesis: chunk, synthesize serially, join."""

from collections.abc import Callable

from .audio import join_chunks
from .clients.tts import TTSClient
from .config import ChunkCfg
from .text import chunk_text


def synthesize_long(tts: TTSClient, text: str, voice: str | None = None, *,
                    chunking: ChunkCfg | None = None,
                    cfg_value: float | None = None, timesteps: int | None = None,
                    on_chunk: Callable[[int, int, str], None] | None = None) -> bytes:
    """Synthesize arbitrarily long text at a stable timbre.

    Chunks are sent one at a time on purpose. The engine's peak VRAM grows with the
    length of a single generation and torch does not hand it back, so overlapping
    requests can push the GPU host into an out-of-memory 500.
    """
    chunking = chunking or ChunkCfg()
    chunks = chunk_text(text, chunking.max_chars, chunking.sentence_enders)
    if not chunks:
        raise ValueError("nothing to synthesize")

    wavs = []
    for i, chunk in enumerate(chunks):
        if on_chunk:
            on_chunk(i, len(chunks), chunk)
        wavs.append(tts.speech(chunk, voice, cfg_value=cfg_value, timesteps=timesteps))

    if len(wavs) == 1:
        return wavs[0]
    return join_chunks(wavs, chunking.join_pause_ms, chunking.trim_silence_db)
