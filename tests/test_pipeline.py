"""End-to-end tests for the pipeline, its result shape and the CLI.

These must run with no LLM, no ERPNext and no network — that is the phase-01
exit criterion "pipeline chạy độc lập".
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from vietnamese_nlp import NormalizedResult, normalize

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"


class TestNormalizeShape(unittest.TestCase):
    def test_returns_normalized_result(self) -> None:
        self.assertIsInstance(normalize("Anh Nam trả 10 triệu"), NormalizedResult)

    def test_full_example(self) -> None:
        result = normalize("Anh Nam trả 10 triệu 500 nghìn tiền cám")
        self.assertEqual(result.original, "Anh Nam trả 10 triệu 500 nghìn tiền cám")
        self.assertEqual(result.text, "Nam trả 10 triệu 500 nghìn tiền cám")
        self.assertEqual(result.amount, 10_500_000)
        self.assertEqual(result.amounts, (10_500_000,))
        self.assertEqual(result.titles, ("Anh",))

    def test_quantity_entity(self) -> None:
        result = normalize("Chị Lan mua 20 bao cám 25 ký")
        self.assertEqual(
            [(q.value, q.canonical_unit) for q in result.quantities],
            [(20.0, "bao"), (25.0, "kg")],
        )

    def test_quantity_is_not_money(self) -> None:
        result = normalize("mua 25 ký cám")
        self.assertIsNone(result.amount)
        self.assertEqual([q.canonical_unit for q in result.quantities], ["kg"])

    def test_money_and_quantity_together(self) -> None:
        result = normalize("Bác Hai lấy 100 bao cám, giá 320 nghìn một bao")
        self.assertEqual(result.amount, 320_000)
        self.assertEqual(result.titles, ("Bác",))
        self.assertEqual([q.value for q in result.quantities], [100.0])

    def test_empty_and_whitespace_input(self) -> None:
        for text in ("", "   ", "\n"):
            with self.subTest(text=text):
                result = normalize(text)
                self.assertIsNone(result.amount)
                self.assertEqual(result.amounts, ())
                self.assertEqual(result.intents, ())

    def test_rejects_non_str(self) -> None:
        with self.assertRaises(TypeError):
            normalize(123)  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            normalize(None)  # type: ignore[arg-type]

    def test_result_is_immutable(self) -> None:
        result = normalize("Anh Nam trả 10 triệu")
        with self.assertRaises(Exception):
            result.amount = 1  # type: ignore[misc]

    def test_to_dict_is_json_serialisable(self) -> None:
        payload = normalize("Chị Lan ghi nợ 5 triệu, mua 20 bao cám").to_dict()
        json.dumps(payload, ensure_ascii=False)
        self.assertEqual(payload["amount"], 5_000_000)
        self.assertEqual(payload["intents"], ["credit_sale"])


class TestDeterminism(unittest.TestCase):
    def test_same_input_same_output(self) -> None:
        text = "Bác Hai trả 2tr5 tiền cám heo"
        self.assertEqual(normalize(text), normalize(text))


class TestCli(unittest.TestCase):
    def _run(self, *args: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ)
        env["PYTHONPATH"] = str(SRC_DIR) + os.pathsep + env.get("PYTHONPATH", "")
        return subprocess.run(
            [sys.executable, "-m", "vietnamese_nlp", *args],
            capture_output=True,
            text=True,
            input=stdin,
            env=env,
            cwd=str(REPO_ROOT),
            check=False,
        )

    def test_positional_text(self) -> None:
        proc = self._run("Anh Nam trả 10 triệu")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["amount"], 10_000_000)

    def test_stdin(self) -> None:
        proc = self._run(stdin="Chị Lan ghi nợ 5 triệu\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["intents"], ["credit_sale"])

    def test_multiple_lines_return_a_list(self) -> None:
        proc = self._run(stdin="mười triệu\n500 ngàn\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual([row["amount"] for row in payload], [10_000_000, 500_000])

    def test_pretty_flag(self) -> None:
        proc = self._run("--pretty", "10tr")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("\n  ", proc.stdout)

    def test_no_input_exits_with_usage(self) -> None:
        proc = self._run(stdin="")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
