**Đánh giá: báo cáo agent **khớp code** — A0–A2 (mock + pipeline) đã ship; Exit A trên ERPNext thật **chưa** vì cấu hình kho.**

### Đã có trên disk (xác nhận)

| Deliverable | Có? |
|-------------|-----|
| `A0-einvoice-formats.md` | ✅ |
| `A-result.md` | ✅ |
| `src/einvoice/einvoice-xml.mjs` + `einvoice-slots.mjs` | ✅ |
| Fixture 4 XML | ✅ |
| `a1-einvoice-parser.test.mjs` / `a2-einvoice-input.test.mjs` | ✅ |
| `POST /input/einvoice` (theo result + implementation tick) | ✅ (route server) |
| Checkbox A0–A2 trong `implementation.md` | ✅ `[x]` |
| Upload Flutter | ❌ cố ý chưa (route “và/hoặc”) |
| Nháp PO **thật** trên site | ❌ chặn **Default Warehouse** |
| B dedupe tờ HĐ | ❌ optional, chưa |
| A3 PDF | ❌ chưa |

### Suite (theo `A-result.md`)

- Full Node **739 / 737 pass** — 2 fail **dsh** (cũ từ B0)  
- A1+A2 tests xanh; regress nhóm liên quan 185/185  
- Agent còn vá **4 bug thật** (filter MCP số, catch TDZ, fragment “lý”, kho PO) — đáng tin hơn chỉ “thêm feature”

### Còn việc **human / site**

1. Desk: **Item Defaults → Default Warehouse** cho item tồn kho  
2. Chạy lại `loop-a2-einvoice-real.mjs` → kỳ vọng `PUR-ORD-…` nháp  
3. (Tuỳ) Flutter upload XML  
4. (Tuỳ) B dedupe · A3 PDF · commit  
5. Gap **UOM “Nos”** (agent ghi, chưa sửa)

### Kết luận một dòng

| Câu hỏi | Trả lời |
|---------|---------|
| Plan XML/PDF đã triển khai chưa? | **A0–A2 code + mock: có** |
| Xong 100% Exit A (nháp ERPNext thật)? | **Chưa** — thiếu kho mặc định trên site |
| Báo cáo trong ảnh có đúng không? | **Đúng** |

**Việc bạn:** cấu hình warehouse trên ERPNext → chạy loop thật → mới coi A2 “đóng” trên production data.
-------------------
những việc của tôi thì có thể giao cho AI tự làm đc vì AI có quyền truy cập erpnext site nhé. Soạn prompt cho agent làm nốt việc đến khi đóng dc A2.
-----
```text
Project: /Users/hoang/htdocs/erpnext/erpn_mobile1

Mục tiêu: ĐÓNG Exit A2 trên ERPNext THẬT — tạo được 1 Purchase Order NHÁP từ XML HĐĐT và ghi tên doc vào result.

Đọc:
- .plan/next3/implementation.md (A2 + Exit A)
- .plan/next3/A-result.md §3 (gap Default Warehouse / PO_WAREHOUSE_UNRESOLVED)
- .plan/next3/loop-a2-einvoice-real.mjs
- .plan/next3/A0-einvoice-formats.md
- src/einvoice/*, route POST /input/einvoice, purchase-order-write (warehouse)

Bối cảnh: A0–A2 code + mock ĐÃ ship. Vòng thật từng tới /ask 200 (proposal PO) nhưng ERPNext 417 vì item tồn kho thiếu Default Warehouse. User CHO PHÉP bạn dùng quyền truy cập ERPNext site để cấu hình + ghi nháp.

Việc BẮT BUỘC (làm đến khi xong):

1) Site ERPNext — kho mặc định cho item dùng trong fixture/loop
   - Xác định item(s) trong XML/loop (vd CAM-GA-25KG hoặc item thật trên site).
   - Gán Item Default / Default Warehouse hợp lệ (cùng Company COPILOT_COMPANY, vd "Minh Phát Cám & VLXD").
   - Chỉ tạo/sửa master tối thiểu để PO nháp được chấp nhận — không đụng data không liên quan.
   - Fail-closed vẫn giữ: app không tự bịa kho; kho phải có trên master.

2) Correlation field
   - Xác nhận custom_ai_action_id (hoặc field contract) trên Purchase Order; thiếu thì chạy migration script idempotent có sẵn, không ghi mù.

3) Chạy lại E2E thật
   - source .env; COPILOT_COMPANY đúng; KHÔNG COPILOT_MOCK_OK cho vòng thật.
   - node .plan/next3/loop-a2-einvoice-real.mjs (hoặc flow tương đương: /input/einvoice → slots → /ask proposal → confirm/execute nháp).
   - Kỳ vọng: 1 PO docstatus 0, tên dạng PUR-ORD-…; verify đọc lại được.

4) UOM "Nos" (nếu chặn loop)
   - Nếu số lượng không parse vì UOM Nos: sửa tối thiểu (map/alias hoặc từ chối rõ + fixture) để loop XML chuẩn chạy được; ghi rõ trong result. Không hardcode quy đổi bừa.

5) Cập nhật docs
   - .plan/next3/A-result.md: section "E2E THẬT ĐẠT" + tên doc + company + item/warehouse đã gán.
   - implementation.md: Exit A đánh dấu đạt trên ERPNext thật (ghi ngày).
   - Không báo xong nếu chưa có tên PO thật trong result.

CẤM:
- Auto-submit PO
- Xóa/hủy chứng từ đã submit
- Auto-create Customer/Item/Supplier từ XML
- JE / chi không party
- Làm B dedupe / A3 PDF / Flutter upload trong phiên này (trừ khi chặn E2E)
- In API key/secret
- Tự push git (có thể stage; commit chỉ khi user từng cho phép vùng này — ưu tiên hỏi nếu chưa chắc)

Regress: chạy lại test a1+a2 + b4/po liên quan sau mọi sửa code; full suite nếu đụng gateway.

Khi xong: tóm tắt 10 dòng — PO name, warehouse đã set, suite numbers, path file đổi.
```