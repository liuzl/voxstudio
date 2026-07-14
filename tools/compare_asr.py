#!/usr/bin/env python3
"""Compare ASR endpoints on the same WAV files, with CER against reference texts.

Usage:
    python3 tools/compare_asr.py \
        --endpoint nemotron=http://host:18087 \
        --endpoint sensevoice=http://127.0.0.1:18088 \
        [--language zh] audio1.wav audio2.wav ...

A reference transcript is read from `<audio>.ref.txt` next to each WAV when present;
without one the transcripts are printed for eyeballing but no CER is computed.
Utterances collected with `vox listen --save-utterances DIR` come with a `.txt` sidecar
holding what the then-active engine heard — correct it by hand and rename to `.ref.txt`.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.request
import uuid
from pathlib import Path

PUNCT = re.compile(r"[\s。，、！？；：\"\"''‘’“”,.!?;:\-—…()（）]")


def normalize(text: str) -> str:
    return PUNCT.sub("", text).lower()


def edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, 1):
        current = [i]
        for j, char_b in enumerate(b, 1):
            current.append(min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (char_a != char_b),
            ))
        previous = current
    return previous[len(b)]


def cer(reference: str, hypothesis: str) -> float:
    ref = normalize(reference)
    hyp = normalize(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def transcribe(base_url: str, wav: Path, language: str | None) -> tuple[str, float]:
    boundary = uuid.uuid4().hex
    parts = []
    if language:
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\n{language}\r\n".encode()
        )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{wav.name}\"\r\n"
        f"Content-Type: audio/wav\r\n\r\n".encode() + wav.read_bytes() + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/audio/transcriptions",
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=300) as response:
        import json
        payload = json.loads(response.read())
    elapsed = time.monotonic() - started
    # Engines tag the language in different styles — parakeet appends <zh-CN>, SenseVoice
    # wraps <|zh|>. The product client strips both; scoring must too.
    text = re.sub(r"<\|[^|]*\|>|<[A-Za-z-]+>", "", str(payload.get("text", ""))).strip()
    return text, elapsed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", action="append", required=True,
                        metavar="NAME=URL", help="repeatable: name=base_url")
    parser.add_argument("--language", default=None)
    parser.add_argument("audio", nargs="+", type=Path)
    args = parser.parse_args()
    endpoints = dict(spec.split("=", 1) for spec in args.endpoint)

    totals: dict[str, list[float]] = {name: [] for name in endpoints}
    latencies: dict[str, list[float]] = {name: [] for name in endpoints}
    for wav in args.audio:
        reference_path = wav.with_suffix(".ref.txt")
        reference = reference_path.read_text().strip() if reference_path.exists() else None
        print(f"\n=== {wav.name} ===")
        if reference:
            print(f"  参考: {reference}")
        for name, url in endpoints.items():
            try:
                text, elapsed = transcribe(url, wav, args.language)
            except Exception as error:  # noqa: BLE001 - report and continue
                print(f"  {name}: 请求失败: {error}")
                continue
            latencies[name].append(elapsed)
            line = f"  {name} ({elapsed:.2f}s): {text}"
            if reference is not None:
                value = cer(reference, text)
                totals[name].append(value)
                line += f"   [CER {value:.1%}]"
            print(line)

    print("\n=== 汇总 ===")
    for name in endpoints:
        scored = totals[name]
        lat = latencies[name]
        cer_part = f"平均CER {sum(scored) / len(scored):.1%} (n={len(scored)})" if scored else "无参考"
        lat_part = f"平均延迟 {sum(lat) / len(lat):.2f}s" if lat else "无成功请求"
        print(f"  {name}: {cer_part}  {lat_part}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
