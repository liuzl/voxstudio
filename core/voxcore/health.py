"""Engine liveness probing."""

from typing import NamedTuple

import httpx

from .config import EngineCfg


class Health(NamedTuple):
    name: str
    base_url: str
    model: str
    ok: bool
    detail: str


def probe(name: str, cfg: EngineCfg, timeout: float = 5.0) -> Health:
    # Health lives at /health on the PyTorch server and /healthz on the C++ one.
    try:
        response = httpx.get(cfg.base_url.rstrip("/") + cfg.health_path, timeout=timeout)
        ok = response.is_success
        detail = "ok" if ok else f"HTTP {response.status_code}"
    except httpx.HTTPError as exc:
        ok, detail = False, type(exc).__name__
    return Health(name, cfg.base_url, cfg.model, ok, detail)


def first_healthy(candidates: list[EngineCfg], name: str = "engine") -> EngineCfg | None:
    return next((c for c in candidates if probe(name, c).ok), None)
