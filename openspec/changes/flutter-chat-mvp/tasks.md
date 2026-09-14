## 1. HTTP wrapper `/ask` cho copilot (Node, cạnh nlp_service)

- [x] 1.1 Viết `mcp-erpnext/src/http-ask.mjs`: HTTP server tối giản (Node http, bind 127.0.0.1 mặc định, port 8788) — POST `/ask` {text} → `answerQuestion(text)` (import từ copilot-server.mjs) → JSON; GET `/health`; lỗi trả JSON sạch `{ok:false,error}` không leak stack; log stderr gọn.
- [x] 1.2 Viết `mcp-erpnext/test/http-ask.test.mjs`: spawn thật — /health 200, /ask câu hỏi mock trả answer đúng shape, /ask text thiếu → 400, /ask service NLP chết → 5xx JSON sạch, không leak key.
- [x] 1.3 Chạy `npm test` xanh (34 cũ + mới), cập nhật README mục chạy.

## 2. Flutter app khung (apps/mobile/)

- [x] 2.1 `flutter create apps/mobile --platforms android,linux` (org theo repo, không web/iOS); `flutter pub get`.
- [x] 2.2 Model + client: `ChatTurn` (question/answer/reason/routed/customer/outstanding/ok/ts) + `CopilotClient` (POST `/ask`, timeout 15s, map lỗi thành exception có message tiếng Việt) — đầy đủ unit test với mock HTTP (không cần service thật).
- [x] 2.3 Màn hình chat 1 screen: ListView lịch sử, input + nút gửi, loading indicator khi chờ, disabled input khi đang chờ, footer hiện `COPILOT_BASE_URL` đang dùng.
- [x] 2.4 Lịch sử local bằng `shared_preferences` (key versioned `chat_history_v1`), restore khi mở app; lỗi lưu/fail-safe: mất lịch sử không crash app.
- [x] 2.5 Toast lỗi (SnackBar) khi request fail, giữ lại text đã gõ trong ô nhập; không dialog chặn.
- [x] 2.6 `flutter analyze` 0 issue; `flutter test` xanh (13/13: 9 unit + 4 widget; widget test: gửi câu hỏi mock → hiện answer + route label; service lỗi → hiện toast + giữ text).

## 3. CI build APK trên GitHub Actions

- [x] 3.1 Thêm `.github/workflows/android-debug-apk.yml`: trigger push/PR, setup Java 21 + Flutter stable + `flutter pub get` + `flutter analyze` + `flutter test` + `flutter build apk --debug`, upload artifact `erpn-chat-debug-apk`.
- [ ] 3.2 Ghi trong README + next.md: quy trình user cấp repo → push → tải APK từ tab Actions (KHÔNG build trên VPS theo quyết định user).

## 4. Đóng gói phase

- [ ] 4.1 UI-checkpoint: chạy app (desktop nếu cài deps được, nếu không qua widget test + screenshot sau) → xin user duyệt UI trước khi commit.
- [ ] 4.2 Cập nhật result7.txt (số liệu thật: analyze/test/wrapper test), checklist.md, features.md, next.md, handoff mới.
- [ ] 4.3 `/opsx:verify` → commit trên branch change → sync/archive OpenSpec change khi user OK.
