# Design — next8 Purchase vertical

## 1. Draft (server-authoritative, không I/O khi test)

```
PurchaseTransactionDraft            (plan §14)
├── supplier_id       ← picker (server re-validate id trên master vừa đọc)
├── warehouse_id      ← picker kho (mặc định COPILOT_DEFAULT_WAREHOUSE)
├── items[]           ← transactionItem: { item_id, uom, qty, unit_price? }
├── payment_methods[] ← ≤ 1 (lock §6.1) — paymentMethod: { mode, amount, account_id }
└── outstanding       ← server tính = purchase_total − actual_paid
```

`transactionItem` / `paymentMethod` / `validatePaymentMethods` / `buildTransactionSummary` là
primitive **đã có** từ Phase 1 (`src/transaction-draft.mjs`) — dùng lại, không viết bản 2.
**plan §14 KHÔNG có `line_discount`/`order_discount` cho NCC** ⇒ `purchase_total = Σ(qty × unit_price)`.

## 2. Số học (server tính; client chỉ xem trước)

```
line_net   = qty × unit_price                     ← KHÔNG chiết khấu (plan §14)
purchase_total = Σ line_net
credit     = purchase_total − actual_paid         ← công nợ = số dư, KHÔNG phải phương thức
```

- `credit` là **một SỐ**, không phải kênh thanh toán: không có `paymentMode = credit`.
- `purchase_total` cuối cùng luôn là số ERPNext trả về sau khi tạo (`grand_total` — thuế site có
  thể làm lệch) — số tự tính chỉ để *hiển thị trước* và đối chiếu.

## 3. Ghi vào ERPNext (đối chiếu field đã ĐO — `phase7-audit.md` §2)

| Draft | Field ERPNext | Ghi chú |
|---|---|---|
| `supplier_id` | `supplier` (reqd) | Link |
| kho | `set_warehouse` + `items[].warehouse` | kho dòng thắng kho đơn |
| dòng: item/uom/qty | `items[].item_code` / `uom` / `qty` | `uom` bắt buộc ⇒ luôn gửi |
| dòng: đơn giá mua | `items[].rate` + `price_list_rate` | **cả hai = giá mua** (plan §14 không CK ⇒ không lệch) |
| dòng: khoản mục | `items[].expense_account` | từ Company `default_inventory_account` (`1410 - Hàng tồn kho - MP`) |
| dòng: trung tâm CP | `items[].cost_center` | từ Company `cost_center` (`Main - MP`) |
| công nợ | `credit_to` | từ Company `default_payable_account` (`2110`); **chưa khai ⇒ TỪ CHỐI** |
| nhận kho | `update_stock = 1` | trên chính PI (đo được) |
| đối soát | `custom_ai_action_id` = action id | field dùng chung SO/QT/PO/DN/PR/PI |
| server điền | `company`, `posting_date` (shopDay), `naming_series`, `currency` | **client không bao giờ gửi** |
| ERPNext tính | `*_total`, `outstanding_amount`, `net_rate`, `amount` | không gửi |

`expense_account` / `cost_center` là **reqd** ở dòng — lấy từ Company, không từ client.

## 4. Giá MUA (khác giá bán — bẫy lớn nhất)

1. `Supplier.default_price_list` (site: null) → **Single** `Buying Settings.buying_price_list` =
   `Standard Buying` (đọc bằng `erpnext_doc_get`, list chỉ là fallback).
2. `Item Price` theo `(item_code, uom, price_list)` **lọc `buying = "1"`** — dùng lại
   `priceForLine()` của `sales-order-write.mjs` (đã có test). **KHÔNG** lọc `selling`.
3. Không tìm thấy giá mua ⇒ **TỪ CHỐI** (`PURCHASE_PRICE_MISSING`), **không** mặc định 0, **không**
   dùng `Item.standard_rate`.

> Bẫy: cùng một bảng `Item Price` giữ cả giá mua và giá bán. Không lọc `buying = 1` ⇒ phiếu nhập
> bị định giá bằng **giá bán** (mirror lỗi Phase 6 ngược chiều). Có test + falsify.

## 5. Thuế nhập

