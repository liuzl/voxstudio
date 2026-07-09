import numpy as np
import pytest

from voxcore import ChunkCfg, read_wav, stream_long, synthesize_long, write_wav

SR = 8000


class FakeTTS:
    """Returns a fixed tone per chunk, wrapped in the edge silence a real engine adds."""

    def __init__(self):
        self.calls: list[str] = []

    def speech(self, text, voice=None, **_):
        self.calls.append(text)
        t = np.arange(int(SR * 0.4)) / SR
        body = (0.5 * np.sin(2 * np.pi * 220 * t)).astype("float32")
        pad = np.zeros(int(SR * 0.2), dtype="float32")
        return write_wav(np.concatenate([pad, body, pad]), SR)


# 0.4s holds one `甲。` (two Han characters, ~0.37s) but never two.
CFG = ChunkCfg(max_seconds=0.4, join_pause_ms=250, edge_pad_ms=0)


def test_chunks_are_requested_serially_in_order():
    tts = FakeTTS()
    list(stream_long(tts, "甲。乙。丙。", chunking=CFG))
    assert tts.calls == ["甲。", "乙。", "丙。"]


def test_stream_yields_a_pause_between_chunks_but_not_around_them():
    tts = FakeTTS()
    pieces = [samples for samples, _ in stream_long(tts, "甲。乙。丙。", chunking=CFG)]
    # speech, pause, speech, pause, speech
    assert len(pieces) == 5
    silent = [i for i, p in enumerate(pieces) if np.abs(p).max() < 1e-6]
    assert silent == [1, 3]
    assert all(len(pieces[i]) == int(SR * 0.250) for i in silent)


def test_first_chunk_is_yielded_before_the_rest_are_synthesized():
    tts = FakeTTS()
    stream = stream_long(tts, "甲。乙。丙。", chunking=CFG)
    next(stream)
    # The whole point of streaming: one request has happened, not three.
    assert tts.calls == ["甲。"]


def test_synthesize_long_equals_the_concatenated_stream():
    wav = synthesize_long(FakeTTS(), "甲。乙。丙。", chunking=CFG)
    samples, rate = read_wav(wav)
    assert rate == SR
    speech, pauses = 3 * 0.4 * SR, 2 * 0.250 * SR
    assert len(samples) == pytest.approx(speech + pauses, abs=SR * 0.05)


def test_single_chunk_still_gets_its_edges_trimmed():
    samples, _ = read_wav(synthesize_long(FakeTTS(), "甲。", chunking=CFG))
    assert len(samples) == pytest.approx(0.4 * SR, abs=SR * 0.02)


def test_empty_text_is_rejected():
    with pytest.raises(ValueError):
        list(stream_long(FakeTTS(), "   ", chunking=CFG))
