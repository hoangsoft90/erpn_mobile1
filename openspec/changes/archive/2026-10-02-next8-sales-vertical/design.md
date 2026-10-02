# Design — next8 Sales vertical

## 1. Draft (server-authoritative, không I/O khi test)

```
SalesTransactionDraft
├── customer_id        ← picker (server re-validate id trên master vừa đọc)
├── warehouse_id       ← picker kho (mặc định COPILOT_DEFAULT_WAREHOUSE)
├── items[]            ← transactionItem: { item_id, uom, qty, unit_price?, line_discount }
├── order_discount     ← số tiền (tầng 2, KHÁC tầng 1)
├── payment_methods[]  ← ≤ 1 (lock §6.1) — paymentMethod: { mode, amount, account_id }
└── outstanding        ← server tính = grand_total − actual_paid
```

`transactionItem` / `paymentMethod` / `validatePaymentMethods` / `buildTransactionSummary`
là primitive **đã có** từ Phase 1 (`src/transaction-draft.mjs`) — dùng lại, không viết bản 2.

## 2. Số học (server tính; client chỉ xem trước)

```
line_gross = qty × unit_price
line_net   = line_gross − line_discount          ← tầng 1 (theo DÒNG)
subtotal   = Σ line_net
grand_total= subtotal − order_discount           ← tầng 2 (theo ĐƠN)
credit     = grand_total − actual_paid           ← công nợ = số dư, KHÔNG phải phương thức
```

- Hai tầng **không bao giờ gộp** (plan §12.2): hai hàm riêng, hai field riêng trong draft,
  hai field riêng khi ghi ERPNext (xem §3), và một test khẳng định không hàm nào gộp.
- `grand_total` **cuối cùng** luôn là số ERPNext trả về sau khi tạo (thuế site có thể làm lệch)
  — số tự tính chỉ dùng để *hiển thị trước* và để đối chiếu.

## 3. Ghi vào ERPNext (đối chiếu field đã ĐO — `phase6-audit.md` §1/§2)

| Draft | Field ERPNext | Ghi chú |
|---|---|---|
| `customer_id` | `customer` (reqd) | Link |
| kho | `set_warehouse` (không reqd) + `items[].warehouse` | kho dòng thắng kho đơn |
| dòng: item/uom/qty | `items[].item_code` / `uom` (reqd) / `qty` | `uom` bắt buộc ⇒ luôn gửi |
| dòng: đơn giá | `items[].rate` (reqd) + `price_list_rate` | `rate` là giá thực ghi; `price_list_rate` để CK dòng có nghĩa |
| **CK dòng** | `items[].discount_amount` (hoặc `discount_percentage`) | neo vào `price_list_rate` (depends_on đo được) |
| **CK đơn** | `additional_discount_percentage` **hoặc** `discount_amount` + `apply_discount_on = "Grand Total"` (default) | bảng CHA, khác bảng với CK dòng |
| tiền thu | (không ghi vào SI) | `paid_amount`/`outstanding_amount` **read_only** |
| vòng đời CK | `camvlxd_transfer_state = "pending"` khi mode = `bank_transfer` | field thật của site, đang dùng |
| đối soát | `custom_ai_action_id` = action id | field thật đã có trên SI |
| server điền | `company`, `posting_date` (shopDay), `selling_price_list`, `debit_to`, `naming_series`, `items[].income_account`, `items[].cost_center`, `taxes_and_charges` | **client không bao giờ gửi** |
| ERPNext tính | `currency`, `conversion_rate`, `*_total`, `net_rate`, `amount` | không gửi |

`income_account` / `cost_center` là **reqd** ở dòng: lấy từ Company
(`default_income_account` = `4110 - Doanh thu bán hàng - MP`, `cost_center` = `Main - MP`).

## 4. Giá

1. `Customer.default_price_list` (site: null) → `Selling Settings.selling_price_list` = "Standard Selling".
2. `Item Price` theo `(item_code, uom, price_list)` — dùng lại `priceForLine()` của
   `sales-order-write.mjs` (đã có test).
3. Không tìm thấy giá ⇒ **HỎI** (`no_price = "ask"`), **không** mặc định 0, **không** dùng
   `Item.standard_rate` (site = 0 cho hàng thật).
4. `Pricing Rule` bật = 0 ⇒ không cần `ignore_pricing_rule`; không tự chọn luật giá.

## 5. Thuế

Server **chỉ chọn tên** `taxes_and_charges` (mặc định: template default của company, hoặc
`Item Tax Template` của dòng nếu người dùng chọn) và **copy** `item_tax_template` xuống dòng.
Không tự cộng/trừ thuế; `grand_total` đọc từ ERPNext.

## 6. Đường thu tiền (owner chốt (A))

- Bước 1 (cùng `/execute`): **SI nháp** (`docstatus 0`), có `camvlxd_transfer_state` nếu là CK.
- Bước 2 (lệnh riêng, cùng cửa `/execute`): `payment.create` chế độ **on-account** đã có từ
  Phase 4 — **một** phương thức ⇒ **một** PE, `references: []`, `unallocated_amount = số thu`.
