agent đã xong "chống trùng theo TỜ hoá đơn ( business_doc_key )",  xem báo cáo .agent_sessions/res5.txt và đối chiếu  code mới nhất rồi đưa ra kết luận
--------------------------
**Kết luận: Workstream B (chống trùng tờ HĐ) — code + test đạt; chưa “đóng production” đến khi migration site + (tuỳ) vòng XML thật 2 lần.**

### Đối chiếu `res5.txt` ↔ repo

| Hạng mục | Trạng thái |
|----------|------------|
| Module `src/business-doc-key.mjs` | ✅ Có |
| `test/b-dedupe.test.mjs` | ✅ Có |
| Deliverable `B-dedupe-result.md` | ✅ Có, chi tiết khớp report |
| Flutter `source_document` trên `/ask` | ✅ (theo result + file list) |
| Suite (theo agent) | B 10/10 · full ~763–764 pass · falsify 8→9 · Flutter 304 |
| **Migration `custom_business_doc_key` trên PO** | ❌ **Chưa chạy site** (agent nói rõ) |
| Commit | ⛔ Chờ bạn |

### Thiết kế (đúng thống nhất)

- Khóa = **kind (contract) + party (MST ưu tiên) + số HĐ chính xác + ngày** → `bdk_<sha256>`  
- Đi **ngoài câu** (`source_document`) vì NLP nuốt số HĐ thành tiền  
- Trùng → **409 `PO_DUPLICATE_DOC` + `existing_doc`**  
- Thiếu cột → **refuse, không ghi**  
- `command_id` / `custom_ai_action_id` giữ; câu mua thường **vẫn** tạo nhiều nháp  

### Giới hạn đã ghi (chấp nhận được)

- Chỉ **PO** (chưa SO/bán)  
- OCR chưa luôn gắn `source_document` (app đã sẵn chỗ truyền)  
- `unique=1` ↔ hủy/amend — vận hành tay nếu đụng  
- Race song song chưa đo  

### Việc còn lại của bạn

1. Migration PO: `add-correlation-field.mjs "Purchase Order"` (plan-only → dry-run → chạy)  
2. Duyệt commit  
3. (Tuỳ) XML thật **2 lần cùng file** → lần 2 phải 409 + cùng `PUR-ORD-…`  

**Một câu:** B **đúng và đủ trên mock/test**; production anti-dup tờ HĐ **bật sau migration** — không phải thiếu code.
-----------------------
Đọc:
- .plan/next3/implementation.md §A3
- .plan/next3/A0-einvoice-formats.md
- src/einvoice/* (tái dùng schema slots XML)
- OCR path (PDF scan → OCR, không làm lại OCR trong A3 trừ fallback)

Mục tiêu: MVP PDF có text-layer → extract → cùng schema slots untrusted → /input/einvoice hoặc compose tương đương → proposal → confirm → nháp (cùng A2).

Làm:
1) Spike: 1–2 PDF mẫu (text extract được). Ghi .plan/next4/A3-pdf-spike.md nếu format lệch XML.
2) Extract text/structured fields tối thiểu (invoice_no, dates, MST, lines nếu parse được).
3) Map vào slots source: "einvoice_pdf" (untrusted).
4) PDF scan / không text → fail rõ hoặc hướng OCR (C), không bịa số.
5) Endpoint hoặc flag kind=pdf trên input hiện có — không nhân pipeline WRITE.
6) Test fixture ≥2 PDF (hoặc text extracted golden) + regress a1/a2.

CẤM: auto-create master; submit; parser bỏ qua confirm; làm B/M1 trong phiên trừ khi chặn.

Deliverable: .plan/next4/A3-result.md.
ERPNext nháp thật: chỉ khi user đã cho phép (giống A2); không bắt buộc nếu extract chưa ổn định.