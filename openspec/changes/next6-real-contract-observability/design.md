# Design — next6-real-contract-observability

## Structural-change gate (4 điểm)

1. **Exact problem:** log `dsh_ask` thiếu `user_id`/`conversation_id`/`dsh_in_flight` ⇒ không trace được request → conversation → outcome từ log alone; Flutter bỏ qua `conversation_id` server trả ⇒ thread có thể tách context mà client không biết.
2. **Acceptance criterion không đạt nếu giữ nguyên:** Prompt-5 §Observability ("request tối thiểu có correlation: request_id, principal/user_id, conversation_id, outcome, latency, DSH concurrency state"); §API ("response conversation_id phải được Flutter persist đúng").
3. **Why current implementation is insufficient:** `dsh-gateway.mjs` logEvent lines (refused/failed/answered) không có 2 field này dù biến `principalId`/`conversationId` có sẵn trong scope; `DshAnswer` parse đúng 3 field (`answer`, `erpnext_target`, `dsh_session_id`) nhưng bỏ `conversation_id`.
4. **Smallest viable change:** thêm field vào 3 logEvent hiện có (không thêm log line mới, không đổi schema event khác); thêm 1 field + 1 nhánh cập nhật ở client. Không dời module, không đổi route.

## REAL-only audit (không cần code change — bằng chứng là deliverable)

- `pickServerScript` (`copilot-server.mjs:119-143`): thiếu `ERPNEXT_*` ⇒ throw `ERPNEXT_NOT_CONFIGURED` trừ khi `COPILOT_MOCK_OK === "1"` (opt-in tường minh cho test) — không fallback âm thầm.
- Remote DSH (`runRemoteDsh`): thiếu config/token/tunnel chết/timeout ⇒ `DSH_UNAVAILABLE`/`DSH_TIMEOUT` — **không bao giờ** hạ cấp về local spawn.
- `ocr-provider.mjs:256`: provider lạ ⇒ refuse, "never silently mocked".
- ERPNext unreachable giữa chừng ⇒ refusal có mã (503/`ERP_UNAVAILABLE`…), không 0 giả (next5 D0.5 đã gate).
- Grep `mock|smock|fake|dummy|fixture|stub|sample|demo|fallback|testData` trên `src/` — kết quả + phân loại (runtime usage vs comment/label/test-only) ghi `.plan/next6-result5.md`.
- **Guardrail**: KHÔNG xóa mock fixture vì tên "mock" (`mock-server.mjs`, `mock-ocr.mjs` là test boundary hợp lệ); KHÔNG refactor logging toàn hệ thống.

## API `/dsh/ask` — trạng thái đạt + gap

Đã đạt (không sửa): message required + bound; `conversation_id` optional với ID-generating thống nhất (`opts.conversationId ?? randomUUID()` trong `dshGatewayAsk`); malformed id ⇒ 400; identity từ auth/bind-policy (`principalId: userId` từ route, không đọc body); `log_tail` scrubbed.

Gap sửa:
1. **Log correlation** (backend): 3 logEvent thêm `user_id`, `conversation_id`, `dsh_in_flight`. `dsh_in_flight` = giá trị `dshInFlight()` tại thời điểm log (sau run: số slot đang bận; refused 400: trước khi vào run). Giữ `CORRELATION_KEYS` của `learning-log.mjs` nguyên — các field mới đi qua spread `...fields` của `logEvent` (không cần sửa learning-log).
2. **Client persist response id** (Flutter): `DshAnswer.conversationId` (String?) + controller cập nhật `_dshConversationId` khi server trả id khác; persist qua `ConversationIdService` (thêm method `save(scope, id)` tái dùng `_persist` — private hiện tại).

## Secrets: cái gì được log, cái gì không

- Log `dsh_ask` chỉ mang: ids, mode, runtime, session id, target label (`REAL|MOCK`), `text.slice(0,200)`, latency, concurrency. Không có token/password/env.
- `log_tail` đã qua `scrubDiagnostics` (Prompt-2 audit §2.3, giữ nguyên).
- Test assert: raw log line không match `/password|token|secret|api[_-]?key/i`.

## What is NOT changed

- `learning-log.mjs` (logEvent generic, spread đủ), `http-ask.mjs` (route đã pass `principalId`), mock-server/mock-ocr, auth model, payment-write, Retry-After, session store, DSH concurrency cap.
