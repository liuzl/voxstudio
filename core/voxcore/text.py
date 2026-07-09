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


def chunk_text(text: str, max_chars: int = 160, enders: str = "。！？；!?;",
               first_max_chars: int | None = None, growth: float = 2.0) -> list[str]:
    """Split into chunks of at most `max_chars`, breaking only after sentence enders.

    `max_chars=160` is roughly 30s of Mandarin speech. The bound exists because a
    single TTS generation drifts away from the reference voice as it runs -- speaker
    similarity decays monotonically, noticeably past ~40s. It is not about any token
    limit. Each chunk re-conditions on the reference audio, which resets the timbre.

    `first_max_chars` caps the opening chunk, and each chunk after it may be `growth`
    times the last, up to `max_chars`. That ramp exists for streaming: the listener
    waits for chunk 1 before hearing anything, but from then on each chunk must play
    for longer than the next one takes to synthesize, or playback stalls. Synthesis
    runs at roughly 0.37x realtime, so a chunk can afford to be ~2.7x its predecessor;
    2.0 leaves margin. A uniformly short opening chunk would start fast and then stall.
    """
    text = " ".join(text.split())
    if not text:
        return []

    sentences = re.split(f"(?<=[{re.escape(enders)}])", text)
    sentences = [s for s in sentences if s.strip()]

    # A cap on the opening chunk only makes it shorter, never longer than the rest.
    first_cap = min(first_max_chars, max_chars) if first_max_chars else max_chars

    chunks: list[str] = []
    current = ""

    def limit() -> int:
        if not chunks:
            return first_cap
        return min(max_chars, max(1, int(first_cap * growth ** len(chunks))))

    for sentence in sentences:
        while True:
            # Read the cap once: appending below flips `limit()` to the general one,
            # and slicing with a stale cap would silently drop text.
            cap = limit()
            if len(sentence) <= cap:
                break
            if current:
                chunks.append(current)
                current = ""
                continue
            # A sentence longer than a whole chunk: no good break point exists.
            chunks.append(sentence[:cap])
            sentence = sentence[cap:]
        if not current:
            current = sentence
        elif len(current) + len(sentence) <= limit():
            current += sentence
        else:
            chunks.append(current)
            current = sentence
    if current:
        chunks.append(current)
    return chunks
