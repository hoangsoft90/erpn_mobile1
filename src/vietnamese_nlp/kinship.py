"""Vietnamese kinship-title stripper.

ERPNext stores ``customer_name`` without the vocative the user speaks
(``Nguyễn Văn Nam``, not ``Anh Nam``), so the title has to be removed before a
fuzzy search.

Two rules keep this safe:

1. a title is only removed when a *plausible name* follows it, so a customer
   literally named ``Cô`` is never reduced to nothing;
2. **number words count as names** (``Bác Hai``, ``Cô Ba``, ``Chú Tư``,
   ``Ông Năm`` are the classic Vietnamese birth-order nicknames), while scale
   words do not (``ba trăm`` must never become ``trăm``).

Titles are matched **with** diacritics: ``chị`` (title) must not match ``Chi``
(a name).
"""

from __future__ import annotations

import re

from .money import BIG_SCALES, FILLERS, HALF_WORDS, HALVES, HUNDREDS, TENS

#: vocatives / kinship terms removed before a customer lookup (diacritic sensitive)
KINSHIP_TITLES: frozenset[str] = frozenset(
    {
        "anh",
        "chị",
        "em",
        "cô",
        "chú",
        "bác",
        "ông",
        "bà",
        "cậu",
        "dì",
        "mợ",
        "thím",
        "dượng",
        "bố",
        "ba",
        "má",
        "mẹ",
        "con",
        "cháu",
        "cụ",
        "thầy",
    }
)

#: Vietnamese birth-order nicknames. They collide with number words, but a
#: title in front of one is always a name: ``Bác Hai``, ``Cô Ba``, ``Chú Tư``,
#: ``Ông Năm``, ``Thím Mười``.
#: ``mươi`` (as in ``ba mươi``) is deliberately absent, so a title is never
#: stripped out of a real amount like ``ba mươi nghìn``.
NICKNAMES: frozenset[str] = frozenset(
    {"hai", "ba", "tư", "năm", "sáu", "bảy", "tám", "chín", "mười", "mốt", "lăm"}
)

#: words that can follow a title but are never a name
NON_NAME_WORDS: frozenset[str] = frozenset(
    {
        # particles / function words
        "ơi", "à", "ạ", "vâng", "dạ", "ừ", "thì", "là", "có", "không", "chưa",
        "đã", "vừa", "mới", "sẽ", "đang", "rồi", "của", "cho", "và", "với",
        "này", "đó", "kia", "gì", "sao", "ai", "nào", "bao", "nhiêu", "mấy",
        "hết", "cả", "ở", "tại", "đi", "đến", "về", "lên", "ra", "vào",
        # domain verbs / nouns
        "trả", "thanh", "toán", "thu", "nợ", "ghi", "bán", "chịu", "mua",
        "nhập", "xuất", "giao", "lấy", "đặt", "hỏi", "tiền", "hàng", "cám",
        "kho", "đơn", "giá", "công", "tồn", "kiểm", "còn", "trừ", "cọc",
        "ứng", "trước", "bù", "cấn", "gửi", "chốt", "tạo", "xem", "tra",
        "muốn", "cần", "được", "bị", "phải", "nên",
    }
)

_NOT_A_NAME: frozenset[str] = (
    frozenset(BIG_SCALES) | frozenset(TENS) | frozenset(HUNDREDS) | FILLERS | HALVES | frozenset(HALF_WORDS)
)

_TOKEN_RE = re.compile(r"[^\W\d_]+|\d+", re.UNICODE)


def _looks_like_name(word: str) -> bool:
    low = word.lower()
    if low in NICKNAMES:
        return True
    if low in KINSHIP_TITLES:
        # "anh chị Nam" -> both titles are removed
        return True
    if low in _NOT_A_NAME:
        return False
    return low not in NON_NAME_WORDS


def strip_kinship(text: str) -> tuple[str, tuple[str, ...]]:
    """Remove kinship titles that directly precede a name.

    Returns ``(cleaned_text, stripped_titles)``. When nothing is stripped the
    original text is returned unchanged (so offsets of other layers stay valid).
    """
    if not text:
        return text, ()

    tokens = list(_TOKEN_RE.finditer(text))
    removals: list[tuple[int, int]] = []
    titles: list[str] = []

    for idx, match in enumerate(tokens):
        if match.group().lower() not in KINSHIP_TITLES:
            continue
        nxt = tokens[idx + 1] if idx + 1 < len(tokens) else None
        if nxt is None or nxt.group().isdigit():
            continue
        if not _looks_like_name(nxt.group()):
            continue
        removals.append((match.start(), match.end()))
        titles.append(match.group())

    if not removals:
        return text, ()

    parts: list[str] = []
    prev = 0
    for start, end in removals:
        parts.append(text[prev:start])
        prev = end
    parts.append(text[prev:])

    cleaned = re.sub(r"\s{2,}", " ", "".join(parts)).strip()
    return cleaned, tuple(titles)
