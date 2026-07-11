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


def client() -> tuple[TestClient, FakeEngine]:
    engine = FakeEngine()
    server_moss.app.state.engine = engine
    return TestClient(server_moss.app), engine


def test_parse_transcript():
    assert [segment.__dict__ for segment in server_moss.parse_transcript(RAW)] == [
        {"id": 0, "start": 0.28, "end": 1.2, "speaker": "S01", "text": "你好"},
        {"id": 1, "start": 1.4, "end": 2.3, "speaker": "S02", "text": "Hello"},
    ]


def test_verbose_json_preserves_speakers_and_timestamps():
    http, engine = client()
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


def test_json_and_text_return_visible_text():
    http, _ = client()
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
    http, _ = client()
    response = http.post(
        "/v1/audio/transcriptions",
        data={"prompt": "hotword"},
        files={"file": ("sample.wav", b"wav")},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["error"]["code"] == "unsupported_prompt"
