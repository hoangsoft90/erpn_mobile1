## 1. Session isolation (boundary 1)

- [x] 1.1 `DshSessionStore` khoá theo `principalId + conversationId`; API `get/set/delete(principalId, conversationId)` + `touch` convenience; metadata `principal_id/conversation_id/created_at/last_used_at/request_count/version`. — `src/dsh-gateway.mjs:485` (`dshSessionKey`), `:573` (`get`), `:598` (`set`), `:629` (`touch`), `:661` (`delete`).
- [x] 1.2 Cap đọc từ `cfg.maxSessions` (env `DSH_MAX_SESSIONS`); eviction LRU theo `last_used_at`; bảo vệ session active; cạn ứng viên ⇒ `SESSION_LIMIT_EXCEEDED`. — `src/dsh-gateway.mjs:532` (`#prune`), `:481` (`DSH_DEFAULT_SESSION_LIMIT`), `:484` (`SESSION_LIMIT_EXCEEDED`).
- [x] 1.3 Per-conversation lock (Promise map) trong `runDshAsk`; global concurrency giữ = 1. — `src/dsh-gateway.mjs:710` (`withDshConversationLock`), `:866`.
- [x] 1.4 `dshGatewayAsk`/`runDshAsk` nhận `principalId` (mặc định `anonymous` cho test), truyền xuống store + lock. — `src/dsh-gateway.mjs:858`, `:1284`.
- [x] 1.5 `http-ask.mjs`: truyền `principal.user_id` xuống `dshGatewayAsk`. — `src/http-ask.mjs` (`/dsh/ask` handler).

## 2. sessionContext scope theo principal (G3)

- [x] 2.1 `session-context.mjs`: key kèm principal; `clear` chỉ namespace caller. — `src/session-context.mjs` (`contextKey`, `clear(scope)`).
- [x] 2.2 `copilot-server.mjs`: mọi `set/get/writeEligible` truyền `userId`. — `src/copilot-server.mjs` (`contextScopeFor`, call sites).

## 3. WRITE isolation (boundary 2)

- [x] 3.1 `idempotency.begin()`: record lưu `user_id`; replay khác `user_id` ⇒ từ chối `COMMAND_ID_FOREIGN`. — `src/idempotency.mjs` (`begin`).
- [x] 3.2 `action-proposal.mjs` build: thêm `principal_user_id` (additive, ở `answerQuestionLogged`). — `src/copilot-server.mjs`.
- [x] 3.3 `safety-gateway.mjs` runExecute: so `proposal.principal_user_id` với `actor.user_id` ⇒ `PROPOSAL_PRINCIPAL_MISMATCH`. — `src/safety-gateway.mjs`.

## 4. Observability + 429

- [x] 4.1 `Retry-After` trên 429 (DSH busy). — `src/http-ask.mjs` (`DSH_BUSY_RETRY_AFTER_S`).
- [x] 4.2 `/ask` nhận `conversation_id` optional (validate) + ghi vào audit line qua `correlation`. — `src/http-ask.mjs`.

## 5. Flutter conversation lifecycle (G8)

- [x] 5.1 Helper tạo conversation id ổn định (UUID-ish) + persist (SharedPreferences) gắn `(server,user)`. — `apps/mobile/lib/features/chat/data/conversation_id_service.dart`.
- [x] 5.2 "Cuộc trò chuyện mới" (clearHistory) ⇒ id mới; đổi server/user ⇒ clear. — `chat_controller.dart` (`build`, `clearHistory`), `settings_screen.dart`.
- [x] 5.3 Test Flutter. — `apps/mobile/test/conversation_id_service_test.dart` 5/5.

## 6. Tests + docs

- [x] 6.1 `test/next6-session-isolation.test.mjs` 14/14: §9.1/9.2/9.3/9.4/9.6 · cap/eviction active-protected · clear scoped.
- [x] 6.2 Cập nhật `test/dsh-gateway.test.mjs` theo API store mới.
- [x] 6.3 Full node test **834 / 832 pass / 2 fail dsh-env B0** · `flutter analyze` 0 · `flutter test` 338/338.
- [x] 6.4 `.plan/next6-result2.md` đã viết.
