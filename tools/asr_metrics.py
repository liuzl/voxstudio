"""Shared ASR scoring: one text normalization, one CER.

`compare_asr.py` and `benchmark_longform_asr.py` once carried separate normalizations
(an enumerated punctuation regex vs. NFKC + Unicode categories), so the same audio could
score a different CER depending on which script measured it. One implementation, imported
by both, keeps every CER in this repo comparable.
"""

from __future__ import annotations

import unicodedata


def normalized_text(value: str) -> str:
    """NFKC text with whitespace and punctuation removed for Chinese-friendly CER."""
    return "".join(
        char.casefold()
        for char in unicodedata.normalize("NFKC", value)
        if not char.isspace() and not unicodedata.category(char).startswith("P")
    )


def levenshtein(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
    row = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, 1):
        next_row = [left_index]
        for right_index, right_char in enumerate(right, 1):
            next_row.append(min(
                next_row[-1] + 1,
                row[right_index] + 1,
                row[right_index - 1] + (left_char != right_char),
            ))
        row = next_row
    return row[-1]


def cer(reference: str, prediction: str) -> float | None:
    """Character error rate over normalized text; None when the reference is empty."""
    reference = normalized_text(reference)
    prediction = normalized_text(prediction)
    if not reference:
        return None
    return levenshtein(reference, prediction) / len(reference)
