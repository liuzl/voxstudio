"""The calibration kit behind the measurement scripts in this directory.

Production lives in TypeScript (`packages/text`, `packages/audio`). The scripts here are
Python because their instruments are (numpy, soundfile, speechbrain), so this module keeps
a minimal mirror of exactly what they measure against:

  - `est_seconds` / `chunk_text` mirror `estSeconds` / `chunkText` in
    `packages/text/src/index.ts`. Both consume the same `fixtures/text/` cases --
    `tools/tests/test_voxkit.py` pins this mirror to them, so a drift fails in CI.
  - `read_wav` / `trim_edge_silence` mirror `packages/audio`'s trim semantics; duration
    measured here means the same thing the joiner will act on.
  - `CPS` is the table `measure_speech_rates.py` fits. `est_seconds(text, rates=...)`
    prices under a candidate table, which is how a fit validates itself before you paste
    it into `packages/text/src/index.ts`.

Config and transport are the few dozen lines the scripts actually need: `voxstudio.yaml`
(`engines.tts` + `tts_defaults`), `${VAR}` expansion, `VOXSTUDIO_TTS_*` overrides, and a
blocking `/v1/audio/speech` client.
"""

from __future__ import annotations

import io
import os
import re
import unicodedata
from bisect import bisect_right
from dataclasses import dataclass
from itertools import accumulate
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf
import yaml

# --- text: mirrors packages/text/src/index.ts ---------------------------------------

SENTENCE_ENDERS = (
    "。！？；"      # CJK
    "!?;."         # Latin (and Greek `;` = question mark)
    ";"       # GREEK QUESTION MARK, the non-ASCII spelling of the same
    "।॥"           # Devanagari danda, double danda
    "؟۔"           # Arabic question mark, Urdu full stop
    "។៕"           # Khmer khan, bariyoosan
    "။"            # Myanmar section mark
)

_CLAUSE_BREAKS = "，、,：:；;—–…،؛၊"
_CLOSERS = "\"'”’)）」』】》»"
_ABBREVIATIONS = frozenset(
    "mr mrs ms dr prof st vs etc fig no vol jr sr approx cf al".split()
)

# Speech rate per script, chars/sec. Fitted by `measure_speech_rates.py` against the live
# engine; only the first significant figure is real. The production copy of this table is
# `charsPerSecond` in packages/text/src/index.ts -- keep them identical.
CPS = {
    "Latin": 18.3,
    "Greek": 16.4,
    "Cyrillic": 16.1,
    "Myanmar": 15.2,
    "Lao": 14.6,
    "Devanagari": 14.4,
    "Thai": 14.0,
    "Khmer": 13.6,
    "Hebrew": 12.5,
    "Arabic": 11.0,
    "Hangul": 7.9,
    "Kana": 6.3,
    "Han": 5.7,
}

_SCRIPT_RANGES = (
    ("Han", ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x2FA1F))),
    ("Kana", ((0x3040, 0x30FF), (0x31F0, 0x31FF), (0xFF66, 0xFF9D))),
    ("Hangul", ((0x1100, 0x11FF), (0x3130, 0x318F), (0xA960, 0xA97F), (0xAC00, 0xD7FF))),
    ("Latin", ((0x0041, 0x024F), (0x1E00, 0x1EFF), (0x2C60, 0x2C7F), (0xA720, 0xA7FF),
               (0xFF21, 0xFF3A), (0xFF41, 0xFF5A))),
    ("Cyrillic", ((0x0400, 0x052F), (0x2DE0, 0x2DFF), (0xA640, 0xA69F))),
    ("Greek", ((0x0370, 0x03FF), (0x1F00, 0x1FFF))),
    ("Arabic", ((0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF),
                (0xFB50, 0xFDFF), (0xFE70, 0xFEFF))),
    ("Hebrew", ((0x0590, 0x05FF), (0xFB1D, 0xFB4F))),
    ("Devanagari", ((0x0900, 0x097F), (0xA8E0, 0xA8FF))),
    ("Thai", ((0x0E00, 0x0E7F),)),
    ("Lao", ((0x0E80, 0x0EFF),)),
    ("Khmer", ((0x1780, 0x17FF), (0x19E0, 0x19FF))),
    ("Myanmar", ((0x1000, 0x109F), (0xA9E0, 0xA9FF), (0xAA60, 0xAA7F))),
)


def script_of(ch: str) -> str | None:
    """The script a character is spoken in, or None if it inherits the running one."""
    category = unicodedata.category(ch)
    if category[0] not in "LM":
        return None
    codepoint = ord(ch)
    for name, spans in _SCRIPT_RANGES:
        if any(lo <= codepoint <= hi for lo, hi in spans):
            return name
    return None if category[0] == "M" else "Other"


