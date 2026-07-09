"""Text preparation for TTS: chunking and sanitization.

The engine (VoxCPM2) speaks 30 languages. Nothing here is allowed to assume Chinese --
but Chinese is what the constants were first measured against, so read `docs/chunking.md`
before touching a number.
"""

import unicodedata
from bisect import bisect_right
from itertools import accumulate

# Sentence enders, per script. A chunk boundary is a good place to stop only if a
# listener would already have expected a pause there.
#
# `.` is in the set but is not trusted on sight -- see `_period_ends_sentence`.
# Thai, Lao and Khmer mostly separate sentences with a space rather than a mark, so
# for them this set rarely fires and the oversized-sentence fallback does the work.
SENTENCE_ENDERS = (
    "。！？；"      # CJK
    "!?;."         # Latin (and Greek `;` = question mark)
    ";"       # GREEK QUESTION MARK, the non-ASCII spelling of the same
    "।॥"           # Devanagari danda, double danda
    "؟۔"           # Arabic question mark, Urdu full stop
    "។៕"           # Khmer khan, bariyoosan
    "။"            # Myanmar section mark
)

# Weaker breaks. Used only when a single sentence is longer than a whole chunk and
# something has to give: better to split where a listener already hears a comma.
_CLAUSE_BREAKS = "，、,：:；;—–…،؛၊"

# Punctuation that trails a sentence ender and belongs to the sentence it closes.
_CLOSERS = "\"'”’)）」』】》»"

# Lowercased tokens that take a period without ending a sentence. English-only and
# frankly incomplete: a miss costs one spurious 210ms pause, not a wrong split.
_ABBREVIATIONS = frozenset(
    "mr mrs ms dr prof st vs etc fig no vol jr sr approx cf al".split()
)

# Speech rate per script, chars/sec, measured against the live engine on paragraphs of
# roughly a full chunk's length. See `docs/chunking.md` for the method and the error.
#
# These are properties of the *script*, not the language, because that is all a lone
# string can tell us. It works because rate is dominated by how much phonetic content a
# character carries: an ideograph is a syllable, a Latin letter is a phoneme or less.
# Where script and language disagree the estimate degrades gracefully -- German and
# Vietnamese both measure within 4% of the pooled Latin rate.
_CPS = {
    "Cyrillic": 18.3,
    "Latin": 18.1,
    "Greek": 15.8,
    "Myanmar": 15.0,
    "Devanagari": 14.6,
    "Khmer": 14.3,
    "Lao": 14.0,
    "Thai": 13.4,
    "Hebrew": 11.9,
    "Arabic": 11.4,
    "Hangul": 8.2,
    "Han": 5.4,
    "Kana": 5.1,
}

# An unrecognised script gets the slowest measured rate. The engine may well speak it --
# the model card invites you to try -- and over-estimating its duration only costs an
# extra seam, while under-estimating it lets the timbre drift.
_DEFAULT_CPS = min(_CPS.values())

_SCRIPT_RANGES = (
    ("Han", ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x2FA1F))),
    ("Kana", ((0x3040, 0x30FF), (0x31F0, 0x31FF), (0xFF66, 0xFF9D))),
    ("Hangul", ((0x1100, 0x11FF), (0x3130, 0x318F), (0xA960, 0xA97F), (0xAC00, 0xD7FF))),
    ("Latin", ((0x0041, 0x024F), (0x1E00, 0x1EFF), (0x2C60, 0x2C7F), (0xA720, 0xA7FF),
               (0xFF21, 0xFF3A), (0xFF41, 0xFF5A))),
    ("Cyrillic", ((0x0400, 0x052F), (0x2DE0, 0x2DFF), (0xA640, 0xA69F))),
    ("Greek", ((0x0370, 0x03FF), (0x1F00, 0x1FFF))),
    ("Arabic", ((0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF),
                (0xFB50, 0xFDFF), (0xFE70, 0xFEFF))),
    ("Hebrew", ((0x0590, 0x05FF), (0xFB1D, 0xFB4F))),
    ("Devanagari", ((0x0900, 0x097F), (0xA8E0, 0xA8FF))),
    ("Thai", ((0x0E00, 0x0E7F),)),
    ("Lao", ((0x0E80, 0x0EFF),)),
    ("Khmer", ((0x1780, 0x17FF), (0x19E0, 0x19FF))),
    ("Myanmar", ((0x1000, 0x109F), (0xA9E0, 0xA9FF), (0xAA60, 0xAA7F))),
)


def _script_of(ch: str) -> str | None:
    """The script a character is spoken in, or None if it inherits the running one.

    Punctuation, spaces and digits return None: `.` is read at the speed of whatever
    surrounds it. So do combining marks outside a script's own block -- a Latin acute
    accent belongs to the letter it sits on, not to a script of its own.
    """
    category = unicodedata.category(ch)
    if category[0] not in "LM":
        return None
    codepoint = ord(ch)
    for name, spans in _SCRIPT_RANGES:
        if any(lo <= codepoint <= hi for lo, hi in spans):
            return name
    return None if category[0] == "M" else "Other"


