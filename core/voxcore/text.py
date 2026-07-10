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

# Speech rate per script, chars/sec. Fitted by `tools/measure_speech_rates.py` against the
# live engine: 5 generations of each paragraph, reduced by their median. See
# `docs/chunking.md` for the method, the error, and why the median.
#
# **Only the first significant figure is real.** The engine is not reproducible -- the same
# paragraph varies 13-25% in duration run to run -- and independent fits of the same voice
# disagree in the second digit. Do not tune these. The ratios the budget rests on (an
# ideograph costs three Latin letters) tower over that noise.
#
# These are properties of the *script*, not the language, because that is all a lone
# string can tell us. It works because rate is dominated by how much phonetic content a
# character carries. Where script and language disagree the estimate degrades gracefully --
# English, German and Vietnamese all measure within 4% of the pooled Latin rate.
_CPS = {
    "Latin": 18.3,
    "Greek": 16.4,
    "Cyrillic": 16.1,
    "Myanmar": 15.2,
    "Lao": 14.6,
    "Devanagari": 14.4,
    "Thai": 14.0,
    "Khmer": 13.6,
    "Hebrew": 12.5,
    "Arabic": 11.0,
    "Hangul": 7.9,
    # Solved for, not pooled: Japanese interleaves kanji with kana and `_char_seconds`
    # charges the kanji at the Han rate. So this number carries Han's error too, and it is
    # the least stable in the table.
    "Kana": 6.3,
    "Han": 5.7,
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

    Within ~15% on held-out text, which is also roughly the engine's own run-to-run
    spread on a fixed paragraph -- it will not synthesize the same text to the same
    length twice, so no estimator can do better (`docs/chunking.md`). The bias is
    deliberately toward over-estimating: a chunk that runs short costs a seam, one that
    runs long costs speaker similarity.
    """
    return sum(_char_seconds(" ".join(text.split())))


# A span is `prefix[b] - prefix[a]`, which is not bit-identical to summing `costs[a:b]`:
# subtracting two partial sums loses the low bits. Without slack, whether a sentence fits
# its budget would depend on how much rounding error the document accumulated before it --
# the same sentence splits differently at the top of a page and the bottom. The estimate
# carries ~15% error; refusing to split on the last ULP of a float is not a compromise.
_SPAN_TOLERANCE = 1e-9


def _exceeds(span: float, cap: float) -> bool:
    return span > cap * (1 + _SPAN_TOLERANCE)

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
    hi = bisect_right(prefix, prefix[pos] + cap * (1 + _SPAN_TOLERANCE), pos, end + 1) - 1
    hi = min(max(hi, pos + 1), end)
    if hi >= end:
        return end
    return _break_index(text, pos, hi)


def chunk_text(text: str, max_seconds: float = 15.0, enders: str = SENTENCE_ENDERS,
               first_max_seconds: float | None = None, growth: float = 2.0) -> list[str]:
    """Split into chunks of at most `max_seconds` of estimated speech.

    The bound is on *duration*, not on characters: a single TTS generation drifts away
    from the reference voice as it runs, from the first second and with no plateau, and
    85 Chinese characters and 275 English ones both take about 15 seconds to say. It is
    not about any token limit. Each chunk re-conditions on the reference audio, which
    resets the timbre. Shortening the chunk buys similarity and pays in seams; 15s is
    where a listener judged the trade. See `docs/chunking.md`.

    `first_max_seconds` caps the opening chunk, and each chunk after it may be `growth`
    times **the one actually emitted before it**, up to `max_seconds`. That ramp exists for
    streaming: the listener waits for chunk 1 before hearing anything, but from then on
    each chunk must play for longer than the next one takes to synthesize, or playback
    stalls. Synthesis runs at roughly 0.37x realtime, so a chunk can afford to be ~2.7x its
    predecessor; 2.0 leaves margin. A uniformly short opening chunk would start fast and
    then stall.

    Hanging the ramp off the previous chunk's real duration, rather than off `first_cap *
    growth ** k`, is the whole point: a sentence boundary can end a chunk well short of its
    cap, and the next chunk would otherwise still be allowed the full ramped cap -- six
    times its predecessor, and the buffer runs dry at that seam.

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
    previous = 0.0             # duration of the last chunk emitted, not of its cap

    def emit(a: int, b: int) -> None:
        nonlocal previous
        chunks.append(text[a:b])
        previous = span(a, b)

    def limit() -> float:
        if not chunks:
            return first_cap
        # The ramp hangs off what the last chunk actually *was*, not off what it was
        # allowed to be. A sentence boundary can end a chunk far short of its cap -- and
        # if the next chunk were still allowed the full ramped cap, it could be many times
        # its predecessor, which is exactly the case where playback runs dry.
        return min(max_seconds, growth * previous)

    for sentence_start, sentence_end in _sentence_bounds(text, enders):
        pos = sentence_start
        # Re-read `limit()` after every emit. Closing a chunk lowers the cap to `growth`
        # times what that chunk turned out to be, and a sentence measured against the old
        # cap may no longer fit under the new one. Deciding once, up front, is how a
        # sentence twice the new cap used to slip through whole.
        while pos < sentence_end:
            if start is not None:
                if not _exceeds(span(start, sentence_end), limit()):
                    break            # the sentence rides along in the open chunk
                emit(start, pos)     # close it; `pos` is this sentence's first character
                start = None
                continue
            if not _exceeds(span(pos, sentence_end), limit()):
                start = pos          # open a chunk on a sentence that fits alone
                break
            cut = _cut_index(text, prefix, pos, sentence_end, limit())
            emit(pos, cut)           # a sentence too long for a whole chunk: break it up
            pos = cut
    if start is not None:
        emit(start, len(text))
    return chunks
