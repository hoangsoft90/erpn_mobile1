# next8 / Purchase vertical — tasks

> Phase 7 của `.plan/next8/phases/phase-07-purchase-vertical.md` · Program A · vùng **TIỀN + KHO**
> ⇒ **KHÔNG tự commit**, trình owner duyệt.
> Locks áp dụng: §6.1 (1 phương thức = 1 PE) · §6.2 (tài khoản đúng loại hoặc BLOCK) · §6.3
> (KHÔNG mượn cho NCC) · §14 (Purchase contract) · §15 (party type từ capability).
> Nguồn phải đọc trước khi code: `plan1_final_v2.md` §14/§15/§31 + `phases/phase-00-audit.md` §2.2
> + `phase7-audit.md`.

## 0. Sự thật ĐÃ ĐO trên site (dùng thẳng — xem `.plan/next8/phase7-audit.md`)

- Chứng từ chính = **Purchase Invoice (PI)**: all=65 · submitted=45 · cancelled=20; `credit_to="2110"`
  · `update_stock=1` · `naming_series="ACC-PINV-.YYYY.-"` · `outstanding_amount` có.
- PR all=12 (submitted 10) phải theo PO; PO all=9 (draft 4, submitted 5).
- Giá mua: **`Item Price` `buying=1`** — CAM-HEO-25KG `Standard Buying:295.000/Bao` (vs Selling 320.000).
- Company defaults: bank `1210 - ACB 110296868 - MP` · cash `1110` · payable `2110` · receivable `1310`
  · cost center `Main - MP` · inventory `1410 - Hàng tồn kho - MP`.
- `Buying Settings` SINGLE ⇒ `buying_price_list="Standard Buying"`; supplier `default_price_list=null`.
- Pay PE thật: `paid_from` ngân quỹ (`1110`/`1210`) · `paid_to=2110` · mode Cash/Chuyển khoản/Wire Transfer.
- `frappe.client.get_meta` PI/PR/PO = **417** ⇒ chưa lấy được reqd list; dựa vào builder sẵn có.

**Owner chốt 2026-10-01 (trong phiên)**: trả NCC = **(A) tái dùng `payment.create`** nhánh Pay (không
tạo `payment.pay_supplier`) · chế độ **(b) trả trước** `references: []` · **CẤM** partial allocate
theo PI NCC · credit = số dư · party_type/direction **từ capability**.

## 1. OpenSpec (trước code lớn)

- [x] `openspec/changes/next8-purchase-vertical/{proposal.md,design.md,specs/*,tasks.md}` — tạo **trước** code.
- [x] `openspec validate next8-purchase-vertical --strict` = **valid** (xác nhận lại 2026-10-01).
- [x] `.plan/next8/phase7-audit.md` (6 mục §4 + quyết định PI vs PR) có bằng chứng thật.

## 2. Server — draft + proposal

- [x] `PurchaseTransactionDraft` theo plan §14: `supplier_id, warehouse_id, items[{item_id,uom,qty,unit_price}], payment_methods[]`.
- [x] Tổng server tính: `purchase_total = Σ(qty × unit_price)` (**không** chiết khấu — plan §14).
- [x] `buildPurchaseProposal` → risk `HIGH`, mọi số từ server; `payment_methods ≤ 1`.
- [x] Giá: `resolveBuyingPriceList` (supplier → **Single** `Buying Settings`); `Item Price` lọc `buying = "1"`
      ⇒ **không bao giờ lấy giá bán làm giá mua** (test + falsify).
- [x] Không có giá mua ⇒ **TỪ CHỐI** (`PURCHASE_PRICE_MISSING`), không mặc định 0.
- [x] `credit = purchase_total − actual_paid` là **số dư**, không phải phương thức (spec + test).
- [x] `credit_to` từ Company `default_payable_account`; chưa khai ⇒ **TỪ CHỐI** (không ghi `credit_to` lạ).
- [x] Dòng hàng: `expense_account` (Company `default_inventory_account`) + `cost_center`; `update_stock = 1`.
- [x] Tồn kho: đọc `Bin` (read-only) ⇒ **chỉ cảnh báo**, không chặn/không hạ số.

## 3. Trả NCC (owner chốt A + chế độ b)

- [x] Trả NCC qua nhánh `Pay` của `payment.create` (1 phương thức = 1 PE) — **không** sửa contract/registry.
- [x] `references = []`, `unallocated_amount = số trả`; **KHÔNG** gạch nợ vào PI nháp; **KHÔNG** có đường allocate.
- [x] `paid_from` = ngân quỹ · `paid_to` = `2110` · sai `account_type` ⇒ **BLOCK** (§6.2).
- [x] `party_type = Supplier`, direction `Pay` **từ capability** — test khẳng định không suy từ tên (falsify F2/F3).
- [x] Copy: *"đã ghi phiếu nhập NHÁP … (phiếu chi NHÁP, tiền trả trước, CHƯA gạch nợ)"*.

