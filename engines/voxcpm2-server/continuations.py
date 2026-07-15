"""Bounded in-memory continuation sessions for serial TTS generation."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any


SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,96}$")


@dataclass
class Session:
    cache: dict[str, Any]
    # The anchor every later merge re-attaches to: the pure reference cache (clone), or
    # the first chunk's merged cache (design voices, whose first chunk defines the voice).
    # Without it, each merge stacked onto the previous merge and the session conditioned
    # on ever more of its own synthesized audio — audible as progressive timbre drift on
    # long replies, worst for cloned voices.
    base: dict[str, Any] | None
    updated_at: float


class ContinuationStore:
    def __init__(self, ttl_seconds: float = 900, capacity: int = 8):
        self.ttl_seconds = ttl_seconds
        self.capacity = capacity
        self._sessions: dict[str, Session] = {}

    def prune(self, now: float | None = None) -> int:
        now = time.monotonic() if now is None else now
        expired = [key for key, value in self._sessions.items()
                   if now - value.updated_at > self.ttl_seconds]
        for key in expired:
            del self._sessions[key]
        return len(expired)

    def get(self, session_id: str) -> dict[str, Any] | None:
        return self._sessions.get(session_id).cache if session_id in self._sessions else None

    def get_base(self, session_id: str) -> dict[str, Any] | None:
        return self._sessions.get(session_id).base if session_id in self._sessions else None

    def put(self, session_id: str, cache: dict[str, Any],
            base: dict[str, Any] | None = None, now: float | None = None) -> None:
        if session_id not in self._sessions and len(self._sessions) >= self.capacity:
            oldest = min(self._sessions, key=lambda key: self._sessions[key].updated_at)
            del self._sessions[oldest]
        self._sessions[session_id] = Session(cache, base, time.monotonic() if now is None else now)

    def pop(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def stats(self) -> dict[str, int]:
        return {"active": len(self._sessions), "capacity": self.capacity}
