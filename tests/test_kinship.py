"""Unit tests for the kinship stripper.

Covers every title in :data:`KINSHIP_TITLES` (the phase-01 exit criterion) plus
the two rules that make it safe: a title is kept when no name follows, and
number-words that are also birth-order nicknames are treated as names.
"""

from __future__ import annotations

import unittest

from vietnamese_nlp import KINSHIP_TITLES, normalize, strip_kinship

#: every title, with a sample name behind it -> the title must be removed
TITLE_WITH_NAME: list[tuple[str, str]] = [
    ("Anh", "Nam"),
    ("Chị", "Nguyễn Thị Lan"),
    ("Em", "Nam"),
    ("Cô", "Lan"),
    ("Chú", "Tư"),
    ("Bác", "Hai"),
    ("Ông", "Năm"),
    ("Bà", "Sáu"),
    ("Cậu", "Bảy"),
    ("Dì", "Tám"),
    ("Mợ", "Chín"),
    ("Thím", "Mười"),
    ("Dượng", "Hai"),
    ("Bố", "Nam"),
    ("Ba", "Nam"),
    ("Má", "Lan"),
    ("Mẹ", "Lan"),
    ("Con", "Nam"),
    ("Cháu", "Hoa"),
    ("Cụ", "Bảy"),
    ("Thầy", "Nam"),
]

#: text -> must be returned unchanged with no titles stripped
MUST_NOT_STRIP: list[str] = [
    "Cô",  # title with nothing behind it
    "Cô ơi cho hỏi",  # followed by a particle
    "ba trăm nghìn",  # "trăm" is a scale word, not a name
    "ba mươi nghìn",  # "mươi" must not count as a nickname
    "ba ghi nợ",  # followed by a verb
    "Chi Lan",  # "Chi" (no diacritic) is a name, not the title "Chị"
    # result9 batch-accuracy finding (b12): real ERPNext names CONTAIN titles —
    # a mid-utterance title is part of a stored name, not a vocative.
    "xem phiếu thu của Công trình nhà ông An",
    "nợ của Anh Ba — xây nhà",
]


class TestTitleCoverage(unittest.TestCase):
    def test_every_defined_title_is_stripped_before_a_name(self) -> None:
        for title, name in TITLE_WITH_NAME:
            with self.subTest(title=title):
                cleaned, titles = strip_kinship(f"{title} {name}")
                self.assertEqual(cleaned, name)
                self.assertEqual(titles, (title,))

    def test_title_list_is_fully_exercised(self) -> None:
        covered = {title.lower() for title, _ in TITLE_WITH_NAME}
        self.assertEqual(covered, set(KINSHIP_TITLES))

    def test_multiple_titles_stripped(self) -> None:
        cleaned, titles = strip_kinship("Anh chị Nam")
        self.assertEqual(cleaned, "Nam")
        # titles keep the casing of the spoken utterance
        self.assertEqual(titles, ("Anh", "chị"))


class TestSafety(unittest.TestCase):
    def test_never_strips_when_no_name_follows(self) -> None:
        for text in MUST_NOT_STRIP:
            with self.subTest(text=text):
                cleaned, titles = strip_kinship(text)
                self.assertEqual(titles, ())
                self.assertEqual(cleaned, text)

    def test_scale_words_are_not_names(self) -> None:
        # would corrupt "mươi nghìn" if "mươi" were treated as a nickname
        _, titles = strip_kinship("ba mươi nghìn")
        self.assertEqual(titles, ())

    def test_birth_order_nicknames_are_names(self) -> None:
        for nickname in ("Hai", "Ba", "Tư", "Năm", "Sáu", "Bảy", "Tám", "Chín", "Mười"):
            with self.subTest(nickname=nickname):
                cleaned, titles = strip_kinship(f"Bác {nickname}")
                self.assertEqual(cleaned, nickname)
                self.assertEqual(titles, ("Bác",))

    def test_titles_are_reported(self) -> None:
        result = normalize("Anh Nam trả 10 triệu")
        self.assertEqual(result.titles, ("Anh",))
        self.assertEqual(result.text, "Nam trả 10 triệu")

    def test_linh_after_a_title_is_a_name(self) -> None:
        # F7-2 session (Golden k18): "linh" is in money.py's FILLERS, but after
        # a title it is a common given name. The title is the evidence.
        cleaned, titles = strip_kinship("Con Linh còn nợ bao nhiêu")
        self.assertEqual(cleaned, "Linh còn nợ bao nhiêu")
        self.assertEqual(titles, ("Con",))

    def test_linh_without_a_title_is_not_stripped_from_fillers(self) -> None:
        # No title before "linh" ⇒ the stripper never fires and the filler
        # behaviour of the money layer is untouched.
        cleaned, titles = strip_kinship("linh tinh")
        self.assertEqual(cleaned, "linh tinh")
        self.assertEqual(titles, ())


if __name__ == "__main__":
    unittest.main()