- **Không** gạch nợ vào SI nháp (bất khả thi — `must be submitted`), **không** ghi
  `paid_amount` (read_only), **không** dùng child `Sales Invoice Payment` (site không dùng).
- Copy bắt buộc nói: *"đã ghi phiếu thu NHÁP … (tiền đặt trước, chưa gạch nợ vào hoá đơn nháp
  này)"*; nhánh chuyển khoản thêm *"chờ xác nhận tiền về"*.
- Hệ quả đã biết (OPEN, chờ owner): khách **đang có hoá đơn mở khác** sẽ bị luật §6.3 của
  Collect từ chối cho tới khi có luật riêng cho Sales.

## 7. Vòng đời chuyển khoản (plan §13)

| Trạng thái | Cách biểu diễn |
|---|---|
| Chuyển khoản — **chờ xác nhận tiền về** | `camvlxd_transfer_state = "pending"` trên SI + copy "chờ tiền về" |
| **Đã nhận tiền** | chỉ khi tiền thực sự được xác nhận (bước sau/ngoài app) — app **không** tự nói đã nhận |
| Tiền mặt | không set `transfer_state`; copy nói rõ là phiếu thu nháp |

Bất biến: **không** câu nào trong app được nói "đã nhận tiền" chỉ vì chứng từ vừa được tạo.
Có test pin nguyên văn copy.

## 8. Capability & tái dùng

- Capability mới **`sales.create`** (route_group `sales_write`, risk HIGH, `double_confirm` như
  các WRITE khác) — **không** nới `sales_invoice.create` (P9-D, order-driven).
- Tái dùng: `resolveSalesCompany` + `priceForLine` (`sales-order-write.mjs`),
  primitive draft (`transaction-draft.mjs`), `runExecute`/idempotency/verify/reconcile
  (`safety-gateway.mjs`, `idempotency.mjs`), luồng PE advance (`payment-write.mjs`),
  Flutter `entity_picker` / `ProposalCard` / `payment_method_section` / `pipeline_progress`.
- **Không** viết: bộ chọn item/kho/FIFO tự động, parser tiền thứ hai, bản sao luật §6.2.

## 9. Rủi ro & bẫy

- Sales ≠ Collect: SI là chứng từ cha đã lưu ⇒ nhiều PE vào cùng một SI là hợp lệ **sau khi
  submit**; điều đó **không** cho phép N PE trong 1 lệnh (lock §6.1 vẫn nguyên).
- Item trùng tên khác UOM ⇒ khoá dòng = `item_id + uom`.
- Tồn kho: chỉ cảnh báo; "chặn khi âm kho" là hard constraint ⇒ cần owner quyết riêng.
- Tiền Việt ("3tr5"): parse **ở server**, không viết parser trong Dart.
- Thuế site làm `grand_total` lệch số tự tính ⇒ luôn hiển thị số ERPNext trả về là số cuối.

## 10. ĐÍNH CHÍNH sau khi chạy THẬT (2026-09-30) — 3 điều measurement dạy lại

Ba điều dưới đây chỉ lộ ra khi chạy vòng nháp trên site thật; mock cũ **nói dối** ở cả ba (đã sửa mock):

1. **`Selling Settings` là Single.** `erpnext_doc_list` trên nó trả **HTTP 500**
   (`MySQLdb.ProgrammingError: ('DocType', 'Selling Settings')`); chỉ `erpnext_doc_get` đọc được.
   Đọc bằng list ⇒ `price_list = null` ⇒ `priceForLine` rơi vào `pool[0]`.
2. **Giá mua và giá bán cùng một bảng `Item Price`.** Với `price_list = null`, `pool[0]` chính là
   dòng **Standard Buying** ⇒ hoá đơn bán bị định giá bằng **giá vốn** (đo được: `CAM-HEO-25KG`
   295.000 mua vs 320.000 bán). ⇒ Lọc `selling = 1` ở đường bán + đòi price list giải được.
3. **`items[].discount_amount` là field DẪN XUẤT**, không phải input: ERPNext tự tính
   `discount_amount = price_list_rate × qty − rate × qty` và **bỏ qua** giá trị gửi lên
   (đo được: gửi 20.000 ⇒ đọc lại 0). ⇒ CK dòng phải gửi **cặp** (`price_list_rate` = giá bảng,
   `rate` = giá NET) — đúng như chính bảng §3 đã ghi ("`rate` là giá thực ghi; `price_list_rate`
   để CK dòng có nghĩa"), chỉ là bản implement đã đặt hai field bằng nhau nên CK biến mất.

**Ngoài ra (site, không phải code của mình):** site có automation tạo `Audit Issue` (severity
Critical, "Fraud Detection") + `Payment Ledger Entry` + `GL Entry` (đều `is_cancelled`) +
`Payment Allocation` cho MỖI hoá đơn/phiếu mới ⇒ xoá chứng từ phải xoá cascade theo `voucher_no`
/`payment_entry` trước, và **tên chứng từ bị tái dùng** sau khi xoá (F-P5-4 tái hiện) ⇒ đối soát
luôn theo `custom_ai_action_id`/`reference_no`, không theo tên.
