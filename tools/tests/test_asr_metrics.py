"""Pin the shared CER contract both measurement scripts now score with.

The unified rule: normalization is NFKC + casefold with all whitespace and every
Unicode punctuation category removed; an empty normalized reference yields None
(the sample is excluded) rather than the old compare_asr 0/1 convention.
"""

import pytest

from asr_metrics import cer, levenshtein, normalized_text


def test_normalization_strips_any_unicode_punctuation():
    # Not just the CJK/ASCII marks an enumerated regex would list.
    assert normalized_text("«guten – tag» „ja“ ¿qué?") == "gutentagjaqué"


def test_normalization_folds_width_and_case():
    assert normalized_text("Ａ， B！") == "ab"
    assert normalized_text("STRASSE Straße") == "strassestrasse"


def test_empty_reference_is_excluded_not_scored():
    assert cer("", "anything") is None
    assert cer("，。！", "anything") is None  # punctuation-only normalizes to empty


def test_perfect_and_total_error():
    assert cer("你好世界", "你好世界") == 0.0
    assert cer("你好", "完全不同") == pytest.approx(2.0)  # insertions can exceed 1.0


def test_cer_scores_over_normalized_text():
    assert cer("你好，世界！", "你 好 世 界") == 0.0
    assert cer("Hello, World!", "hello world") == 0.0


def test_levenshtein_is_symmetric_in_cost():
    assert levenshtein("abc", "axc") == 1
    assert levenshtein("axc", "abc") == 1
    assert levenshtein("", "abc") == 3
