# next8 / D4 — tasks

## 1. Acceptance tests (T-cases chưa pin E2E)

- [x] T4: supplier 1 match (exact) ⇒ detail, KHÔNG picker (`candidates: []`).
- [x] T4b: item 1 match (fuzzy-single READ) ⇒ auto-select theo policy, KHÔNG chips.
- [x] T5: 0 match ⇒ MISSING/SUPPLIER_NOT_FOUND, không giả entity.
- [x] T10: WAITING (picker đang chờ) + câu nghiệp vụ mới rõ (`doanh thu hôm nay`)
      ⇒ xử lý turn mới bình thường, KHÔNG bailout, KHÔNG kế thừa candidates.
- [x] T13: WRITE ambiguous + amount trong câu ⇒ handoff payment.create với
      AMBIGUOUS_ENTITY + candidates (amount chờ pick, không tự chạy).

## 2. Re-run evidence (đã pin D1–D3 — chạy lại lấy output)

- [x] T1/T2/T3/T9 (supplier loop) — next8-entity-pick 4/4.
- [x] T11/T12/T14 (bailout/limit/stale) — next8-picker-safety 5/5.
- [x] T15/T16 (double-tap/TTL) — Flutter next8_picker_safety 5/5.
- [x] T6/T7/T8 (shared + WRITE bind) — next8-d3-shared 7/7.

## 3. H6 evidence

- [x] p2-context-uncertainty suite (kinds + .ok + expired-first-mention) — output.

## 4. No-regression (next6/next7)

- [x] next7-a0-dsh-write-handoff (A0–A2 handoff + execute bound id).
- [x] Node FULL baseline pair + Flutter analyze/test baseline.

## 5. Final report

- [x] `.plan/next8/next8-final-result.md` format plan §13 A–H + bảng T1–T16 trỏ
      evidence; verdict FIXED chỉ khi đủ.