def _char_seconds(text: str) -> list[float]:
    """Per-character duration estimate, with inherited characters resolved.

    A character with no script of its own is charged at the rate of the script that
    precedes it. Leading ones -- an opening quote, say -- are charged at the rate of the
    first script that turns up, which is why this cannot be a simple left-to-right sum,
    and why it has to see the whole text: a lone `।` priced on its own would be charged
    the unknown-script rate that the Devanagari after it was about to settle.
    """
    seconds = [0.0] * len(text)
    unresolved: list[int] = []
    current: str | None = None

    for i, ch in enumerate(text):
        script = _script_of(ch)
        if script is None:
            if current is None:
                unresolved.append(i)
            else:
                seconds[i] = 1 / _CPS.get(current, _DEFAULT_CPS)
            continue
        rate = _CPS.get(script, _DEFAULT_CPS)
        for j in unresolved:
            seconds[j] = 1 / rate
        unresolved.clear()
        current = script
        seconds[i] = 1 / rate

    for j in unresolved:  # text with no letters at all
        seconds[j] = 1 / _DEFAULT_CPS
    return seconds


def est_seconds(text: str) -> float:
    """Estimated speech duration, in seconds.

    Accurate to about +13% / -17% against held-out text (`docs/chunking.md`). The bias
    is deliberately toward over-estimating: a chunk that runs short costs a seam, one
    that runs long costs speaker similarity.
    """
    return sum(_char_seconds(" ".join(text.split())))


# `growth ** n` past this has long since exceeded any `max_seconds`, and overflows at 1024.
_MAX_RAMP_STEPS = 64

_DROP_CATEGORIES = frozenset(("Cc", "Cf", "Co", "Cs", "Cn", "So", "Sk"))
_JOINERS = ("‌", "‍")  # ZWNJ, ZWJ


def _joins_letters(text: str, i: int) -> bool:
    if i == 0 or i + 1 == len(text):
        return False
    return all(unicodedata.category(text[j])[0] in "LM" for j in (i - 1, i + 1))


def _is_variation_selector(ch: str) -> bool:
    # Nonspacing marks by category, and so kept by the rule below, but they only pick a
    # glyph -- the `️` that turns `☂` into an emoji has nothing to pronounce.
    return 0xFE00 <= ord(ch) <= 0xFE0F or 0xE0100 <= ord(ch) <= 0xE01EF


def _speakable(ch: str) -> bool:
    if _is_variation_selector(ch):
        return False
    # Newlines and tabs are control characters, but dropping them would weld the words
    # on either side into one.
    return ch.isspace() or unicodedata.category(ch) not in _DROP_CATEGORIES


def sanitize_for_tts(text: str) -> tuple[str, list[str]]:
    """Drop what cannot be spoken. Returns the text and what was dropped.

    Emoji, control codes, private-use and unassigned code points corrupt the audio. What
    survives is every letter, mark, digit, and piece of punctuation -- the filter must
    not care which script they are in, because the engine speaks thirty of them.

    ZWJ and ZWNJ are format characters, and so nominally droppable, but between two
    letters they are orthography: Devanagari, Khmer and Myanmar spell with them.
    """
    kept: list[str] = []
    dropped: list[str] = []
    for i, ch in enumerate(text):
        if ch in _JOINERS and _joins_letters(text, i):
            kept.append(ch)
        elif _speakable(ch):
            kept.append(ch)
        else:
            dropped.append(ch)
    return "".join(kept), dropped


def _period_ends_sentence(text: str, i: int) -> bool:
    """Whether the `.` at `i` closes a sentence, rather than a decimal or an initial.

    Every rule here fails toward *not* splitting. A missed split hands the sentence to
    the oversized fallback, which breaks it at a word boundary; a false split puts a
    pause and a fresh voice conditioning in the middle of `Dr. Chen`.
    """
    nxt = text[i + 1] if i + 1 < len(text) else ""
    if nxt.isdigit() or nxt == ".":
        return False  # 3.14, or a dot of an ellipsis that is not its last
    if nxt and not nxt.isspace() and nxt not in _CLOSERS:
        return False  # example.com

    j = i - 1
    while j >= 0 and (text[j].isalnum() or text[j] == "."):
        j -= 1
    token = text[j + 1: i]
    if "." in token:
        return False  # an acronym: U.S., e.g.
    if len(token) == 1 and token.isalpha():
        return False  # an initial: J. Smith
    return token.lower() not in _ABBREVIATIONS


def _sentence_bounds(text: str, enders: str) -> list[tuple[int, int]]:
    """`(start, end)` after each sentence ender, keeping it and any closing punctuation.

    Half-open index pairs rather than substrings: every chunk is a contiguous slice of
    `text`, so the whole splitter can run on offsets into one duration table. Nothing is
    stripped -- the spans tile `text` end to end.
    """
    bounds: list[tuple[int, int]] = []
    start = 0
    for i, ch in enumerate(text):
        if ch not in enders:
            continue
        if ch == "." and not _period_ends_sentence(text, i):
            continue
        end = i + 1
        while end < len(text) and text[end] in _CLOSERS:
            end += 1
        bounds.append((start, end))
        start = end
    if start < len(text):
        bounds.append((start, len(text)))
    return bounds


