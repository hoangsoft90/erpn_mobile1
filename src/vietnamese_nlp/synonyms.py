"""Domain synonym mapper.

A **fixed dictionary** — the whole point is that the LLM must never invent what
``ghi nợ`` or ``thu tiền`` mean. Each phrase is rewritten to one canonical
intent label and that label is also reported in ``NormalizedResult.intents``.

Product nouns are deliberately **not** mapped: ``cám heo`` is an Item to look up
in ERPNext, not an intent, so rewriting it to ``feed`` would destroy the item
name the LLM needs.

Known spec ambiguity (documented, not silently resolved)
--------------------------------------------------------
``phase-01-vietnamese-nlp-pipeline.md`` lists ``công nợ`` in **two** groups
(``= credit`` and ``= residual``). It cannot be both, so it is mapped to
``receivable`` here, and intent-level disambiguation is left to Phase 6.
"""

from __future__ import annotations

import re

from .result import SynonymMatch

#: canonical intent label -> phrases that mean it
SYNONYM_GROUPS: dict[str, tuple[str, ...]] = {
    "payment": (
        "thu tiền hàng",
        "thanh toán nợ",
        "trả tiền hàng",
        "thu tiền",
        "thanh toán",
        "trả tiền",
        "trả nợ",
        "trả hết",
        "thu nợ",
        "payment",
    ),
    "credit_sale": (
        "ghi nợ",
        "bán chịu",
        "cho nợ",
        "bán nợ",
        "credit",
    ),
    "receivable": (
        "công nợ",
        "còn nợ",
        "nợ bao nhiêu",
        "dư nợ",
        "nợ cũ",
        "residual",
        "outstanding",
    ),
    "purchase": (
        "nhập hàng",
        "mua hàng",
        "lấy hàng",
        "nhập kho",
        "mua vào",
        "purchase",
    ),
    "delivery": (
        "xuất kho",
        "giao hàng",
        "gửi hàng",
        "xuất hàng",
        "giao đơn",
        "delivery",
    ),
    "sale": (
        "bán hàng",
        "chốt đơn",
        "tạo đơn",
        "lên đơn",
        "bán lẻ",
        "sales order",
        "sale",
    ),
    "stock_level": (
        "kiểm kho",
        "tồn kho",
        "còn tồn",
        "còn hàng",
        "stock",
    ),
    "unit_price": (
        "hỏi giá",
        "xem giá",
        "đơn giá",
        "giá bán",
        "giá bao nhiêu",
        "unit price",
    ),
    "advance_payment": (
        "đặt cọc",
        "ứng trước",
        "tạm ứng",
        "trả trước",
        "advance",
    ),
    "offset": (
        "cấn trừ",
        "bù trừ",
        "trừ nợ",
        "offset",
    ),
}

#: lower-cased phrase -> canonical label
SYNONYM_TERMS: dict[str, str] = {
    phrase: canonical for canonical, phrases in SYNONYM_GROUPS.items() for phrase in phrases
}

#: longest phrase first so "cám heo"-style overlaps resolve to the specific term
_ORDERED_TERMS = sorted(SYNONYM_TERMS, key=len, reverse=True)

_SYNONYM_RE = re.compile(
    r"(?<!\w)("
    + "|".join(re.escape(t).replace(r"\ ", r"\s+") for t in _ORDERED_TERMS)
    + r")(?!\w)",
    re.IGNORECASE | re.UNICODE,
)


def map_synonyms(text: str) -> tuple[str, tuple[SynonymMatch, ...]]:
    """Rewrite known domain phrases to their canonical label.

    Returns ``(cleaned_text, matches)``. Overlapping matches are skipped so the
    longest phrase at a given position always wins.
    """
    if not text:
        return text, ()

    found: list[tuple[int, int, str, str]] = []
    last_end = 0
    for match in _SYNONYM_RE.finditer(text):
        if match.start() < last_end:
            continue
        term = re.sub(r"\s+", " ", match.group(0).lower())
        canonical = SYNONYM_TERMS.get(term)
        if canonical is None:  # pragma: no cover - defensive
            continue
        found.append((match.start(), match.end(), match.group(0), canonical))
        last_end = match.end()

    if not found:
        return text, ()

    parts: list[str] = []
    prev = 0
    for start, end, _raw, canonical in found:
        parts.append(text[prev:start])
        parts.append(canonical)
        prev = end
    parts.append(text[prev:])

    return "".join(parts), tuple(SynonymMatch(term=raw, canonical=canon) for _, _, raw, canon in found)
