# next8 / Review hardening — tasks

## 1. TDD đỏ

- [x] `test/next8-review-hardening.test.mjs`: T-A: `/ask` + `entity_id` 141+ ký tự
      ⇒ HTTP 400 `DSH_GATEWAY_BAD_REQUEST` (đỏ: hiện 200).
- [x] T-B: cả 2 route + `entity_id` đúng 140 ký tự ⇒ 200 `ENTITY_PICK_STALE`
      (không đổi hành vi với id trong hợp đồng).
- [x] T-C: `tồn kho cám` (chưa pick) ⇒ stderr KHÔNG có dòng
      `session context write refused` (đỏ: hiện có).
- [x] T-D: pin cap của `/dsh/ask` (141+ ⇒ 400) — guard chống drift 2 chuẩn.

## 2. Implement

- [x] `http-ask.mjs`: export `MAX_ENTITY_ID_LENGTH = 140`; `/ask` check như
      `/dsh/ask`; `/dsh/ask` dùng chung hằng (xoá literal 140).
- [x] `copilot-server.mjs`: xoá block `set("item", {id: null, …})` (L1183-1194)
      — chỉ set sau khi có pick thật; giữ nguyên .ok-check ở 3 call site thật.

## 3. Xanh + no-regression

- [x] Test mới 4/4 xanh (sau khi đỏ đúng lý do).
- [x] Targeted: http-ask + next8-entity-pick + next8-picker-safety +
      next8-d3-shared + next8-d4-acceptance + p2-context-uncertainty — **36/36**.
- [x] Node FULL baseline pair: **917/915/2** (đúng 2 fail env baseline).

## 4. Sổ sách

- [x] `.plan/next8/review-hardening-result.md` (A–H ngắn).
- [x] `working.md` mục mới; tick tasks.md đủ; trình user duyệt (KHÔNG tự commit).