def _safe_cut(text: str, pos: int, i: int) -> int:
    """Move a cut off the inside of a grapheme cluster, without backing past `pos`."""
    while pos < i < len(text) and (unicodedata.category(text[i])[0] == "M"
                                   or text[i - 1] in _JOINERS):
        i -= 1
    return max(pos + 1, i)


def _break_index(text: str, pos: int, hi: int) -> int:
    """Where to cut `text[pos:]`, which does not fit, searching backwards from `hi`.

    A clause mark is the best break, a space the next best, and an arbitrary character
    the last resort -- which is the normal case for Chinese, Japanese and Thai, none of
    which put spaces between words.

    A break is only taken in the back half of what fits. Otherwise a comma near the very
    start of a long sentence would strand a two-word chunk and re-open the same problem.
    """
    floor = pos + max(1, (hi - pos) // 2)
    for i in range(hi, floor, -1):
        if text[i - 1] in _CLAUSE_BREAKS:
            return i
    for i in range(hi, floor, -1):
        if text[i - 1].isspace():
            return i - 1  # leave the space to the tail, as sentence splitting does
    return _safe_cut(text, pos, hi)


def _cut_index(text: str, prefix: list[float], pos: int, end: int, cap: float) -> int:
    """Where to end a chunk starting at `pos`, worth at most `cap` seconds, within `end`.

    `prefix` is a cumulative duration over the whole text, so this is a bisect rather than
    a scan: the tail is never re-priced as it shrinks. At least one character is always
    taken, even when that one character is worth more than the cap.
    """
    hi = bisect_right(prefix, prefix[pos] + cap, pos, end + 1) - 1
    hi = min(max(hi, pos + 1), end)
    if hi >= end:
        return end
    return _break_index(text, pos, hi)


def chunk_text(text: str, max_seconds: float = 30.0, enders: str = SENTENCE_ENDERS,
               first_max_seconds: float | None = None, growth: float = 2.0) -> list[str]:
    """Split into chunks of at most `max_seconds` of estimated speech.

    The bound is on *duration*, not on characters: a single TTS generation drifts away
    from the reference voice as it runs -- speaker similarity decays monotonically,
    noticeably past ~40s -- and 160 Chinese characters and 540 English ones both take
    about 30 seconds to say. It is not about any token limit. Each chunk re-conditions on
    the reference audio, which resets the timbre.

    `first_max_seconds` caps the opening chunk, and each chunk after it may be `growth`
    times the last, up to `max_seconds`. That ramp exists for streaming: the listener
    waits for chunk 1 before hearing anything, but from then on each chunk must play for
    longer than the next one takes to synthesize, or playback stalls. Synthesis runs at
    roughly 0.37x realtime, so a chunk can afford to be ~2.7x its predecessor; 2.0 leaves
    margin. A uniformly short opening chunk would start fast and then stall.

    Every character is priced exactly once, before any cutting. `vox say -f` takes a file
    of any size, and a document with no sentence enders in it -- one long Thai paragraph,
    a wall of Chinese without punctuation -- would otherwise re-price the whole shrinking
    tail on every cut, burning tens of seconds of CPU before the engine is contacted.
    """
    text = " ".join(text.split())
    if not text:
        return []

    prefix = list(accumulate(_char_seconds(text), initial=0.0))

    def span(a: int, b: int) -> float:
        return prefix[b] - prefix[a]

    # A cap on the opening chunk only makes it shorter, never longer than the rest.
    first_cap = min(first_max_seconds, max_seconds) if first_max_seconds else max_seconds

    chunks: list[str] = []
    start: int | None = None   # where the chunk being packed began, if one is open

    def limit() -> float:
        if not chunks:
            return first_cap
        # Clamp the exponent. The ramp has pinned itself to `max_seconds` within a few
        # steps anyway, and `2.0 ** 1024` raises OverflowError -- which a long document
        # cut into a thousand chunks would otherwise reach.
        return min(max_seconds, first_cap * growth ** min(len(chunks), _MAX_RAMP_STEPS))

    for sentence_start, sentence_end in _sentence_bounds(text, enders):
        pos = sentence_start
        while span(pos, sentence_end) > limit():
            # Re-read the cap each pass: appending below flips `limit()` to the general
            # one, and cutting with a stale cap would silently drop text.
            if start is not None:
                chunks.append(text[start:pos])
                start = None
                continue
            cut = _cut_index(text, prefix, pos, sentence_end, limit())
            chunks.append(text[pos:cut])
            pos = cut

        if pos >= sentence_end:
            continue
        if start is None:
            start = pos
        elif span(start, sentence_end) > limit():
            chunks.append(text[start:pos])
            start = pos
    if start is not None:
        chunks.append(text[start:])
    return chunks
