"""Rule-based Vietnamese text normalisation for the ERPNext voice copilot.

Runs **before** any LLM call, so money, vocatives and domain wording are fixed
by code rather than by prompt engineering::

    >>> from vietnamese_nlp import normalize
    >>> normalize("Anh Nam trả 10 triệu 500 nghìn tiền cám").amount
    10500000

Zero runtime dependencies (standard library only).
"""

from __future__ import annotations

from .kinship import KINSHIP_TITLES, strip_kinship
from .money import find_amounts
from .pipeline import normalize
from .quantity import find_quantities
from .result import MoneyMatch, NormalizedResult, QuantityMatch, SynonymMatch
from .synonyms import SYNONYM_GROUPS, SYNONYM_TERMS, map_synonyms

__all__ = [
    "KINSHIP_TITLES",
    "MoneyMatch",
    "NormalizedResult",
    "QuantityMatch",
    "SYNONYM_GROUPS",
    "SYNONYM_TERMS",
    "SynonymMatch",
    "find_amounts",
    "find_quantities",
    "map_synonyms",
    "normalize",
    "strip_kinship",
]

__version__ = "0.1.0"
