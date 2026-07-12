import os
import re
from importlib import metadata


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def model_identity() -> str:
    """Identify the installed upstream package used for generation."""
    try:
        return f"voxcpm@{metadata.version('voxcpm')}"
    except metadata.PackageNotFoundError:
        return "voxcpm@unknown"


def model_manifest_sha256(environment: dict[str, str] | None = None) -> str | None:
    """Read the deployment-pinned SHA-256 for the complete model artifact manifest."""
    value = (environment or os.environ).get("VOXCPM2_MODEL_MANIFEST_SHA256")
    if value is None:
        return None
    if not _SHA256_RE.fullmatch(value):
        raise ValueError("VOXCPM2_MODEL_MANIFEST_SHA256 must be a lowercase SHA-256")
    return value
