agent đã xong next4_prompt2 — Flutter upload file XML HĐĐT, đọc code mới nhất và xem báo cáo .agent_sessions/res4.txt
-------------------------
**next4_prompt2 — đạt về code/test theo `res4.txt`; deliverable `.plan/next4/flutter-xml-upload-result.md` không thấy trên path kiểm tra (có thể gitignore / chưa sync), nhưng source Flutter có thật.**

### Code có trên disk

| Thành phần | Có? |
|------------|-----|
| `lib/.../einvoice_file_picker.dart` | ✅ Interface + decode, **không** parse nghiệp vụ, cap 950KB |
| `file_selector: ^1.1.0` trong `pubspec.yaml` | ✅ |
| `test/chat_einvoice_xml_test.dart` | ✅ |
| Nút / wiring `chat_screen` + providers | ✅ (grep HĐĐT) |
| Tái dùng form OCR slots → compose → `/ask` | ✅ đúng hướng `res4` |
| Server đổi skill WRITE | Agent báo **0 dòng** — hợp lý nếu chỉ client |

### Khớp báo cáo agent

| Điểm | Đánh giá |
|------|----------|
| JSON `{xml, kind:"purchase"}` không multipart | Đúng contract A2 |
| Cấm parser XML thứ hai trên client | Có trong design + tripwire (theo res4) |
| Không auto-execute / không master | Cùng form OCR đã có |
| Suite Flutter **298→299** sau review | Chỉ có trong report — không chạy lại live ở đây |
| Review 4 finding (2 layout test, layering, kind literal…) | Có lý, kiểu P9 |

### Còn mở (đúng res4)

1. **Commit** (dependency + UI ghi) — chờ bạn  
2. **E2E ERPNext** qua app — chưa (tránh PO nháp thứ 2)  
3. **Smoke APK** 9 bước trên máy thật  
4. File **`flutter-xml-upload-result.md`**: res4 nói đã ghi; listing `.plan/next4` lúc check **chỉ thấy** `M1-site-result.md` → nên xác nhận path/commit docs  

### Kết luận

| Câu hỏi | Trả lời |
|---------|---------|
| Prompt2 code xong? | **Có** (picker + test + pubspec + chat) |
| Đủ production user? | **Gần** — thiếu smoke APK + (tuỳ) E2E tay |
| Tin `res4`? | **Tin thiết kế + file source**; số suite lấy theo agent |

**Một câu:** Upload XML trên Flutter **đã implement đúng pipeline server**; coi **kỹ thuật xong**, còn **duyệt commit + test máy thật**.