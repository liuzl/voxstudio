"""Engine errors, normalized across backends.

The two TTS backends disagree on the error envelope. FastAPI wraps whatever the
handler raised in a `detail` key, so voxcpm2-server emits

    {"detail": {"error": {"code": ..., "message": ..., "type": ...}}}

while the C++ voxcpm-server emits the same object without the wrapper. Callers
should not have to know which backend they are pointed at.
"""

import json


class EngineError(Exception):
    def __init__(self, status: int, code: str, message: str, type: str | None = None):
        super().__init__(f"[{status}] {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.type = type


def normalize_error(status: int, body: bytes | str | dict) -> EngineError:
    if isinstance(body, (bytes, str)):
        try:
            body = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            body = {}
    if not isinstance(body, dict):
        body = {}

    err = body.get("detail", body)
    if isinstance(err, dict):
        err = err.get("error", err)
    if not isinstance(err, dict):
        # FastAPI's own validation errors put a string or list in `detail`.
        return EngineError(status, "engine_error", str(err) or f"HTTP {status}")

    return EngineError(
        status,
        err.get("code") or "engine_error",
        err.get("message") or f"HTTP {status}",
        err.get("type"),
    )
