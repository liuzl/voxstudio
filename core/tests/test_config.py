from voxcore import load_config

YAML = """
engines:
  tts:
    base_url: http://127.0.0.1:9999
    api_key: ${VOXTEST_KEY}
  llm:
    base_url: http://127.0.0.1:8080
    api_key: ${VOXTEST_ABSENT}
chunking:
  max_chars: 200
"""


def write(tmp_path, text=YAML):
    path = tmp_path / "voxstudio.yaml"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_yaml_merges_onto_defaults(tmp_path, monkeypatch):
    monkeypatch.delenv("VOXSTUDIO_TTS_BASE_URL", raising=False)
    cfg = load_config(write(tmp_path))
    assert cfg.engine("tts").base_url == "http://127.0.0.1:9999"
    assert cfg.engine("tts").model == "voxcpm2"          # kept from defaults
    assert cfg.engine("asr").model == "nemotron-asr"     # engine absent from yaml
    assert cfg.chunking.max_chars == 200
    assert cfg.chunking.join_pause_ms == 210             # kept from defaults


def test_env_vars_expand_and_unset_ones_become_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("VOXTEST_KEY", "sk-abc")
    monkeypatch.delenv("VOXTEST_ABSENT", raising=False)
    cfg = load_config(write(tmp_path))
    assert cfg.engine("tts").api_key == "sk-abc"
    assert cfg.engine("llm").api_key == ""


def test_env_overrides_win_over_yaml(tmp_path, monkeypatch):
    monkeypatch.setenv("VOXSTUDIO_TTS_BASE_URL", "http://elsewhere:1234")
    monkeypatch.setenv("VOXSTUDIO_CHUNK_MAX_CHARS", "80")
    cfg = load_config(write(tmp_path))
    assert cfg.engine("tts").base_url == "http://elsewhere:1234"
    assert cfg.chunking.max_chars == 80


def test_missing_engine_is_a_clean_exit(tmp_path):
    import pytest
    cfg = load_config(write(tmp_path))
    with pytest.raises(SystemExit, match="engines.nope"):
        cfg.engine("nope")
