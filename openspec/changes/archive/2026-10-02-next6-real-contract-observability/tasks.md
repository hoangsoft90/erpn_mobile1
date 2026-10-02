## 1. REAL-only audit (không code change — deliverable là bằng chứng)

- [x] 1.1 Grep runtime paths `src/` với `mock|smock|fake|dummy|fixture|stub|sample|demo|fallback|testData`; phân loại mỗi match: runtime-usage / comment-nhãn / test-boundary. Kết quả + kết luận ghi `.plan/next6-result5.md`.
- [x] 1.2 Xác nhận bằng test hiện có: thiếu ERPNext config ⇒ FAIL (`test/target.test.mjs`, `test/mock-optin.test.mjs` — `ERPNEXT_NOT_CONFIGURED`), không fallback âm thầm. **KHÔNG xóa mock fixture** hợp lệ ở test boundary.

## 2. Observability — correlation cho log `dsh_ask` (backend)

- [x] 2.1 `dsh-gateway.mjs`: 3 `logEvent` phase `dsh_ask` (refused / failed / answered) thêm `user_id` (principal server-side đã có trong scope) + `conversation_id` + `dsh_in_flight` (giá trị `dshInFlight()` lúc log). Không thêm log line mới, không đổi shape HTTP.
- [x] 2.2 Test: log line `dsh_ask` mang đủ `request_id`/`user_id`/`conversation_id`/`dsh_in_flight`/`outcome`/`latency_ms`; raw line không match `/password|token|secret|api[_-]?key/i` (không leak secret).

## 3. API `/dsh/ask` — contract đã đạt (audit-only, có test hiện có làm bằng chứng)

- [x] 3.1 Validate `conversation_id` format/length: đã đạt (`isValidConversationId` ⇒ 400, test `http-ask.test.mjs` "malformed conversation_id").
- [x] 3.2 Omitted ID có cơ chế tạo thống nhất: đã đạt (`opts.conversationId ?? randomUUID()` trong `dshGatewayAsk`) — audit ghi nhận, không sửa.
- [x] 3.3 `user_id` body không phải authority: code đúng từ Prompt-2 (`principalId` từ route auth) — thêm TEST chứng minh (body gửi `user_id` khác ⇒ session/context vẫn scope theo principal auth, body bị bỏ qua).
- [x] 3.4 Không log full sensitive conversation chỉ để debug: đã đạt (`text.slice(0,200)` + `log_tail` scrubbed) — audit ghi nhận.

## 4. Flutter — persist `conversation_id` từ response

- [x] 4.1 `copilot_api_client.dart`: `DshAnswer` thêm field `conversationId` (String?, parse từ response envelope — additive).
- [x] 4.2 `chat_controller.dart`: sau turn DSH thành công, server trả `conversation_id` khác id hiện dùng ⇒ cập nhật `_dshConversationId` + persist qua `ConversationIdService` (thêm method `save(scope, id)`).
- [x] 4.3 Test Flutter: (a) `DshAnswer` parse `conversation_id`; (b) controller cập nhật id khi server trả id khác; (c) id giữ nguyên khi server trả cùng id.

## 5. Tests tổng hợp + bằng chứng

- [x] 5.1 Node: `npm test` full — mới pass, không regression (2 fail môi trường dsh từ B0 được chấp nhận và ghi rõ).
- [x] 5.2 Flutter: `flutter analyze` 0 + `flutter test` pass.
- [x] 5.3 Grep secret-leak trên log evidence (mục 2.2).

## 6. Docs

- [x] 6.1 `.plan/next6-result5.md`: REAL-only audit + grep results, API contract changes, observability fields, changed/unchanged files, tests/commands/results, structural-change justification, remaining mock references + lý do hợp lệ, limitations.
- [x] 6.2 Root docs: `working.md` cập nhật entry Prompt-5.
