# Checklist test — Chat thường (copilot /ask)

Nguồn: `capabilities.json` routing + skills đã wire. Ghi kết quả cột **Kết quả**.

**Chuẩn bị:** chế độ **Chat thường** · bubble `nguồn: REAL` · company/kho đã pin.

---

## A. READ — Công nợ / khách

| # | Câu gợi ý | Capability | Kỳ vọng | Kết quả |
|---|-----------|------------|---------|--------|
| A1 | chị Lan còn nợ bao nhiêu | customer.balance | Số công nợ REAL + (tuỳ) drill | |
| A2 | công nợ khách [Tên] | customer.balance | / picker nếu trùng | |
| A3 | [Tên] còn nợ gì | customer.balance | | |
| A4 | tình trạng công nợ [Tên] | customer.balance | | |

## B. READ — Hóa đơn

| # | Câu gợi ý | Capability | Kỳ vọng | Kết quả |
|---|-----------|------------|---------|--------|
| B1 | hóa đơn của [Tên] | invoice.lookup | List / tóm tắt HĐ | |
| B2 | xem hóa đơn [Tên] | invoice.lookup | | |
| B3 | chứng từ nợ [Tên] | invoice.lookup | | |

## C. READ — Lịch sử thu

| # | Câu gợi ý | Capability | Kỳ vọng | Kết quả |
|---|-----------|------------|---------|--------|
| C1 | lịch sử thu [Tên] | payment.history | | |
| C2 | đã thu bao nhiêu của [Tên] | payment.history | | |

## D. READ — Kho

| # | Câu gợi ý | Capability | Kỳ vọng | Kết quả |
|---|-----------|------------|---------|--------|
| D1 | tồn [mặt hàng] | stock.balance | Qty REAL | |
| D2 | [mặt hàng] còn bao nhiêu | stock.balance | | |

## E. READ — NCC

| # | Câu gợi ý | Capability | Kỳ vọng | Kết quả |
|---|-----------|------------|---------|--------|
| E1 | nhà cung cấp [Tên] | supplier.lookup | | |

## F. WRITE — card [Xác nhận]

| # | Câu gợi ý | Capability | Kỳ vọng | Kết quả |
|---|-----------|------------|---------|--------|
| F1 | thu tiền [Tên] 100000 | payment.create | Card → confirm → PE | |
| F2 | [Tên] trả 50 nghìn | payment.create | | |
| F3 | bán [Tên] 1 bao [item] | sales_order.create | Card SO | |
| F4 | báo giá [Tên] … | quotation.create | Card | |
| F5 | đặt hàng NCC … | purchase_order.create | Card | |
| F6 | xuất kho / giao … | delivery.create | Card nếu wired | |
| F7 | nhận hàng NCC … | purchase_receipt.create | Card | |
| F8 | xuất hóa đơn bán … | sales_invoice.create | Card | |
| F9 | thêm khách [Tên] | customer.create | Offer/card | |
| F10 | trả hàng … (theo HĐ) | sales_return.create | Card | |
| F11 | xuất hủy / hàng hỏng … | stock.adjustment | Card | |

## G. Drawer

| # | Mục | Kỳ vọng | Kết quả |
|---|-----|---------|--------|
| G1 | Tóm tắt ngày | REAL, đúng ngày | |
| G2 | Công nợ / Nợ lâu / HĐ chưa trả | | |
| G3 | Tồn nóng / Nháp hôm nay | | |

## H. Doanh thu (đã hiện thực — next7 C1/C2)

| # | Câu | Kỳ vọng | Kết quả |
|---|-----|---------|--------|
| H1 | Báo cáo doanh thu hôm nay | Route `sales.summary`; trả **NET** ngày hôm nay (Asia/Ho_Chi_Minh) + đơn vị tiền + số chứng từ; `erp_target=REAL`; khớp drawer (**abs(chat − drawer) == 0**); ngày trống = 0 THẬT; ERP lỗi = lỗi (không 0 giả) | ✅ REAL 2026-09-27 (`.plan/next7/C2-result.md`): routed `sales.summary`/matched `doanh thu`, `erp_target=REAL`, company `Minh Phát Cám & VLXD`, net **0 VND — 0 chứng từ** (ngày thật chưa có HĐ), drawer cùng ngày 0/0 ⇒ **abs = 0** |
| H2 | Doanh thu hôm nay | Cùng route (keyword `doanh thu`); **KHÔNG còn** `KNOWN_INTENT_UNIMPLEMENTED` | ✅ REAL: route `sales.summary` |
| H3 | Ngày **có trả hàng** (net phải bị kéo xuống) | return hiện là 1 dòng của ngày, note "Trả hàng (giảm doanh thu)", số âm | ✅ REAL 2026-09-15 (6 HĐ, 1 return): block `720.675` == drill summary `720.675` == REST `720.675` (= 817.875 − **97.200**); dòng `ACC-SINV-2026-00052` = **−97.200** |
| H4 | Chưa pin company | Từ chối kèm copy tiếng Việt, **KHÔNG** tự chọn công ty | unit `test/next7-sales-summary.test.mjs` + E2E `test/copilot.test.mjs` |

## I. Nguồn

| # | Kiểm | Kỳ vọng | Kết quả |
|---|-------|---------|--------|
| I1 | Bubble | `nguồn: REAL` | |
| I2 | Meta | `route: …` khi đã route | |

Dùng tên khách/item thật; WRITE số nhỏ.
