import numpy as np
import pytest

from voxcore import join_chunks, read_wav, trim_edge_silence, write_wav

SR = 8000


def tone(seconds: float, lead: float = 0.0, tail: float = 0.0) -> bytes:
    t = np.arange(int(SR * seconds)) / SR
    body = (0.5 * np.sin(2 * np.pi * 220 * t)).astype("float32")
    pad = lambda s: np.zeros(int(SR * s), dtype="float32")  # noqa: E731
    return write_wav(np.concatenate([pad(lead), body, pad(tail)]), SR)


def test_trim_removes_both_edges():
    samples, _ = read_wav(tone(0.5, lead=0.2, tail=0.3))
    trimmed = trim_edge_silence(samples, SR)
    assert len(samples) == pytest.approx(SR * 1.0, abs=SR * 0.02)
    assert len(trimmed) == pytest.approx(SR * 0.5, abs=SR * 0.02)


def test_join_inserts_exactly_one_pause_per_seam():
    chunks = [tone(0.4, lead=0.1, tail=0.3), tone(0.4, lead=0.3, tail=0.05), tone(0.4)]
    joined, rate = read_wav(join_chunks(chunks, pause_ms=290))

    assert rate == SR
    speech = 3 * 0.4 * SR
    pauses = 2 * 0.290 * SR
    assert len(joined) == pytest.approx(speech + pauses, abs=SR * 0.05)


def test_join_seam_is_silent_and_uniform():
    joined, rate = read_wav(join_chunks([tone(0.3, tail=0.3), tone(0.3, lead=0.25)], pause_ms=200))
    silent = np.flatnonzero(np.abs(joined) < 1e-6)
    # The only silence left is the pause we inserted -- both edges were trimmed away.
    assert len(silent) == pytest.approx(0.200 * rate, abs=rate * 0.03)


def test_single_chunk_is_untouched_by_the_caller():
    # synthesize_long short-circuits, but join of one chunk must still trim, not pad.
    joined, _ = read_wav(join_chunks([tone(0.3, lead=0.2, tail=0.2)]))
    assert len(joined) == pytest.approx(0.3 * SR, abs=SR * 0.02)


def test_mixed_sample_rates_are_rejected():
    other = write_wav(np.zeros(100, dtype="float32"), 16000)
    with pytest.raises(ValueError, match="sample rate"):
        join_chunks([tone(0.2), other])


def test_empty_input_is_rejected():
    with pytest.raises(ValueError):
        join_chunks([])
