"""Text preparation for TTS: chunking and sanitization."""

import re

# Scripts the TTS model was trained on. Anything else is a generation artifact:
# the LLM occasionally emits a stray glyph from a neighbouring script (a
# Vietnamese `ứ` has been observed), and feeding it to TTS corrupts the audio.
_KEEP = re.compile(
    "[^"
    " -~"      # printable ASCII
    "·—…"  # · — …
    "‘’“”"
    "　-〿"      # CJK punctuation
    "一-鿿"      # CJK unified ideographs
    "぀-ヿ"      # kana
    "＀-￯"      # fullwidth forms
    "\\s"
    "]"
)


def sanitize_for_tts(text: str) -> tuple[str, list[str]]:
    """Drop glyphs outside the model's scripts. Returns the text and what was dropped."""
    dropped = _KEEP.findall(text)
    return _KEEP.sub("", text), dropped


def chunk_text(text: str, max_chars: int = 160, enders: str = "。！？；!?;") -> list[str]:
    """Split into chunks of at most `max_chars`, breaking only after sentence enders.

    `max_chars=160` is roughly 30s of Mandarin speech. The bound exists because a
    single TTS generation drifts away from the reference voice as it runs -- speaker
    similarity decays monotonically, noticeably past ~40s. It is not about any token
    limit. Each chunk re-conditions on the reference audio, which resets the timbre.
    """
    text = " ".join(text.split())
    if not text:
        return []

    sentences = re.split(f"(?<=[{re.escape(enders)}])", text)
    sentences = [s for s in sentences if s.strip()]

    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        while len(sentence) > max_chars:
            # A sentence longer than a whole chunk: no good break point exists.
            if current:
                chunks.append(current)
                current = ""
            chunks.append(sentence[:max_chars])
            sentence = sentence[max_chars:]
        if not current:
            current = sentence
        elif len(current) + len(sentence) <= max_chars:
            current += sentence
        else:
            chunks.append(current)
            current = sentence
    if current:
        chunks.append(current)
    return chunks
