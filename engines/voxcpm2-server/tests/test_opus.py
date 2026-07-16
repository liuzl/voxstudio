"""The Opus wire wrapper: encodes a primed PCM generator, and every exit path closes
the inner generator (the pipeline-lock rule from the 2026-07-15 wedge)."""
import math
import shutil
import struct
import subprocess

import pytest

from opus_stream import opus_encode

ffmpeg = shutil.which("ffmpeg")


def sine_pcm(seconds: float, rate: int = 48_000) -> bytes:
    count = int(seconds * rate)
    return b"".join(
        struct.pack("<f", 0.4 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(count)
    )


class TrackedIter:
    """A closable PCM iterator that records whether close() reached it."""

    def __init__(self, chunks):
        self.closed = False
        self._iter = iter(chunks)

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._iter)

    def close(self):
        self.closed = True


@pytest.mark.skipif(ffmpeg is None, reason="ffmpeg not installed")
def test_encodes_ogg_much_smaller_and_decodable():
    pcm = sine_pcm(1.0)
    first, rest = pcm[:4096], pcm[4096:]
    inner = TrackedIter([rest])
    ogg = b"".join(opus_encode(first, inner, 48_000))
    assert ogg[:4] == b"OggS"
    assert len(ogg) < len(pcm) / 10  # the point: an order of magnitude smaller
    assert inner.closed  # normal completion still closes the synthesis generator

    decoded = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-f", "f32le", "-ar", "48000", "-ac", "1", "pipe:1"],
        input=ogg, stdout=subprocess.PIPE, check=True).stdout
    # Opus codec delay pads the edges; duration within 100ms of the input.
    assert abs(len(decoded) - len(pcm)) < 4 * 4_800


@pytest.mark.skipif(ffmpeg is None, reason="ffmpeg not installed")
def test_closing_the_encoder_closes_the_synthesis_generator():
    # An endless inner iterator: only close() can end it.
    class Endless(TrackedIter):
        def __next__(self):
            if self.closed:
                raise StopIteration
            return sine_pcm(0.1)

    inner = Endless([])
    encoded = opus_encode(sine_pcm(0.1), inner, 48_000)
    assert next(encoded)  # stream is live
    encoded.close()  # the client disconnected
    assert inner.closed
