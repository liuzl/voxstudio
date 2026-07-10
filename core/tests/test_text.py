from voxcore import chunk_text, est_seconds, sanitize_for_tts

# Chunking is budgeted in seconds, so the tests express their caps in seconds too --
# via `est_seconds` of the text they expect to fit, rather than a magic float.
ZH = "第一句。第二句。第三句。"
EN = "Speech synthesis has improved. Voices sound natural now. Anyone can use them."
TH = "พรุ่งนี้บ่ายเรามาเจอกัน ถ้ามีธุระด่วนช่วยบอกล่วงหน้า เราเลื่อนไปตอนเย็นก็ได้"


def test_breaks_only_after_sentence_enders():
    assert chunk_text(ZH, est_seconds("第一句。")) == ["第一句。", "第二句。", "第三句。"]
    # Packing is greedy: fewer chunks means fewer seams to hide.
    assert chunk_text(ZH, est_seconds("第一句。第二句。")) == ["第一句。第二句。", "第三句。"]


def test_packs_sentences_up_to_the_limit():
    cap = est_seconds("甲。乙。丙。")
    chunks = chunk_text("甲。乙。丙。丁。", cap)
    assert chunks == ["甲。乙。丙。", "丁。"]
    assert all(est_seconds(c) <= cap for c in chunks)


def test_the_budget_is_duration_not_characters():
    # The whole point of the rewrite: the same cap admits very different character counts.
    cap = 30.0
    zh = chunk_text("啊" * 400, cap)[0]
    en = chunk_text("a " * 400, cap)[0]
    assert 150 <= len(zh) <= 175, len(zh)
    assert len(en) > 3 * len(zh), (len(en), len(zh))
    assert est_seconds(zh) <= cap and est_seconds(en) <= cap


def test_est_seconds_matches_the_measured_rates():
    # 5.7 chars/s for Han, 18.3 for Latin -- the constants the engine was measured at.
    assert abs(est_seconds("啊" * 171) - 30.0) < 0.5
    assert abs(est_seconds("a" * 549) - 30.0) < 0.5


def test_long_sentence_without_an_ender_is_hard_split():
    # No spaces and no clause marks: Chinese has to be cut mid-phrase.
    cap = est_seconds("啊" * 10)
    chunks = chunk_text("啊" * 25, cap)
    assert chunks == ["啊" * 10, "啊" * 10, "啊" * 5]


def test_an_oversized_latin_sentence_breaks_at_word_boundaries():
    text = "the quick brown fox jumps over the lazy dog and keeps running well past dusk"
    words = set(text.split())
    chunks = chunk_text(text, est_seconds("the quick brown fox"))
    assert len(chunks) > 1
    assert "".join(chunks) == text
    for chunk in chunks:
        assert all(word in words for word in chunk.split()), chunk


def test_an_oversized_thai_sentence_breaks_at_spaces():
    # Thai writes no sentence-ending mark: the spaces are the only break points there are.
    chunks = chunk_text(TH, est_seconds("พรุ่งนี้บ่ายเรามาเจอกัน"))
    assert len(chunks) > 1
    assert "".join(chunks) == TH
    assert all(not c.strip().startswith(("ถ้", "เร")) or c.startswith(" ") for c in chunks)


def test_a_pending_chunk_is_flushed_before_a_hard_split():
    text = "短。" + "长" * 12
    chunks = chunk_text(text, est_seconds("啊" * 10))
    assert chunks[0] == "短。"
    assert "".join(chunks) == text


def test_a_period_is_not_a_sentence_ender_inside_decimals_or_names():
    text = "Pi is 3.14 exactly. Dr. Chen agrees."
    chunks = chunk_text(text, est_seconds("Pi is 3.14 exactly."))
    assert chunks == ["Pi is 3.14 exactly.", " Dr. Chen agrees."]


def test_an_acronym_does_not_end_a_sentence():
    text = "She works at the U.S. mission today."
    assert chunk_text(text, 60.0) == [text]


def test_ascii_enders_and_whitespace_collapse():
    assert chunk_text("Hello world!  Bye?", 60.0) == ["Hello world! Bye?"]


def test_empty_text_yields_no_chunks():
    assert chunk_text("   \n ") == []


def test_sanitize_keeps_every_script_the_engine_speaks():
    # VoxCPM2 speaks 30 languages. A filter that knows only CJK and ASCII would eat these.
    for text in ("Chúng ta gặp nhau", "Давайте встретимся", "لنلتق غدا",
                 "चलो कल मिलते हैं", "만나기로 해요", "Grüße aus München", "Ας συναντηθούμε"):
        clean, dropped = sanitize_for_tts(text)
        assert clean == text and dropped == []


def test_sanitize_keeps_cjk_ascii_and_punctuation():
    text = '你好，world 2026！“引号”…—·'
    clean, dropped = sanitize_for_tts(text)
    assert clean == text
    assert dropped == []


def test_sanitize_drops_what_cannot_be_spoken():
    clean, dropped = sanitize_for_tts("好👍的\x00话")
    assert clean == "好的话"
    assert dropped == ["👍", "\x00"]


def test_sanitize_drops_an_emoji_presentation_selector():
    # U+2602 is a symbol, U+FE0F a format character. Neither has a pronunciation.
    clean, dropped = sanitize_for_tts("下雨☂️了")
    assert clean == "下雨了"
    assert len(dropped) == 2


