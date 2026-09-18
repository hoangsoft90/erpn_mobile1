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
- [x] 5.5 Review vòng 2 trên fix của mình: 5 window-sau-await + stripFields validation (+2 test; router 10/10). → commit `49317a7` (đã duyệt, đã push).
- [x] 5.6 **E2E thật XANH (result17 §K/L, 2026-09-15 14:40)**: 1 session trả đúng **457.875đ** từ ERPNext thật, khớp ground truth độc lập; fix 2 root cause chặn nó — cooldown không được disable đường duy nhất (router 13/13) + **gateway mang `thought_signature` của Gemini 3.x** (`ThoughtSignatureCache`, router 19/19); harness durable `mcp-erpnext/dsh-e2e.patch.yml` + `scripts/llm-router.e2e.json`.
- [x] 5.7 Commit `be57052` (đã duyệt + push) — thought_signature + harness + docs (result17).
- [x] 5.8 Commit `8d9f04c` + `a379a71` (đã duyệt + push) — mock E2E config + đếm lại số quota (result18/19) + upstream `mac-custom` (LLM tự host trên Mac, không quota) làm chain dev hàng ngày (result20).
- [x] 5.9 **Fix credit-note — ĐÃ COMMIT `6054458` (đã duyệt + push, result21)**: `outstanding_amount > 0` → `!== 0` (customer.mjs + sales.mjs) + mock credit note SINV-0004 + nhãn "chứng từ chưa thanh toán"; verify thật 457.875đ/1 và 171.800đ/4 (trước fix 269.000đ/3).
- [x] 5.10 Review vòng 2 đợt fix (result21 §6): 3 lỗi thật — batch runner bị `node --test` chạy như unit test (guard `NODE_TEST_CONTEXT`), `http-ask.test.mjs` treo suite do leak `ASK_*` + setup ngoài try (strip `ASK_*` + try/finally), kỳ vọng eval cũ `"(N hóa đơn"` thành fail giả sau khi đổi nhãn (chấm theo số tiền/số lượng).

## 6. Ngoài scope change này (Phase 6–9 — tracked ở root docs + resultNN; entry point để phiên sau không phải dò lại)

> Các phase sau MVP được quản lộ bằng `.plan/phases/` + root docs (checklist/next/working +
> result*.txt). Mục này chỉ là pointer ngắn — KHÔNG nhân bản trạng thái chi tiết.

