"""Contract tests over a fake recognizer: no model download, no audio decode."""

import pytest
from fastapi.testclient import TestClient

from server_funasr import Settings, clean_language, create_app


class FakeRecognizer:
    def __init__(self):
        self.calls = []

    def transcribe(self, path: str, language: str) -> str:
        self.calls.append(language)
        return "<|zh|><|NEUTRAL|>你好，世界。"


SETTINGS = Settings(model="fake", device="cpu", hub="ms", max_upload_bytes=1024, queue_limit=2)


@pytest.fixture
def client():
    recognizer = FakeRecognizer()
    app = create_app(recognizer=recognizer, settings=SETTINGS)
    with TestClient(app) as session:
        yield session, recognizer


def post(session, payload=b"RIFFfake", **form):
    files = {"file": ("utt.wav", payload, "audio/wav")}
    return session.post("/v1/audio/transcriptions", files=files, data=form)


def test_reports_health_with_model_identity(client):
    session, _ = client
    response = session.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "model": "fake"}


def test_transcribes_and_passes_the_language_hint(client):
    session, recognizer = client
    response = post(session, language="zh")
    assert response.status_code == 200
    assert response.json() == {"text": "你好，世界。"}
    assert recognizer.calls == ["zh"]


def test_text_format_returns_plain_text(client):
    session, _ = client
    response = post(session, response_format="text")
    assert response.status_code == 200
    assert response.text == "你好，世界。"


def test_unknown_language_hint_degrades_to_auto(client):
    session, recognizer = client
    assert post(session, language="français").status_code == 200
    assert recognizer.calls == ["auto"]


def test_rejects_oversized_and_empty_uploads(client):
    session, _ = client
    assert post(session, payload=b"x" * 2048).status_code == 413
    assert post(session, payload=b"").status_code == 400


def test_rejects_unsupported_response_format(client):
    session, _ = client
    assert post(session, response_format="srt").status_code == 400


def test_language_hints():
    assert clean_language("ZH") == "zh"
    assert clean_language(None) == "auto"
    assert clean_language("english") == "auto"
    assert clean_language("en") == "en"
