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


def _ass_time(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    hours, centiseconds = divmod(centiseconds, 360_000)
    minutes, centiseconds = divmod(centiseconds, 6_000)
    seconds, centiseconds = divmod(centiseconds, 100)
    return f"{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}"


def _render_ass(segments) -> str:
    header = """[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,60,60,36,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"""
    events = []
    for segment in segments:
        prefix = f"[{segment.speaker}] " if segment.speaker else ""
        text = f"{prefix}{segment.text}".replace("\r", "").replace("\n", r"\N")
        events.append(f"Dialogue: 0,{_ass_time(segment.start)},{_ass_time(segment.end)},Default,,0,0,0,,{text}")
    return "\n".join((header, *events))


def add_parser(sub):
    p = sub.add_parser("transcribe", help="transcribe an audio file")
    p.add_argument("audio", help="audio file to transcribe")
    p.add_argument("--language", default="auto")
    p.add_argument("--mode", choices=("realtime", "longform"), default="realtime")
    p.add_argument("--json", action="store_true", help="emit structured JSON")
    p.add_argument("--format", choices=("text", "json", "srt", "ass"), help="output format")
    p.add_argument("--max-new-tokens", type=int, help="longform generation-token limit")
    return p


def run(args, cfg) -> int:
    longform = args.mode == "longform"
    output_format = args.format or ("json" if args.json else "text")
    if args.json and args.format:
        raise SystemExit("transcribe: --json cannot be combined with --format")
    if output_format in ("srt", "ass") and not longform:
        raise SystemExit(f"transcribe: --format {output_format} requires --mode longform")
    if args.max_new_tokens is not None and args.max_new_tokens <= 0:
        raise SystemExit("transcribe: --max-new-tokens must be a positive integer")
    if args.max_new_tokens is not None and not longform:
        raise SystemExit("transcribe: --max-new-tokens requires --mode longform")
    with ASRClient(cfg.engine("asr_longform" if longform else "asr")) as asr:
        result = asr.transcribe(
            args.audio,
            language=args.language,
            structured=longform,
            max_new_tokens=args.max_new_tokens,
        )
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
    elif output_format == "ass":
        if not result.segments:
            raise SystemExit("transcribe: longform engine returned no segments for ASS")
        print(_render_ass(result.segments))
    else:
        print(result.text)
    return 0
