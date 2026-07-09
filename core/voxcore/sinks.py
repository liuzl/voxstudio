"""Where streamed audio goes: a growing file, or a player, or both."""

import contextlib
import queue
import shutil
import subprocess
import threading
from pathlib import Path

import numpy as np
import soundfile as sf


class WavFileSink:
    """Append samples to a WAV as they arrive; the header is fixed up on close."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._file: sf.SoundFile | None = None

    def write(self, samples: np.ndarray, rate: int) -> None:
        if self._file is None:
            # PCM_16 to match write_wav's default: `vox say` must not emit a different
            # WAV subtype depending on whether it streamed.
            self._file = sf.SoundFile(self.path, "w", samplerate=rate, channels=1,
                                      format="WAV", subtype="PCM_16")
        self._file.write(samples)

    def close(self) -> None:
        if self._file is not None:
            self._file.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class PlayerSink:
    """Pipe raw float32 samples to ffplay, so sound starts on the first chunk.

    A background thread does the piping. ffplay drains its stdin at playback speed
    and the pipe buffer holds well under a second of 48kHz audio, so writing from
    the synthesis loop would block it until the listener caught up -- generation and
    playback would lock-step, and the whole point of streaming ahead is lost.
    """

    def __init__(self, player: str = "ffplay"):
        if not shutil.which(player):
            raise SystemExit(f"{player} not found on PATH; drop --play or install ffmpeg")
        self.player = player
        self._proc: subprocess.Popen | None = None
        self._queue: queue.Queue = queue.Queue()
        self._thread: threading.Thread | None = None

    def _pump(self) -> None:
        while (item := self._queue.get()) is not None:
            try:
                self._proc.stdin.write(item)
            except BrokenPipeError:  # listener closed the player
                break
        with contextlib.suppress(BrokenPipeError, OSError):
            self._proc.stdin.close()

    def write(self, samples: np.ndarray, rate: int) -> None:
        if self._proc is None:
            self._proc = subprocess.Popen(
                [self.player, "-f", "f32le", "-ar", str(rate), "-ch_layout", "mono",
                 "-nodisp", "-autoexit", "-loglevel", "error", "-"],
                stdin=subprocess.PIPE)
            self._thread = threading.Thread(target=self._pump, daemon=True)
            self._thread.start()
        self._queue.put(samples.astype("float32").tobytes())

    def close(self) -> None:
        if self._proc is None:
            return
        self._queue.put(None)
        self._thread.join()
        self._proc.wait()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class Tee:
    def __init__(self, *sinks):
        self.sinks = [s for s in sinks if s is not None]

    def write(self, samples: np.ndarray, rate: int) -> None:
        for sink in self.sinks:
            sink.write(samples, rate)

    def close(self) -> None:
        for sink in self.sinks:
            sink.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