def test_sanitize_keeps_newlines_so_words_do_not_weld_together():
    clean, _ = sanitize_for_tts("hello\nworld")
    assert clean == "hello\nworld"


def test_sanitize_keeps_a_joiner_between_letters_but_not_between_emoji():
    devanagari = "क्‍ष"          # ZWJ is orthography here
    clean, dropped = sanitize_for_tts(devanagari)
    assert clean == devanagari and dropped == []

    clean, dropped = sanitize_for_tts("👨‍👩")   # ZWJ only glues two dropped emoji
    assert clean == ""
    assert "‍" in dropped


def test_first_chunk_can_be_capped_shorter_than_the_rest():
    text = "甲。" * 20
    cap, first = est_seconds("甲。" * 5), est_seconds("甲。" * 2)
    chunks = chunk_text(text, cap, first_max_seconds=first)
    assert est_seconds(chunks[0]) <= first
    assert all(est_seconds(c) <= cap for c in chunks[1:])
    assert "".join(chunks) == text


def test_first_chunk_cap_does_not_lose_an_overlong_sentence():
    chunks = chunk_text("啊" * 9, est_seconds("啊" * 10),
                        first_max_seconds=est_seconds("啊" * 4))
    assert chunks == ["啊" * 4, "啊" * 5]


def test_chunking_never_drops_or_reorders_text():
    for text in ("第一句。" + "长" * 250 + "。收尾。", EN * 4, TH * 3,
                 "Mixed 中英 text。With English. And 中文句子。"):
        for cap, first in ((30.0, 4.5), (2.0, 0.8), (1.0, 1.0), (40.0, 90.0)):
            chunks = chunk_text(text, cap, first_max_seconds=first)
            assert "".join(chunks) == " ".join(text.split()), (text[:20], cap, first)


def test_first_cap_larger_than_max_seconds_is_clamped():
    cap = est_seconds("甲。")
    chunks = chunk_text("甲。" * 10, cap, first_max_seconds=60.0)
    assert all(est_seconds(c) <= cap for c in chunks)


def test_a_sentence_splits_the_same_wherever_it_sits_in_the_document():
    # Spans are `prefix[b] - prefix[a]`, which drops the low bits of a float. Without
    # slack, a sentence that exactly fills its budget would fit near the top of a
    # document and overflow it further down, by one ULP of accumulated rounding.
    cap = est_seconds("第一句。")
    for count in range(2, 40):
        chunks = chunk_text("第一句。" * count, cap)
        assert chunks == ["第一句。"] * count, count


def test_every_character_is_priced_exactly_once():
    # `vox say -f` takes a file of any size. Re-pricing the shrinking tail on every cut
    # made a 100k-character document with no sentence enders take 45s of CPU before the
    # first TTS request. Counting the passes pins that down without timing anything.
    from voxcore import text as textmod

    calls = []
    original = textmod._char_seconds
    textmod._char_seconds = lambda s: (calls.append(len(s)), original(s))[1]
    try:
        chunks = textmod.chunk_text("啊" * 20_000, 30.0, first_max_seconds=4.5)
    finally:
        textmod._char_seconds = original

    assert len(chunks) > 100          # plenty of cuts, none of which re-priced anything
    assert calls == [20_000]


def test_a_thousand_chunks_ramp_without_arithmetic_trouble():
    chunks = chunk_text("啊" * 5_000, 0.5, first_max_seconds=0.5)
    assert len(chunks) > 1_024
    assert "".join(chunks) == "啊" * 5_000


def test_leading_punctuation_is_priced_by_the_script_that_resolves_it():
    # A lone danda carries no script. Priced on its own it would take the slow
    # unknown-script rate; the Devanagari that follows is what settles it.
    text = "।इआ।इ। ।अआ"
    assert est_seconds(text) < 10 / 14.0        # not 10 chars at the 5.1 cps fallback
    assert chunk_text(text, 2.0, first_max_seconds=0.8) == [text]


def test_chunks_ramp_up_so_playback_never_outruns_synthesis():
    chunks = chunk_text("甲。" * 200, 30.0, first_max_seconds=4.5, growth=2.0)
    spans = [est_seconds(c) for c in chunks]
    assert spans[0] <= 4.5
    assert spans[-1] <= 30.0
    # Synthesis runs at ~0.37x realtime, so a chunk may be at most ~2.7x its
    # predecessor without the listener catching up to it. Growth is capped at 2.0.
    for prev, nxt in zip(spans, spans[1:]):
        assert nxt <= 2.7 * prev, (prev, nxt)


def test_a_chunk_cut_short_by_a_sentence_end_still_bounds_the_next_one():
    # The ramp used to be `first_cap * growth ** index`, which asks how many chunks have
    # been emitted rather than how long the last one was. Here the second chunk ends after
    # one short sentence -- the third sentence does not fit beside it -- and the third
    # chunk was then handed the full index-based cap, arriving four times its predecessor.
    # By then the listener is still playing 2.6 seconds of audio against 3.5 of synthesis.
    text = "甲" * 20 + "。" + "乙" * 15 + "。" + "丙" * 55 + "。" + "丁" * 55 + "。"
    spans = [est_seconds(c) for c in chunk_text(text, 30.0, first_max_seconds=4.5, growth=2.0)]

    assert spans[1] < 3.0                      # the short chunk that used to license a huge one
    for prev, nxt in zip(spans, spans[1:]):
        assert nxt <= 2.0 * prev * (1 + 1e-9), (prev, nxt)
