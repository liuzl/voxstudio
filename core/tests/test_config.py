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
  max_seconds: 20.0
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
    assert cfg.chunking.max_seconds == 20.0
    assert cfg.chunking.join_pause_ms == 210             # kept from defaults


def test_env_vars_expand_and_unset_ones_become_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("VOXTEST_KEY", "sk-abc")
    monkeypatch.delenv("VOXTEST_ABSENT", raising=False)
    cfg = load_config(write(tmp_path))
    assert cfg.engine("tts").api_key == "sk-abc"
    assert cfg.engine("llm").api_key == ""


def test_env_overrides_win_over_yaml(tmp_path, monkeypatch):
    monkeypatch.setenv("VOXSTUDIO_TTS_BASE_URL", "http://elsewhere:1234")
    monkeypatch.setenv("VOXSTUDIO_CHUNK_MAX_SECONDS", "8")
    cfg = load_config(write(tmp_path))
    assert cfg.engine("tts").base_url == "http://elsewhere:1234"
    assert cfg.chunking.max_seconds == 8.0


def test_missing_engine_is_a_clean_exit(tmp_path):
    import pytest
    cfg = load_config(write(tmp_path))
    with pytest.raises(SystemExit, match="engines.nope"):
        cfg.engine("nope")


def test_a_character_budget_is_refused_rather_than_read_as_seconds(tmp_path):
    # `max_chars: 160` read as 160 seconds would synthesize the timbre drift it exists
    # to prevent, and it would do it silently.
    import pytest
    stale = "chunking:\n  max_chars: 160\n"
    with pytest.raises(SystemExit, match="chunking.max_seconds"):
        load_config(write(tmp_path, stale))


def test_a_nan_budget_is_refused(tmp_path):
    # Every comparison against nan is false, so `chunk_text` would never find a chunk
    # too long: the whole document goes to the engine in one generation. YAML spells it
    # `.nan`, and it survives `float()` without complaint.
    import pytest
    for key in ("max_seconds", "first_max_seconds"):
        with pytest.raises(SystemExit, match=f"chunking.{key}"):
            load_config(write(tmp_path, f"chunking:\n  {key}: .nan\n"))


def test_a_budget_that_bounds_nothing_is_refused(tmp_path):
    import pytest
    for value in (".inf", "0", "-5"):
        with pytest.raises(SystemExit, match="positive number of seconds"):
            load_config(write(tmp_path, f"chunking:\n  max_seconds: {value}\n"))


def test_growth_must_be_finite_but_may_shrink_the_ramp(tmp_path, monkeypatch):
    # `growth: inf` makes `limit()` non-finite; `growth: 0.5` is merely an odd trade,
    # buying lower latency with more seams, and the exponent clamp keeps it off zero.
    import pytest
    monkeypatch.delenv("VOXSTUDIO_CHUNK_GROWTH", raising=False)
    with pytest.raises(SystemExit, match="chunking.growth"):
        load_config(write(tmp_path, "chunking:\n  growth: .nan\n"))
    assert load_config(write(tmp_path, "chunking:\n  growth: 0.5\n")).chunking.growth == 0.5


def test_a_nan_budget_from_the_environment_is_refused_too(tmp_path, monkeypatch):
    import pytest
    monkeypatch.setenv("VOXSTUDIO_CHUNK_MAX_SECONDS", "nan")
    with pytest.raises(SystemExit, match="chunking.max_seconds"):
        load_config(write(tmp_path))


def test_a_stale_env_budget_is_refused_too(tmp_path, monkeypatch):
    # A host that had tuned VOXSTUDIO_CHUNK_MAX_CHARS away from the default would
    # otherwise boot on the default and say nothing.
    import pytest
    for old, new in (("MAX_CHARS", "MAX_SECONDS"),
                     ("FIRST_MAX_CHARS", "FIRST_MAX_SECONDS")):
        monkeypatch.setenv(f"VOXSTUDIO_CHUNK_{old}", "160")
        with pytest.raises(SystemExit, match=f"VOXSTUDIO_CHUNK_{new}"):
            load_config(write(tmp_path))
        monkeypatch.delenv(f"VOXSTUDIO_CHUNK_{old}")