def _char_seconds(text: str, rates: dict[str, float] | None = None) -> list[float]:
    """Per-character duration estimate, with inherited characters resolved.

    A character with no script of its own is charged at the rate of the script that
    precedes it; leading ones at the rate of the first script that turns up.
    """
    cps = rates if rates is not None else CPS
    default = min(cps.values())
    seconds = [0.0] * len(text)
    unresolved: list[int] = []
    current: str | None = None

    for i, ch in enumerate(text):
        script = script_of(ch)
        if script is None:
            if current is None:
                unresolved.append(i)
            else:
                seconds[i] = 1 / cps.get(current, default)
            continue
        rate = cps.get(script, default)
        for j in unresolved:
            seconds[j] = 1 / rate
        unresolved.clear()
        current = script
        seconds[i] = 1 / rate

    for j in unresolved:  # text with no letters at all
        seconds[j] = 1 / default
    return seconds


def est_seconds(text: str, rates: dict[str, float] | None = None) -> float:
    """Estimated speech duration in seconds, optionally under a candidate rate table."""
    return sum(_char_seconds(" ".join(text.split()), rates))


_SPAN_TOLERANCE = 1e-9


def _exceeds(span: float, cap: float) -> bool:
    return span > cap * (1 + _SPAN_TOLERANCE)


def _period_ends_sentence(text: str, i: int) -> bool:
    """Whether the `.` at `i` closes a sentence, rather than a decimal or an initial."""
    nxt = text[i + 1] if i + 1 < len(text) else ""
    if nxt.isdigit() or nxt == ".":
        return False  # 3.14, or a dot of an ellipsis that is not its last
    if nxt and not nxt.isspace() and nxt not in _CLOSERS:
        return False  # example.com

    j = i - 1
    while j >= 0 and (text[j].isalnum() or text[j] == "."):
        j -= 1
    token = text[j + 1: i]
    if "." in token:
        return False  # an acronym: U.S., e.g.
    if len(token) == 1 and token.isalpha():
        return False  # an initial: J. Smith
    return token.lower() not in _ABBREVIATIONS


def _sentence_bounds(text: str, enders: str) -> list[tuple[int, int]]:
    bounds: list[tuple[int, int]] = []
    start = 0
    for i, ch in enumerate(text):
        if ch not in enders:
            continue
        if ch == "." and not _period_ends_sentence(text, i):
            continue
        end = i + 1
        while end < len(text) and text[end] in _CLOSERS:
            end += 1
        bounds.append((start, end))
        start = end
    if start < len(text):
        bounds.append((start, len(text)))
    return bounds


_JOINERS = ("‌", "‍")  # ZWNJ, ZWJ


def _safe_cut(text: str, pos: int, i: int) -> int:
    while pos < i < len(text) and (unicodedata.category(text[i])[0] == "M"
                                   or text[i - 1] in _JOINERS):
        i -= 1
    return max(pos + 1, i)


def _break_index(text: str, pos: int, hi: int) -> int:
    floor = pos + max(1, (hi - pos) // 2)
    for i in range(hi, floor, -1):
        if text[i - 1] in _CLAUSE_BREAKS:
            return i
    for i in range(hi, floor, -1):
        if text[i - 1].isspace():
            return i - 1  # leave the space to the tail, as sentence splitting does
    return _safe_cut(text, pos, hi)


def _cut_index(text: str, prefix: list[float], pos: int, end: int, cap: float) -> int:
    hi = bisect_right(prefix, prefix[pos] + cap * (1 + _SPAN_TOLERANCE), pos, end + 1) - 1
    hi = min(max(hi, pos + 1), end)
    if hi >= end:
        return end
    return _break_index(text, pos, hi)


def chunk_text(text: str, max_seconds: float = 15.0, enders: str = SENTENCE_ENDERS,
               first_max_seconds: float | None = None, growth: float = 2.0) -> list[str]:
    """Split into chunks of at most `max_seconds` of estimated speech.

    Mirror of `chunkText` in packages/text/src/index.ts; see that file and
    `docs/chunking.md` for the reasoning behind the budget, the ramp, and the cuts.
    """
    text = " ".join(text.split())
    if not text:
        return []

    prefix = list(accumulate(_char_seconds(text), initial=0.0))

    def span(a: int, b: int) -> float:
        return prefix[b] - prefix[a]

    first_cap = min(first_max_seconds, max_seconds) if first_max_seconds else max_seconds

    chunks: list[str] = []
    start: int | None = None   # where the chunk being packed began, if one is open
    previous = 0.0             # duration of the last chunk emitted, not of its cap

    def emit(a: int, b: int) -> None:
        nonlocal previous
        chunks.append(text[a:b])
        previous = span(a, b)

    def limit() -> float:
        if not chunks:
            return first_cap
        return min(max_seconds, growth * previous)

    for sentence_start, sentence_end in _sentence_bounds(text, enders):
        pos = sentence_start
        while pos < sentence_end:
            if start is not None:
                if not _exceeds(span(start, sentence_end), limit()):
                    break            # the sentence rides along in the open chunk
                emit(start, pos)     # close it; `pos` is this sentence's first character
                start = None
                continue
            if not _exceeds(span(pos, sentence_end), limit()):
                start = pos          # open a chunk on a sentence that fits alone
                break
            cut = _cut_index(text, prefix, pos, sentence_end, limit())
            emit(pos, cut)           # a sentence too long for a whole chunk: break it up
            pos = cut
    if start is not None:
        emit(start, len(text))
    return chunks


# --- audio: mirrors packages/audio's trim semantics ----------------------------------

FRAME_MS = 10


def read_wav(data: bytes) -> tuple[np.ndarray, int]:
    samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return samples, rate


def _frame_db(samples: np.ndarray, rate: int) -> np.ndarray:
    frame = max(1, int(rate * FRAME_MS / 1000))
    n = len(samples) // frame
    if n == 0:
        return np.empty(0)
    frames = samples[: n * frame].reshape(n, frame)
    return 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-12)


