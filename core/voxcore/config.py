"""Configuration: YAML file, then `${VAR}` expansion, then flat env overrides."""

import math
import os
import re
from dataclasses import dataclass, field, replace
from pathlib import Path

import yaml

from .text import SENTENCE_ENDERS

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
    max_seconds: float = 15.0        # timbre drifts within a longer single generation
    first_max_seconds: float = 8.0   # enough context to stabilize mixed-language delivery
    growth: float = 2.0              # then ramp up, so playback never outruns synthesis
    sentence_enders: str = SENTENCE_ENDERS
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
    """`VOXSTUDIO_TTS_BASE_URL`, `VOXSTUDIO_LLM_MAX_TOKENS`, `VOXSTUDIO_CHUNK_MAX_SECONDS`, ..."""
    engines = dict(cfg.engines)
    for name, engine in engines.items():
        patch = {}
        for f in ("base_url", "model", "api_key", "health_path", "max_tokens"):
            raw = os.environ.get(f"VOXSTUDIO_{name.upper()}_{f.upper()}")
            if raw is not None:
                patch[f] = int(raw) if f == "max_tokens" else raw
        if patch:
            engines[name] = replace(engine, **patch)

    for old, new in _RENAMED.items():
        if f"VOXSTUDIO_CHUNK_{old.upper()}" in os.environ:
            raise _stale_budget_key(f"VOXSTUDIO_CHUNK_{old.upper()}",
                                    f"VOXSTUDIO_CHUNK_{new.upper()}")

    chunk_patch = {}
    for f, cast in (("max_seconds", float), ("first_max_seconds", float), ("growth", float),
                    ("join_pause_ms", int), ("trim_floor_db", float), ("edge_pad_ms", int),
                    ("sentence_enders", str)):
        raw = os.environ.get(f"VOXSTUDIO_CHUNK_{f.upper()}")
        if raw is not None:
            chunk_patch[f] = cast(raw)

    return replace(cfg, engines=engines,
                   chunking=replace(cfg.chunking, **chunk_patch) if chunk_patch else cfg.chunking)


_RENAMED = {"max_chars": "max_seconds", "first_max_chars": "first_max_seconds"}


def _stale_budget_key(old: str, new: str) -> SystemExit:
    """Refuse a character budget rather than silently reading it as seconds.

    Both spellings of the budget have to refuse it. Dropping a stale *file* key would
    fall back to a 30s default that is at least sane; dropping a stale *env* override
    would do the same, but on the host where someone had deliberately tuned it away
    from the default -- and say nothing.
    """
    return SystemExit(
        f"config: `{old}` was replaced by `{new}`. The budget is now estimated speech "
        f"duration, not characters: ~85 Chinese characters or ~275 English ones fit "
        f"in 15 seconds."
    )


def _validate_chunking(chunking: ChunkCfg) -> ChunkCfg:
    """Reject a budget that cannot bound anything.

    `nan` is the one that matters. Every comparison against it is false, so `chunk_text`
    never finds a chunk too long and hands the engine the whole document in one
    generation -- silently, and precisely the drift this budget exists to prevent. YAML
    spells it `.nan` and the environment spells it `nan`; both reach `float()` intact.

    A non-positive budget is merely absurd rather than dangerous -- one character per
    chunk, slow and obvious -- but it is always a mistake, and failing at load beats
    failing ten minutes into a long file. `inf` is left alone on `growth`, where it just
    pins the ramp to `max_seconds`, but not on the budgets themselves.
    """
    for field_name in ("max_seconds", "first_max_seconds"):
        value = getattr(chunking, field_name)
        if not math.isfinite(value) or value <= 0:
            raise SystemExit(
                f"config: `chunking.{field_name}` must be a positive number of seconds, "
                f"not {value!r}. A budget that compares false against everything (`nan`) "
                f"or bounds nothing (`inf`, 0) would send the whole document to the "
                f"engine as one generation."
            )
    if not math.isfinite(chunking.growth):
        raise SystemExit(
            f"config: `chunking.growth` must be finite, not {chunking.growth!r}."
        )
    return chunking


def _migrate_chunking(raw: dict) -> dict:
    """`max_chars: 160` read as `max_seconds: 160` is two minutes in one generation."""
    for old, new in _RENAMED.items():
        if old in raw:
            raise _stale_budget_key(f"chunking.{old}", f"chunking.{new}")
    return raw


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

    cfg = _env_overrides(Config(
        engines=engines,
        tts_defaults=TTSDefaults(**(raw.get("tts_defaults") or {})),
        chunking=ChunkCfg(**_migrate_chunking(raw.get("chunking") or {})),
    ))
    # After the env overrides, so neither source of a budget can slip past.
    _validate_chunking(cfg.chunking)
    return cfg
