# next8 / Sales vertical — hoá đơn bán tự doanh mục + thu tiền nháp

## Why

Phase 5b đã đóng đường **thu tiền** (`payment.create`): server là nguồn số duy nhất, một
phương thức = một PE (lock §6.1), tài khoản đúng `account_type` hoặc BLOCK (§6.2), đọc đủ
danh sách khách (F-P5-1) — tất cả có test pin + falsify + 2 vòng ghi nháp thật.

Đường **bán hàng** thì chưa có: capability `sales_invoice.create` hiện có là **order-driven**
(`entities.required = ["order"]`, `line_policy.rate_source = "erpnext"` — lấy dòng/giá từ một
Sales Order đã submit), và chính `capabilities.json` ghi rõ *"Hoá đơn KHÔNG có đơn (tự doanh
mục + giá) là bước sau"*. Phase 6 **là** bước đó: khách tự chọn hàng, số lượng/đơn vị, đơn giá,
chiết khấu dòng, chiết khấu đơn, rồi (tuỳ) thu tiền.

Audit Phase 6 (`.plan/next8/phase6-audit.md`, đo trên site thật) chốt các dữ kiện sau — mọi
con số dưới đây là **đo được**, không suy đoán:

1. `Sales Invoice.paid_amount` / `outstanding_amount` là **read_only** ⇒ tiền **không** đi
   thẳng vào hoá đơn; và đường POS (`Sales Invoice Payment` child) có **0 dòng** trên site.
2. PE **không thể** gạch nợ vào SI **nháp** — source ERPNext 16.16.0 của site
   (`payment_entry.py#validate_reference_documents`): `if ref_doc.docstatus != 1: frappe.throw("… must be submitted")`,
   và với `party_type = "Customer"`, Sales Invoice **nằm trong** danh sách tham chiếu hợp lệ
   (`get_valid_reference_doctypes`) ⇒ check đó **áp dụng**.
3. Vòng đời chuyển khoản của plan §13 **có thật** trên site dưới dạng custom field của app
   tham chiếu: `camvlxd_transfer_state` (`pending`/`confirmed`), `camvlxd_transfer_amount`,
   `camvlxd_transfer_account`, `camvlxd_transfer_content`, `camvlxd_transfer_vietqr`,
   `camvlxd_payment_entry` — đang dùng thật (**2 pending / 15 confirmed** trên 532 SI).
4. Site **ẩn** nhóm chiết khấu đơn trên form (`additional_discount_section.hidden = 1`) nhưng
   field vẫn ghi được qua API; `Pricing Rule` bật = **0**; giá đến từ `Item Price` theo
   `price_list` (`Selling Settings.selling_price_list = "Standard Selling"`, khách mẫu đều
   `default_price_list = null`); `Item.standard_rate` của hàng thật = **0**.
5. Thuế: `VAT 8% VLXD - MP` là default của company; có `Item Tax Template` riêng
   (`KCT Cám chăn nuôi - MP`…) ⇒ server chỉ **chọn tên template**, không tự cộng thuế.
6. Kho: 11 kho lá, đã pin `COPILOT_DEFAULT_WAREHOUSE = "Kho Cám - MP"`; `Bin` đọc được số thật
   ⇒ đủ để **cảnh báo** tồn, không đủ tư cách để **chặn**.

**Owner đã chốt (2026-09-30, trong phiên)** khi được hỏi về blocker ở mục 2:
- **Đường thu tiền = (A) PE NHÁP ON-ACCOUNT**: thu ngay, **không** gạch nợ vào hoá đơn nháp;
  tiền vào sổ là **tiền đặt trước của khách**; copy phải nói rõ "chưa gạch nợ"; bước gạch nợ
  thuộc phase sau (sau khi SI được submit).
- **Có ghi `camvlxd_transfer_state = "pending"`** cho ý định chuyển khoản ⇒ tách "chờ tiền về"
  khỏi "đã nhận tiền" đúng plan §13, ngay trên chứng từ.
- **Cho phép 1 vòng ghi nháp thật** (1 SI nháp + 1 PE nháp on-account, khách/số tiền nhỏ, xoá lại).
- **§6.3 cho Sales = S1** (chốt sau, cùng ngày): Collect `payment.create` GIỮ NGUYÊN §6.3;
  đường Sales được PE nháp advance **cùng party** với SI nháp vừa tạo, KHÔNG bắt allocate vào
  hoá đơn mở cũ; vẫn cấm nới Collect / 1 lệnh N PE / submit (xem mục "Quyết định OPEN đã chốt").

## What Changes

1. **Capability mới `sales.create`** (WRITE, risk **HIGH**, `draft_only`) — hoá đơn bán **tự
   doanh mục**: khách + kho + dòng hàng + 2 tầng chiết khấu + (tuỳ) một phương thức thu.
   **Không** nới `sales_invoice.create` của P9-D (đó là vùng tiền đã chốt, có test riêng).