def speech_level_db(samples: np.ndarray, rate: int) -> float:
    """A robust level for the speech itself, ignoring pauses."""
    db = _frame_db(samples, rate)
    if not db.size:
        return -120.0
    if db.max() <= -119:
        return -120.0
    voiced = db[db > db.max() - 40]
    return float(np.percentile(voiced, 60)) if voiced.size else -120.0


def trim_edge_silence(samples: np.ndarray, rate: int, floor_below_speech_db: float = 25.0,
                      pad_ms: int = 40) -> np.ndarray:
    """Trim leading and trailing audio quieter than `floor_below_speech_db` under speech.

    `pad_ms` of sub-gate audio is kept on each side: unvoiced consonants carry almost no
    energy but decide which syllable a listener hears.
    """
    db = _frame_db(samples, rate)
    if not db.size:
        return samples[:0]
    level = speech_level_db(samples, rate)
    if level <= -119:
        return samples[:0]
    voiced = np.flatnonzero(db > level - floor_below_speech_db)
    if voiced.size == 0:
        return samples[:0]
    frame = max(1, int(rate * FRAME_MS / 1000))
    pad = int(rate * pad_ms / 1000)
    start = max(0, voiced[0] * frame - pad)
    end = min(len(samples), (voiced[-1] + 1) * frame + pad)
    return samples[start:end]


# --- config + transport: just enough to reach the TTS engine -------------------------

_SEARCH_PATHS = (
    Path("voxstudio.yaml"),
    Path.home() / ".config" / "voxstudio" / "config.yaml",
)

_UNRESOLVED = re.compile(r"\$\{[^}]*\}")


@dataclass(frozen=True)
class TtsEngine:
    base_url: str = "http://127.0.0.1:8880"
    model: str = "voxcpm2"
    api_key: str = ""
    voice: str = "clone"
    cfg_value: float = 2.0
    timesteps: int = 10


def _expand(value):
    if isinstance(value, str):
        # An unset ${VAR} means "not configured", not a literal.
        return _UNRESOLVED.sub("", os.path.expandvars(value))
    if isinstance(value, dict):
        return {k: _expand(v) for k, v in value.items()}
    return value


def load_tts_engine(path: str | None = None) -> TtsEngine:
    found = Path(path) if path else (
        Path(env) if (env := os.environ.get("VOXSTUDIO_CONFIG"))
        else next((p for p in _SEARCH_PATHS if p.exists()), None))
    raw = {}
    if found:
        if not found.exists():
            raise SystemExit(f"config not found: {found}")
        raw = _expand(yaml.safe_load(found.read_text(encoding="utf-8")) or {})

    engine = raw.get("engines", {}).get("tts") or {}
    defaults = raw.get("tts_defaults") or {}
    fields = {
        "base_url": engine.get("base_url"),
        "model": engine.get("model"),
        "api_key": engine.get("api_key"),
        "voice": defaults.get("voice"),
        "cfg_value": defaults.get("cfg_value"),
        "timesteps": defaults.get("timesteps"),
    }
    for key in ("base_url", "model", "api_key"):
        if (override := os.environ.get(f"VOXSTUDIO_TTS_{key.upper()}")) is not None:
            fields[key] = override
    return TtsEngine(**{k: v for k, v in fields.items() if v is not None})


class TtsClient:
    """Blocking `/v1/audio/speech` client. Generous timeout: the GPU serializes."""

    def __init__(self, engine: TtsEngine | None = None, timeout: float = 600.0):
        self.engine = engine or load_tts_engine()
        headers = {"Authorization": f"Bearer {self.engine.api_key}"} if self.engine.api_key else {}
        self._client = httpx.Client(base_url=self.engine.base_url.rstrip("/"),
                                    headers=headers, timeout=timeout)

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def speech(self, text: str, voice: str | None = None) -> bytes:
        response = self._client.post("/v1/audio/speech", json={
            "input": text,
            "model": self.engine.model,
            "voice": voice or self.engine.voice,
            "response_format": "wav",
            "cfg_value": self.engine.cfg_value,
            "timesteps": self.engine.timesteps,
        })
        if not response.is_success:
            raise RuntimeError(f"TTS HTTP {response.status_code}: {response.text[:200]}")
        return response.content
