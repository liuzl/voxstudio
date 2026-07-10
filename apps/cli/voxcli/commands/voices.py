"""`vox voices` -- named voice profiles."""

import json
import os
import platform
import shlex
import shutil
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
    source = add.add_mutually_exclusive_group(required=True)
    source.add_argument("--audio", help="reference audio file")
    source.add_argument("--record", nargs="?", const=0.0, type=float, metavar="SECONDS",
                        help="record from a microphone; optionally stop after SECONDS")
    add.add_argument("--device", help="ffmpeg audio input device (only with --record)")
    add.add_argument("--text", help="reference transcript; omitted uses the configured ASR")
    add.add_argument("--language", default="auto", help="ASR language when --text is omitted")
    add.add_argument("--edit", action="store_true",
                     help="edit the transcript with $VISUAL or $EDITOR before registering")
    add.add_argument("--dry-run", action="store_true",
                     help="print the final transcript without registering the voice")

    ops.add_parser("show", help="show one voice").add_argument("id")
    ops.add_parser("rm", help="delete a voice").add_argument("id")
    return p


def _record_command(output: Path, duration: float, device: str | None,
                    system: str | None = None) -> list[str]:
    system = system or platform.system()
    base = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if system == "Darwin":
        source = device or "0"
        command = [*base, "-f", "avfoundation", "-i", f":{source.lstrip(':')}"]
    elif system == "Linux":
        command = [*base, "-f", "pulse", "-i", device or "default"]
    elif system == "Windows":
        command = [*base, "-f", "dshow", "-i", f"audio={device or 'default'}"]
    else:
        raise SystemExit(f"microphone recording is not supported on {system}")

    if duration:
        command.extend(["-t", str(duration)])
    command.extend(["-ac", "1", "-ar", "16000", str(output)])
    return command


def _record_audio(duration: float, device: str | None) -> Path:
    if duration < 0:
        raise SystemExit("--record duration must be greater than zero")
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg not found on PATH; install ffmpeg to use --record")

    fd, name = tempfile.mkstemp(prefix="voxstudio-voice-", suffix=".wav")
    os.close(fd)
    output = Path(name)
    command = _record_command(output, duration, device)
    try:
        if duration:
            print(f"recording for {duration:g}s...", file=sys.stderr)
            subprocess.run(command, check=True)
        else:
            process = subprocess.Popen(command, stdin=subprocess.PIPE)
            try:
                input("recording... press Enter to stop\n")
            except (EOFError, KeyboardInterrupt):
                print(file=sys.stderr)
            process.communicate(b"q\n")
            if process.returncode:
                raise subprocess.CalledProcessError(process.returncode, command)
        if output.stat().st_size <= 44:
            raise SystemExit("recording produced no audio")
        print(f"recorded {output}", file=sys.stderr)
        return output
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"recording failed: {exc}") from exc
    finally:
        if output.exists() and output.stat().st_size <= 44:
            output.unlink()


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


def _voice_transcript(args, cfg, audio: str) -> str:
    if args.text is not None:
        text = args.text.strip()
    else:
        with ASRClient(cfg.engine("asr")) as asr:
            result = asr.transcribe(audio, language=args.language)
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
        if args.device and args.record is None:
            raise SystemExit("--device requires --record")
        recording = _record_audio(args.record, args.device) if args.record is not None else None
        audio = str(recording) if recording else args.audio
        completed = False
        try:
            text = _voice_transcript(args, cfg, audio)
            if args.dry_run:
                print(text)
                completed = True
                return 0

            with TTSClient(cfg.engine("tts"), cfg.tts_defaults) as tts:
                result = tts.create_voice(args.id, text, audio)
            print(json.dumps(result, ensure_ascii=False))
            completed = True
            return 0
        finally:
            if recording:
                if completed:
                    recording.unlink(missing_ok=True)
                else:
                    print(f"recording kept at {recording}", file=sys.stderr)

    with TTSClient(cfg.engine("tts"), cfg.tts_defaults) as tts:
        if args.op == "list":
            voices = tts.list_voices()
            if not voices:
                print("(no registered voices)")
            for v in voices:
                print(f"{v['id']:<20} {v.get('prompt_audio_length', '?')}s  {v.get('created_at', '')}")
        elif args.op == "show":
            print(json.dumps(tts.get_voice(args.id), ensure_ascii=False))
        elif args.op == "rm":
            tts.delete_voice(args.id)
            print(f"deleted {args.id}")
    return 0
