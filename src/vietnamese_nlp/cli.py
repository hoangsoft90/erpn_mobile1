"""CLI for the pipeline — no LLM, no ERPNext, no network.

Examples::

    python -m vietnamese_nlp "Anh Nam trả 10 triệu 500 nghìn tiền cám"
    python -m vietnamese_nlp --pretty "Cô Ba mua 20 bao cám 25 ký, còn nợ 5 triệu"
    echo "Bác Hai trả 2tr5" | python -m vietnamese_nlp
    python -m vietnamese_nlp --file sentences.txt
"""

from __future__ import annotations

import argparse
import json
import sys

from .pipeline import normalize


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m vietnamese_nlp",
        description="Normalise Vietnamese text (money, kinship titles, domain synonyms).",
    )
    parser.add_argument("text", nargs="*", help="text to normalise (omit to read stdin)")
    parser.add_argument("--file", help="read one sentence per line from a UTF-8 file")
    parser.add_argument(
        "--pretty", action="store_true", help="indent the JSON output"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.file:
        with open(args.file, encoding="utf-8") as handle:
            sentences = [line.rstrip("\n") for line in handle if line.strip()]
    elif args.text:
        sentences = [" ".join(args.text)]
    else:
        sentences = [line.rstrip("\n") for line in sys.stdin if line.strip()]

    if not sentences:
        _build_parser().print_help(sys.stderr)
        return 2

    indent = 2 if args.pretty else None
    results = [normalize(sentence).to_dict() for sentence in sentences]
    payload = results[0] if len(results) == 1 else results
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=indent)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
