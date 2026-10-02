# next8 / Route CL-6 — out-of-domain sentences are not ERP questions

## Why

Phase 8's route corpus (`.plan/next10/corpus.json`, 280 cases, measured on the real
site at git `cc2073b`) locks two C6 sentences whose correct answer is "not an ERP
question": `bật đèn phòng khách` and `cửa hàng mở cửa lúc nào`. Both currently get
**answered with ERP data** because the two BROAD READ groups match a generic noun:
`customer` matches `khách` inside "phòng **khách**" and `inventory` matches `hàng`
inside "cửa **hàng**". 18 of the 20 C6 sentences already resolve to nothing; these
two leak — the exact "broad keyword eats an off-topic sentence" class the audit
named in `res1.md` §4.1.

## What Changes

1. `resolveCapability` (via `routeIntent`) gains an **out-of-domain guard**: a small,
   DENY-only cue list of physical / smart-home / off-topic phrases measured from the
   audit's C6 bucket. A sentence containing one returns **no route** (the pipeline's
   existing `UNKNOWN_INTENT` answer: "ngoài phạm vi").
2. The guard **never adds a route** and never widens a keyword — it only removes a
   broad-keyword match. Every ERP sentence is untouched.

## Out of scope

- No keyword widening, no new capability, no LLM/NLU. The generic nouns `khách`/`hàng`
  stay as route keywords (dozens of passing ERP sentences depend on them).
- No change to `answerQuestion`'s refusal copy (Phase 9 owns wording).

## Impact

- 2 locked corpus cases (C6-225, C6-237) move FAIL → PASS.
- Safety: an off-topic sentence can no longer be answered with a balance/stock figure.
