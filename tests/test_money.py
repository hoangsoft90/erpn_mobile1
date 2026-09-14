"""Unit tests for the money normalizer.

The ``REQUIRED_FORMS`` table mirrors the pattern list in
``.plan/phases/phase-01-vietnamese-nlp-pipeline.md`` / the Phase 1 task exactly.
The ``MUST_NOT_PARSE`` table is the safety contract: no amount may ever be
invented from a bare word-number or an ambiguous fragment.
"""

from __future__ import annotations

import unittest

from vietnamese_nlp import find_amounts, normalize

#: patterns Phase 1 explicitly requires
REQUIRED_FORMS: list[tuple[str, int]] = [
    ("mười triệu", 10_000_000),
    ("10 triệu", 10_000_000),
    ("10tr", 10_000_000),
    ("mười củ", 10_000_000),
    ("một chục triệu", 10_000_000),
    ("hai trăm ba mươi nghìn", 230_000),
    ("230k", 230_000),
    ("230.000", 230_000),
    ("một trăm hai mươi lăm triệu", 125_000_000),
    ("năm trăm nghìn", 500_000),
    ("500 ngàn", 500_000),
    ("0.5 triệu", 500_000),
    ("10 triệu 500 nghìn", 10_500_000),
    ("2 triệu rưỡi", 2_500_000),
]

#: utterances that must yield NO amount (guessing money is worse than asking)
MUST_NOT_PARSE: list[str] = [
    "Bác Hai",
    "Cô Ba",
    "Ông Năm",
    "Chú Tư",
    "hai trăm",
    "ba trăm",
    "Anh Nam còn nợ bao nhiêu",
    "anh Nam trả 10",
    "trả 500",
    "mua 25 ký cám",
    "kho còn 30 bao",
    "chị Lan mua ba bao cám",
    "Anh Nam trả",
    "không có gì",
    "không triệu",  # must not become 1.000.000
    "không đồng",
    "2 triệu 500",  # ambiguous trailing bare number
    "3 củ 5",
    "10 triệu năm",
    # shape guards (see money.py docstring) — look numeric, are never money
    "gọi anh Nam 0912345678",
    "anh Nam ở nhà 1234",
    "tổng doanh thu 2024",
    "số lượng 2000 bao",
    "mua 5 củ cải",
    "mua 5 củ cải đường",
    "mua 2 chai nước",
    "anh Nam trả 2000",  # bare 4-digit year shape -> declined on purpose
    # digit<->word/scale runs created by the digit-only lookahead — money is
    # never written like this, so they must be refused instead of merged
    "anh Nam trả 2tr5k",  # scale glued on scale (2.5 triệu × 1000!)
    "anh Nam trả 2024năm",
    "anh Nam trả 2024rưỡi",
    "anh Nam trả 2tr50",  # 2 triệu 50? 2.500.000? 250k? -> ambiguous
]


class TestRequiredForms(unittest.TestCase):
    def test_every_required_pattern_parses(self) -> None:
        for text, expected in REQUIRED_FORMS:
            with self.subTest(text=text):
                self.assertEqual(normalize(text).amount, expected)

    def test_amount_is_int_not_str(self) -> None:
        result = normalize("mười triệu")
        self.assertIsInstance(result.amount, int)
        self.assertNotIsInstance(result.amount, bool)

    def test_all_amounts_are_int(self) -> None:
        result = normalize("trả 10 triệu, còn nợ 2 triệu rưỡi")
        self.assertEqual(result.amounts, (10_000_000, 2_500_000))
        for value in result.amounts:
            self.assertIsInstance(value, int)


class TestSafetyNegatives(unittest.TestCase):
    def test_no_amount_invented(self) -> None:
        for text in MUST_NOT_PARSE:
            with self.subTest(text=text):
                self.assertIsNone(normalize(text).amount, msg=f"invented money for {text!r}")

    def test_bare_number_word_is_not_money(self) -> None:
        # "Bác Hai" must never become 2 VND
        self.assertEqual(find_amounts("Bác Hai"), ())
        self.assertEqual(find_amounts("Anh Nam"), ())


class TestSpans(unittest.TestCase):
    def test_spans_point_into_original_text(self) -> None:
        text = "Anh Nam trả 10 triệu"
        match = find_amounts(text)[0]
        self.assertEqual(text[match.start : match.end], "10 triệu")
        self.assertEqual(match.raw, "10 triệu")


