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
    values = dict(op="add", id="alice", audio="sample.wav", text=None,
                  language="auto", edit=False, dry_run=False)
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
