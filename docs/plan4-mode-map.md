# plan4-mode-map — Mode of Payment → Cash | Bank (P4-0, đo trên ERPNext thật)

> Ngày đo: **2026-09-21** · Site: ERPNext thật (tunnel) · Phương pháp: **chỉ ĐỌC** — `frappe.client.get_list` trên `Mode of Payment`, `Payment Entry`, `Account`, `Company`.
> Nguồn spec: `.plan/plan4_final.md` §3.2 (thu/chi tách Cash|Bank), §10.3 (két = `Company.default_cash_account`), §12 (mapping ghi vào checklist).
> **Cấm đã tuân thủ:** không UI Flutter, không WRITE, không Redis, không skill WRITE mới.

## 1. Kết luận điều hành (đọc dòng này là đủ)

- Két tiền mặt (block "Két dự kiến" P4-1): **KHÔNG bị chặn** — cả 3 company đều có `default_cash_account` (bảng §4).
- **CỜ MỚI (đo được, chưa ai ghi):** site này **KHÔNG thể xếp Cash|Bank bằng `Mode of Payment.type`**:
  - **91/173 PE docstatus=1 (53%) có `mode_of_payment` TRỐNG**;
  - mode `"Chuyển khoản"` bị cấu hình **`type = Cash`** trên doctype Mode of Payment, nhưng mọi PE thực dùng nó đều nhận tiền vào **tài khoản ngân hàng** `1210 - ACB …` (`account_type = Bank`).
- ⇒ Khuyến nghị P4-1: xếp Cash|Bank theo **`Account.account_type` của TÀI KHOẢN TIỀN** (`paid_to` khi Receive, `paid_from` khi Pay), dùng `mode_of_payment`/`MoP.type` chỉ làm HINT. Bảng map dưới đây là **hint-layer**, không phải luật xếp loại.

## 2. Bảng map (hint-layer) — mode → cash|bank

> Quy ước: xếp theo `Mode of Payment.type`, trừ hai ngoại lệ tường minh ghi dưới bảng. **Chưa có dữ liệu thật nào mâu thuẫn** (xem §5) — nếu P4-1 gặp mode mới, thêm dòng + nguồn đo.

| Mode of Payment (tên trên site) | MoP.type (ERPNext) | Xếp (P4-1) | Ngoại lệ tường minh | Bằng chứng PE |
|---|---|---|---|---|
| `Cash` | Cash | **cash** | — | 61 Receive + 7 Pay vào/ra `1110 - Tiền mặt - MP` (account_type=Cash) ✓ |
| `Chuyển khoản` | **Cash** (cấu hình đặc thù site) | **bank** | **CÓ** — đè lên type=Cash | 15 Receive + 1 Pay qua `1210 - ACB …` (account_type=Bank) ✓ |
| `Wire Transfer` | Bank | **bank** | — | 7 Pay + 4 Receive qua `1210 - ACB …` (Bank) ✓ |
| `Cheque` | Bank | **bank** | — | 0 PE — xếp theo MoP.type |
| `Bank Draft` | Bank | **bank** | — | 0 PE — xếp theo MoP.type |
| `Credit Card` | Bank | **bank** | — | 0 PE — xếp theo MoP.type |

**Nguồn:** doctype `Mode of Payment` (6 mode, đều `enabled=1`) + aggregate 245 PE (2026-09-21).

## 3. PE mode TRỐNG (53%) — quy tắc xếp cho P4-1

- 91/173 PE submitted có `mode_of_payment` **trống** — xếp theo mode sẽ MISS quá nửa dữ liệu submitted (82 Receive + 9 Pay).
- Tài khoản tiền (`paid_to` khi Receive / `paid_from` khi Pay) là **bộ phân loại đáng tin nhất**: `account_type` ∈ {Cash, Bank} đã đo đủ cho mọi tài khoản tiền thực dùng (§5) — 100% PE mode-trống được xếp đủ mà không cần fallback.
- Vẫn giữ **rule-3 (đếm "không xếp được" riêng)** làm lưới an toàn — không 0 giả.

## 3b. Dùng map này thế nào trong P4-1 (thứ tự rule-1 → rule-2 → rule-3)

1. **Rule-1:** xếp theo `Account.account_type` của tài khoản tiền: `Cash` → cash; `Bank` → bank.
   Đo đủ 9/9 tài khoản tiền thực dùng: 3 Cash (`1110 - Tiền mặt - MP`, `Tiền mặt - DPC`, `Cash - S`), 1 Bank (`1210 - ACB 110296868 - MP`) ⇒ **100% PE mode-trống được xếp đủ bằng rule-1**.
   Nhóm `account_type` khác (Receivable/Payable/Equity/…) → rơi rule-2/3.
2. **Rule-2 (fallback):** nếu tài khoản tiền không có `account_type` ∈ {Cash, Bank} → so với `Company.default_cash_account` (= cash) / `default_bank_account` (= bank) của company của PE; không khớp cả hai → đếm riêng "không xếp được". (Rule-2 còn dùng được cho PE có mode loại `General` — không có trên site hiện tại.)
3. **Rule-3:** PE mode-trống mà không xếp được bằng rule-1/2 → **đếm riêng "không xếp được" — KHÔNG 0 giả, KHÔNG tự đoán** (đúng policy §4.3 plan4_final cho partial).

## 4. Company — default accounts (két P4-1)

| Company | default_cash_account | default_bank_account | Két V1 (§10.3) |
|---|---|---|---|
| Minh Phát Cám & VLXD | `1110 - Tiền mặt - MP` | `1210 - ACB 110296868 - MP` | ✅ Được |
| DEMO POC CO | `Tiền mặt - DPC` | **null** | ✅ Được (phần bank của két không mở) |
| SANLOAN | `Cash - S` | **null** | ✅ Được (phần bank của két không mở) |

> Đo bằng `get_list` Company với field select tường minh — `frappe.client.get` (Company) bị **403** với API key này (ghi ở §6).

## 5. Dữ liệu nền đã đo (2026-09-21)

- 6 Mode of Payment, đều `enabled=1` (§2).
- 245 PE tổng; **173 docstatus=1**: Receive 146 (Cash 52, mode-trống 82, `Chuyển khoản` 9, `Wire Transfer` 3), Pay 27 (Cash 10, mode-trống 9, `Wire Transfer` 8, `Chuyển khoản` 1).
- `Account.account_type` đo đủ 9/9 tài khoản xuất hiện trong PE: 1110-MP=Cash, 1210-ACB-MP=Bank, Tiền mặt-DPC=Cash, Cash-S=Cash, 1310-MP=Receivable, 2110-MP=Payable, Con nợ-DPC=Receivable, Chủ nợ-DPC=Payable, Debtors-S=Receivable.
- SANLOAN/DEMO POC không có `default_bank_account` ⇒ P4-1 không fallback-bank từ Company cho 2 company đó — rule-3 bắt.

## 6. Cảnh báo cho P4-1

- Chưa test **quyền của ERPNext user drawer sẽ dùng** trên `Account`/`Company`/`Mode of Payment` — 403 trên `frappe.client.get` (Company) với API key hiện có cho thấy ranh giới thật; P4-1 phải kiểm authorization từng doctype trước khi tin partial/empty.
- Chưa **test viết** gì (cấm) — mọi con số ở đây là kết quả get_list tại thời điểm đo; thêm mode mới trên site ⇒ phải đo lại trước khi tin map.

**Kết luận P4-0: ✓ map ở §2 + thứ tự rule ở §3b + két KHÔNG bị chặn (§4) — đủ để P4-1 bắt đầu.**