- [x] 6.1 Phase 6 (entity resolution + Risk Level + ProposalCard) — ✅ commit `553d962`.
- [x] 6.2 Phase 7 Stage A (idempotency + /execute mock + nút Flutter) — ✅ commit `8ebfc0e`.
- [x] 6.3 Phase 7 Stage B + review vùng tiền + chaos test (result25/26/27) — ✅ **commit `eea0411` (đã duyệt + push 2026-09-16)**.
- [x] 6.4 faq.md + 2 fix NLP/resolver (result28) — ✅ cùng commit `eea0411`.
- [x] 6.5 Phase 9 phần an toàn: TTL + re-validate + intent lock + `clash_command_id` (result29) — ✅ cùng commit `eea0411`; **result31 đã nối thêm**: route `/execute/cancel` (chỉ huỷ PENDING sau reconcile=0) + nối `buildPaymentProposal()` vào router (nhóm `payment_write`, anchor `startsWith` + `notIf` — nút [Xác nhận] thật qua E2E + widget test JSON verbatim); review vòng 2 (result31 §11): F1 anchor nuốt câu đọc lịch sử (fix deny-list + test round 2) · F2 `store.cancel()` ngoài try/catch → crash process risk (đã bọc) · F3 reason dùng `rawText`. Suite: Node 119/119 · Python 60/60 · Flutter 29/29 · analyze 0 — **9 file + result31 addendum CHỜ DUYỆT COMMIT tiếp theo**.
- [x] 6.6 Còn treo chờ user: SUBMIT phiếu thu demo (2 PE demo đã xoá 2026-09-16 qua `erpnext_doc_delete`, verify hóa đơn gốc không đổi) · thought_signature live · audio 150 câu · APK thật.
- [x] 6.7 **P0 phases2** (Capability Contract + Safety Gateway + kill switch + golden dataset) — ✅ commit `b4acdb1` (+ docs `0ce2893`); review vòng 2 sửa 3 lỗi thật + falsify (`result44.txt`); chi tiết `.plan/phases2/p0-result.md` (bị gitignore — xem root docs).
- [x] 6.8 **P1 phases2** (entity 4 trạng thái + candidate picker + immutable snapshot + codes tách + `UNKNOWN→RECONCILING` + business dedup + NLP-down write block) — ✅ **ĐÃ COMMIT `ee93f13`** (đã push 2026-09-17); review vòng 2 fix harness Flutter (`result45.txt`). Suite: Python 60 · Node 173 · Flutter 67 · analyze 0.
- [x] 6.9 **P2 phases2** (uncertainty taxonomy 11 mã + copy TV + session context provenance/TTL + WRITE fail-closed + Flutter `PipelineProgress`) — ✅ **ĐÃ COMMIT `33ff725`**.
- [x] 6.10 **P3 phases2** (LLM Classifier semantic-only qua LLM Router cho câu keyword-router không hiểu; không trả ERP id; intent ∈ contract; LLM down ⇒ rule-only; golden classifier gate + mock LLM) — ✅ **ĐÃ COMMIT `c38e4ea`** (kèm fix guard env numbers `451cd8f`).
- [x] 6.11 **P4 phases2** (learning loop có người duyệt: JSONL never-throw + cluster report chỉ-đọc + contract chỉ sửa qua người) — ✅ **ĐÃ COMMIT `d7e9ba9`**.
- [x] 6.12 **P5 phases2** (DSH explicit opt-in READ: `COPILOT_DSH_CONTEXT` gate; `/ask` không có đường spawn dsh; mọi WRITE trong context dsh bị `DSH_WRITE_BLOCKED`) — ✅ **ĐÃ COMMIT `6318eca`**.
- [x] 6.13 **P7 phases2** (background job queue cho lệnh ghi đã confirm khi ERP tạm down + `startJobRunner()` trong `main()` + `/jobs` + cancel `release()` + crash-recovery) — ✅ **ĐÃ COMMIT `3e6240a`**; TTS hoãn có lý do (việc client).
- [x] 6.14 **P10 slice** (enforce rate limit trong contract + 429 trước Safety Gateway + correlation §17 trên `/ask`/`/execute`/job) — ✅ **ĐÃ COMMIT `7cb2798`**; vòng review 3 bổ sung test E2E per-capability + `docs/kill-switch-runbook.md` (`21d77ff`) + bài học (`d6295ab`).
- [x] 6.15 **F7 policy ĐÃ QUYẾT (a) DO USER 2026-09-18 — commit `3b41313`**: bảo trì/kill switch KHÔNG phải một lần thử — job về lại RETRYING, attempts roll back, tự chạy lại khi switch tắt (bằng chứng `result53.txt`; `docs/kill-switch-runbook.md` §4).
- [x] 6.16 (cập nhật 2026-09-18) — các phase bị chặn đã GIẢI CHẶN và commit: **P6 voice/STT ✅ `9b54d35`** (gate audio BỎ — dùng STT OS, không corpus; còn lại: build APK CI + smoke mic = human) · **P8 multi-user/RBAC ✅ `90401f0`** (test bằng fake principal; còn lại: `COPILOT_USERS`/`COPILOT_COMPANY` thật + user ERPNext thứ 2 = human) · **P9 gate ĐÃ MỞ** (Golden 0 miss sau `c5db7cc`) — chờ lệnh user · **F7-2 submit switch ✅ `eb4ba34`** (setting OFF mặc định, frozen vào snapshot; còn lại: quyết bật/tắt = user) · P10 full vẫn hoãn (infra: DR drill, dashboard, load test, rate-limit store phân tán).
