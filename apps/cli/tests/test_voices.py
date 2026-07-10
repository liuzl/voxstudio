from argparse import Namespace
from types import SimpleNamespace

import pytest

from voxcli.commands import voices


class Config:
    tts_defaults = object()

    def engine(self, name):
        return name


class FakeASR:
    calls = []

    def __init__(self, engine):
        assert engine == "asr"

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def transcribe(self, audio, *, language):
        self.calls.append((audio, language))
        return SimpleNamespace(text=" 自动识别稿 ", lang="zh")


class FakeTTS:
    calls = []

    def __init__(self, engine, defaults):
        assert (engine, defaults) == ("tts", Config.tts_defaults)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def create_voice(self, voice_id, text, audio):
        self.calls.append((voice_id, text, audio))
        return {"id": voice_id}


def add_args(**overrides):
    values = dict(op="add", id="alice", audio="sample.wav", record=None, device=None,
                  text=None, language="auto", edit=False, dry_run=False)
    values.update(overrides)
    return Namespace(**values)


@pytest.fixture(autouse=True)
def clients(monkeypatch):
    FakeASR.calls = []
    FakeTTS.calls = []
    monkeypatch.setattr(voices, "ASRClient", FakeASR)
    monkeypatch.setattr(voices, "TTSClient", FakeTTS)


def test_add_transcribes_when_text_is_omitted(capsys):
    assert voices.run(add_args(language="zh"), Config()) == 0
    assert FakeASR.calls == [("sample.wav", "zh")]
    assert FakeTTS.calls == [("alice", "自动识别稿", "sample.wav")]
    output = capsys.readouterr()
    assert '"id": "alice"' in output.out
    assert "ASR transcript (zh): 自动识别稿" in output.err


def test_explicit_text_skips_asr():
    voices.run(add_args(text=" 人工逐字稿 "), Config())
    assert FakeASR.calls == []
    assert FakeTTS.calls == [("alice", "人工逐字稿", "sample.wav")]


def test_dry_run_prints_transcript_without_connecting_to_tts(capsys):
    voices.run(add_args(dry_run=True), Config())
    assert FakeTTS.calls == []
    assert capsys.readouterr().out == "自动识别稿\n"


def test_empty_transcript_is_rejected():
    with pytest.raises(SystemExit, match="transcript is empty"):
        voices.run(add_args(text="  "), Config())


def test_edit_uses_corrected_transcript(monkeypatch):
    monkeypatch.setattr(voices, "_edit_transcript", lambda text: "校正后的逐字稿")
    voices.run(add_args(text="原稿", edit=True), Config())
    assert FakeTTS.calls == [("alice", "校正后的逐字稿", "sample.wav")]


@pytest.mark.parametrize(("system", "device", "source"), [
    ("Darwin", None, ["-f", "avfoundation", "-i", ":0"]),
    ("Darwin", "2", ["-f", "avfoundation", "-i", ":2"]),
    ("Linux", None, ["-f", "pulse", "-i", "default"]),
    ("Windows", "Mic", ["-f", "dshow", "-i", "audio=Mic"]),
])
def test_record_command_selects_platform_input(tmp_path, system, device, source):
    command = voices._record_command(tmp_path / "voice.wav", 12, device, system)
    start = command.index("-f")
    assert command[start:start + 4] == source
    assert ["-t", "12"] == command[command.index("-t"):command.index("-t") + 2]
    assert command[-5:] == ["-ac", "1", "-ar", "16000", str(tmp_path / "voice.wav")]


def test_recorded_audio_is_used_and_removed(monkeypatch, tmp_path):
    recording = tmp_path / "recording.wav"
    recording.write_bytes(b"audio")
    monkeypatch.setattr(voices, "_record_audio", lambda duration, device: recording)

    voices.run(add_args(audio=None, record=10), Config())

    assert FakeASR.calls == [(str(recording), "auto")]
    assert FakeTTS.calls == [("alice", "自动识别稿", str(recording))]
    assert not recording.exists()


def test_recording_is_kept_when_registration_fails(monkeypatch, tmp_path, capsys):
    recording = tmp_path / "recording.wav"
    recording.write_bytes(b"audio")
    monkeypatch.setattr(voices, "_record_audio", lambda duration, device: recording)
    monkeypatch.setattr(voices, "_voice_transcript",
                        lambda args, cfg, audio: (_ for _ in ()).throw(RuntimeError("ASR failed")))

    with pytest.raises(RuntimeError, match="ASR failed"):
        voices.run(add_args(audio=None, record=0), Config())

    assert recording.exists()
    assert f"recording kept at {recording}" in capsys.readouterr().err


def test_device_requires_recording():
    with pytest.raises(SystemExit, match="--device requires --record"):
        voices.run(add_args(device="2"), Config())