Phase này **chỉ** dựa vào `taxes_and_charges` default của company (`VAT 8% VLXD - MP`) khi PI được
submit (`grand_total` đọc từ ERPNext). **Không tự cộng/trừ thuế ở code**; số tự tính chỉ hiển thị.

## 6. Đường trả NCC (owner chốt (A) + chế độ (b))

- Bước 1 (cùng `/execute`): **PI nháp** (`docstatus 0`), `update_stock = 1`.
- Bước 2 (cùng lệnh, cùng cửa `/execute`): PE nhánh **Pay** (đường `payment.create` đã có) —
  **một** phương thức ⇒ **một** PE, `references: []`, `unallocated_amount = số trả`.
- **KHÔNG** gạch nợ vào PI nháp (bất khả thi — `must be submitted`), **KHÔNG** có bất kỳ đường
  allocate nào (kể cả partial theo PI NCC — plan §14 **cấm**).
- Copy bắt buộc nói: *"đã ghi phiếu nhập NHÁP … (phiếu chi NHÁP, tiền trả trước, CHƯA gạch nợ vào
  phiếu nhập này)"*.
- Tài khoản (lock §6.2): `paid_from` = ngân quỹ (`1110`/`1210`), `paid_to` = `2110`; sai `account_type`
  ⇒ **BLOCK**, không thay thế.
- plan §15: `party_type = Supplier`, direction `Pay` lấy **từ capability** (`payment.create.direction_policy`
  resolve party trên cả hai master) — **không** suy từ tên hiển thị.

## 7. Capability & tái dùng

- Capability mới **`purchase_invoice.create`** (route_group `purchase_invoice_write`, risk HIGH,
  `draft_only`, `update_stock = 1`) — **không** nới `purchase_order.create`/`purchase_receipt.create`.
- Tái dùng: `resolveSalesCompany` (resolver Company tổng quát) + `priceForLine` + `refuse`/`rowsOf`/`docOf`
  (`sales-order-write.mjs`), primitive draft (`transaction-draft.mjs`), `runExecute`/idempotency/verify
  (`safety-gateway.mjs`), `resolveAdvanceAccounts` + `channelOfMode` + `buildPaymentEntryData`
  (`payment-write.mjs`), Flutter `entity_picker` / `proposal_card` / `item_line_editor` /
  `sales_summary` / `PaymentMethodSection` / `pipeline_progress`.
- **Không** viết: bộ chọn item/NCC/FIFO tự động, parser tiền thứ hai trong Dart, bản sao luật §6.2.

## 8. Handoff / chat

- Nhóm định tuyến `purchase_invoice_write` đứng **TRƯỚC** nhóm READ `inventory`/`supplier` để câu
  mệnh lệnh ("nhập hàng cho …", "mua … cho NCC") không bị nhóm đọc giành mất (bài học Phase 6).
- `purchaseHandoffFor()` trả ticket `purchase_invoice.create`/screen `purchase` với supplier đã
  resolve, còn lại MISSING, **KHÔNG BAO GIỜ** có số.
- Chat KHÔNG đề xuất mua tự do (`proposal: null` — câu nói không mang dòng hàng); màn mua mở từ ticket.

## 9. Rủi ro & bẫy

- **Bẫy lớn nhất: mượn luật Collect** (plan §31). Supplier payment KHÁC Customer collection ⇒ test
  phải khẳng định: không oldest-first, không tự chọn PI, không FIFO, không partial allocate.
- AP `2110` vs AR `1310`: sai `paid_to` ⇒ chứng từ sai sổ; verify kiểm đúng field.
- `credit_to` khác company (site đa công ty MP + SANLOAN) ⇒ luôn kiểm company scope.
- Giá mua vs giá bán cùng bảng `Item Price` ⇒ bắt buộc lọc `buying = 1`.
- Trả trước NCC khi chưa nhập hàng ⇒ số nằm trên `2110` (NCC nhận trước) — copy phải giải thích được.
- Tiền Việt ("3tr5"): parse **ở server**, không viết parser trong Dart.
- Vùng tiền ⇒ **KHÔNG tự commit**, trình owner.
