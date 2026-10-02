# next8 / M1 — pick namespace guard — tasks

## 1. TDD đỏ

- [x] T1: câu khách + `entity_id: "SUP-HATIEN"` (supplier sống, không có trong
      list khách) ⇒ `ENTITY_PICK_WRONG_KIND` + reason nói rõ lệch kind (đỏ: hiện
      `ENTITY_PICK_STALE`). *(E2E dùng supplier branch + CUST-00001 — surface
      observable; nhánh customer giữ contract D0, refusal chỉ lên stderr)*
- [x] T2 (guard list-authority): id CÓ trong list luôn resolve bất chấp series —
      unit test với row id lệch series. *(= U1)*
- [x] T3 (guard same-kind): `SUP-99999` trên nhánh supplier vẫn `ENTITY_PICK_STALE`.
- [x] T4 (guard series lạ): id 140 ký tự không tiền tố vẫn `ENTITY_PICK_STALE`.

## 2. Implement

- [x] `entity-resolution.mjs`: export `pickIdKindSeries(id)` + `ENTITY_KIND_SERIES`;
      refine refusal trong `pickFromCandidates` + `pickRowFromCandidates`.
- [x] `uncertainty.mjs`: `ENTITY_PICK_WRONG_KIND` + copy "chọn lại từ danh sách".
- [x] `copilot-server.mjs`: nhánh supplier READ + inventory nhận diện mã mới ⇒
      error_code/reason riêng, fresh chips đứng lại (inventory `rows: []`).

## 3. Xanh + chống hồi quy

- [x] Test mới xanh (đỏ đúng lý do: U3/T1/T5). **8/8** (U1–U4 + T1/T3/T4/T5).
- [x] Falsify 2 mutation `scripts/falsify/next8-m1-namespace.mjs`: F1 bỏ refine ⇒
      U3+T1+T5 đỏ ✅; F2 series-override-list ⇒ U1 đỏ ✅; restore byte-identical.
- [x] Targeted: 8 suite next8-* + p2 + http-ask — **44/44**.
- [x] Node FULL baseline pair: **925/923/2** (đúng 2 fail env dsh).

## 4. Sổ sách

- [x] `.plan/next8/m1-namespace-result.md` + `working.md` + tick tasks.md;
      trình user duyệt (KHÔNG tự commit — chạm vùng refusal/validation).
