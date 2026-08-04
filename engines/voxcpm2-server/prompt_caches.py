"""Reusable reference-voice prompt caches.

Building a prompt cache means running the reference audio through the VAE encoder —
seconds of fixed cost, and deterministic for a given reference. Paying it once per voice
instead of once per continuation session removes the dominant fixed latency from every
reply's first audio. Sharing is safe: upstream `generate_with_prompt_cache` only reads the
cache, and `merge_prompt_cache` builds a new dict around concatenated tensors.
"""

from __future__ import annotations

import hashlib
import os
import pickle
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import torch


_DISK_SCHEMA = 1


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
    """LRU of built prompt caches, optionally backed by disposable disk snapshots.

    The reference WAV remains the authoritative portable asset. A disk snapshot is only
    reused when its schema, model namespace, and content-addressed key all match.
    """

    def __init__(self, capacity: int = 16, namespace: str = ""):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self.namespace = namespace
        self._entries: dict[str, _Entry] = {}
        self.hits = 0
        self.misses = 0
        self.disk_hits = 0
        self.builds = 0
        self.write_errors = 0

    def get_or_build(
        self,
        key: str,
        build: Callable[[], dict[str, Any]],
        persist_path: str | Path | None = None,
    ) -> dict[str, Any]:
        entry = self._entries.get(key)
        now = time.monotonic()
        if entry is not None:
            entry.used_at = now
            self.hits += 1
            return entry.cache
        self.misses += 1
        cache = self._load(persist_path, key) if persist_path else None
        if cache is not None:
            self.disk_hits += 1
        else:
            cache = build()
            self.builds += 1
            if persist_path:
                try:
                    self._save(persist_path, key, cache)
                except (OSError, RuntimeError, TypeError, ValueError):
                    # Persistence is an optimization. Keep serving from memory when the
                    # cache directory is read-only, full, or the payload is unsupported.
                    self.write_errors += 1
        if len(self._entries) >= self.capacity:
            oldest = min(self._entries, key=lambda item: self._entries[item].used_at)
            del self._entries[oldest]
        self._entries[key] = _Entry(cache, now)
        return cache

    def stats(self) -> dict[str, int]:
        return {
            "entries": len(self._entries),
            "hits": self.hits,
            "misses": self.misses,
            "disk_hits": self.disk_hits,
            "builds": self.builds,
            "write_errors": self.write_errors,
        }

    def _load(self, path: str | Path, key: str) -> dict[str, Any] | None:
        try:
            envelope = torch.load(Path(path), map_location="cpu", weights_only=True)
            if not isinstance(envelope, dict):
                return None
            if envelope.get("schema") != _DISK_SCHEMA:
                return None
            if envelope.get("namespace") != self.namespace or envelope.get("key") != key:
                return None
            cache = envelope.get("cache")
            return cache if isinstance(cache, dict) else None
        except (EOFError, FileNotFoundError, OSError, RuntimeError, ValueError, TypeError,
                pickle.UnpicklingError):
            # A feature cache is derived data. Corrupt, stale, or incompatible snapshots
            # are rebuilt from the retained WAV instead of making the voice unusable.
            return None

    def _save(self, path: str | Path, key: str, cache: dict[str, Any]) -> None:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
        try:
            torch.save(
                {"schema": _DISK_SCHEMA, "namespace": self.namespace, "key": key, "cache": cache},
                temporary,
            )
            os.chmod(temporary, 0o600)
            os.replace(temporary, destination)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
