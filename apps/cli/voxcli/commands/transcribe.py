"""`vox transcribe` -- speech to text."""

import json

from voxcore import ASRClient


def add_parser(sub):
    p = sub.add_parser("transcribe", help="transcribe an audio file")
    p.add_argument("audio", help="audio file to transcribe")
    p.add_argument("--language", default="auto")
    p.add_argument("--json", action="store_true", help="emit {text, lang}")
    return p


def run(args, cfg) -> int:
    with ASRClient(cfg.engine("asr")) as asr:
        result = asr.transcribe(args.audio, language=args.language)
    if args.json:
        print(json.dumps({"text": result.text, "lang": result.lang}, ensure_ascii=False))
    else:
        print(result.text)
    return 0
