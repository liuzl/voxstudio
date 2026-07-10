"""`vox say` -- long-text speech synthesis, streamed chunk by chunk."""

import sys
import time

from voxcore import TTSClient, est_seconds, sanitize_for_tts, stream_long, write_wav
from voxcore.sinks import PlayerSink, Tee, WavFileSink

from .._io import read_text_arg


def add_parser(sub):
    p = sub.add_parser("say", help="synthesize speech from text")
    p.add_argument("text", nargs="?", help="text to speak; '-' or omitted reads stdin")
    p.add_argument("-f", "--file", help="read text from a file")
    p.add_argument("-o", "--output", help="output wav path ('-' for stdout)")
    p.add_argument("--play", action="store_true", help="play as it is generated (needs ffplay)")
    p.add_argument("--voice", help="clone | design | <registered voice id>")
    p.add_argument("--design", metavar="DESC",
                   help="English voice description; implies --voice design")
    p.add_argument("--cfg", type=float, dest="cfg_value")
    p.add_argument("--timesteps", type=int)
    p.add_argument("-q", "--quiet", action="store_true", help="no per-chunk progress")
    return p


def run(args, cfg) -> int:
    if not args.output and not args.play:
        args.output = "-"

    text = read_text_arg(args.text, args.file)
    if not text.strip():
        raise SystemExit("no text to speak")

    text, dropped = sanitize_for_tts(text)
    if dropped and not args.quiet:
        print(f"dropped {len(dropped)} unspeakable character(s): "
              f"{''.join(sorted(set(dropped)))}", file=sys.stderr)

    voice = args.voice
    input_prefix = ""
    if args.design:
        # Every independently generated chunk needs the voice description.
        input_prefix = f"({args.design})"
        voice = "design"

    def progress(i, total, chunk):
        print(f"  [{i + 1}/{total}] {len(chunk)} chars, ~{est_seconds(chunk):.1f}s",
              file=sys.stderr)

    # stdout can't take an incremental WAV -- the header carries lengths we only know
    # at the end, and a pipe isn't seekable. Buffer that one case; stream the rest.
    to_stdout = args.output == "-"
    started = time.monotonic()
    first_audio = None

    with TTSClient(cfg.engine("tts"), cfg.tts_defaults) as tts:
        pieces = stream_long(tts, text, voice, chunking=cfg.chunking,
                             cfg_value=args.cfg_value, timesteps=args.timesteps,
                             input_prefix=input_prefix,
                             on_chunk=None if args.quiet else progress)
        sink = Tee(
            PlayerSink() if args.play else None,
            WavFileSink(args.output) if args.output and not to_stdout else None,
        )
        buffered, rate = [], None
        with sink:
            for samples, rate in pieces:
                if first_audio is None:
                    first_audio = time.monotonic() - started
                sink.write(samples, rate)
                if to_stdout:
                    buffered.append(samples)

    if to_stdout:
        import numpy as np
        sys.stdout.buffer.write(write_wav(np.concatenate(buffered), rate))
    elif not args.quiet and args.output:
        print(f"wrote {args.output}", file=sys.stderr)

    if not args.quiet and first_audio is not None:
        print(f"first audio after {first_audio:.1f}s, done in "
              f"{time.monotonic() - started:.1f}s", file=sys.stderr)
    return 0
