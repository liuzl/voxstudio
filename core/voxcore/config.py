"""Configuration: YAML file, then `${VAR}` expansion, then flat env overrides."""

import os
import re
from dataclasses import dataclass, field, replace
from pathlib import Path

import yaml

SEARCH_PATHS = (
    Path("voxstudio.yaml"),
    Path.home() / ".config" / "voxstudio" / "config.yaml",
)


@dataclass(frozen=True)
class EngineCfg:
    base_url: str
    model: str = ""
    api_key: str = ""
    health_path: str = "/health"
    max_tokens: int = 4096


@dataclass(frozen=True)
class TTSDefaults:
    voice: str = "clone"
    cfg_value: float = 2.0
    timesteps: int = 10
    response_format: str = "wav"


@dataclass(frozen=True)
class ChunkCfg:
    max_chars: int = 160
    first_max_chars: int = 24   # streamed audio starts only once chunk 1 exists
    growth: float = 2.0         # then ramp up, so playback never outruns synthesis
    sentence_enders: str = "。！？；!?;"
    join_pause_ms: int = 210     # gap the listener perceives, matched to the model's own
    trim_floor_db: float = 25.0  # gate this far below speech level, not below peak
    edge_pad_ms: int = 40        # keep this much sub-gate audio: it holds the consonants


@dataclass(frozen=True)
class Config:
    engines: dict[str, EngineCfg] = field(default_factory=dict)
    tts_defaults: TTSDefaults = field(default_factory=TTSDefaults)
    chunking: ChunkCfg = field(default_factory=ChunkCfg)

    def engine(self, name: str) -> EngineCfg:
        try:
            return self.engines[name]
        except KeyError:
            raise SystemExit(f"no `engines.{name}` in config; see config.example.yaml") from None


DEFAULT_ENGINES = {
    "tts": EngineCfg(base_url="http://127.0.0.1:8880", model="voxcpm2"),
    "asr": EngineCfg(base_url="http://127.0.0.1:18086", model="nemotron-asr"),
    "llm": EngineCfg(base_url="http://127.0.0.1:8080", model="gemma"),
}


_UNRESOLVED = re.compile(r"\$\{[^}]*\}")


def _expand(value):
    if isinstance(value, str):
        # An unset ${VAR} means "not configured", not a literal.
        return _UNRESOLVED.sub("", os.path.expandvars(value))
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    return value


def _find_config(explicit: str | None) -> Path | None:
    if explicit:
        return Path(explicit)
    if env := os.environ.get("VOXSTUDIO_CONFIG"):
        return Path(env)
    return next((p for p in SEARCH_PATHS if p.exists()), None)


def _env_overrides(cfg: Config) -> Config:
    """`VOXSTUDIO_TTS_BASE_URL`, `VOXSTUDIO_LLM_MAX_TOKENS`, `VOXSTUDIO_CHUNK_MAX_CHARS`, ..."""
    engines = dict(cfg.engines)
    for name, engine in engines.items():
        patch = {}
        for f in ("base_url", "model", "api_key", "health_path", "max_tokens"):
            raw = os.environ.get(f"VOXSTUDIO_{name.upper()}_{f.upper()}")
            if raw is not None:
                patch[f] = int(raw) if f == "max_tokens" else raw
        if patch:
            engines[name] = replace(engine, **patch)

    chunk_patch = {}
    for f, cast in (("max_chars", int), ("first_max_chars", int), ("growth", float),
                    ("join_pause_ms", int), ("trim_floor_db", float), ("edge_pad_ms", int),
                    ("sentence_enders", str)):
        raw = os.environ.get(f"VOXSTUDIO_CHUNK_{f.upper()}")
        if raw is not None:
            chunk_patch[f] = cast(raw)

    return replace(cfg, engines=engines,
                   chunking=replace(cfg.chunking, **chunk_patch) if chunk_patch else cfg.chunking)


def load_config(path: str | None = None) -> Config:
    raw = {}
    if found := _find_config(path):
        if not found.exists():
            raise SystemExit(f"config not found: {found}")
        raw = _expand(yaml.safe_load(found.read_text(encoding="utf-8")) or {})

    engines = dict(DEFAULT_ENGINES)
    for name, values in (raw.get("engines") or {}).items():
        base = engines.get(name)
        engines[name] = replace(base, **values) if base else EngineCfg(**values)

    return _env_overrides(Config(
        engines=engines,
        tts_defaults=TTSDefaults(**(raw.get("tts_defaults") or {})),
        chunking=ChunkCfg(**(raw.get("chunking") or {})),
    ))
