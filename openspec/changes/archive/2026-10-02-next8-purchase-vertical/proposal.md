# next8 / Purchase vertical — phiếu nhập tự doanh mục + trả NCC nháp

## Why

Phase 6 đã đóng đường **bán hàng** (`sales.create`): server là nguồn số duy nhất, giá lấy từ
`Item Price` **phía bán** (`selling = 1`), một phương thức = một PE (§6.1), tài khoản đúng
`account_type` hoặc BLOCK (§6.2) — có test pin + falsify + 1 vòng ghi nháp thật.

Đường **nhập hàng** (mua vào / trả NCC) thì chưa có: `purchase_order.create` và
`purchase_receipt.create` đã có (draft) nhưng **không** có chứng từ NCC tự doanh mục, và không
có capability `purchase_invoice.create`. `features/purchase/**` chưa tồn tại.

Audit Phase 7 (`.plan/next8/phase7-audit.md`, đo trên site `frontend`) chốt các dữ kiện sau —
mọi con số dưới đây là **đo được**, không suy đoán:

1. **Chứng từ chính của flow "nhập hàng" = Purchase Invoice (PI)**: site có **65** PI (45
   submitted) với `credit_to="2110 - Phải trả người bán - MP"`, `outstanding_amount`,
   `naming_series="ACC-PINV-.YYYY.-"`; PR chỉ **12** và phải theo PO. `update_stock = 1` **trên
   chính PI** ⇒ một PI nháp là đủ cho cả công nợ lẫn nhận kho.
2. Giá mua đến từ **`Item Price` phía MUA** (`Standard Buying`, 13 dòng): CAM-HEO-25KG
   `295.000/Bao` (vs Standard Selling `320.000`). ⇒ **KHÔNG bao giờ** lấy giá bán làm giá mua.
3. PI shape (mẫu `ACC-PINV-2026-00074`): header `credit_to` `2110`, `set_warehouse="Kho Cám - MP"`,
   `update_stock=1`; dòng hàng `price_list_rate`+`rate`+`warehouse`+`expense_account`
   (`1410 - Hàng tồn kho - MP`)+`cost_center`.
4. Company defaults (MP): bank `1210 - ACB 110296868 - MP`, cash `1110 - Tiền mặt - MP`,
   payable `2110 - Phải trả người bán - MP`, receivable `1310 - Phải thu khách hàng - MP`.
   Purchase Taxes and Charges Template: `VAT 8% VLXD - MP` (**is_default=1**).
5. Pay Payment Entry thật: `paid_from` = ngân quỹ (`1110`/`1210`), `paid_to` = `2110`, khớp
   phase-00 §2.2.
6. `frappe.client.get_meta` trên PI/PR/PO bị **417** (site chặn) ⇒ danh sách reqd chưa lấy được
   bằng đường này; dựa vào builder sẵn có (`purchase-receipt-write.mjs`) + field đã ghi được —
   **KHÔNG đoán** (ghi rõ trong audit §2[B]).

**Owner đã chốt (2026-10-01, trong phiên)** khi được hỏi về blocker "capability payment NCC":
- **Đường trả NCC = (A) TÁI DÙNG `payment.create`** (nhánh `Pay` **đã có**: `DIRECTION_SPEC`
  `pay → payment_type:"Pay", party_type:"Supplier", anchor_account_type:"Payable"`; hướng suy từ
  **dữ liệu** — resolve party trên cả Customer lẫn Supplier). `payment.pay_supplier` **KHÔNG**
  tồn tại (grep = 0 hit) và **không** tạo mới trong phase này.
- **Chế độ trả NCC = (b) trả trước** (`references: []`, `unallocated = paid`) — PE nháp on-account
  cùng party, **KHÔNG** gạch nợ vào PI nháp. Chế độ (a) "trả đủ outstanding PI sống" **hoãn** phase sau.
- **CẤM phân bổ từng phần theo hoá đơn NCC** (không mượn Collect §6.3 / oldest-first / FIFO).
- **Công nợ = `purchase_total − actual_paid`** là **số dư**, không phải một phương thức thanh toán.
- **party_type = Supplier, direction = Pay lấy TỪ CAPABILITY** — không suy từ tên hiển thị.

## What Changes

1. **Capability mới `purchase_invoice.create`** (WRITE, risk **HIGH**, `draft_only`) — phiếu nhập
   NCC tự doanh mục: NCC + kho + dòng hàng (qty/uom/giá mua) + (tuỳ) một lần trả. **Không** nới
   `purchase_order.create`/`purchase_receipt.create` đã có.
