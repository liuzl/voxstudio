"""`vox voices` -- named voice profiles."""

import json

from voxcore import TTSClient


def add_parser(sub):
    p = sub.add_parser("voices", help="manage named voices")
    ops = p.add_subparsers(dest="op", required=True)

    ops.add_parser("list", help="list registered voices")

    add = ops.add_parser("add", help="register a voice from a reference recording")
    add.add_argument("id")
    add.add_argument("--audio", required=True, help="reference audio file")
    add.add_argument("--text", required=True, help="transcript of the reference audio")

    ops.add_parser("show", help="show one voice").add_argument("id")
    ops.add_parser("rm", help="delete a voice").add_argument("id")
    return p


def run(args, cfg) -> int:
    with TTSClient(cfg.engine("tts"), cfg.tts_defaults) as tts:
        if args.op == "list":
            voices = tts.list_voices()
            if not voices:
                print("(no registered voices)")
            for v in voices:
                print(f"{v['id']:<20} {v.get('prompt_audio_length', '?')}s  {v.get('created_at', '')}")
        elif args.op == "add":
            print(json.dumps(tts.create_voice(args.id, args.text, args.audio), ensure_ascii=False))
        elif args.op == "show":
            print(json.dumps(tts.get_voice(args.id), ensure_ascii=False))
        elif args.op == "rm":
            tts.delete_voice(args.id)
            print(f"deleted {args.id}")
    return 0
