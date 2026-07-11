#!/usr/bin/env python3
"""Benchmark a long-form OpenAI-compatible transcription endpoint from a private manifest."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from statistics import mean, median
from typing import Any

import httpx


@dataclass(frozen=True)
class ReferenceSegment:
    start: float
    end: float
    speaker: str
    text: str


def normalized_text(value: str) -> str:
    """NFKC text with whitespace and punctuation removed for Chinese-friendly CER."""
    return "".join(
        char.casefold()
        for char in unicodedata.normalize("NFKC", value)
        if not char.isspace() and not unicodedata.category(char).startswith("P")
    )


def levenshtein(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
    row = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, 1):
        next_row = [left_index]
        for right_index, right_char in enumerate(right, 1):
            next_row.append(min(
                next_row[-1] + 1,
                row[right_index] + 1,
                row[right_index - 1] + (left_char != right_char),
            ))
        row = next_row
    return row[-1]


def cer(reference: str, prediction: str) -> float | None:
    reference = normalized_text(reference)
    prediction = normalized_text(prediction)
    if not reference:
        return None
    return levenshtein(reference, prediction) / len(reference)


def parse_reference_segments(value: Any) -> list[ReferenceSegment] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError("reference_segments must be an array")
    result = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValueError(f"reference_segments[{index}] must be an object")
        if not all(isinstance(item.get(key), (int, float)) for key in ("start", "end")):
            raise ValueError(f"reference_segments[{index}] needs numeric start/end")
        if not isinstance(item.get("speaker"), str) or not isinstance(item.get("text"), str):
            raise ValueError(f"reference_segments[{index}] needs speaker/text")
        result.append(ReferenceSegment(float(item["start"]), float(item["end"]), item["speaker"], item["text"]))
    return result


def timestamp_boundary_mae(reference: list[ReferenceSegment], prediction: list[dict[str, Any]]) -> float | None:
    """Ordinal segment boundary MAE; only meaningful when segmentation cardinality matches."""
    if len(reference) != len(prediction) or not reference:
        return None
    errors = []
    for expected, actual in zip(reference, prediction):
        if not isinstance(actual.get("start"), (int, float)) or not isinstance(actual.get("end"), (int, float)):
            return None
        errors.extend((abs(expected.start - actual["start"]), abs(expected.end - actual["end"])))
    return sum(errors) / len(errors)


def source_duration(path: Path, ffprobe: str) -> float:
    completed = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError("ffprobe could not determine input duration")
    duration = float(completed.stdout.strip())
    if duration <= 0:
        raise RuntimeError("input duration must be positive")
    return duration


def load_manifest(path: Path) -> list[dict[str, Any]]:
    records = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_number}: invalid JSON") from exc
        if not isinstance(record, dict):
            raise ValueError(f"{path}:{line_number}: record must be an object")
        if not isinstance(record.get("id"), str) or not isinstance(record.get("audio"), str):
            raise ValueError(f"{path}:{line_number}: id and audio are required strings")
        if not isinstance(record.get("reference_text"), str):
            raise ValueError(f"{path}:{line_number}: reference_text is required")
        parse_reference_segments(record.get("reference_segments"))
        records.append(record)
    if not records:
        raise ValueError("manifest contains no records")
    return records


def request_transcript(
    client: httpx.Client,
    endpoint: str,
    model: str,
    audio: Path,
    max_new_tokens: int,
) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    with audio.open("rb") as source:
        response = client.post(
            endpoint,
            data={
                "model": model,
                "response_format": "verbose_json",
                "max_new_tokens": str(max_new_tokens),
            },
            files={"file": (audio.name, source, "application/octet-stream")},
        )
    elapsed = time.perf_counter() - started
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
        raise RuntimeError("endpoint returned no transcription text")
    return payload, elapsed


def evaluate(record: dict[str, Any], payload: dict[str, Any], duration: float, elapsed: float) -> dict[str, Any]:
    reference_segments = parse_reference_segments(record.get("reference_segments"))
    segments = payload.get("segments") if isinstance(payload.get("segments"), list) else []
    predicted_speakers = sorted({segment.get("speaker") for segment in segments if isinstance(segment, dict) and isinstance(segment.get("speaker"), str)})
    result: dict[str, Any] = {
        "id": record["id"],
        "audio_seconds": duration,
        "wall_seconds": elapsed,
        "rtf": elapsed / duration,
        "cer": cer(record["reference_text"], payload["text"]),
        "predicted_segment_count": len(segments),
        "predicted_speaker_count": len(predicted_speakers),
    }
    if reference_segments is not None:
        result["reference_segment_count"] = len(reference_segments)
        result["reference_speaker_count"] = len({segment.speaker for segment in reference_segments})
        result["speaker_count_delta"] = result["predicted_speaker_count"] - result["reference_speaker_count"]
        result["timestamp_boundary_mae_seconds"] = timestamp_boundary_mae(reference_segments, segments)
    return result


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def aggregate(results: list[dict[str, Any]]) -> dict[str, Any]:
    def values(key: str) -> list[float]:
        return [float(result[key]) for result in results if isinstance(result.get(key), (int, float))]

    def distribution(key: str) -> dict[str, float | None]:
        data = values(key)
        return {
            "mean": mean(data) if data else None,
            "median": median(data) if data else None,
            "p95": percentile(data, 0.95),
        }

    return {
        "audio_seconds": sum(values("audio_seconds")),
        "wall_seconds": sum(values("wall_seconds")),
        "cer": distribution("cer"),
        "rtf": distribution("rtf"),
        "timestamp_boundary_mae_seconds": distribution("timestamp_boundary_mae_seconds"),
        "speaker_count_delta": distribution("speaker_count_delta"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="private JSONL manifest; paths are relative to this file")
    parser.add_argument("--base-url", required=True, help="MOSS endpoint base URL")
    parser.add_argument("--model", default="moss-transcribe-diarize")
    parser.add_argument("--max-new-tokens", type=int, default=65536)
    parser.add_argument("--timeout", type=float, default=1800)
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--out", type=Path, required=True, help="JSON result path; do not commit private results")
    parser.add_argument("--dry-run", action="store_true", help="validate manifest and input files without requests")
    args = parser.parse_args()
    if args.max_new_tokens <= 0 or args.timeout <= 0:
        parser.error("--max-new-tokens and --timeout must be positive")

    records = load_manifest(args.manifest)
    root = args.manifest.parent
    endpoint = args.base_url.rstrip("/") + "/v1/audio/transcriptions"
    results = []
    errors = []
    with httpx.Client(timeout=args.timeout) as client:
        for record in records:
            audio = (root / record["audio"]).resolve()
            if not audio.is_file():
                errors.append({"id": record["id"], "error": f"audio not found: {record['audio']}"})
                continue
            try:
                duration = source_duration(audio, args.ffprobe)
                if not args.dry_run:
                    payload, elapsed = request_transcript(client, endpoint, args.model, audio, args.max_new_tokens)
                    results.append(evaluate(record, payload, duration, elapsed))
            except Exception as exc:  # Keep evaluating other private fixtures.
                errors.append({"id": record["id"], "error": str(exc)})

    report = {
        "manifest_records": len(records),
        "completed": len(results),
        "errors": errors,
        "summary": aggregate(results),
        "results": results,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"completed": len(results), "errors": len(errors), "out": str(args.out)}))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
