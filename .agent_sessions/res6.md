agent đã xong A3,  xem báo cáo .agent_sessions/res6.txt và đối chiếu  code mới nhất rồi đưa ra kết luận
-------------------
**Kết luận: A3 đạt (server + đo site read-only) — đóng đúng phạm vi prompt4.**

### Đối chiếu `res6.txt` ↔ repo

| Hạng mục | Trạng thái |
|----------|------------|
| `src/einvoice/einvoice-pdf.mjs` | ✅ Có |
| Route `/input/einvoice` XOR xml/pdf | ✅ (`http-ask` + `source=einvoice_pdf`) |
| `A3-pdf-spike.md` + `A3-result.md` | ✅ |
| Fixture PDF + `a3-einvoice-pdf.test.mjs` | ✅ (15/15 theo result) |
| Site thật (chỉ đọc) | ✅ PDF text → 200, resolve NCC MST, 2 dòng item; PDF không chữ → **422** `EINVOICE_PDF_NO_TEXT` |
| Suite full | ~780 pass / 2 fail dsh (cũ) · Flutter 304 |
| Đường ghi mới / auto master / OCR trong A3 | ✅ Không (cùng pipeline A2 sau slots) |

### Đúng thiết kế

- Cùng schema slots + `source_document` (số HĐ không nhét câu NLP)  
- Số không đọc được / qty×rate lệch → **từ chối**, không form “đẹp nhưng sai”  
- Scan / no text-layer → camera (C), không bịa  

### Còn mở (không phải fail A3)

| Việc | Ghi chú |
|------|--------|
| **Commit** | Chờ bạn (cùng đống B/M1/A2 Flutter) |
| **Flutter chọn `.pdf`** | Chưa — picker vẫn `.xml`; A3 qua **API route** |
| **Migration B** `custom_business_doc_key` | Chưa chạy → execute PO từ XML/PDF vẫn có thể **PO_DOC_KEY_FIELD_MISSING** |
| PDF nhà cung cấp thật / ObjStm | Fixture tự sinh; ObjStm refuse có tên |
| Falsify harness riêng A3 | Không có (agent ghi) |

### Kết luận một dòng

| Câu hỏi | Trả lời |
|---------|---------|
| A3 xong? | **Có — server + test + probe site đọc** |
| Dùng trên app UI? | **Chưa** (thiếu file picker PDF) |
| Ghi nháp từ PDF end-to-end? | Cần **migration B** + confirm như XML |

**Tiếp:** migration B + commit hàng next4; (tuỳ) Flutter accept `.pdf`; rồi **prompt5 P9-D** nếu vẫn theo backlog.
-------------------
soạn prompt làm các việc sau: 
* bạn nói thiếu file picker PDF ? bổ xung
* migration B + commit hàng next4; (tuỳ) Flutter accept .pdf;
------
```text
Project: /Users/hoang/htdocs/erpnext/erpn_mobile1

Mục tiêu phiên này (3 việc, theo thứ tự):

════════════════════════════════════
1) Flutter: nhận file .pdf (bổ sung A3 UI)
════════════════════════════════════
Đọc: .plan/next4/A3-result.md (gap picker chỉ .xml),
apps/mobile/.../einvoice_file_picker.dart, chat_screen, /input/einvoice (pdf_base64).

Làm:
- Mở picker cho .xml VÀ .pdf (cùng nút HĐĐT hoặc nhóm type rõ).
- .xml → body { xml, kind } như A2.
- .pdf → body { pdf_base64, kind } đúng contract server (XOR, không gửi cả hai).
- Tái dùng form slots + source_document + /ask → proposal → confirm (0 đường ghi mới).
- PDF no-text / 422 EINVOICE_PDF_NO_TEXT → message tiếng Việt hướng camera.
- Test: mock picker pdf + xml; assert path/body; tripwire không parser PDF trên client.
- CẤM: parse PDF trong Dart; auto-execute; skill WRITE mới.

Deliverable: cập nhật .plan/next4/A3-result.md (mục Flutter PDF) hoặc .plan/next4/flutter-pdf-picker-result.md.

════════════════════════════════════
2) Migration B — custom_business_doc_key trên Purchase Order
════════════════════════════════════
Đọc: .plan/next4/B-dedupe-result.md §7, scripts/add-correlation-field.mjs.

Làm (site thật, idempotent):
  cd mcp-erpnext
  node scripts/add-correlation-field.mjs --plan-only
  set -a && source ../.env && set +a   # hoặc cách load env chuẩn repo
  node scripts/add-correlation-field.mjs "Purchase Order" --dry-run
  node scripts/add-correlation-field.mjs "Purchase Order"
- Verify field tồn tại (đọc meta / list).
- Ghi vào B-dedupe-result.md: ngày, host (không secret), verified.
- CẤM: xóa data; nới unique; migration doctype không liên quan trừ plan-only đã liệt kê.

════════════════════════════════════
3) Commit hàng next4 (khi 1+2 xong hoặc 1 xong + migration verified)
════════════════════════════════════
User CHO PHÉP commit (không push trừ khi ghi rõ).

Phạm vi gợi ý (một hoặc vài commit rõ message):
- M1-site (customer-create profile)
- A2 Flutter XML + A3 PDF picker
- B business_doc_key
- A3 einvoice-pdf server
- docs next4 results

Không commit: .env, secret, node_modules, file tạm probe nếu không cần.
Chạy lại nhanh: a3 + b-dedupe + flutter test liên quan trước commit.
Ghi hash commit vào result ngắn .plan/next4/next4-commit-note.md.

════════════════════════════════════
CẤM chung
════════════════════════════════════
- P9-D / skill WRITE mới
- Auto-submit
- In API key
- Tự push remote trừ user bảo "push"

Khi xong: tóm tắt 15 dòng — picker PDF paths, migration verified?, commit hashes, suite numbers.
```