"""Ogg/Opus wrapper for streamed synthesis: raw f32 PCM at 48kHz needs 187.5KB/s on the
wire, which a slow WAN link cannot carry; 96kbps Opus needs ~12KB/s and is close to
transparent for mono speech (48kbps measured ~25dB windowed SNR against the raw PCM)."""
import subprocess
import threading


def opus_encode(first_chunk, pcm_iter, sample_rate, bitrate="96k"):
    """Encode a primed PCM generator into an Ogg/Opus byte stream.

    A feeder thread drives the (lock-holding) synthesis generator into ffmpeg while the
    caller reads encoded pages. Closing this generator kills ffmpeg, which breaks the
    feeder's pipe, which closes the synthesis generator — releasing the pipeline lock
    (the 2026-07-15 wedge rule: every path out must close the inner generator).
    """
    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
         "-c:a", "libopus", "-b:a", bitrate, "-frame_duration", "20",
         "-page_duration", "100000",
         "-f", "ogg", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    failure = []

    def feed():
        try:
            proc.stdin.write(first_chunk)
            for chunk in pcm_iter:
                proc.stdin.write(chunk)
        except (BrokenPipeError, ValueError):
            pass  # the reader is gone (client disconnect); closing below frees the lock
        except BaseException as error:  # noqa: BLE001 — surfaced to the reader
            failure.append(error)
        finally:
            pcm_iter.close()
            try:
                proc.stdin.close()
            except Exception:
                pass

    thread = threading.Thread(target=feed, daemon=True)
    thread.start()
    try:
        while True:
            data = proc.stdout.read(4096)
            if not data:
                break
            yield data
        if failure:
            raise failure[0]
    finally:
        proc.kill()
        thread.join(timeout=10)
