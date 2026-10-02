## Why

C1 made `sales.summary` answer the shop's **today** — and C2's REAL probe (2026-09-27,
`.plan/next7/C2-result.md`) named the gap it left: the chat path never handed a day to the skill, so
the day came from the skill's own clock. "Doanh thu ngày 15/9" would have answered with **today's**
number inside a sentence that also said "hôm nay": a wrong day is a wrong money figure, and the
shopkeeper has no way to notice.

The router already understands the sentence (keyword `doanh thu`). The classifier's `date_text` slot
cannot help: it only runs when the keyword router MISSES, and a "doanh thu …" sentence never misses.
So the day has to be read **deterministically**, in the money path, with no model in the loop.

## What Changes

- **The question may name its own day** — `mcp-erpnext/src/day-phrase.mjs` (new, pure: no clock, no
  ERP, no I/O) reads ONE day out of the sentence the pipeline routed on (`nlp.text`):
  - `hôm nay` · `hôm qua` · `hôm kia` (and their unaccented spellings — the routing keywords ship
    unaccented forms too)
  - `15/9` · `15/9/2026` · `15-9-2026` · `15.9.2026` · `2026-09-15` · `ngày 15 tháng 9 [năm 2026]`
    (unaccented too)
- **A day that cannot be pinned is a REFUSAL, never a quiet "today"** (user decision 2026-09-27;
  fail-closed like the rest of the money path):
  - a PERIOD (`tuần/tháng/quý/năm`, "mấy ngày nay", "3 ngày qua") ⇒ `KNOWN_INTENT_UNIMPLEMENTED`
    — understood, not built
  - an unusable day (an impossible date like `31/2`, a future day, a year-less day still to come
    this year, a 2-digit year, a vague "hôm trước"/"bữa nọ", two different days in one sentence)
    ⇒ `DAY_PHRASE_INVALID`
- **Pipeline:** `answerQuestion()` resolves the day BEFORE the company guard (it is about the
  QUESTION, not about a book) and passes it to `getSalesSummary({date})`; the refusal carries the
  Vietnamese sentence the screen shows. A question that names no day keeps C1's behaviour exactly.
- **The answer names the day it read:** the ISO day is printed as before, plus `(hôm qua)` /
  `(hôm kia)` when that is what it is — so a past-day figure cannot read as today's.
- **Contract/taxonomy:** `sales.summary.errors[]` gains `DAY_PHRASE_INVALID`; the new code is added
  to the uncertainty taxonomy WITH its Vietnamese copy (a refusal without words is a dead end).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `sales.summary` — the day is now read from the sentence, and an unpinnable day is refused.

## Impact

- **Files:** `mcp-erpnext/src/day-phrase.mjs` (new) · `src/copilot-server.mjs` (branch: day phrase +
  `date` argument + day word in the answer) · `src/uncertainty.mjs` (`DAY_PHRASE_INVALID` + copy) ·
  `capabilities.json` (description + one declared error) · `test/next7-c3-day-phrase.test.mjs`
  (new) · `scripts/falsify/next7-day-phrase.mjs` (new).
- **Public shape touched:** one new refusal code (`DAY_PHRASE_INVALID`) and one already-existing code
  reused for a period (`KNOWN_INTENT_UNIMPLEMENTED`). `error_code` travels to the client as a plain
  string, and the refusal text the chat renders comes from `answer ?? reason`, so no client change
  is needed — the Flutter side does not read `sales_summary` at all.
- **NOT touched:** the `/read/daily-summary` + drill paths (their `date` argument is unchanged) ·
  Payment Entries · no write path, no `/execute`, no DSH behaviour change, no voice, no Flutter code.
- Suite after the change: **Node 880 — 880 pass, 0 fail** (was 871) · falsify
  `next7-day-phrase` **10/10 RED**, restore byte-identical.
