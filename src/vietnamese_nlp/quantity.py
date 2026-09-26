"""Minimal rule-based quantity extractor (``20 bao``, ``25 ký``, ``1,5 tấn``).

Kept intentionally small — Phase 1 only needs "basic entities" so downstream
layers can tell a quantity apart from an amount of money. Note that ``25k`` is
money (``k`` = nghìn) while ``25 kg`` / ``25 ký`` is a quantity; the two are
never confused because units here are always 2+ characters.
"""

from __future__ import annotations

import re

from .result import QuantityMatch

#: spoken unit -> canonical unit
UNITS: dict[str, str] = {
    "ki lô gam": "kg",
    "ki-lô-gam": "kg",
    "kilogam": "kg",
    "kg": "kg",
    "ký": "kg",
    "kí": "kg",
    "ky": "kg",
    "tấn": "tan",
    "tạ": "ta",
    "yến": "yen",
    "bao": "bao",
    "bịch": "bich",
    "gói": "goi",
    "thùng": "thung",
    "can": "can",
    "lọ": "lo",
    "hộp": "hop",
    "cái": "cai",
    "chiếc": "chiec",
    "con": "con",
    "khối": "khoi",
    "lít": "lit",
    "lit": "lit",
    #: `Nos` is ERPNext's own UOM name for "a countable thing" — measured on the
    #: live site 2026-09-24: `UOM` has `Nos` (must_be_whole_number 1), and the
    #: service item `PHI-VAN-CHUYEN` has `stock_uom: "Nos"`. A structured
    #: e-invoice line for a service therefore carries `Nos`, and without this
    #: entry the composed sentence `3 Nos Phí vận chuyển` yielded NO quantity at
    #: all (PO_QTY_MISSING) — the number was read, the unit was not recognised.
    #: An IDENTITY alias, not a conversion: no factor is implied or applied, and
    #: the ERPNext `UOM` list still decides the final name (uom.mjs UOM_SYNONYMS).
    "nos": "nos",
}

_UNIT_ALT = "|".join(
    re.escape(u).replace(r"\ ", r"\s+")
    for u in sorted(UNITS, key=len, reverse=True)
)

_QUANTITY_RE = re.compile(
    rf"(?<!\w)(\d{{1,3}}(?:[.,]\d{{3}})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*({_UNIT_ALT})(?!\w)",
    re.IGNORECASE | re.UNICODE,
)

_GROUPED_RE = re.compile(r"(\d{1,3}(?:[.,]\d{3})+)(?:[.,](\d+))?\Z")


def _to_float(raw: str) -> float:
    match = _GROUPED_RE.match(raw)
    if match:
        whole = re.sub(r"[.,]", "", match.group(1))
        frac = match.group(2)
        return float(whole + ("." + frac if frac else ""))
    return float(raw.replace(",", "."))


def find_quantities(text: str) -> tuple[QuantityMatch, ...]:
    """Return every ``<number> <unit>`` expression in ``text``."""
    if not text:
        return ()

    out: list[QuantityMatch] = []
    for match in _QUANTITY_RE.finditer(text):
        raw_number = match.group(1)
        raw_unit = match.group(2)
        unit_key = re.sub(r"\s+", " ", raw_unit.lower())
        canonical = UNITS.get(unit_key)
        if canonical is None:  # pragma: no cover - defensive
            continue
        out.append(
            QuantityMatch(
                value=_to_float(raw_number),
                unit=raw_unit,
                canonical_unit=canonical,
                raw=match.group(0),
                start=match.start(),
                end=match.end(),
            )
        )
    return tuple(out)
