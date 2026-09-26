## Why

DSH (chế độ "Phân tích bằng AI") lưu context hội thoại trong `DshSessionStore` khoá bằng **`conversation_id` đơn độc** (`mcp-erpnext/src/dsh-gateway.mjs:459,524,544`) — không có `principal/user_id`. Vì vậy hai thiết bị/người dùng khác nhau gửi cùng một `conversation_id` sẽ **dùng chung context** (rò rỉ cross-user). Audit `.plan/next6-audit1.md` (§8) khẳng định đây là gap **G1**, kèm các gap liên quan: `sessionContext` toàn cục khoá theo `kind` (G3), idempotency replay không kiểm `user_id` (G4), proposal không bind principal (G5), `DSH_MAX_SESSIONS` không được dùng + eviction không bảo vệ session đang chạy (G7), Flutter tạo conversation id rải rác/không persist (G8).

NEXT 6 **không** triển khai multi-user authentication. Mục tiêu là **session/write isolation đúng** để một lớp auth theo từng người dùng (sau này) có thể gắn vào an toàn, trong khi DSH global concurrency vẫn giữ = 1.

## What Changes

- **Session key**: `DshSessionStore` scope theo `principalId + conversation_id` (key nội bộ `principalId\0conversationId`); API `get(principalId, conversationId)`, `set(...)`, `delete(...)`; metadata thêm `principal_id`, `conversation_id`, `created_at`, `last_used_at`, `request_count`, `version`.
- **Session limits**: dùng `cfg.maxSessions` (env `DSH_MAX_SESSIONS`, mặc định 200) thay hằng cứng `DSH_SESSION_LIMIT`; eviction LRU theo `last_used_at`; **không evict session đang xử lý**; cạn ứng viên ⇒ `SESSION_LIMIT_EXCEEDED` (deterministic, không random).
- **Per-conversation serialization**: lock theo `principal+conversation` (Promise map) — hai request cùng conversation phải nối tiếp, không lost update; global cap vẫn = 1.
- **Identity server-authoritative**: `http-ask.mjs` truyền `principal.user_id` (từ bind-policy/Basic Auth) xuống `dshGatewayAsk`; không nhận `user_id` từ body.
- **`sessionContext` scoped** theo principal (không dùng chung toàn cục) — G3.
- **WRITE isolation**: `idempotency.begin()` từ chối replay/khác `user_id` (mã riêng) — G4; proposal mang `user_id` lúc build và `runExecute` so lại (additive, tương thích client cũ) — G5.
- **Flutter conversation lifecycle**: helper tạo id ổn định (UUID-ish), **persist** (SharedPreferences) gắn `(server,user)`; "cuộc trò chuyện mới" ⇒ id mới; đổi server/user ⇒ clear (G8).
- **Observability**: `Retry-After` trên 429 (DSH busy + rate limit); `conversation_id` xuất hiện trong audit line `/dsh/ask` đã có, thêm vào `/ask` khi client gửi (optional, additive).

## Capabilities

### New Capabilities
- `session-isolation`: session/context DSH được scope theo principal + conversation; lifecycle (cap/LRU/eviction bảo vệ active/TTL) deterministic; clear chỉ trong namespace của caller; WRITE idempotency không cross-user.

### Modified Capabilities

(Không sửa requirement nào của `chat-client` — luồng UX không đổi.)

## Impact

- **Code (backend)**: `mcp-erpnext/src/dsh-gateway.mjs` (store + lock + metadata + limit) · `mcp-erpnext/src/http-ask.mjs` (principalId, Retry-After, log field) · `mcp-erpnext/src/copilot-server.mjs` + `session-context.mjs` (scope principal) · `mcp-erpnext/src/idempotency.mjs` (cross-user refuse) · `mcp-erpnext/src/action-proposal.mjs` + `safety-gateway.mjs` (proposal bind user_id).
- **Code (client)**: `apps/mobile/lib/features/chat/application/chat_controller.dart` (+ helper conversation id).
- **Tests**: `mcp-erpnext/test/next6-session-isolation.test.mjs` (MỚI) + cập nhật `test/dsh-gateway.test.mjs` theo API mới.
- **KHÔNG đụng**: `payment-write.mjs` (lifecycle đã đạt), `authorization.mjs` (đã server-authoritative), `mock-server.mjs`/REAL path, Drawer/READ semantics next5.
- **Migration**: store mặc định memory-only ⇒ **clean restart in-memory** khi deploy (mất context DSH cũ), document rõ; **không** dựng migration shim.
- **API contract**: **additive** — client cũ vẫn chạy (field mới optional); `conversation_id` trên `/dsh/ask` giữ nguyên shape `^[A-Za-z0-9_.:-]{1,64}$`.
