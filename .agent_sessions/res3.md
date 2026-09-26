**next4_prompt1 (M1-site): đạt — E2E thật OK.**

### Khớp `res3.txt` ↔ code/docs

| Hạng mục | Đánh giá |
|----------|----------|
| Bỏ hardcode **`Múa`** | ✅ Comment + `resolveProfileValues` (user → env → site → refuse) trong `customer-create.mjs` |
| Profile từ site/env | ✅ Individual / Vietnam / Individual (theo result) |
| Fuzzy **“A”** chặn mọi tên chứa chữ a | ✅ Sửa word-boundary; test + falsify ca P |
| `listCustomers` đủ danh mục | ✅ `limit: 0` (tránh sót khách → clone) |
| Correlation Customer | ✅ Migration đã chạy (theo result) |
| **E2E thật** | ✅ Customer **`Khách Test App M1`**; 123→124; công nợ resolve được |
| Suite | M1 **30/30** · Node **753/755** (2 dsh) · falsify **16/16** · Flutter **281** · Python **63** |
| Deliverable | ✅ `.plan/next4/M1-site-result.md` |

### Chất lượng

- Tìm bug **chỉ lộ trên site** (Múa, fuzzy “A”, limit 100) rồi ghim test — đúng kiểu P9/A2.  
- Fail-closed khi env/group sai (`CC_PROFILE_INVALID`) — hợp lý.

### Còn lại (không chặn “xong prompt1”)

1. **Duyệt commit** (agent không tự ký — master + record thật)  
2. Checklist **28 case APK** máy thật  
3. Chỉnh `.env` `COPILOT_DEFAULT_*` nếu muốn default khác Individual/Vietnam  

### Kết luận

| Câu hỏi | Trả lời |
|---------|---------|
| Prompt1 hoàn thành? | **Có** |
| Dùng được trên site? | **Có** (đã tạo khách test) |
| Việc tiếp theo trong next4? | prompt2 Flutter XML upload (hoặc 3–5 theo ưu tiên) |

**Một câu:** M1-site **đóng đúng spec** — hết hardcode Múa, tạo được khách thật, suite/falsify ổn; chỉ còn commit + smoke APK.