import numpy as np
import pytest

from voxcore import join_chunks, read_wav, trim_edge_silence, write_wav

SR = 8000


def tone(seconds: float, lead: float = 0.0, tail: float = 0.0) -> bytes:
    t = np.arange(int(SR * seconds)) / SR
    body = (0.5 * np.sin(2 * np.pi * 220 * t)).astype("float32")
    pad = lambda s: np.zeros(int(SR * s), dtype="float32")  # noqa: E731
    return write_wav(np.concatenate([pad(lead), body, pad(tail)]), SR)


def test_trim_removes_both_edges_but_keeps_a_pad():
    samples, _ = read_wav(tone(0.5, lead=0.2, tail=0.3))
    trimmed = trim_edge_silence(samples, SR, pad_ms=40)
    assert len(samples) == pytest.approx(SR * 1.0, abs=SR * 0.02)
    # 0.5s of tone plus 40ms of protected pad on each side.
    assert len(trimmed) == pytest.approx(SR * 0.58, abs=SR * 0.02)


def test_trim_pad_never_runs_off_the_ends():
    samples, _ = read_wav(tone(0.3))          # no lead-in or tail-out to pad into
    assert len(trim_edge_silence(samples, SR, pad_ms=100)) <= len(samples)


def test_a_seam_gap_is_the_pause_the_listener_should_perceive():
    # The inserted silence is shorter than pause_ms: each chunk keeps pad_ms of its
    # own quiet edge, and that padding is part of what the listener hears as the gap.
    # Every chunk needs silence to pad back into, or the pad is clipped by the edge.
    chunks = [tone(0.4, lead=0.1, tail=0.3), tone(0.4, lead=0.3, tail=0.1),
              tone(0.4, lead=0.1, tail=0.1)]
    joined, rate = read_wav(join_chunks(chunks, pause_ms=210, pad_ms=40))

    assert rate == SR
    speech_with_pads = 3 * (0.4 + 2 * 0.040) * SR
    inserted = 2 * (0.210 - 2 * 0.040) * SR
    assert len(joined) == pytest.approx(speech_with_pads + inserted, abs=SR * 0.05)


def test_join_levels_the_chunks_to_the_first():
    quiet = read_wav(tone(0.4))[0] * 0.1
    joined, rate = read_wav(join_chunks([tone(0.4), write_wav(quiet, SR)], pause_ms=210))
    half = len(joined) // 2
    loud_rms = np.sqrt((joined[:half] ** 2).mean())
    quiet_rms = np.sqrt((joined[half:] ** 2).mean())
    assert quiet_rms == pytest.approx(loud_rms, rel=0.2)


def test_join_seam_silence_is_uniform():
    joined, rate = read_wav(join_chunks([tone(0.3, tail=0.3), tone(0.3, lead=0.25)],
                                        pause_ms=200, pad_ms=0))
    silent = np.flatnonzero(np.abs(joined) < 1e-6)
    # With no pad, the only silence left is the pause -- both edges were trimmed away.
    assert len(silent) == pytest.approx(0.200 * rate, abs=rate * 0.03)


def test_single_chunk_is_trimmed_not_padded_with_a_pause():
    joined, _ = read_wav(join_chunks([tone(0.3, lead=0.2, tail=0.2)], pad_ms=0))
    assert len(joined) == pytest.approx(0.3 * SR, abs=SR * 0.02)


def test_mixed_sample_rates_are_rejected():
    other = write_wav(np.zeros(100, dtype="float32"), 16000)
    with pytest.raises(ValueError, match="sample rate"):
        join_chunks([tone(0.2), other])


def test_empty_input_is_rejected():
    with pytest.raises(ValueError):
        join_chunks([])
