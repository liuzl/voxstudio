"""`vox transcribe` -- speech to text."""

import json

from voxcore import ASRClient


def _srt_time(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def _render_srt(segments) -> str:
    return "\n\n".join(
        f"{index}\n{_srt_time(segment.start)} --> {_srt_time(segment.end)}\n"
        f"{'[' + segment.speaker + '] ' if segment.speaker else ''}{segment.text}"
        for index, segment in enumerate(segments, 1)
    )


def add_parser(sub):
    p = sub.add_parser("transcribe", help="transcribe an audio file")
    p.add_argument("audio", help="audio file to transcribe")
    p.add_argument("--language", default="auto")
    p.add_argument("--mode", choices=("realtime", "longform"), default="realtime")
    p.add_argument("--json", action="store_true", help="emit structured JSON")
    p.add_argument("--format", choices=("text", "json", "srt"), help="output format")
    return p


def run(args, cfg) -> int:
    longform = args.mode == "longform"
    output_format = args.format or ("json" if args.json else "text")
    if args.json and args.format:
        raise SystemExit("transcribe: --json cannot be combined with --format")
    if output_format == "srt" and not longform:
        raise SystemExit("transcribe: --format srt requires --mode longform")
    with ASRClient(cfg.engine("asr_longform" if longform else "asr")) as asr:
        result = asr.transcribe(args.audio, language=args.language, structured=longform)
    if output_format == "json":
        payload = {"text": result.text, "lang": result.lang}
        if result.duration is not None:
            payload["duration"] = result.duration
        if result.segments is not None:
            payload["segments"] = [segment._asdict() for segment in result.segments]
        print(json.dumps(payload, ensure_ascii=False))
    elif output_format == "srt":
        if not result.segments:
            raise SystemExit("transcribe: longform engine returned no segments for SRT")
        print(_render_srt(result.segments))
    else:
        print(result.text)
    return 0
