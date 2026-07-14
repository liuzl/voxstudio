"""Contract tests over a fake synthesizer: no model download, no torch inference."""

import struct

import pytest
import torch
from fastapi.testclient import TestClient

from server_kokoro import Settings, create_app


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
