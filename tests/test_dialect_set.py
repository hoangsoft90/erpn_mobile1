"""Runs the 3-region corpus in ``tests/data/dialect_cases.json``.

* ``money_cases``    — the gate required by phase-01: **≥95% accuracy**.
* ``kinship_cases``  — every case must pass.
* ``synonym_cases``  — every case must pass.
* ``challenge_cases`` — reported only (see ``report_challenge_set``); these are
  forms Phase 1 does **not** claim to support, and they are deliberately
  excluded from the gate so the published accuracy stays honest.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from vietnamese_nlp import normalize

DATA_FILE = Path(__file__).resolve().parent / "data" / "dialect_cases.json"
ACCURACY_GATE = 0.95

with DATA_FILE.open(encoding="utf-8") as _handle:
    DATA = json.load(_handle)

MONEY_CASES = DATA["money_cases"]
KINSHIP_CASES = DATA["kinship_cases"]
SYNONYM_CASES = DATA["synonym_cases"]
CHALLENGE_CASES = DATA["challenge_cases"]


def money_accuracy() -> tuple[int, int, list[str]]:
    """Return ``(correct, total, failures)`` for the scored money corpus."""
    failures: list[str] = []
    for case in MONEY_CASES:
        actual = normalize(case["text"]).amount
        if actual != case["amount"]:
            failures.append(f"{case['id']} [{case['region']}] {case['text']!r}: got={actual} want={case['amount']}")
    return len(MONEY_CASES) - len(failures), len(MONEY_CASES), failures


class TestMoneyCorpus(unittest.TestCase):
    def test_corpus_is_large_enough(self) -> None:
        self.assertGreaterEqual(len(MONEY_CASES), 200)

    def test_covers_three_regions(self) -> None:
        self.assertEqual(
            {case["region"] for case in MONEY_CASES}, {"bac", "trung", "nam"}
        )

    def test_money_accuracy_meets_gate(self) -> None:
        correct, total, failures = money_accuracy()
        ratio = correct / total
        self.assertGreaterEqual(
            ratio,
            ACCURACY_GATE,
            msg=f"money accuracy {ratio:.2%} ({correct}/{total}) < {ACCURACY_GATE:.0%}\nfailures:\n"
            + "\n".join(failures),
        )

    def test_negative_cases_exist(self) -> None:
        # the corpus must actually exercise the "refuse to guess" path
        negatives = [c for c in MONEY_CASES if c["amount"] is None]
        self.assertGreaterEqual(len(negatives), 20)


class TestKinshipCorpus(unittest.TestCase):
    def test_every_case_matches(self) -> None:
        for case in KINSHIP_CASES:
            with self.subTest(case=case["id"]):
                result = normalize(case["text"])
                self.assertEqual(result.text, case["expected_text"])
                self.assertEqual(list(result.titles), case["expected_titles"])


class TestSynonymCorpus(unittest.TestCase):
    def test_every_case_matches(self) -> None:
        for case in SYNONYM_CASES:
            with self.subTest(case=case["id"]):
                self.assertEqual(
                    list(normalize(case["text"]).intents), sorted(case["expected_intents"])
                )


def report_challenge_set() -> list[str]:
    """Return human-readable lines for the unsupported-forms set."""
    lines: list[str] = []
    for case in CHALLENGE_CASES:
        result = normalize(case["text"])
        lines.append(
            f"{case['id']:>7} {case['text']!r:<38} -> amount={result.amount!r:<12} note={case['note']}"
        )
    return lines


if __name__ == "__main__":
    correct, total, failures = money_accuracy()
    print(f"money accuracy: {correct}/{total} = {correct / total:.2%}")
    for line in failures:
        print("  FAIL", line)
    print("\nchallenge set (NOT part of the gate):")
    for line in report_challenge_set():
        print("  " + line)
    unittest.main(exit=False)
