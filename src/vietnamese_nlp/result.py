"""Immutable result types for the Vietnamese NLP pipeline.

All dataclasses are frozen so a ``NormalizedResult`` can be safely passed
around (and cached) without any layer mutating it by accident.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class MoneyMatch:
    """A single amount-of-money expression found in the raw text.

    ``start``/``end`` are offsets into the **original** text.
    """

    value: int
    raw: str
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class QuantityMatch:
    """A quantity expression such as ``20 bao`` or ``25 kg``.

    ``start``/``end`` are offsets into the **original** text.
    """

    value: float
    unit: str
    canonical_unit: str
    raw: str
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class SynonymMatch:
    """A domain phrase mapped to its canonical intent label.

    Offsets are intentionally omitted: kinship stripping shifts offsets,
    and no consumer needs to highlight the synonym inside the cleaned text.
    """

    term: str
    canonical: str


@dataclass(frozen=True, slots=True)
class NormalizedResult:
    """Output of :func:`vietnamese_nlp.pipeline.normalize`."""

    original: str
    #: Text after kinship stripping + synonym canonicalisation.
    text: str
    #: First amount found (VND), or None. See ``amounts`` for all of them.
    amount: int | None
    #: Every amount found, in order of appearance.
    amounts: tuple[int, ...] = ()
    money_matches: tuple[MoneyMatch, ...] = ()
    quantities: tuple[QuantityMatch, ...] = ()
    #: Kinship terms that were stripped, in order of appearance.
    titles: tuple[str, ...] = ()
    #: Canonical intent labels detected (sorted, unique).
    intents: tuple[str, ...] = ()
    synonyms: tuple[SynonymMatch, ...] = ()

    def to_dict(self) -> dict:
        """JSON-serialisable view (used by the CLI)."""

        def _num(v: float) -> int | float:
            return int(v) if float(v).is_integer() else v

        return {
            "original": self.original,
            "text": self.text,
            "amount": self.amount,
            "amounts": list(self.amounts),
            "money_matches": [
                {"value": m.value, "raw": m.raw, "start": m.start, "end": m.end}
                for m in self.money_matches
            ],
            "quantities": [
                {
                    "value": _num(q.value),
                    "unit": q.unit,
                    "canonical_unit": q.canonical_unit,
                    "raw": q.raw,
                    "start": q.start,
                    "end": q.end,
                }
                for q in self.quantities
            ],
            "titles": list(self.titles),
            "intents": list(self.intents),
            "synonyms": [
                {"term": s.term, "canonical": s.canonical} for s in self.synonyms
            ],
        }
