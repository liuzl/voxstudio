from pathlib import Path

from fastapi.testclient import TestClient

import server_moss


RAW = "[0.28][S01]你好[1.20][1.40][S02]Hello[2.30]"


class FakeEngine:
    def __init__(self):
        self.calls: list[tuple[bytes, int]] = []

    def transcribe(self, path: Path, max_new_tokens: int) -> str:
        self.calls.append((path.read_bytes(), max_new_tokens))
        return RAW

    def close(self) -> None:
        pass


class FakeNormalizer:
    def __init__(self):
        self.calls: list[bytes] = []

    def normalize(self, source: Path, target: Path) -> float:
        data = source.read_bytes()
        self.calls.append(data)
        target.write_bytes(data)
        return 2.3


def client(*, max_upload_bytes: int = 1024) -> tuple[TestClient, FakeEngine, FakeNormalizer]:
    engine = FakeEngine()
    normalizer = FakeNormalizer()
    server_moss.app.state.engine = engine
    server_moss.app.state.normalizer = normalizer
    server_moss.app.state.settings = server_moss.Settings(
        max_upload_bytes=max_upload_bytes,
        max_duration_seconds=10,
        queue_limit=2,
        ffmpeg_timeout_seconds=10,
        ffmpeg="ffmpeg",
        ffprobe="ffprobe",
    )
    server_moss.app.state.admission = server_moss.Admission(2)
    return TestClient(server_moss.app), engine, normalizer


def test_parse_transcript():
    assert [segment.__dict__ for segment in server_moss.parse_transcript(RAW)] == [
        {"id": 0, "start": 0.28, "end": 1.2, "speaker": "S01", "text": "你好"},
        {"id": 1, "start": 1.4, "end": 2.3, "speaker": "S02", "text": "Hello"},
    ]


def test_verbose_json_preserves_speakers_and_timestamps():
    http, engine, normalizer = client()
    response = http.post(
        "/v1/audio/transcriptions",
        data={"model": "moss", "response_format": "verbose_json", "max_new_tokens": "123"},
        files={"file": ("sample.wav", b"wav bytes", "audio/wav")},
    )

    assert response.status_code == 200
    assert response.json() == {
        "task": "transcribe",
        "language": None,
        "duration": 2.3,
        "text": "你好 Hello",
        "model": "moss",
        "segments": [
            {"id": 0, "start": 0.28, "end": 1.2, "speaker": "S01", "text": "你好"},
            {"id": 1, "start": 1.4, "end": 2.3, "speaker": "S02", "text": "Hello"},
        ],
    }
    assert engine.calls == [(b"wav bytes", 123)]
    assert normalizer.calls == [b"wav bytes"]


def test_json_and_text_return_visible_text():
    http, _, _ = client()
    json_response = http.post(
        "/v1/audio/transcriptions",
        data={"response_format": "json"},
        files={"file": ("sample.wav", b"wav")},
    )
    text_response = http.post(
        "/v1/audio/transcriptions",
        data={"response_format": "text"},
        files={"file": ("sample.wav", b"wav")},
    )
    assert json_response.json() == {"text": "你好 Hello"}
    assert text_response.text == "你好 Hello"


def test_rejects_unsupported_generation_options():
    http, _, _ = client()
    response = http.post(
        "/v1/audio/transcriptions",
        data={"prompt": "hotword"},
        files={"file": ("sample.wav", b"wav")},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["error"]["code"] == "unsupported_prompt"


def test_rejects_upload_larger_than_limit():
    http, engine, _ = client(max_upload_bytes=3)
    response = http.post(
        "/v1/audio/transcriptions",
        files={"file": ("sample.mp4", b"four", "video/mp4")},
    )
    assert response.status_code == 413
    assert response.json()["detail"]["error"]["code"] == "upload_too_large"
    assert engine.calls == []


def test_health_reports_readiness_and_queue():
    http, _, _ = client()
    response = http.get("/health")
    assert response.status_code == 200
    assert response.json()["ready"] is True
    assert response.json()["queue"] == {"capacity": 2, "active": 0, "waiting": 0}


def test_queue_rejects_when_all_slots_are_reserved():
    http, _, _ = client()
    admission = server_moss.Admission(1)
    server_moss.app.state.admission = admission
    assert admission.enter()
    try:
        response = http.post(
            "/v1/audio/transcriptions",
            files={"file": ("sample.wav", b"wav")},
        )
        assert response.status_code == 429
        assert response.headers["retry-after"] == "5"
        assert response.json()["detail"]["error"]["code"] == "queue_full"
    finally:
        admission.leave()