## 4. Flutter — PurchaseScreen

- [x] `features/purchase/{data,application,presentation}` theo blueprint; route `/purchase` nhận `handoffId`.
- [x] 4 khối: **NCC · Hàng hoá · Thanh toán/Công nợ · Tổng**; hiển thị "Đã trả / Còn nợ NCC".
- [x] Tái dùng `item_line_editor`/`sales_summary`/`PaymentMethodSection`/`entity_picker`/`proposal_card`
      (tham số hoá, **không** fork 2 bản widget).
- [x] Riverpod controller + epoch; đổi NCC/kho ⇒ reset items + tiền (có test).
- [x] Thiếu handoff ⇒ màn từ chối tiếng Việt, **không** tự dựng handoff.
- [x] **Không** parser tiền thứ hai trong Dart.
- [x] Chat auto-mở `/purchase` khi `full.screen == "purchase"` (+ guard giọng nói có trigger `purchase_invoice.create`).

## 5. Execute + verify

- [x] `/execute` duy nhất ⇒ PI **nháp** (`docstatus 0`) + PE nháp Pay nếu có trả.
- [x] Verify đọc lại: PI (supplier, docstatus 0, `update_stock`, `credit_to`, items đủ dòng, qty/rates,
      `grand_total`) + PE (`payment_type=Pay`, `party_type=Supplier`, `paid_from` ngân quỹ, `paid_to`,
      `unallocated_amount`, `references`=chuỗi rỗng) + correlation ids.
- [x] Idempotency: double confirm ⇒ **1** PI (+1 PE nếu có trả); trùng action key ⇒ từ chối.
- [x] Tripwire: **không** tồn tại đường partial allocate theo PI trong code mới (test khẳng định).

## 6. Test + falsify

- [x] `test/next8-purchase-*.test.mjs` phủ ma trận plan §31 (nhiều item · qty/uom · giá mua · cash ·
      bank · cash+bank (từ chối) · trả một phần · công nợ còn lại · account theo phương thức ·
      sai loại tài khoản · supplier/company scope · thiếu giá mua ⇒ từ chối) — **20/20**.
- [x] F1 partial allocate PI · F2 party_type từ tên · F3 direction `Receive` · F4 credit như tiền vào
      tài khoản · F5 fallback ngân quỹ/bỏ company scope · F6 >1 phương thức trong 1 PE ⇒ **đỏ đúng test**
      — `node .plan/next8/_falsify_phase7.mjs`: **RED 7/7** (F5 tách F5 ngân quỹ + F5b company scope).
- [x] Restore byte-identical (`cp` trước + `sha256sum -c` sau) — **7/7**, re-run sau fix root_type vẫn 7/7.

## 7. Regression

- [x] Node: file mới xanh + `npm test` chỉ 2 fail baseline env `dsh` — **1095/1093/2** (fix pin: invariant
      safety-gateway + doctypeset correlation-migration).
- [x] Flutter: `flutter analyze` 0 warning mới (1 warning = baseline) · `flutter test` giữ baseline —
      **449 pass/3 fail** (3 = `_probe_review_test.dart` untracked).
- [x] Python không đổi.

## 8. Vòng ghi nháp THẬT (owner đã cho phép 1 vòng)

- [x] 1 vòng: PI nháp + PE nháp Pay (supplier/số tiền nhỏ) — **lần 3 xanh**: PI `ACC-PINV-2026-00075`
      + PE `ACC-PAY-2026-00777` (2 lần ĐỎ đầu lộ 2 GAP thật, xem `phase7-result.md` §4a: thiếu Custom
      Field correlation trên PI ⇒ migration có owner OK; bug `root_type` Asset/Liability + mock nói dối).
- [x] Verify bằng REST: PI `docstatus 0`, `update_stock 1`, `credit_to 2110`, items + giá mua;
      PE `payment_type Pay`, `paid_to 2110`, `unallocated_amount` = số trả, **0 dòng reference**.
- [x] Xoá lại đúng chứng từ của mình + verify 404 + số nền không đổi (PI **65/0 submit-draft** · PE **316/17**;
      xoá cascade vì automation site gắn thêm Audit Issue/PLE/GL/ALLOC).

## 9. Sổ sách & bàn giao

- [x] `resultNN.txt` + `.plan/next8/phase7-result.md` + tick file này + `working.md` (`result93.txt`).
- [x] **KHÔNG tự commit** (vùng tiền + kho) — chờ lệnh owner.

## 10. DỪNG hỏi owner khi

- Muốn **phân bổ từng phần theo hoá đơn NCC** (out of scope — cần audit + owner).
- Muốn tạo capability payment NCC mới (chạm contract/registry), muốn submit, hoặc muốn chế độ (a)
  "trả đủ outstanding PI sống".
- Site khác plan §14/§15 ⇒ cập nhật spec, không bịa.
