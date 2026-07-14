"""Reusable reference-voice prompt caches.

Building a prompt cache means running the reference audio through the VAE encoder —
seconds of fixed cost, and deterministic for a given reference. Paying it once per voice
instead of once per continuation session removes the dominant fixed latency from every
reply's first audio. Sharing is safe: upstream `generate_with_prompt_cache` only reads the
cache, and `merge_prompt_cache` builds a new dict around concatenated tensors.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Any, Callable


def file_identity(path: str | None) -> str:
    """Content identity of a reference file. Hashing beats mtime: uploaded clones land in
    fresh temp files every request, and identical bytes must hit the same cache entry."""
    if path is None:
        return "-"
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def prompt_cache_key(ref: str | None, prompt: tuple[str, str] | None) -> str:
    parts = [file_identity(ref)]
    if prompt:
        parts.append(file_identity(prompt[0]))
        parts.append(hashlib.sha256(prompt[1].encode()).hexdigest())
    return ":".join(parts)


@dataclass
class _Entry:
    cache: dict[str, Any]
    used_at: float


class PromptCacheStore:
    """LRU of built prompt caches, keyed by reference content identity."""

    def __init__(self, capacity: int = 16):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self._entries: dict[str, _Entry] = {}
        self.hits = 0
        self.misses = 0

    def get_or_build(self, key: str, build: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        entry = self._entries.get(key)
        now = time.monotonic()
        if entry is not None:
            entry.used_at = now
            self.hits += 1
            return entry.cache
        self.misses += 1
        cache = build()
        if len(self._entries) >= self.capacity:
            oldest = min(self._entries, key=lambda item: self._entries[item].used_at)
            del self._entries[oldest]
        self._entries[key] = _Entry(cache, now)
        return cache

    def stats(self) -> dict[str, int]:
        return {"entries": len(self._entries), "hits": self.hits, "misses": self.misses}
