from voxcore import chunk_text, sanitize_for_tts


def test_breaks_only_after_sentence_enders():
    text = "第一句。第二句。第三句。"
    assert chunk_text(text, max_chars=4) == ["第一句。", "第二句。", "第三句。"]
    # Packing is greedy: fewer chunks means fewer seams to hide.
    assert chunk_text(text, max_chars=8) == ["第一句。第二句。", "第三句。"]


def test_packs_sentences_up_to_the_limit():
    chunks = chunk_text("甲。乙。丙。丁。", max_chars=6)
    assert chunks == ["甲。乙。丙。", "丁。"]
    assert all(len(c) <= 6 for c in chunks)


def test_long_sentence_without_an_ender_is_hard_split():
    chunks = chunk_text("啊" * 25, max_chars=10)
    assert chunks == ["啊" * 10, "啊" * 10, "啊" * 5]


def test_a_pending_chunk_is_flushed_before_a_hard_split():
    chunks = chunk_text("短。" + "长" * 12, max_chars=10)
    assert chunks[0] == "短。"
    assert "".join(chunks) == "短。" + "长" * 12


def test_ascii_enders_and_whitespace_collapse():
    assert chunk_text("Hello world!  Bye?", max_chars=100) == ["Hello world! Bye?"]


def test_empty_text_yields_no_chunks():
    assert chunk_text("   \n ") == []


def test_sanitize_drops_out_of_script_glyphs():
    # The LLM has been seen slipping a Vietnamese glyph into Mandarin output.
    clean, dropped = sanitize_for_tts("我们继续ứ往前")
    assert clean == "我们继续往前"
    assert dropped == ["ứ"]


def test_sanitize_keeps_cjk_ascii_and_punctuation():
    text = '你好，world 2026！“引号”…—·'
    clean, dropped = sanitize_for_tts(text)
    assert clean == text
    assert dropped == []


def test_first_chunk_can_be_capped_shorter_than_the_rest():
    text = "甲。" * 20
    chunks = chunk_text(text, max_chars=10, first_max_chars=4)
    assert len(chunks[0]) == 4
    assert all(len(c) <= 10 for c in chunks[1:])
    assert "".join(chunks) == text


def test_first_chunk_cap_does_not_lose_an_overlong_sentence():
    chunks = chunk_text("啊" * 9, max_chars=10, first_max_chars=4)
    assert chunks == ["啊" * 4, "啊" * 5]


def test_chunking_never_drops_or_reorders_text():
    text = "第一句。" + "长" * 250 + "。收尾。"
    for max_chars, first in ((160, 60), (10, 4), (5, 5), (200, 500)):
        chunks = chunk_text(text, max_chars=max_chars, first_max_chars=first)
        assert "".join(chunks) == text, (max_chars, first)


def test_first_cap_larger_than_max_chars_is_clamped():
    chunks = chunk_text("甲。" * 10, max_chars=4, first_max_chars=60)
    assert all(len(c) <= 4 for c in chunks)


def test_chunks_ramp_up_so_playback_never_outruns_synthesis():
    chunks = chunk_text("甲。" * 200, max_chars=160, first_max_chars=24, growth=2.0)
    sizes = [len(c) for c in chunks]
    assert sizes[0] <= 24
    assert sizes[-1] <= 160
    # Synthesis runs at ~0.37x realtime, so a chunk may be at most ~2.7x its
    # predecessor without the listener catching up to it. Growth is capped at 2.0.
    for prev, nxt in zip(sizes, sizes[1:]):
        assert nxt <= 2.7 * prev, (prev, nxt)