class TestAmbiguityIsNotGuessed(unittest.TestCase):
    def test_two_amounts_reported_in_order(self) -> None:
        result = normalize("Anh Nam còn nợ 15 triệu, hôm nay trả 5 triệu")
        self.assertEqual(result.amounts, (15_000_000, 5_000_000))
        # `amount` is the first one; the caller decides which it wants
        self.assertEqual(result.amount, 15_000_000)

    def test_punctuation_splits_expressions(self) -> None:
        result = normalize("Đơn này 250 nghìn, đơn kia 180 nghìn")
        self.assertEqual(result.amounts, (250_000, 180_000))

    def test_consecutive_bare_numbers_do_not_merge(self) -> None:
        # "10 20" is ambiguous -> refuse rather than invent 30 (or 1020)
        self.assertEqual(find_amounts("10 20"), ())

    def test_space_separated_thousands_still_works(self) -> None:
        # "1 500 000" is a real Vietnamese format and is the documented exception
        self.assertEqual(normalize("1 500 000").amount, 1_500_000)
        self.assertEqual(normalize("10 000 000").amount, 10_000_000)


class TestSouthernSlangScales(unittest.TestCase):
    """``trẹo`` / ``chai`` = triệu (miền Nam) — added in the Phase 1 follow-up fix."""

    CASES: list[tuple[str, int]] = [
        ("Anh Nam trả hai trẹo", 2_000_000),
        ("Chị Lan trả một chai", 1_000_000),
        ("Bác Tâm trả ba trẹo", 3_000_000),
        ("Cô Bích trả bốn chai", 4_000_000),
        ("chú Bảy trả một trẹo rưỡi", 1_500_000),
    ]

    def test_slang_scales_are_money(self) -> None:
        for text, expected in self.CASES:
            with self.subTest(text=text):
                self.assertEqual(normalize(text).amount, expected)

    def test_slang_word_as_a_real_object_is_not_money(self) -> None:
        # "chai" (bottle) and "củ" (tuber) must not silently become millions
        for text in ("mua 2 chai nước", "mua 5 củ cải", "mua 5 củ cải đường"):
            with self.subTest(text=text):
                self.assertIsNone(normalize(text).amount)


class TestShapeGuards(unittest.TestCase):
    """Shapes that look numeric but are never money (see ``money.py`` docstring).

    Every guard fails towards *no amount*: asking the user is recoverable,
    writing a wrong payment is not.
    """

    def test_phone_number_is_not_money(self) -> None:
        for text in ("gọi anh Nam 0912345678", "sđt 0987654321"):
            with self.subTest(text=text):
                self.assertIsNone(normalize(text).amount)

    def test_year_is_not_money_without_currency_suffix(self) -> None:
        self.assertIsNone(normalize("tổng doanh thu 2024").amount)
        # ...but an explicit suffix still wins
        self.assertEqual(normalize("anh Nam trả 2000 đ").amount, 2000)

    def test_identifier_context_is_not_money(self) -> None:
        for text in ("anh Nam ở nhà 1234", "mã số 5000", "số lượng 2000 bao"):
            with self.subTest(text=text):
                self.assertIsNone(normalize(text).amount)

    def test_ambiguous_nouns_are_not_treated_as_identifiers(self) -> None:
        # "đơn" is both "order code" and "order" — guarding on it rejected real
        # utterances, so it is deliberately NOT in _ID_CONTEXT_WORDS.
        self.assertEqual(normalize("mỗi đơn 5000").amount, 5000)
        self.assertEqual(normalize("đơn này 5000").amount, 5000)


class TestGluedCurrencySuffix(unittest.TestCase):
    """Currency suffix written WITHOUT a space ("2000đ", "5000vnd").

    Before the fix the ``(?!(w))`` lookahead made these untokenisable — and
    worse, ``"1 500 000đ"`` silently emitted **1500**. Every case below is a
    regression guard for that.
    """

    GLUED: list[tuple[str, int]] = [
        ("anh Nam trả 2000đ", 2_000),
        ("anh Nam trả 5000vnd", 5_000),
        ("anh Nam trả 500đồng", 500),
        ("anh Nam trả 2tr5đ", 2_500_000),
        ("anh Nam trả 230.000đ", 230_000),
        ("anh Nam trả 1 500 000đ", 1_500_000),  # was silently 1500 before the fix
    ]

    def test_glued_suffix_is_money(self) -> None:
        for text, expected in self.GLUED:
            with self.subTest(text=text):
                self.assertEqual(normalize(text).amount, expected)

    def test_spaced_suffix_still_works(self) -> None:
        for text, expected in (("anh Nam trả 2000 đ", 2_000), ("anh Nam trả 500 đồng", 500)):
            with self.subTest(text=text):
                self.assertEqual(normalize(text).amount, expected)

    def test_glued_garbage_runs_are_refused(self) -> None:
        # "2tr5k" merged scales into 2.500.000.000 before the guard existed
        for text in ("anh Nam trả 2tr5k", "anh Nam trả 2024năm", "anh Nam trả 2024rưỡi"):
            with self.subTest(text=text):
                self.assertIsNone(normalize(text).amount)


if __name__ == "__main__":
    unittest.main()
