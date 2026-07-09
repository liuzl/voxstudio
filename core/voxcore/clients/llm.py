"""LLM engine client: `/v1/chat/completions`."""

from ..config import EngineCfg
from ..http import build_client, raise_for_status


def extract_content(payload: dict) -> str:
    """Take `content`, never `reasoning_content`.

    Gemma puts its chain of thought in `reasoning_content`. That field is not the
    answer, and a `max_tokens` small enough to truncate it leaves `content` empty --
    which is why the default budget below is deliberately large.
    """
    choices = payload.get("choices") or []
    if not choices:
        return ""
    return (choices[0].get("message") or {}).get("content") or ""


class LLMClient:
    def __init__(self, cfg: EngineCfg):
        self.cfg = cfg
        self._client = build_client(cfg)

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def chat(self, messages: list[dict], *, max_tokens: int | None = None,
             temperature: float | None = None) -> str:
        body = {
            "model": self.cfg.model,
            "messages": messages,
            "max_tokens": max_tokens or self.cfg.max_tokens,
        }
        if temperature is not None:
            body["temperature"] = temperature
        return extract_content(raise_for_status(self._client.post("/v1/chat/completions", json=body)).json())
