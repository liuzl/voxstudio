from importlib import metadata

import runtime


def test_model_identity_uses_installed_package_version(monkeypatch):
    monkeypatch.setattr(runtime.metadata, "version", lambda _: "2.0.3.post22+g616d3d3e6")
    assert runtime.model_identity() == "voxcpm@2.0.3.post22+g616d3d3e6"


def test_model_identity_handles_missing_package(monkeypatch):
    def missing(_: str):
        raise metadata.PackageNotFoundError

    monkeypatch.setattr(runtime.metadata, "version", missing)
    assert runtime.model_identity() == "voxcpm@unknown"
