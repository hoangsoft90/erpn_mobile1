## Why

next7 Workstream C (`sales.summary` — "Báo cáo doanh thu hôm nay") bị **chặn bởi gate C0**
(`plan_final.md` §5.2): không được implement skill với filter đoán. Trên site thật chưa từng đo:
(1) field tiền nào dùng được cho doanh thu net (`base_grand_total` vs `grand_total`), (2) ERPNext
site biểu diễn return thế nào (`is_return`? số âm sẵn?), (3) block bán trên Drawer
(`/read/daily-summary` → `getDailySummary().sales_invoices`) **loại** return ra hoàn toàn
(không trừ — `returns: null` ở V1) trong khi định nghĩa nghiệp vụ kỳ vọng là **net = thường − return** ⇒
ngày có return, chat net và drawer block sẽ KHÁC nhau nếu không xử lý. C0 phải đo bằng chứng thật
trước khi C1 code.

## What Changes

- **CHỈ ĐỌC/đo** — đúng phạm vi `prompt-C0.md`:
  - Query REST ERPNext **REAL** (company pin từ env server, KHÔNG auto-pick): lấy sample SI của
    **một ngày lịch VN** (`Asia/Ho_Chi_Minh`) gồm 4 loại: submitted thường, submitted return,
    cancelled, draft.
  - Đo field tiền (`base_grand_total` vs `grand_total`) + dấu của return (âm sẵn hay cần xử lý).
  - Tính net kỳ vọng **bằng tay/script một-lần** từ sample (script đo nằm ngoài repo — /tmp,
    không phải code production).
  - Đọc block bán trên Drawer (`/read/daily-summary`) cùng ngày + company, ghi số.
  - Kết luận filter + field cho C1 + ghi rõ **PE không vào doanh thu**.
- Output `.plan/next7/C0-result.md`: bảng sample (không secret), công thức net đã chứng minh,
  so drawer vs net tay, khuyến nghị C1.

## Capabilities

### New Capabilities
(không có — C0 là đo đạc, không mở capability)

### Modified Capabilities
(không có — `sales.summary` sẽ được delta ở change C1, SAU khi gate này PASS)

## Impact

- **Code production: KHÔNG đổi file nào** (CẤM theo prompt-C0: không implement skill, không đổi
  router/DSH/voice, không WRITE).
- **File mới**: `.plan/next7/C0-result.md` (gitignored) — bằng chứng đo.
- Script đo tạm: `/tmp/c0-*.mjs` dùng env `ERPNEXT_*` + `COPILOT_*` từ `.env` (không in secret,
  không commit).
- PASS khi: có bằng chứng query thật; phân biệt được normal/return/cancelled/draft; ghi rõ
  PE ≠ doanh thu. Không PASS ⇒ C1 không được code.
