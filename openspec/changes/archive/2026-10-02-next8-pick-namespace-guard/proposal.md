# next8 / M1 — Pick namespace guard (find-bugs lần 2, finding Medium)

## Why

Review lần 2 của next8 (working.md mục 20) phát hiện M1: `pickRowFromCandidates`
(entity-resolution.mjs) chỉ validate id chống **list của nhánh đang đọc** — không có
khái niệm namespace/kind. Một id hợp lệ về shape nhưng SAI KIND đi xuyên qua cơ chế
refusal bình thường: tap chip `SUP-*` trên một picker KHÁCH (câu nhắc cả hai bên) bị
nhánh customer trả `ENTITY_PICK_STALE`/"không có trong danh sách" — một refusal sai
bản chất (entity còn sống, chỉ là sai loại), làm client/user chẩn đoán sai. Mọi path
VẪN refuse đúng nguyên tắc hint-not-authority (không có leak dữ liệu); đây là vấn đề
chất lượng refusal/UX contract.

## What Changes

1. **`pickIdKindSeries(id)`** (entity-resolution.mjs, export mới): nhận diện series
   tiền tố ERPNext đang dùng trong fixtures/tests: `SUP-` ⇒ "supplier",
   `CUST-` ⇒ "customer", `CAM-` ⇒ "item"; mọi prefix khác/undefined ⇒ null (KHÔNG
   đoán). Không phụ thuộc văn bản câu hỏi — chỉ nhìn id.
2. **Refine refusal, không mở rộng quyền từ chối** — ở CẢ `pickFromCandidates` và
   `pickRowFromCandidates`: khi id KHÔNG có trong list vừa đọc VÀ series của id nhận
   diện được VÀ khác kind của nhánh ⇒ trả `{ok:false, code:"ENTITY_PICK_WRONG_KIND"}`
   thay vì `ENTITY_PICK_INVALID`. Id có trong list luôn thắng bất chấp series (list
   là authority); cùng kind hoặc series lạ ⇒ giữ nguyên `ENTITY_PICK_STALE`/
   `ENTITY_PICK_INVALID` như cũ.
3. **Pipeline copy riêng cho mã mới** (copilot-server.mjs): nhánh supplier READ và
   inventory khi gặp `ENTITY_PICK_WRONG_KIND` trả cùng cấu trúc STALE (fresh chips +
   `rows: []`) nhưng `error_code`/reason nói đúng chuyện "đây là id loại khác, chọn
   lại từ danh sách" — client nhận diagnostics đúng thay vì stale-sai.
4. Không thêm round-trip ERP; không đổi TTL/bailout/bound; hint-not-authority giữ
   nguyên (một id sai kind KHÔNG BAO GIỜ trở thành authority — chỉ đổi NHÃN refusal).

## Impact

- Affected specs: `entity-selection` (ADDED requirement: refusal đúng kind).
- Affected code: `entity-resolution.mjs` (helper + refine 2 hàm pick),
  `uncertainty.mjs` (code + copy `ENTITY_PICK_WRONG_KIND`), `copilot-server.mjs`
  (2 nhánh đọc mã refusal mới).
- Tests: `test/next8-pick-namespace.test.mjs` (TDD đỏ→xanh) + falsify 2 mutation.
