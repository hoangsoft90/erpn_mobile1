"""Unit tests for the domain synonym mapper.

Exit criterion: every phrase defined in :data:`SYNONYM_GROUPS` is covered.
Also locks in the deliberate decision that **product nouns are not mapped** —
``cám heo`` must survive intact so ERPNext can find the Item.
"""

from __future__ import annotations

import unittest

from vietnamese_nlp import SYNONYM_GROUPS, SYNONYM_TERMS, map_synonyms, normalize


class TestGroupCoverage(unittest.TestCase):
    def test_every_phrase_maps_to_its_canonical_label(self) -> None:
        for canonical, phrases in SYNONYM_GROUPS.items():
            for phrase in phrases:
                with self.subTest(phrase=phrase):
                    cleaned, matches = map_synonyms(phrase)
                    self.assertEqual(cleaned, canonical)
                    self.assertEqual(len(matches), 1)
                    self.assertEqual(matches[0].canonical, canonical)

    def test_canonical_labels_are_unique_phrases(self) -> None:
        # a phrase must never belong to two groups
        self.assertEqual(len(SYNONYM_TERMS), sum(len(v) for v in SYNONYM_GROUPS.values()))

    def test_no_group_is_empty(self) -> None:
        for canonical, phrases in SYNONYM_GROUPS.items():
            with self.subTest(canonical=canonical):
                self.assertTrue(phrases)


class TestPhraseHandling(unittest.TestCase):
    def test_longest_phrase_wins(self) -> None:
        # "thanh toán nợ" must not degrade into "thanh toán"
        cleaned, matches = map_synonyms("thanh toán nợ")
        self.assertEqual(cleaned, "payment")
        self.assertEqual(matches[0].term, "thanh toán nợ")

    def test_inside_a_sentence(self) -> None:
        cleaned, matches = map_synonyms("Anh Nam ghi nợ 5 triệu")
        self.assertEqual(cleaned, "Anh Nam credit_sale 5 triệu")
        self.assertEqual([m.canonical for m in matches], ["credit_sale"])

    def test_two_intents_in_one_sentence(self) -> None:
        result = normalize("Anh Nam mua hàng ghi nợ")
        self.assertEqual(result.intents, ("credit_sale", "purchase"))

    def test_case_insensitive(self) -> None:
        self.assertEqual(normalize("GHI NỢ").intents, ("credit_sale",))
        self.assertEqual(normalize("Thu Tiền").intents, ("payment",))

    def test_word_boundaries_respected(self) -> None:
        # "tro" must not match inside another word
        self.assertEqual(normalize("cám trộn").intents, ())


class TestProductNounsAreNotIntents(unittest.TestCase):
    def test_cam_heo_is_preserved(self) -> None:
        result = normalize("20 bao cám heo 25 ký")
        self.assertEqual(result.intents, ())
        self.assertIn("cám heo", result.text)

    def test_item_name_reaches_llm_intact(self) -> None:
        result = normalize("mua 20 bao cám gà 25 ký")
        self.assertIn("cám gà", result.text)


class TestUnmappedText(unittest.TestCase):
    def test_text_is_untouched_without_synonyms(self) -> None:
        for text in ("không có gì", "Anh Nam trả 10 triệu tiền cám", ""):
            with self.subTest(text=text):
                cleaned, matches = map_synonyms(text)
                self.assertEqual(cleaned, text)
                self.assertEqual(matches, ())


if __name__ == "__main__":
    unittest.main()
