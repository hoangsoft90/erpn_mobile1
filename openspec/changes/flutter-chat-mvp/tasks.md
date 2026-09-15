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
- [x] 3.2 Ghi trong README + next.md: quy trình user cấp repo → push → tải APK từ tab Actions (KHÔNG build trên VPS theo quyết định user).
- [x] 3.3 (mở rộng 2026-09-14) CI build APK nhận `COPILOT_BASE_URL`/auth qua repo Variables + Secret qua dart-define — artifact cài được lên máy thật, không hardcode endpoint vào repo (result10/11).
- [ ] 3.4 **Chờ user** dán 3 giá trị vào GitHub Settings (token hiện tại chỉ-đọc, PUT 404): Variables `COPILOT_BASE_URL`, `COPILOT_AUTH_USER` + Secret `COPILOT_AUTH_PASSWORD` (result11 §6).

## 4. Đóng gói phase

- [x] 4.1 UI-checkpoint: widget test 13/13 + mô tả UI → user duyệt UI → commit `590b1b2` (2026-09-14).
- [x] 4.2 Cập nhật result7.txt (số liệu thật: analyze/test/wrapper test), checklist.md, features.md, next.md, handoff mới.
- [ ] 4.3 `/opsx:verify` → sync/archive OpenSpec change khi APK chạy OK trên thiết bị thật (chờ: user xử lý endpoint — Tailscale/mở port — + dán 3 giá trị GitHub Settings + cài thử).

## 5. Phase 5 mở rộng (ngoài scope gốc của change — user chỉ đạo 2026-09-15 sau khi ký sign-off)

- [x] 5.1 Sign-off Phase 5 ký (không scrub, không 2-tier) → gate mở; LLM Router bản đơn giản `scripts/llm-router.mjs` + config JSON + audit JSONL (7/7 test, E2E smoke mock — result14, commit `87fcbb1`).
- [x] 5.2 Nối upstream thật (result15): endpoint chính thức zen/gemini; fix 2 bug router chạy thật (https transport, `stripFields` cho field `store` Gemini từ chối) + `LLM_ROUTER_DEBUG`; Gemini verify generate 200 · Zen billing-blocked (CreditsError).
- [x] 5.3 Cơ chế dsh thật (cordis patch row) → skill `erpn-dsh-setup`; mock qua router chạy thật 269.000đ.
- [x] 5.4 **User quyết định (2026-09-15)**: Zen ĐỂ SAU (billing-blocked giữ nguyên config) · Gemini free tier chấp nhận (429/503 = bình thường). Evidence result16 §6D: daily cap RPD=20 đã cạn 15/09 — E2E xanh chạy 1 session duy nhất sau reset (~nửa đêm giờ Pacific), không retry-loop trong ngày.
- [x] 5.5 Review vòng 2 trên fix của mình: 5 window-sau-await + stripFields validation (+2 test; router 10/10). Chờ duyệt commit vòng 2.
- [ ] 5.5 Router + config sửa thêm (result15) chưa commit — chờ user duyệt (vùng tiền/phân quyền).
