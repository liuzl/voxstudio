from pathlib import Path

from prompt_caches import PromptCacheStore, file_identity, prompt_cache_key


def test_file_identity_is_content_addressed(tmp_path: Path):
    first = tmp_path / "a.wav"
    second = tmp_path / "b.wav"
    first.write_bytes(b"same bytes")
    second.write_bytes(b"same bytes")
    # Uploaded clones land in fresh temp files every request; identical audio must
    # collapse onto one cache entry regardless of path.
    assert file_identity(str(first)) == file_identity(str(second))
    second.write_bytes(b"other bytes")
    assert file_identity(str(first)) != file_identity(str(second))
    assert file_identity(None) == "-"


def test_prompt_cache_key_distinguishes_prompt_text(tmp_path: Path):
    wav = tmp_path / "ref.wav"
    wav.write_bytes(b"audio")
    with_text = prompt_cache_key(str(wav), (str(wav), "文本甲"))
    other_text = prompt_cache_key(str(wav), (str(wav), "文本乙"))
    ref_only = prompt_cache_key(str(wav), None)
    assert len({with_text, other_text, ref_only}) == 3


def test_store_builds_once_per_key_and_reports_stats():
    store = PromptCacheStore(capacity=2)
    built = []

    def build(name):
        def inner():
            built.append(name)
            return {"prompt_text": name, "audio_feat": None}
        return inner

    first = store.get_or_build("k1", build("k1"))
    again = store.get_or_build("k1", build("k1"))
    assert first is again
    assert built == ["k1"]
    assert store.stats() == {"entries": 1, "hits": 1, "misses": 1}


def test_store_evicts_least_recently_used():
    store = PromptCacheStore(capacity=2)
    store.get_or_build("a", lambda: {"v": "a"})
    store.get_or_build("b", lambda: {"v": "b"})
    store.get_or_build("a", lambda: {"v": "a"})     # refresh a
    store.get_or_build("c", lambda: {"v": "c"})     # evicts b
    rebuilt = []
    store.get_or_build("b", lambda: rebuilt.append("b") or {"v": "b"})
    assert rebuilt == ["b"]
