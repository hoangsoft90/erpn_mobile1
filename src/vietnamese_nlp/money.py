"""Vietnamese money / number normalizer.

Safety principle (money is **not** safe to guess)
-------------------------------------------------
An amount is only emitted when there is strong evidence:

1. a big scale word is present (``nghìn``/``ngàn``/``k``/``triệu``/``tr``/
   ``củ``/``chai``/``trẹo``/``tỷ``), or
2. the expression contains 4+ digits (``50000``, ``230000``), or
3. an explicit currency suffix follows (``đồng``/``đ``/``vnd``/``₫``).

Consequences of that rule (all intentional):

* ``"Bác Hai"`` -> **no** amount. Bare word-numbers never become money.
* ``"Anh Nam còn nợ bao nhiêu"`` -> **no** amount.
* ``"hai trăm"`` -> **no** amount (only a *big* scale qualifies); the caller
  asks the user instead of guessing 200 or 200000.

Number words are matched **with** diacritics on purpose: ``năm`` (5) must not
match ``Nam`` (a name). Parsing nothing is strictly better than parsing wrongly,
so diacritic-free number words (``nam``, ``muoi``...) are deliberately absent.

Supported forms
---------------
``10 triệu`` · ``10tr`` · ``1tr5`` · ``230k`` · ``1k5`` · ``230.000`` ·
``1,500,000`` · ``mười triệu`` · ``mười củ`` · ``một chục triệu`` ·
``hai trăm ba mươi nghìn`` · ``một trăm hai mươi lăm triệu`` · ``500 ngàn`` ·
``0.5 triệu`` · ``10 triệu 500 nghìn`` · ``2 triệu rưỡi`` · ``nửa triệu`` ·
``1 500 000`` (space separated thousands) · ``hai trẹo`` · ``một chai``
(tiếng lóng miền Nam, cũng = triệu)

Shape guards (identifier ≠ money)
---------------------------------
The ``4+ digits`` rule is deliberately broad, so a few shapes that *look* numeric
but are never money are rejected before the amount is emitted:

* phone numbers — ``0`` + 9..11 digits (``"gọi anh Nam 0912345678"``)
* bare 4-digit years 1900..2099 with no currency suffix (``"doanh thu 2024"``);
  ``"2000đ"`` still counts because of the suffix
* a number right after an identifier word (``"nhà 1234"``, ``"số lượng 2000"``,
  ``"mã số 5000"``) — only unambiguous markers are guarded, so ``"mỗi đơn 5000"``
  (each order = 5000) still counts
* the slang scale words that are also everyday nouns, when the next word is that
  noun — ``củ`` as a tuber (``"5 củ cải"``) and ``chai`` as a bottle
  (``"2 chai nước"``). ``"ba củ"`` / ``"hai chai"`` alone still count.

Every guard fails *towards no amount*: a missing amount can be recovered by
asking the user, a wrong amount cannot.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from .result import MoneyMatch

# --------------------------------------------------------------------------
# Vocabulary — diacritic sensitive by design (see module docstring).
# --------------------------------------------------------------------------

ONES: dict[str, int] = {
    "không": 0,
    "một": 1,
    "mốt": 1,
    "hai": 2,
    "ba": 3,
    "bốn": 4,
    "tư": 4,
    "năm": 5,
    "lăm": 5,
    "sáu": 6,
    "bảy": 7,
    "tám": 8,
    "chín": 9,
}

TENS: dict[str, int] = {"mười": 10, "mươi": 10, "chục": 10}

HUNDREDS: dict[str, int] = {"trăm": 100}

#: filler words in "một trăm linh năm" / "một trăm lẻ năm"
FILLERS: frozenset[str] = frozenset({"linh", "lẻ", "lẽ"})

#: "2 triệu rưỡi" -> + half of the last big scale
HALVES: frozenset[str] = frozenset({"rưỡi"})

#: "nửa triệu" -> 0.5 * scale
HALF_WORDS: dict[str, Decimal] = {"nửa": Decimal("0.5")}

#: scale words that are enough on their own to make an amount credible.
BIG_SCALES: dict[str, int] = {
    "nghìn": 1_000,
    "nghin": 1_000,
    "ngàn": 1_000,
    "ngan": 1_000,
    "k": 1_000,
    "vạn": 10_000,
    "van": 10_000,
    "triệu": 1_000_000,
    "trieu": 1_000_000,
    "tr": 1_000_000,
    "củ": 1_000_000,
    "trẹo": 1_000_000,
    "chai": 1_000_000,
    "tỷ": 1_000_000_000,
    "tỉ": 1_000_000_000,
}

#: every word that carries numeric meaning (used by the tokenizer + guards)
NUMBER_WORDS: frozenset[str] = frozenset(
    set(ONES) | set(TENS) | set(HUNDREDS) | set(BIG_SCALES) | FILLERS | HALVES | set(HALF_WORDS)
)

#: words that scale a preceding number (used to decide whether a number after a
#: completed group continues the amount or starts a new phrase)
_SCALE_WORDS: frozenset[str] = frozenset(TENS) | frozenset(HUNDREDS) | frozenset(BIG_SCALES)

#: words that, GLUED directly to digits with no space ("2024năm", "2024rưỡi",
#: "2024linh"), signal a digit<->word run that money is never written as. Only
#: number words that require a preceding number word are listed — standalone
#: scale words ("triệu", "k", "tr"…), currency suffixes and ordinary nouns are
#: deliberately absent so "2triệu", "230k", "2000đ" keep working.
_SUSPICIOUS_AFTER_DIGITS: frozenset[str] = frozenset(
    set(ONES)
    | {w for w in TENS if w != "chục"}
    | set(HUNDREDS)
    | FILLERS
    | HALVES
    | set(HALF_WORDS)
)

#: words that make a following number an identifier, not an amount
#: (``"nhà 1234"``, ``"số lượng 2000"``, ``"mã số 5000"``).
#:
#: Deliberately limited to words that are *unambiguously* identifier markers.
#: Ambiguous ones that are also ordinary nouns (``đơn``, ``bàn``, ``lô``,
#: ``tầng``, ``kệ``, ``tủ``, ``ghế``) are **excluded on purpose**: guarding on
#: them rejected real utterances such as ``"mỗi đơn 5000"`` (each order = 5000).
_ID_CONTEXT_WORDS: frozenset[str] = frozenset(
    {
        "nhà",
        "số",
        "lượng",
        "mã",
        "đường",
        "ngõ",
        "hẻm",
        "cổng",
        "phòng",
        "sđt",
        "điện",
        "thoại",
        "sim",
    }
)

#: Scale words that are ALSO everyday physical nouns. When the next word is a
#: matching noun, the word is the object, not the scale.
_AMBIGUOUS_SCALE_NOUNS: dict[str, frozenset[str]] = {
    # "củ" = triệu (miền Nam) nhưng cũng = củ (khoai, cải, ...)
    "củ": frozenset(
        {
            "cải",
            "hành",
            "gừng",
            "ớt",
            "khoai",
            "sắn",
            "mì",
            "mía",
            "tỏi",
            "nghệ",
            "sả",
            "riềng",
            "sen",
            "ấu",
            "dong",
            "năng",
            "từ",
            "chuối",
            "đậu",
            "lạc",
        }
    ),
    # "chai" = triệu (miền Nam) nhưng cũng = chai (nước, dầu, bia, ...)
    "chai": frozenset(
        {
            "nước",
            "dầu",
            "bia",
            "mắm",
            "tương",
            "rượu",
            "sữa",
            "xăng",
            "dấm",
            "mật",
            "thuốc",
            "coca",
            "sting",
        }
    ),
}

_CURRENCY_SUFFIX_RE = re.compile(
    r"\s*(?:vnđ|vnd|₫|đồng|đ)(?![^\W\d_])",
    re.IGNORECASE | re.UNICODE,
)

_NUM_BODY = r"\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?"
_SCALE_ALT = r"nghìn|nghin|ngàn|ngan|triệu|trieu|tỷ|tỉ|tr|k|vạn|van"

# Lookaheads after numbers are ``(?!\d)``, NOT ``(?!\w)``: Vietnamese currency
# suffixes start with a *letter* (``đ``, ``đồng``, ``vnd``), so a ``(?!(w))``
# lookahead made ``"2000đ"`` / ``"5000vnd"`` / ``"230.000đ"`` untokenisable —
# the digits fell apart into single ``other`` chars and the amount vanished
# (worse: ``"1 500 000đ"`` silently emitted 1500). Digits-only lookahead keeps
# the number glued to its suffix while still refusing ``2tr55``-style runs.
_TOKEN_RE = re.compile(
    rf"(?P<shorthand>(?<!\w)\d+(?:[kK]|[tT][rR])\d(?!\d))"
    rf"|(?P<glued>(?<!\w)(?:{_NUM_BODY})(?:{_SCALE_ALT})(?!\w))"
    rf"|(?P<num>(?<!\w)(?:{_NUM_BODY})(?!\d))"
    rf"|(?P<word>[^\W\d_]+)"
    rf"|(?P<other>\S)",
    re.UNICODE | re.IGNORECASE,
)

_GROUPED_RE = re.compile(r"(\d{1,3}(?:[.,]\d{3})+)(?:[.,](\d+))?\Z")


@dataclass(frozen=True, slots=True)
class _Tok:
    kind: str  # "num" | "word" | "other"
    text: str
    start: int
    end: int
    value: Decimal | None = None
    #: set for shorthand tokens ("1k5") so they count as having a scale
    implied_scale: Decimal | None = None


def _parse_num_text(text: str) -> Decimal:
    """Turn ``230.000`` / ``1,500,000`` / ``0.5`` into a Decimal.

    A ``.``/``,`` group is a thousands separator when it forms 3-digit groups
    (Vietnamese convention), otherwise it is a decimal point.
    """
    m = _GROUPED_RE.match(text)
    if m:
        whole = re.sub(r"[.,]", "", m.group(1))
        frac = m.group(2)
        return Decimal(whole + ("." + frac if frac else ""))
    return Decimal(text.replace(",", "."))


def _tokenize(text: str) -> list[_Tok]:
    out: list[_Tok] = []
    for m in _TOKEN_RE.finditer(text):
        shorthand = m.group("shorthand")
        glued = m.group("glued")
        if shorthand:
            sm = re.fullmatch(r"(\d+)([kK]|[tT][rR])(\d)", shorthand)
            assert sm is not None  # guaranteed by the token regex
            n1, scale, n2 = int(sm.group(1)), sm.group(2).lower(), int(sm.group(3))
            base = Decimal(BIG_SCALES["k"] if scale == "k" else BIG_SCALES["tr"])
            value = Decimal(n1) * base + Decimal(n2) * (base / 10)
            out.append(
                _Tok("num", shorthand, m.start(), m.end(), value=value, implied_scale=base)
            )
        elif glued:
            sm = re.search(rf"({_SCALE_ALT})\Z", glued, re.IGNORECASE)
            assert sm is not None  # guaranteed by the token regex
            digits = glued[: sm.start()]
            scale = glued[sm.start() :]
            split = m.start() + len(digits)
            out.append(_Tok("num", digits, m.start(), split, value=_parse_num_text(digits)))
            out.append(_Tok("word", scale, split, m.end()))
        elif m.group("num"):
            raw = m.group("num")
            out.append(_Tok("num", raw, m.start(), m.end(), value=_parse_num_text(raw)))
        elif m.group("word"):
            out.append(_Tok("word", m.group("word"), m.start(), m.end()))
        else:
            out.append(_Tok("other", m.group("other"), m.start(), m.end()))
    return out


def _is_valid(
    *,
    total: Decimal,
    seen_big_scale: bool,
    has_nonzero: bool,
    digits: int,
    has_suffix: bool,
) -> bool:
    if total <= 0 or not has_nonzero:
        # "không triệu" must not become 1.000.000
        return False
    if seen_big_scale or digits >= 4:
        return True
    return has_suffix


def _looks_like_identifier(
    *,
    raw: str,
    seen_big_scale: bool,
    has_suffix: bool,
    prev_word: str | None,
    next_word: str | None,
    ambiguous_scales: set[str],
) -> bool:
    """Reject shapes that *look* numeric but are never money.

    See the module docstring; every branch fails towards "no amount".
    """
    # phone number: 0 + 9..11 digits ("gọi anh Nam 0912345678")
    if raw.isdigit() and raw.startswith("0") and 9 <= len(raw) <= 11:
        return True

    # bare 4-digit year with no currency suffix ("doanh thu 2024")
    if not seen_big_scale and not has_suffix and raw.isdigit() and len(raw) == 4:
        if 1900 <= int(raw) <= 2099:
            return True

    # right after an identifier word ("nhà 1234", "số lượng 2000", "mã số 5000")
    if not seen_big_scale and not has_suffix and prev_word in _ID_CONTEXT_WORDS:
        return True

    # ambiguous scale word used as a plain object ("5 củ cải", "2 chai nước")
    for word in ambiguous_scales:
        if next_word in _AMBIGUOUS_SCALE_NOUNS[word]:
            return True

    return False


def find_amounts(text: str) -> tuple[MoneyMatch, ...]:
    """Return every credible amount-of-money expression in ``text``."""
    if not text:
        return ()

    toks = _tokenize(text)
    matches: list[MoneyMatch] = []
    n = len(toks)
    i = 0

    while i < n:
        first = toks[i]
        starts_expr = first.kind == "num" or (
            first.kind == "word" and first.text.lower() in NUMBER_WORDS
        )
        if not starts_expr:
            i += 1
            continue

        total = Decimal(0)
        section = Decimal(0)
        current: Decimal | None = None
        #: True while `current` was built from DIGIT tokens only. The
        #: space-separated-thousands rule ("1 500 000") is only meaningful for
        #: digits: a word numeral is a NAME as often as it is a number
        #: ("bác Hai 500 ngàn" — real money bug 2026-09-16: "Hai"=2 merged with
        #: "500" into 2.500.000đ). Word-derived values are therefore excluded.
        current_from_digits = False
        last_scale: Decimal | None = None
        seen_big = False
        has_number = False
        #: ambiguous scale words (củ/chai) consumed by this expression
        ambiguous_scales: set[str] = set()
        #: at least one component was actually non-zero ("không" alone is not money)
        has_nonzero = False
        #: set when the expression stops on a bare trailing number, e.g.
        #: "2 triệu 500" — the caller must NOT get 2,000,000 silently
        ambiguous_tail = False
        #: set when the matched num text is a digit<->word run that only exists
        #: because the digit lookahead is ``(?!\d)`` — e.g. "2tr5k", "2024năm",
        #: "2024rưỡi", "2024linh". Money is never written that way.
        suspicious_run = False
        digits = 0
        start = first.start
        end = first.end

        j = i
        while j < n:
            t = toks[j]

            if t.kind == "num":
                assert t.value is not None
                if re.match(r"(?:[tT][rR]|[kK])\d", text[t.end :]):
                    # Failed shorthand: "2tr50" clearly started as a shorthand
                    # but with an unusual digit count. The split would silently
                    # keep only "2 triệu" and DROP "50" — refuse instead.
                    suspicious_run = True
                    break
                nxt = toks[j + 1] if j + 1 < n else None
                if seen_big and current is None:
                    # A bare number after a completed big-scale group is only
                    # merged when it introduces its own scale
                    # ("10 triệu 500 nghìn"); otherwise it is either a new
                    # phrase ("320 nghìn một bao" -> keep 320.000) or an
                    # ambiguous trailing number ("2 triệu 500" -> refuse).
                    if not (
                        nxt is not None and nxt.kind == "word" and nxt.text.lower() in _SCALE_WORDS
                    ):
                        ambiguous_tail = nxt is None or nxt.kind == "other"
                        break
                if current is None:
                    current = t.value
                    current_from_digits = t.text.isdigit()
                elif (
                    current_from_digits
                    and current == current.to_integral_value()
                    and re.fullmatch(r"\d{3}", t.text)
                ):
                    # "1 500 000" — space separated thousands, guarded to 3-digit
                    # groups AND to digit-origin values (see current_from_digits)
                    current = current * 1000 + t.value
                else:
                    ambiguous_tail = nxt is None or nxt.kind == "other"
                    break  # ambiguous run of numbers -> never guess
                if t.implied_scale is not None:
                    # shorthand glued/adjacent to ANOTHER scale word ("2tr5k"):
                    # the lexer split is meaningless — refuse instead of
                    # multiplying scales (2.5 triệu × 1000)
                    if nxt is not None and nxt.kind == "word" and nxt.text.lower() in _SCALE_WORDS:
                        suspicious_run = True
                        break
                elif (
                    nxt is not None
                    and nxt.kind == "word"
                    and nxt.start == t.end
                    and nxt.text.lower() in _SUSPICIOUS_AFTER_DIGITS
                ):
                    # digit-only number GLUED to a word-number that only makes
                    # sense inside word sequences ("2024năm", "2024rưỡi",
                    # "2024linh") — an artefact of the digit-only lookahead.
                    # "2000đ" / "2triệu" / "230k" use other word sets, so they
                    # are unaffected.
                    suspicious_run = True
                    break
                digits += len(re.sub(r"\D", "", t.text))
                if t.value:
                    has_nonzero = True
                if t.implied_scale is not None:
                    seen_big = True
                    last_scale = t.implied_scale
                has_number = True
                end = t.end
                j += 1
                continue

            if t.kind == "word":
                w = t.text.lower()
                if w in ONES:
                    if seen_big and current is None:
                        # same rule as for digits: "320 nghìn một bao" keeps
                        # 320.000, while "2 triệu năm" is ambiguous and refused
                        nxt = toks[j + 1] if j + 1 < n else None
                        if not (
                            nxt is not None
                            and nxt.kind == "word"
                            and nxt.text.lower() in _SCALE_WORDS
                        ):
                            ambiguous_tail = nxt is None or nxt.kind == "other"
                            break
                    v = Decimal(ONES[w])
                    current = v if current is None else current + v
                    current_from_digits = False
                    if v:
                        has_nonzero = True
                    has_number = True
                elif w in FILLERS:
                    pass
                elif w in TENS:
                    section += (Decimal(1) if current is None else current) * TENS[w]
                    current = None
                    has_nonzero = True
                    has_number = True
                elif w in HUNDREDS:
                    section += (Decimal(1) if current is None else current) * HUNDREDS[w]
                    current = None
                    has_nonzero = True
                    has_number = True
                elif w in BIG_SCALES:
                    base = Decimal(BIG_SCALES[w])
                    if w in _AMBIGUOUS_SCALE_NOUNS:
                        ambiguous_scales.add(w)
                    section += current or Decimal(0)
                    current = None
                    total += (section if section != 0 else Decimal(1)) * base
                    section = Decimal(0)
                    last_scale = base
                    seen_big = True
                    # a scale word is not itself a quantity: "không triệu" stays invalid
                    has_number = True
                elif w in HALF_WORDS:
                    half = HALF_WORDS[w]
                    current = half if current is None else current + half
                    current_from_digits = False
                    has_nonzero = True
                    has_number = True
                elif w in HALVES:
                    total += (last_scale if last_scale is not None else Decimal(1)) / 2
                    has_nonzero = True
                    has_number = True
                else:
                    break
                end = t.end
                j += 1
                continue

            break  # punctuation / anything else terminates the expression

        if has_number and not ambiguous_tail and not suspicious_run:
            total += section + (current or Decimal(0))
            has_suffix = _CURRENCY_SUFFIX_RE.match(text, end) is not None
            nxt_tok = toks[j] if j < n else None
            prev_tok = toks[i - 1] if i > 0 else None
            next_word = (
                nxt_tok.text.lower()
                if nxt_tok is not None and nxt_tok.kind == "word"
                else None
            )
            prev_word = (
                prev_tok.text.lower()
                if prev_tok is not None and prev_tok.kind == "word"
                else None
            )
            rejected = _looks_like_identifier(
                raw=text[start:end],
                seen_big_scale=seen_big,
                has_suffix=has_suffix,
                prev_word=prev_word,
                next_word=next_word,
                ambiguous_scales=ambiguous_scales,
            )
            if not rejected and _is_valid(
                total=total,
                seen_big_scale=seen_big,
                has_nonzero=has_nonzero,
                digits=digits,
                has_suffix=has_suffix,
            ):
                try:
                    rounded = total.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
                except InvalidOperation:  # pragma: no cover - defensive
                    rounded = None
                if rounded is not None:
                    matches.append(
                        MoneyMatch(
                            value=int(rounded), raw=text[start:end], start=start, end=end
                        )
                    )

        i = j if j > i else i + 1

    return tuple(matches)
