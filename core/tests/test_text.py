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
