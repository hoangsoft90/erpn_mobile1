# next7 / C3 — tasks

## 1. Read the day

- [x] `src/day-phrase.mjs`: `readDayPhrase(text, {today})` — pure, no clock (the caller passes
      `today`), returns `{ok:true, date}` or `{ok:false, code, reason}`.
- [x] Understood forms: `hôm nay` / `hôm qua` / `hôm kia` (+ unaccented), `d/m`, `d/m/yyyy`,
      `d-m-yyyy`, `d.m.yyyy`, `yyyy-mm-dd`, `ngày d tháng m [năm yyyy]` (+ unaccented).
- [x] Refusals: period (`KNOWN_INTENT_UNIMPLEMENTED`), impossible / future / year-less-future /
      2-digit-year / vague day / two days (`DAY_PHRASE_INVALID`).
- [x] Boundaries measured, not assumed: `\b` is unusable around Vietnamese diacritics (probed:
      `quý` failed, `tuần` passed) ⇒ letter/mark/number lookarounds; a number followed by a money
      word is money, not a day (`1/5 triệu` ≠ 1 May); "chị Năm" / "anh Nam" are people, not periods.

## 2. Carry the day through the pipeline

- [x] `answerQuestion()` — the day is resolved before the company guard, and an unusable day is
      refused with its Vietnamese reason (no `sales_summary`, no proposal).
- [x] `getSalesSummary({date: day.date ?? today})` — one clock reading for the answer and the read.
- [x] The answer names the day it read (`… (hôm qua)` / `… (hôm kia)` only when that is the day).

## 3. Contract & taxonomy

- [x] `uncertainty.mjs`: `DAY_PHRASE_INVALID` + Vietnamese copy (the copy loop enforces it).
- [x] `capabilities.json`: `sales.summary` description documents the day phrase and the refusal
      policy; `errors[]` gains `DAY_PHRASE_INVALID`.

## 4. Tests

- [x] Unit: understood forms, refusals (each code), no-day ⇒ `null`, month/year boundaries,
      leap day, money-vs-date, people-vs-period, `today` required.
- [x] Taxonomy: every code this layer can emit maps onto the taxonomy and carries copy.
- [x] E2E (real NLP + real copilot + mock): `hôm qua` and an explicit `dd/mm/yyyy` read THAT day,
      the number is derived from the fixture rows, `abs(chat − drawer) == 0` on that day, `hôm nay`
      is unchanged, and the refusal cases refuse with copy.
- [x] Time safety: pure tests inject `today`; the E2E fixture is built from `vnDay()` (no hard-coded
      date in the fixtures).

## 5. Falsify

- [x] `scripts/falsify/next7-day-phrase.mjs`: 10 mutations, each turning the NAMED test red
      (refusal bypass, period rule, future day, two days, day ignored at the call, day word dropped,
      `\b` regression, money-vs-date, relative offsets, taxonomy code removed) — restore
      byte-identical.

## 6. Out of scope (named, not silently dropped)

- [ ] Period revenue (tuần/tháng/quý/năm) — refused by design in C3; it is a different read (many
      days) and needs its own measurement gate.
- [ ] A date picker in the app for `DAY_PHRASE_INVALID` — the code exists for it; no UI work here.
- [ ] The drawer's own day picker/drills — untouched (they already take a `date` argument).
