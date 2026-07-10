"""Shared stdin/stdout plumbing for the subcommands."""

import sys
from pathlib import Path


def read_text_arg(text: str | None, file: str | None = None) -> str:
    if file:
        return Path(file).read_text(encoding="utf-8")
    if text and text != "-":
        return text
    return sys.stdin.read()


def write_audio(wav: bytes, output: str) -> None:
    if output == "-":
        sys.stdout.buffer.write(wav)
        return
    Path(output).write_bytes(wav)
    print(f"wrote {output} ({len(wav) / 1e6:.1f} MB)", file=sys.stderr)
