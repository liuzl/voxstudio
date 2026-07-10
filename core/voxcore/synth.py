"""Long-text synthesis: chunk, synthesize serially, join."""

from collections.abc import Callable, Iterator

import numpy as np

from .audio import match_loudness, read_wav, speech_level_db, trim_edge_silence, write_wav
from .clients.tts import TTSClient
from .config import ChunkCfg
from .text import chunk_text

OnChunk = Callable[[int, int, str], None]


def stream_long(tts: TTSClient, text: str, voice: str | None = None, *,
                chunking: ChunkCfg | None = None,
                cfg_value: float | None = None, timesteps: int | None = None,
                input_prefix: str = "",
                on_chunk: OnChunk | None = None) -> Iterator[tuple[np.ndarray, int]]:
    """Yield `(samples, rate)` as each chunk finishes, ready to play or append.

    Chunks go out one at a time on purpose. The engine's peak VRAM grows with the length
    of a single generation and torch does not hand it back, so overlapping requests can
    push a shared GPU host into an out-of-memory 500 -- and so can one unchunked passage,
    which leaves the engine 500ing until it is restarted. Serial requests also mean a
    listener hears the first chunk while the rest are still being made.

    What comes out is already joined: each chunk is trimmed against its speech level,
    levelled to the first chunk, and preceded by one pause. See `audio.join_chunks`
    for why the edges cannot simply be concatenated.
    """
    chunking = chunking or ChunkCfg()
    chunks = chunk_text(text, chunking.max_seconds, chunking.sentence_enders,
                        chunking.first_max_seconds, chunking.growth)
    if not chunks:
        raise ValueError("nothing to synthesize")

    gap_ms = max(0, chunking.join_pause_ms - 2 * chunking.edge_pad_ms)
    pause: np.ndarray | None = None
    target_db: float | None = None
    sample_rate: int | None = None

    for i, chunk in enumerate(chunks):
        if on_chunk:
            on_chunk(i, len(chunks), chunk)
        samples, rate = read_wav(tts.speech(input_prefix + chunk, voice, cfg_value=cfg_value,
                                            timesteps=timesteps))
        if sample_rate is not None and rate != sample_rate:
            raise ValueError(f"chunks disagree on sample rate: {sample_rate}, {rate}")
        sample_rate = sample_rate or rate
        samples = trim_edge_silence(samples, rate, chunking.trim_floor_db,
                                    chunking.edge_pad_ms)
        if not samples.size:
            continue
        if target_db is None:
            target_db = speech_level_db(samples, rate)
            pause = np.zeros(int(rate * gap_ms / 1000), dtype="float32")
        else:
            samples = match_loudness(samples, rate, target_db)
            yield pause, rate
        yield samples, rate


def synthesize_long(tts: TTSClient, text: str, voice: str | None = None, *,
                    chunking: ChunkCfg | None = None,
                    cfg_value: float | None = None, timesteps: int | None = None,
                    input_prefix: str = "",
                    on_chunk: OnChunk | None = None) -> bytes:
    """Collect `stream_long` into one WAV."""
    pieces = list(stream_long(tts, text, voice, chunking=chunking, cfg_value=cfg_value,
                              timesteps=timesteps, input_prefix=input_prefix, on_chunk=on_chunk))
    if not pieces:
        raise ValueError("engine returned no audio")
    rate = pieces[0][1]
    return write_wav(np.concatenate([samples for samples, _ in pieces]), rate)
