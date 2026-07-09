"""WAV helpers, loudness matching, and the chunk joiner."""

import io

import numpy as np
import soundfile as sf

FRAME_MS = 10


def read_wav(data: bytes) -> tuple[np.ndarray, int]:
    samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return samples, rate


def write_wav(samples: np.ndarray, rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, rate, format="WAV")
    return buf.getvalue()


def _frame_db(samples: np.ndarray, rate: int) -> np.ndarray:
    frame = max(1, int(rate * FRAME_MS / 1000))
    n = len(samples) // frame
    if n == 0:
        return np.empty(0)
    frames = samples[: n * frame].reshape(n, frame)
    return 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-12)


def speech_level_db(samples: np.ndarray, rate: int) -> float:
    """A robust level for the speech itself, ignoring pauses.

    Anchoring on the peak instead would follow whichever single syllable happened to
    be loudest, which varies chunk to chunk.
    """
    db = _frame_db(samples, rate)
    if not db.size:
        return -120.0
    voiced = db[db > db.max() - 40]
    return float(np.percentile(voiced, 60)) if voiced.size else -120.0


def trim_edge_silence(samples: np.ndarray, rate: int, floor_below_speech_db: float = 25.0,
                      pad_ms: int = 40) -> np.ndarray:
    """Trim leading and trailing audio quieter than `floor_below_speech_db` under speech.

    The gate is relative to the speech level, not the peak. A chunk often trails off
    into a long, quiet decay that is still well above a peak-relative gate; leaving it
    in means the audible gap at a seam is far longer than the pause we inserted.

    `pad_ms` of audio is kept outside the gate on each side, and it is not optional.
    Unvoiced consonants -- the aspiration in `ch`, `sh`, `t`, `k` -- carry almost no
    energy but decide which syllable a listener hears. Cutting to the first frame that
    clears an energy gate shaves them off, and the chunk opens on a bare vowel.
    """
    db = _frame_db(samples, rate)
    if not db.size:
        return samples[:0]
    voiced = np.flatnonzero(db > speech_level_db(samples, rate) - floor_below_speech_db)
    if voiced.size == 0:
        return samples[:0]
    frame = max(1, int(rate * FRAME_MS / 1000))
    pad = int(rate * pad_ms / 1000)
    start = max(0, voiced[0] * frame - pad)
    end = min(len(samples), (voiced[-1] + 1) * frame + pad)
    return samples[start:end]


def match_loudness(samples: np.ndarray, rate: int, target_db: float) -> np.ndarray:
    """Scale a chunk so its speech sits at `target_db`.

    Chunks are generated independently and land up to several dB apart. Across a
    silent seam that step is audible as the narrator leaning toward the microphone.
    """
    level = speech_level_db(samples, rate)
    if level <= -119:
        return samples
    return samples * (10 ** ((target_db - level) / 20))


def join_chunks(wavs: list[bytes], pause_ms: int = 210, floor_below_speech_db: float = 25.0,
                pad_ms: int = 40) -> bytes:
    """Concatenate chunk audio with one fixed pause between chunks.

    Each chunk arrives with its own edge silence and its own loudness. Concatenating
    them raw sums two edges into every seam -- anywhere from 170ms to 640ms, wildly
    uneven -- and the narration's rhythm audibly twitches. Crossfading instead
    collapses the seam to ~40ms and the sentences run together. So: trim both edges
    against the speech level, match loudness, and insert one pause we control.

    `pause_ms` is the gap a listener should perceive, matching the model's own median
    pause between sentences under this same gate. The silence actually inserted is
    shorter, because each chunk keeps `pad_ms` of sub-gate audio on both edges to
    protect its consonants -- that padding is part of the gap the listener hears.

    Seams need no fade. Chunks begin and end in silence, so the waveform is already
    continuous across the join.
    """
    if not wavs:
        raise ValueError("nothing to join")

    decoded = [read_wav(w) for w in wavs]
    rates = {rate for _, rate in decoded}
    if len(rates) != 1:
        raise ValueError(f"chunks disagree on sample rate: {sorted(rates)}")
    rate = rates.pop()

    trimmed = [trim_edge_silence(s, rate, floor_below_speech_db, pad_ms) for s, _ in decoded]
    trimmed = [t for t in trimmed if t.size]
    if not trimmed:
        return write_wav(np.zeros(0, dtype="float32"), rate)

    target = speech_level_db(trimmed[0], rate)
    leveled = [trimmed[0]] + [match_loudness(t, rate, target) for t in trimmed[1:]]

    gap_ms = max(0, pause_ms - 2 * pad_ms)
    pause = np.zeros(int(rate * gap_ms / 1000), dtype="float32")
    pieces = [leveled[0]]
    for chunk in leveled[1:]:
        pieces += [pause, chunk]
    return write_wav(np.concatenate(pieces), rate)
