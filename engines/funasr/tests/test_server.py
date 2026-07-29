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


def test_revise_forwards_to_revision_endpoint(monkeypatch):
    import server_funasr

    settings = Settings(
        model="fake", device="cpu", hub="ms", max_upload_bytes=1024, queue_limit=2,
        revise_url="http://127.0.0.1:1/v1/audio/transcriptions",
    )
    monkeypatch.setattr(
        server_funasr, "revise_transcribe", lambda s, payload, name: "修订后的文本。"
    )
    app = create_app(recognizer=FakeRecognizer(), settings=settings)
    with TestClient(app) as session:
        response = post(session, revise="true")
    assert response.status_code == 200
    assert response.json() == {"text": "修订后的文本。", "engine": "revise"}


def test_revise_failure_falls_back_to_draft_model():
    settings = Settings(
        model="fake", device="cpu", hub="ms", max_upload_bytes=1024, queue_limit=2,
        # Port 1 is unroutable: the forward raises and the draft model answers.
        revise_url="http://127.0.0.1:1/v1/audio/transcriptions",
        revise_timeout=0.2,
    )
    app = create_app(recognizer=FakeRecognizer(), settings=settings)
    with TestClient(app) as session:
        response = post(session, revise="true")
    assert response.status_code == 200
    assert response.json() == {"text": "你好，世界。", "engine": "fake"}


def test_revise_flag_without_url_uses_draft_model(client):
    session, _ = client
    response = post(session, revise="true")
    assert response.status_code == 200
    assert response.json() == {"text": "你好，世界。", "engine": "fake"}


def test_revise_transcribe_builds_wellformed_multipart(monkeypatch):
    import io
    import urllib.request

    from server_funasr import revise_transcribe

    captured = {}

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return io.BytesIO(b'{"text": "ok"}')

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    settings = Settings(
        model="fake", device="cpu", hub="ms", max_upload_bytes=1024, queue_limit=2,
        revise_url="http://127.0.0.1:9/v1/audio/transcriptions", revise_model="qwen3-asr",
    )
    payload = b"RIFF\x00\x01binary\xffdata"
    # A hostile filename: quotes plus CRLF trying to inject a multipart header.
    text = revise_transcribe(settings, payload, 'evil"\r\nX-Injected: 1\r\n.wav')

    assert text == "ok"
    assert captured["timeout"] == settings.revise_timeout
    body = captured["request"].data
    content_type = captured["request"].get_header("Content-type")
    boundary = content_type.split("boundary=")[1]
    # Framing: opening boundary per part, closing boundary, both fields present,
    # binary payload carried verbatim.
    assert body.count(f"--{boundary}".encode()) == 3
    assert body.endswith(f"--{boundary}--\r\n".encode())
    assert b'name="model"\r\n\r\nqwen3-asr\r\n' in body
    assert payload in body
    # The injection attempt is neutralized: no CR/LF or quote survives in the
    # filename attribute, so the crafted header never starts its own line.
    assert not any(line.startswith(b"X-Injected") for line in body.split(b"\r\n"))
    filename_line = next(l for l in body.split(b"\r\n") if b"filename=" in l)
    assert b"\r" not in filename_line.split(b'filename="')[1]
    assert filename_line.count(b'"') == 4  # name="file"; filename="..." — no stray quotes
