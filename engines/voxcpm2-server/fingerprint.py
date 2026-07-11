import hashlib


def audio_fingerprint(wav: bytes) -> str:
    """Return the stable SHA-256 fingerprint for generated WAV bytes."""
    return hashlib.sha256(wav).hexdigest()
