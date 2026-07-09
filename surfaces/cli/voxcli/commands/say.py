"""`vox say` -- long-text speech synthesis."""

import sys

from voxcore import TTSClient, sanitize_for_tts, synthesize_long

from .._io import read_text_arg, write_audio


def add_parser(sub):
    p = sub.add_parser("say", help="synthesize speech from text")
    p.add_argument("text", nargs="?", help="text to speak; '-' or omitted reads stdin")
    p.add_argument("-f", "--file", help="read text from a file")
    p.add_argument("-o", "--output", default="-", help="output wav path ('-' for stdout)")
    p.add_argument("--voice", help="clone | design | <registered voice id>")
    p.add_argument("--design", metavar="DESC",
                   help="English voice description; implies --voice design")
    p.add_argument("--cfg", type=float, dest="cfg_value")
    p.add_argument("--timesteps", type=int)
    p.add_argument("-q", "--quiet", action="store_true", help="no per-chunk progress")
    return p


def run(args, cfg) -> int:
    text = read_text_arg(args.text, args.file)
    if not text.strip():
        raise SystemExit("no text to speak")

    text, dropped = sanitize_for_tts(text)
    if dropped and not args.quiet:
        print(f"dropped {len(dropped)} out-of-script glyph(s): {''.join(sorted(set(dropped)))}",
              file=sys.stderr)

    voice = args.voice
    if args.design:
        # The engine reads the parenthesised description off the front of the input.
        text = f"({args.design}){text}"
        voice = "design"

    def progress(i, total, chunk):
        print(f"  [{i + 1}/{total}] {len(chunk)} chars", file=sys.stderr)

    with TTSClient(cfg.engine("tts"), cfg.tts_defaults) as tts:
        wav = synthesize_long(tts, text, voice, chunking=cfg.chunking,
                              cfg_value=args.cfg_value, timesteps=args.timesteps,
                              on_chunk=None if args.quiet else progress)
    write_audio(wav, args.output)
    return 0
