"""Shared httpx plumbing."""

import httpx

from .config import EngineCfg
from .errors import normalize_error


def build_client(cfg: EngineCfg, timeout: float = 600.0) -> httpx.Client:
    # Generous default: a chunk of speech can take seconds, and the GPU serializes.
    headers = {"Authorization": f"Bearer {cfg.api_key}"} if cfg.api_key else {}
    return httpx.Client(base_url=cfg.base_url.rstrip("/"), headers=headers, timeout=timeout)


def raise_for_status(response: httpx.Response) -> httpx.Response:
    if response.is_success:
        return response
    raise normalize_error(response.status_code, response.content)
