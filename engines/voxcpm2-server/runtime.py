from importlib import metadata


def model_identity() -> str:
    """Identify the installed upstream package used for generation."""
    try:
        return f"voxcpm@{metadata.version('voxcpm')}"
    except metadata.PackageNotFoundError:
        return "voxcpm@unknown"
