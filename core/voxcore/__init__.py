"""voxstudio core: engine clients and orchestration behind one OpenAI-compatible contract."""

from .audio import join_chunks, read_wav, trim_edge_silence, write_wav
from .clients.asr import ASRClient, Transcription
from .clients.llm import LLMClient
from .clients.tts import TTSClient
from .config import ChunkCfg, Config, EngineCfg, TTSDefaults, load_config
from .errors import EngineError, normalize_error
from .health import Health, probe
from .synth import stream_long, synthesize_long
from .text import chunk_text, sanitize_for_tts

__version__ = "0.1.0"

__all__ = [
    "ASRClient", "ChunkCfg", "Config", "EngineCfg", "EngineError", "Health",
    "LLMClient", "TTSClient", "TTSDefaults", "Transcription",
    "chunk_text", "join_chunks", "load_config", "normalize_error", "probe",
    "read_wav", "sanitize_for_tts", "stream_long", "synthesize_long", "trim_edge_silence",
    "write_wav",
]
