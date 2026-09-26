# Design — next6-session-isolation

## Structural-change gate (4 điểm bắt buộc)

1. **Exact problem:** `DshSessionStore` khoá session bằng `conversation_id` đơn độc (`dsh-gateway.mjs:459,524,544`); `sessionContext` là singleton toàn cục khoá theo `kind` (`copilot-server.mjs:56,1409`); `idempotency.begin()` replay không kiểm `user_id`; proposal không bind principal.
2. **Acceptance criterion không đạt nếu giữ nguyên:** §11.A "Session key không chỉ là conversation_id" · "Không cross-user context leakage" · §9.1/9.4 (isolation A/A vs B/B, P1/C1 vs P2/C1) · §9.6 (WRITE isolation).
3. **Why insufficient:** key thiếu principal ⇒ hai principal trùng `conversation_id` dùng chung context; sessionContext toàn cục ⇒ customer của A seed được WRITE của B; replay không kiểm user ⇒ B nhận kết quả của A.
4. **Smallest viable change:** thêm `principalId` vào key + metadata; gọi `store.get/set/delete(principalId, conversationId)`; thêm lock Promise per-key; scope `sessionContext` theo principal; `begin()` so `user_id`; thêm field `user_id` additive vào proposal. Không đổi route, không đổi abstraction, không dời file.

## Session key

- Key nội bộ: `` `${principalId}\u0000${conversationId}` `` (NUL không nằm trong charset `isValidConversationId`, nên không thể va chạm).
- Caller KHÔNG truyền composite key thô — luôn `(principalId, conversationId)`.
- `principalId` = `principal.user_id` do `http-ask.mjs` resolve (Basic Auth/bind-policy). Không bao giờ lấy từ body.
- Metadata record: `{ principal_id, conversation_id, turns, created_at, updated_at, last_used_at, request_count, version, ttlMs }`.

## Lifecycle / eviction

- Cap: `cfg.maxSessions` (env `DSH_MAX_SESSIONS`, mặc định 200) — bỏ hằng cứng `DSH_SESSION_LIMIT`.
- Prune TTL trước, rồi LRU theo `last_used_at`.
- `activeKeys` (Set) đánh dấu session đang xử lý; prune bỏ qua chúng.
- Không còn ứng viên ⇒ `SESSION_LIMIT_EXCEEDED` (throw từ `set`/`touch`), route map 429/503 tuỳ contract.
- File mode: cap/eviction áp cho memory mode (mặc định); file mode vẫn TTL-check khi đọc (giữ hành vi cũ).

## Per-conversation serialization

- Map `locks: key → Promise` trong `runDshAsk`. `withConversationLock(key, fn)` nối `fn` vào đuôi chain của key, trả kết quả; xoá entry khi chain xong.
- Thứ tự: acquire conversation lock **trước**, rồi mới kiểm global `inFlight` (để same-conversation xếp hàng thay vì 429; khác conversation vẫn 429 khi global bận).
- Global concurrency giữ = 1.

## Identity source

- `http-ask.mjs`: đã có `const principal = …resolvePrincipal...` (:444) và `userId = principal.user_id` (:452). Truyền `principalId: userId` vào `dshGatewayAsk`, và `userId` vào `sessionContext` scope + proposal.

## sessionContext scope

- Thêm key principal vào mọi `set/get/writeEligible/clear` (key nội bộ `userId\0kind`). Giữ API cũ nếu caller truyền `userId`; thiếu ⇒ namespace `"anonymous"` (tương thích test cũ). `clear(userId)` chỉ xoá namespace của caller.

## WRITE isolation

- `idempotency.begin(commandId, {...user_id})`: record lưu `user_id`; nếu record đã tồn tại và `user_id` khác ⇒ trả `{ ok:false, code:"COMMAND_ID_FOREIGN", ... }` (không replay, không lộ result).
- `buildProposal`: thêm field additive `user_id` (từ opts). `runExecute`: nếu `proposal.user_id` có mặt và khác `actor.user_id` ⇒ từ chối `PROPOSAL_PRINCIPAL_MISMATCH`. Tương thích client cũ (proposal cũ thiếu field ⇒ bỏ qua check, hành vi như trước).

## Migration

- Store mặc định memory-only ⇒ **clean restart in-memory**: deploy mất context DSH cũ (đã document). Không dựng shim.

## What is NOT changed

- `payment-write.mjs` (lifecycle đã đạt §6.5/§9.7), `authorization.mjs` (server-authoritative sẵn), `mock-server.mjs`/REAL path, Drawer/READ semantics next5, route shape `/dsh/ask`.
