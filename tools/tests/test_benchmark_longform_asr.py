import pytest

from tools.benchmark_longform_asr import (
    ReferenceSegment,
    aggregate,
    cer,
    normalized_text,
    timestamp_boundary_mae,
)


def test_cer_normalizes_punctuation_and_width():
    assert normalized_text("Ａ， B！") == "ab"
    assert cer("你好，世界！", "你好世界") == 0
    assert cer("你好", "您好") == 0.5


def test_timestamp_mae_requires_matching_segment_counts():
    reference = [ReferenceSegment(0, 1, "S01", "one")]
    assert timestamp_boundary_mae(reference, [{"start": 0.1, "end": 1.2}]) == pytest.approx(0.15)
    assert timestamp_boundary_mae(reference, []) is None


def test_aggregate_reports_distributions_and_omits_missing_metrics():
    summary = aggregate([
        {"audio_seconds": 10, "wall_seconds": 1, "cer": 0.1, "rtf": 0.1, "speaker_count_delta": 0},
        {"audio_seconds": 20, "wall_seconds": 4, "cer": 0.3, "rtf": 0.2, "speaker_count_delta": 1},
    ])
    assert summary["audio_seconds"] == 30
    assert summary["wall_seconds"] == 5
    assert summary["cer"] == {"mean": 0.2, "median": 0.2, "p95": pytest.approx(0.29)}
    assert summary["timestamp_boundary_mae_seconds"] == {"mean": None, "median": None, "p95": None}
