"""`vox transcribe` -- speech to text."""

import json

from voxcore import ASRClient


def add_parser(sub):
    p = sub.add_parser("transcribe", help="transcribe an audio file")
    p.add_argument("audio", help="audio file to transcribe")
    p.add_argument("--language", default="auto")
    p.add_argument("--mode", choices=("realtime", "longform"), default="realtime")
    p.add_argument("--json", action="store_true", help="emit structured JSON")
    return p


def run(args, cfg) -> int:
    longform = args.mode == "longform"
    with ASRClient(cfg.engine("asr_longform" if longform else "asr")) as asr:
        result = asr.transcribe(args.audio, language=args.language, structured=longform)
    if args.json:
        payload = {"text": result.text, "lang": result.lang}
        if result.duration is not None:
            payload["duration"] = result.duration
        if result.segments is not None:
            payload["segments"] = [segment._asdict() for segment in result.segments]
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print(result.text)
    return 0
