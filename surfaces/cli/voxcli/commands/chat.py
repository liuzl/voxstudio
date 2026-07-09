"""`vox chat` -- one LLM turn, optionally spoken."""

import sys

from voxcore import LLMClient, TTSClient, sanitize_for_tts, synthesize_long

from .._io import read_text_arg, write_audio


def add_parser(sub):
    p = sub.add_parser("chat", help="one-shot LLM turn")
    p.add_argument("prompt", nargs="?", help="prompt; '-' or omitted reads stdin")
    p.add_argument("--system", help="system message")
    p.add_argument("--max-tokens", type=int, dest="max_tokens")
    p.add_argument("--speak", action="store_true", help="also synthesize the reply")
    p.add_argument("-o", "--output", default="reply.wav", help="wav path when --speak")
    p.add_argument("--voice")
    return p


def run(args, cfg) -> int:
    prompt = read_text_arg(args.prompt)
    messages = ([{"role": "system", "content": args.system}] if args.system else [])
    messages.append({"role": "user", "content": prompt})

    with LLMClient(cfg.engine("llm")) as llm:
        reply = llm.chat(messages, max_tokens=args.max_tokens)
    if not reply.strip():
        raise SystemExit("model returned empty content (try a larger --max-tokens)")
    print(reply)

    if args.speak:
        # An LLM will occasionally slip a glyph from another script into otherwise
        # clean Chinese, and the TTS engine renders it as garbage. Filter before speaking.
        spoken, dropped = sanitize_for_tts(reply)
        if dropped:
            print(f"dropped {len(dropped)} out-of-script glyph(s): "
                  f"{''.join(sorted(set(dropped)))}", file=sys.stderr)
        with TTSClient(cfg.engine("tts"), cfg.tts_defaults) as tts:
            wav = synthesize_long(tts, spoken, args.voice, chunking=cfg.chunking)
        write_audio(wav, args.output)
    return 0