2. **Server là nguồn số duy nhất** (`src/skills/purchase-invoice-write.mjs`): giải item/uom/giá mua
   từ ERPNext (`Item Price` **`buying = 1`**; không có ⇒ **TỪ CHỐI/ HỎI**, không đặt giá 0),
   `purchase_total = Σ(qty × unit_price)` (plan §14 **không** có chiết khấu), công nợ
   `= purchase_total − actual_paid`.
3. **Ghi PI nháp** (`docstatus 0`) với `credit_to` (từ Company `default_payable_account` — **từ chối**
   nếu chưa khai), `update_stock = 1`, `expense_account` (từ `default_inventory_account`),
   `cost_center`, dòng hàng `price_list_rate = rate`; đối soát `custom_ai_action_id`.
4. **Trả NCC là lệnh riêng** dùng đường `payment.create` nhánh **Pay**: **một** phương thức = **một**
   PE (§6.1), `paid_from` = ngân quỹ, `paid_to` = `2110` (§6.2 — sai loại ⇒ BLOCK),
   `references = []` (trả trước), copy nói rõ **chưa gạch nợ**.
5. **Thực thi qua đúng cửa `/execute`** duy nhất: 1 PI nháp (+ 1 PE nháp nếu trả ngay); verify đọc
   lại đủ field; idempotency double-confirm ⇒ **1 PI**.
6. **Flutter `features/purchase/`** + route `/purchase` (nhận `handoffId`, thiếu ⇒ từ chối tiếng
   Việt): 4 khối **NCC · Hàng hoá · Thanh toán/Công nợ · Tổng**; tái dùng `item_line_editor` /
   `sales_summary` / `PaymentMethodSection` / `entity_picker` / `proposal_card` của Sales (tham số
   hoá, **không** fork 2 bản widget mù).
7. **Chat mở màn mua**: nhóm định tuyến WRITE `purchase_invoice_write` đứng **TRƯỚC** các nhóm
   READ (`inventory`/`supplier`), cẩn thận synonym NLP (bài học "bán hàng" Phase 6);
   `purchaseHandoffFor()` + nhánh `/purchase/propose`.

## Impact

- **Mới**: `mcp-erpnext/src/skills/purchase-invoice-write.mjs`, `test/next8-purchase-*.test.mjs`,
  `apps/mobile/lib/features/purchase/**`, `apps/mobile/test/purchase_*.dart`.
- **Sửa (tối thiểu, có test)**: `capabilities.json` (+1 capability + 1 nhóm `purchase_invoice_write`),
  `src/router.mjs` (+1 nhóm đọc cho purchase), `src/safety-gateway.mjs` (+1 dòng `WRITE_EXECUTORS`),
  `src/business-handoff.mjs` (+1 screen), `src/copilot-server.mjs` (+handoff/propose/branch/guard),
  `src/http-ask.mjs` (+ route `/purchase/propose`), `src/mock-server.mjs` (fixture Item Price buying /
  Buying Settings Single cho mock **đúng shape thật**).
- **KHÔNG đụng**: luật `payment.create` của Collect (trừ việc **gọi** nó ở nhánh Pay đã có),
  `idempotency.mjs`, thứ tự gate của `safety-gateway`, `sales.create`/`sales_invoice.create` đã chốt,
  `purchase_order.create`/`purchase_receipt.create`.

## Out of scope (cấm trong phase này)

**Phân bổ từng phần theo hoá đơn NCC** (không oldest-first / FIFO / tự chọn PI) · trả "đủ outstanding
PI sống" (hoãn phase sau) · `Receive` cho Supplier · mô hình hoá credit như một phương thức tiền ·
1 lệnh → N PE · submit · sửa bất kỳ luật Collect/Sales đã chốt · write-off.

## Quyết định OPEN đã chốt — đường trả NCC = **(A) tái dùng `payment.create`** (owner, 2026-10-01)

- Nhánh **Pay** của `payment.create` là đường **duy nhất** cho tiền ra NCC; **không** tạo
  `payment.pay_supplier`, **không** sửa contract/registry của Collect.
- Chế độ trong phase này = **(b) trả trước** (`references: []`); chế độ (a) "trả đủ outstanding PI
  sống" là backlog **cần audit riêng**, không tự làm.
- Hệ quả kỹ thuật: executor của `purchase_invoice.create` tự dựng **nội bộ** payload PE Pay
  (dùng lại `resolveAdvanceAccounts` + `buildPaymentEntryData` ở chế độ `references: []`), **không**
  đi qua luật §6.3 của Collect, có test riêng, và **không** có bất kỳ đường allocate nào.
