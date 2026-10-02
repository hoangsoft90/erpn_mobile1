"""The single entry point of the Vietnamese NLP pipeline.

Order matters and is deliberate::

    raw text
      -> money extraction      (on the ORIGINAL text, so spans stay usable for UI)
      -> quantity extraction   (idem)
      -> kinship stripping     (shifts offsets, so it runs after the above)
      -> synonym canonicalisation
      -> NormalizedResult

Running the extractors first means ``MoneyMatch.start/end`` always point into
``NormalizedResult.original``, which is what a UI needs to highlight the amount
the user actually said.
"""

from __future__ import annotations

from .kinship import strip_kinship
from .money import find_amounts
from .quantity import find_quantities
from .result import NormalizedResult
from .synonyms import map_synonyms


def normalize(text: str) -> NormalizedResult:
    """Normalise one Vietnamese utterance.

    Never raises on odd input: anything that cannot be parsed with confidence is
    simply reported as absent (``amount is None``) instead of guessed.
    """
    if text is None:
        raise TypeError("text must be a str, got None")
    if not isinstance(text, str):
        raise TypeError(f"text must be a str, got {type(text).__name__}")

    money_matches = find_amounts(text)
    quantities = find_quantities(text)

    cleaned, titles = strip_kinship(text)
    cleaned, synonyms = map_synonyms(cleaned)

    amounts = tuple(m.value for m in money_matches)
    intents = tuple(sorted({s.canonical for s in synonyms}))

    return NormalizedResult(
        original=text,
        text=cleaned,
        amount=amounts[0] if amounts else None,
        amounts=amounts,
        money_matches=money_matches,
        quantities=quantities,
        titles=titles,
        intents=intents,
        synonyms=synonyms,
    )