2. **Server là nguồn số duy nhất** (`src/skills/sales-write.mjs`): giải item/uom/giá từ ERPNext
   (Item Price theo price list; không có ⇒ **HỎI**, không mặc định 0), tính
   `line_net = qty×unit_price − line_discount` → `subtotal = Σ line_net` → `grand_total = subtotal − order_discount`,
   **hai tầng chiết khấu giữ riêng** (không hàm nào gộp), `credit = grand_total − actual_paid`
   là **số dư công nợ**, không phải phương thức thanh toán.
3. **Draft hợp nhất với primitive Phase 1**: `transactionItem` / `paymentMethod` /
   `validatePaymentMethods` (max 1) / `buildTransactionSummary` — không viết bản thứ hai.
4. **Thực thi qua đúng cửa `/execute`**: tạo **SI nháp** (`docstatus 0`) + ghi
   `custom_ai_action_id`/`reference_no` để đối soát; verify đọc lại đủ field; idempotency
   double-confirm ⇒ **1 SI**.
5. **Thu tiền là lệnh riêng** (đường đã chứng minh của Phase 4, `payment.create` chế độ
   on-account/advance): một phương thức = một PE, tài khoản theo §6.2 (sai loại ⇒ BLOCK),
   **không** gạch nợ vào hoá đơn nháp; copy nói đúng "tiền đặt trước, chưa gạch nợ".
6. **Vòng đời chuyển khoản (§13)** ghi thẳng lên SI: `camvlxd_transfer_state = "pending"` khi
   thu bằng chuyển khoản ⇒ chứng từ tự nói "chờ tiền về"; **không** bao giờ báo "đã nhận tiền"
   chỉ vì đã tạo chứng từ.
7. **Flutter `features/sales/`** + route `/sales` (nhận `handoffId`, thiếu ⇒ từ chối tiếng Việt):
   4 khối Khách · Hàng hoá · Chiết khấu (dòng ≠ đơn) · Thu tiền/Tổng; Riverpod + epoch; đổi
   khách/kho ⇒ reset; **không** viết parser tiền thứ hai trong Dart.
8. **Cảnh báo tồn kho chỉ để hiển thị** (đọc `Bin` read-only) — không chặn, không hạ số.

## Impact

- **Mới**: `mcp-erpnext/src/skills/sales-write.mjs`, `test/next8-sales-*.test.mjs`,
  `apps/mobile/lib/features/sales/**`, `apps/mobile/test/sales_*.dart`.
- **Sửa (tối thiểu, có test)**: `capabilities.json` (+1 capability), `src/router.mjs`
  (+1 nhóm đọc cho Sales), `src/safety-gateway.mjs` (+1 dòng `WRITE_EXECUTORS`),
  `src/http-ask.mjs` (+ route `/sales/propose`, `/sales/execute` hoặc dùng lại `/execute`),
  `src/business-handoff.mjs` (screen cho capability mới), `src/mock-server.mjs`
  (fixture Item Price / UOM / Bin cho mock **đúng shape thật**).
- **KHÔNG đụng**: luật `payment.create` (trừ việc **gọi** nó ở chế độ advance đã có),
  `idempotency.mjs`, thứ tự gate của `safety-gateway`, `sales_invoice.create` của P9-D,
  logic Collect đã chốt (§6.1–6.4).

## Out of scope (cấm trong phase này)

Submit SI/PE (Phase 9) · write-off · `paymentMode = credit` · gộp 2 tầng chiết khấu ·
client làm thẩm quyền giá/tổng · tự chọn item/kho/bảng giá · 1 lệnh → N PE ·
Purchase (Phase 7) · nới bất kỳ luật Collect nào đã chốt.

## Quyết định OPEN đã chốt — §6.3 cho Sales = **S1** (owner, 2026-09-30)

- **Collect `payment.create` GIỮ NGUYÊN §6.3** (còn hoá đơn mở ⇒ bắt buộc allocate) — không nới.
- **Đường Sales** (`sales.create` / `buildSalesProposal` + executor): được phép **PE nháp
  on-account (advance) cùng party** với SI nháp vừa tạo — **KHÔNG** bắt allocate vào hoá đơn mở
  cũ; copy nói "tiền đặt trước / chưa gạch nợ".
- Vẫn cấm: nới Collect · 1 lệnh → N PE · submit.

Hệ quả kỹ thuật: executor của `sales.create` tự dựng **nội bộ** payload advance cho party vừa
bán (dùng lại `resolveAdvanceAccounts` + `buildPaymentEntryData` ở chế độ `references: []`) —
đường này KHÔNG đi qua luật §6.3 của Collect nên không phải "nới" gì; nó là một luồng mới, có
test riêng, và chỉ tồn tại trong executor của Sales.
