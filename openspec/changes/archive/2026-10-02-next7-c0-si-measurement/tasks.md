## 1. Chuẩn bị đo (không đổi code production)

- [x] 1.1 Đọc code drawer: block bán = `getDailySummary().sales_invoices` — SI `posting_date=date`, `docstatus=1`, `status!=="Cancelled"`, `!is_return`, sum `grand_total`; return **loại ra** (không trừ), `returns: null` V1. — `mcp-erpnext/src/skills/ops-summary.mjs` (`salesInvoices()`, `submittedNotCancelled()`) · bằng chứng dòng code trong C0-result.
- [x] 1.2 Company pin từ env server (`COPILOT_COMPANY`), KHÔNG auto-pick. — đọc `.env` key names, không in giá trị.

## 2. Query thật trên ERPNext REAL (một ngày lịch VN)

- [x] 2.1 Script đo tạm `/tmp/c0-si-measure.mjs` + `/tmp/c0-day.mjs` (REST + `token key:secret`, không in secret) — KHÔNG nằm trong repo production.
- [x] 2.2 Sample SI: 448 SI/16 ngày; 3 ngày then chốt đo chi tiết — 09-13 (27 normal + 1 return + 2 draft), 09-16 (157+4+**29 cancelled**), 09-17 (149+**17 return**+8 cancelled). Bảng + sample trong `.plan/next7/C0-result.md` §1. Không ngày nào đủ cả 4 loại (giới hạn dữ liệu thật — ghi rõ, không bịa).
- [x] 2.3 Field tiền: `grand_total` == `base_grand_total` trên MỌI row đo (VND); return **âm sẵn** trong DB (vd −777.600, `return_against` đúng HĐ gốc) ⇒ không cần abs. — C0-result §2.
- [x] 2.4 Net tay/script: 09-13 = **392.878.525** · 09-16 = **246.260.625** · 09-17 = **397.505.620**. — C0-result §3.
- [x] 2.5 Ngày mẫu: chọn 3 ngày phủ normal+return+cancelled+draft qua 3 lần đo (không 1 ngày đủ 4) — C0-result §7.

## 3. Đối chiếu Drawer cùng ngày + company

- [x] 3.1 `/read/daily-summary` THẬT (gateway REAL local 8904, `erp_target=REAL`, partial=false): 09-13 = 28 · 392.878.525; 09-16 = 161 · 246.260.625; 09-17 = 166 · 397.505.620. — C0-result §4.
- [x] 3.2 So: **drawer == NET tay, chênh 0 cả 3 ngày**. Phát hiện: aggregate `salesInvoices()` (ops-summary.mjs **L237**) KHÔNG xin field `is_return` ⇒ guard `!r.is_return` (**L244**) là dead code trên site thật ⇒ block thực chất NET; drill `invoices_today` (**L535**) CÓ field ⇒ LOẠI return ⇒ **drift thật aggregate↔drill** khi ngày có return (comment code không khớp hành vi thật). — C0-result §5.

## 4. Kết luận cho C1 (không code)

- [x] 4.1 `.plan/next7/C0-result.md` hoàn thành: sample · công thức net · so drawer (chênh 0) · khuyến nghị field/filter + quyết định drift để user duyệt · PE ≠ doanh thu · company pin. **Gate C0: PASS.**
- [x] 4.2 Giới hạn bằng chứng ghi rõ: không ngày nào đủ cả 4 loại; return đo được ở cả 3 ngày (1/4/17 lượt) nên dấu âm không phải 1 mẫu duy nhất; C7 (return làm net giảm) có bằng chứng thật, C8 (đủ 4 loại trong 1 query) có bằng chứng qua hợp 3 ngày.
