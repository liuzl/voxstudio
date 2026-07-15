"""Contract tests over a fake synthesizer: no model download, no torch inference."""

import struct
import threading

import pytest
import torch
from fastapi.testclient import TestClient

import server_kokoro
from server_kokoro import KokoroSynthesizer, Settings, create_app


class FakeSynthesizer:
    def __init__(self):
        self.calls = []

    def voices(self):
        return ["zf_001", "zm_009"]

    def synthesize(self, text, voice, speed):
        self.calls.append((text, voice, speed))
        yield torch.full((240,), 0.25)
        yield torch.full((240,), -0.25)


SETTINGS = Settings(repo="fake/kokoro", default_voice="zf_001", output_rate=24_000, device="cpu")


@pytest.fixture
def client():
    synthesizer = FakeSynthesizer()
    app = create_app(synthesizer=synthesizer, settings=SETTINGS)
    with TestClient(app) as session:
        yield session, synthesizer


def test_health_reports_identity_and_voice_count(client):
    session, _ = client
    assert session.get("/healthz").json() == {
        "status": "ok", "model": "fake/kokoro", "sample_rate": 24_000, "voices": 2,
    }
    identity = session.get("/health").json()
    assert identity["model"].startswith("kokoro@")
    assert identity["model_manifest_sha256"] is None


def test_lists_the_voice_bank(client):
    session, _ = client
    assert session.get("/v1/voices").json() == {"voices": [{"id": "zf_001"}, {"id": "zm_009"}]}


def test_batch_speech_returns_wav_and_ignores_continuation_fields(client):
    session, synthesizer = client
    response = session.post("/v1/audio/speech", json={
        "input": "你好", "voice": "zm_009", "model": "kokoro",
        "cfg_value": 2, "timesteps": 10, "prosody_prompt": True,
        "continuation_id": "session-1", "continuation_end": False,
    })
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content[:4] == b"RIFF"
    assert synthesizer.calls == [("你好", "zm_009", 1.0)]


def test_streaming_speech_returns_chunked_f32le(client):
    session, _ = client
    response = session.post("/v1/audio/speech", json={"input": "你好", "stream": True})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/pcm")
    assert response.headers["x-sample-rate"] == "24000"
    values = struct.unpack(f"<{len(response.content) // 4}f", response.content)
    assert len(values) == 480
    assert abs(values[0] - 0.25) < 1e-6
    assert abs(values[-1] + 0.25) < 1e-6


def test_default_voice_applies_and_unknown_voice_is_rejected(client):
    session, synthesizer = client
    assert session.post("/v1/audio/speech", json={"input": "好"}).status_code == 200
    assert synthesizer.calls[-1][1] == "zf_001"
    assert session.post("/v1/audio/speech", json={"input": "好", "voice": "nope"}).status_code == 400


def test_rejects_empty_input(client):
    session, _ = client
    assert session.post("/v1/audio/speech", json={"input": "   "}).status_code == 400


class _Segment:
    def __init__(self, audio):
        self.audio = audio


class LockedFakeSynthesizer(KokoroSynthesizer):
    """The real synthesize() — real lock, real generator — over a fake pipeline."""

    def __init__(self, segments=3):
        self._lock = threading.Lock()
        self._voices = ["zf_001"]
        self._segments = segments

        def pipeline(text, voice, speed):
            for _ in range(self._segments):
                yield _Segment(torch.full((240,), 0.25))

        self._pipeline = pipeline

    @property
    def lock(self):
        return self._lock


def locked_client():
    synthesizer = LockedFakeSynthesizer()
    app = create_app(synthesizer=synthesizer, settings=SETTINGS)
    return TestClient(app), synthesizer


def test_abandoned_stream_releases_the_pipeline_lock(monkeypatch):
    # A barge-in aborts the TTS stream mid-reply. The abandoned generator must not
    # keep the pipeline lock — that exact leak wedged the live server until restart
    # (every later request queued forever behind a suspended `with`).
    monkeypatch.setattr(server_kokoro, "LOCK_TIMEOUT_SECONDS", 1.0)
    with locked_client()[0] as session:
        with session.stream("POST", "/v1/audio/speech",
                            json={"input": "第一句。第二句。第三句。", "stream": True}) as response:
            assert response.status_code == 200
            next(response.iter_bytes(960))  # first segment only, then disconnect

        # The lock must be free again: a full request completes instead of timing out.
        follow_up = session.post("/v1/audio/speech", json={"input": "还在吗"})
        assert follow_up.status_code == 200
        assert follow_up.headers["content-type"] == "audio/wav"


def test_busy_pipeline_returns_503_instead_of_hanging(monkeypatch):
    monkeypatch.setattr(server_kokoro, "LOCK_TIMEOUT_SECONDS", 0.05)
    client, synthesizer = locked_client()
    with client as session:
        assert synthesizer.lock.acquire()  # someone is wedged mid-synthesis
        try:
            streaming = session.post("/v1/audio/speech", json={"input": "好", "stream": True})
            assert streaming.status_code == 503
            batch = session.post("/v1/audio/speech", json={"input": "好"})
            assert batch.status_code == 503
        finally:
            synthesizer.lock.release()
        assert session.post("/v1/audio/speech", json={"input": "好"}).status_code == 200
