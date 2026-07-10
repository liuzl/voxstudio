"""`vox voices` -- named voice profiles."""

import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

from voxcore import ASRClient, TTSClient


def add_parser(sub):
    p = sub.add_parser("voices", help="manage named voices")
    ops = p.add_subparsers(dest="op", required=True)

    ops.add_parser("list", help="list registered voices")

    add = ops.add_parser("add", help="register a voice from a reference recording")
    add.add_argument("id")
    add.add_argument("--audio", required=True, help="reference audio file")
    add.add_argument("--text", help="reference transcript; omitted uses the configured ASR")
    add.add_argument("--language", default="auto", help="ASR language when --text is omitted")
    add.add_argument("--edit", action="store_true",
                     help="edit the transcript with $VISUAL or $EDITOR before registering")
    add.add_argument("--dry-run", action="store_true",
                     help="print the final transcript without registering the voice")

    ops.add_parser("show", help="show one voice").add_argument("id")
    ops.add_parser("rm", help="delete a voice").add_argument("id")
    return p


def _edit_transcript(text: str) -> str:
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR")
    if not editor:
        raise SystemExit("--edit requires $VISUAL or $EDITOR")

    path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as fh:
            fh.write(text)
            if text and not text.endswith("\n"):
                fh.write("\n")
            path = Path(fh.name)
        subprocess.run([*shlex.split(editor), str(path)], check=True)
        return path.read_text(encoding="utf-8").strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"editor failed: {exc}") from exc
    finally:
        if path is not None:
            path.unlink(missing_ok=True)


def _voice_transcript(args, cfg) -> str:
    if args.text is not None:
        text = args.text.strip()
    else:
        with ASRClient(cfg.engine("asr")) as asr:
            result = asr.transcribe(args.audio, language=args.language)
        text = result.text.strip()
        language = result.lang or "unknown"
        print(f"ASR transcript ({language}): {text}", file=sys.stderr)

    if args.edit:
        text = _edit_transcript(text)
    if not text:
        raise SystemExit("reference transcript is empty")
    return text


def run(args, cfg) -> int:
    if args.op == "add":
        text = _voice_transcript(args, cfg)
        if args.dry_run:
            print(text)
            return 0

    with TTSClient(cfg.engine("tts"), cfg.tts_defaults) as tts:
        if args.op == "list":
            voices = tts.list_voices()
            if not voices:
                print("(no registered voices)")
            for v in voices:
                print(f"{v['id']:<20} {v.get('prompt_audio_length', '?')}s  {v.get('created_at', '')}")
        elif args.op == "add":
            print(json.dumps(tts.create_voice(args.id, text, args.audio), ensure_ascii=False))
        elif args.op == "show":
            print(json.dumps(tts.get_voice(args.id), ensure_ascii=False))
        elif args.op == "rm":
            tts.delete_voice(args.id)
            print(f"deleted {args.id}")
    return 0
