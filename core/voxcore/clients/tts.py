"""TTS engine client: `/v1/audio/speech` plus the `/v1/voices` extension."""

from pathlib import Path

from ..config import EngineCfg, TTSDefaults
from ..errors import EngineError
from ..http import build_client, raise_for_status


class TTSClient:
    def __init__(self, cfg: EngineCfg, defaults: TTSDefaults | None = None):
        self.cfg = cfg
        self.defaults = defaults or TTSDefaults()
        self._client = build_client(cfg)

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def speech(self, text: str, voice: str | None = None, *,
               cfg_value: float | None = None, timesteps: int | None = None,
               response_format: str | None = None) -> bytes:
        """Synthesize one chunk. `voice` is `clone`, `design`, or a registered voice id.

        For `design` the caller must have already prefixed `text` with an English
        description in parentheses -- composing that prompt is policy, not transport.
        """
        body = {
            "input": text,
            "model": self.cfg.model,
            "voice": voice or self.defaults.voice,
            "response_format": response_format or self.defaults.response_format,
            "cfg_value": cfg_value if cfg_value is not None else self.defaults.cfg_value,
            "timesteps": timesteps if timesteps is not None else self.defaults.timesteps,
        }
        return raise_for_status(self._client.post("/v1/audio/speech", json=body)).content

    def create_voice(self, voice_id: str, prompt_text: str, audio_path: str | Path) -> dict:
        path = Path(audio_path)
        with path.open("rb") as fh:
            response = self._client.post(
                "/v1/voices",
                data={"id": voice_id, "text": prompt_text},
                files={"audio": (path.name, fh)},
            )
        return raise_for_status(response).json()

    def list_voices(self) -> list[dict]:
        response = self._client.get("/v1/voices")
        if response.status_code == 404:
            # The C++ voxcpm-server build has no list-all route.
            return []
        return raise_for_status(response).json().get("voices", [])

    def get_voice(self, voice_id: str) -> dict:
        return raise_for_status(self._client.get(f"/v1/voices/{voice_id}")).json()

    def delete_voice(self, voice_id: str) -> dict:
        response = raise_for_status(self._client.delete(f"/v1/voices/{voice_id}"))
        return response.json() if response.content else {"id": voice_id, "deleted": True}

    def voice_exists(self, voice_id: str) -> bool:
        try:
            self.get_voice(voice_id)
        except EngineError as exc:
            if exc.status == 404 or exc.code == "voice_not_found":
                return False
            raise
        return True
