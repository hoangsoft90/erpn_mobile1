# next8 / D4 — Acceptance T1–T16 + đóng next8 (verification-only)

## Why

D1–D3 shipped the fixes (supplier loop, picker safety, shared selection). D4 proves the
plan_final_v3 §11 acceptance table T1–T16 with EXECUTED evidence (not narration), answers
H6 with evidence, verifies no next6/7 regression, and produces the §13 A–H final report
(`.plan/next8/next8-final-result.md`). Verdict `FIXED` only with evidence; otherwise the
report lists the remaining FAILs honestly.

## What Changes

1. **Acceptance tests** for the T-cases not yet pinned end-to-end: T4 (1 match ⇒ no
   picker), T5 (0 match ⇒ MISSING, không giả), T10 (WAITING + câu nghiệp vụ mới ⇒ xử
   turn mới, không bailout), T13 (WRITE ambiguous + amount → handoff mang candidates).
   T1/T2/T3/T9/T11/T12/T14/T15/T16 đã pin ở D1–D3 — D4 chỉ LIỆT KÊ + CHẠY LẠI evidence.
2. **H6 evidence run**: p2-context-uncertainty suite (kinds supplier 30m/item 10m,
   `.ok` checked, expired = first-mention) — CONFIRMED-ĐÃ-VÁ verdict với test output.
3. **No-regression run**: next6 scope (p8/p2/next6 suites) + next7 handoff (A0 suite)
   + Node FULL baseline pair + Flutter analyze/test baseline.
4. **Final report** `.plan/next8/next8-final-result.md` format plan §13 A–H.

## Impact

- Affected specs: `entity-selection` (MODIFIED — acceptance-mapping note only).
- Affected code: NONE (verification-only — prompt-D4 cấm scope mới).
- Tests: new `test/next8-d4-acceptance.test.mjs` (T4/T5/T10/T13), suite re-runs as
  evidence.