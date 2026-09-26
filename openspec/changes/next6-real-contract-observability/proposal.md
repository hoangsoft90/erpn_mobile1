## Why

Prompt-5 của NEXT 6 (`.plan/next6-prompt5.md`) yêu cầu hoàn thiện REAL-only runtime, API contract `/dsh/ask` và observability. Audit code thật (2026-09-26, file:line trong `.plan/next6-result5.md`) cho thấy phần lớn yêu cầu đã đạt từ Prompt-2→4, còn đúng 2 gap thật:

1. **Log `dsh_ask` thiếu correlation**: 3 `logEvent` trong `dsh-gateway.mjs` (nhánh refused / failed / answered) không mang `user_id` (principal) lẫn `conversation_id` — một operator không trace được request → conversation từ log; cũng không có trường nào ghi lại **DSH concurrency state** (`dshInFlight()`) như spec §Observability đòi hỏi.
2. **Flutter không persist `conversation_id` từ response**: gateway trả `conversation_id` (kể cả khi client omitted — server tự sinh `randomUUID()`) nhưng `DshAnswer` của Flutter không đọc field này và controller không cập nhật id. Nếu một request gửi thiếu id (hoặc response đổi id), thread tiếp theo sẽ tách khỏi context mà client không biết.

Ngoài ra: `user_id` trong body không được dùng làm authority đã đúng trong code từ Prompt-2, nhưng **chưa có test nào chứng minh** — Prompt-5 liệt kê đây là test bắt buộc.

## What Changes

- **`mcp-erpnext/src/dsh-gateway.mjs`**: 3 `logEvent` của phase `dsh_ask` thêm `user_id` (principal đã resolve server-side) + `conversation_id` + `dsh_in_flight` (trạng thái concurrency đọc từ `dshInFlight()` lúc log). Không đổi shape outcome/HTTP.
- **`apps/mobile/lib/features/chat/data/copilot_api_client.dart`**: `DshAnswer` thêm field `conversationId` (parse từ response, additive — null nếu server không trả).
- **`apps/mobile/lib/features/chat/application/chat_controller.dart`**: sau một lượt `/dsh/ask` thành công mà server trả id khác id hiện dùng ⇒ cập nhật `_dshConversationId` (persist qua `ConversationIdService.rotate` semantics — ghi đè scope hiện tại), để thread sau nối đúng context server đã dùng.
- **Tests (Node)**: (a) `user_id` client gửi trong body `/dsh/ask` không đổi principal mà gateway dùng (session vẫn scope theo principal auth); (b) correlation fields `user_id`/`conversation_id`/`dsh_in_flight` xuất hiện trên log line `dsh_ask` và **không** chứa secret; (c) regression: một conversation vẫn commit đúng namespace.
- **Tests (Flutter)**: response `conversation_id` được model parse; controller cập nhật id khi server trả id khác.

## Capabilities

### New Capabilities

(không có —Prompt-5 không mở capability mới)

### Modified Capabilities

- `session-isolation` (delta): log audit của phase `dsh_ask` mang đủ correlation (request_id · user_id · conversation_id · dsh_in_flight · outcome · latency_ms) và không chứa secret; client persist `conversation_id` mà server trả để conversation tiếp theo nối đúng context.

## Impact

- **Code**: `mcp-erpnext/src/dsh-gateway.mjs` (3 logEvent + 1 hằng rõ nghĩa) · `apps/mobile/lib/features/chat/data/copilot_api_client.dart` (1 field) · `apps/mobile/lib/features/chat/application/chat_controller.dart` (1 nhánh cập nhật id).
- **Tests**: `mcp-erpnext/test/next6-session-isolation.test.mjs` (+correlation/principal tests) · `apps/mobile/test/conversation_id_service_test.dart` hoặc file test controller (persist response id).
- **KHÔNG đụng**: mock-server/mock-ocr (REAL-only giữ nguyên — chỉ audit + grep evidence), auth model, payment lifecycle, route shape, Retry-After, DSH concurrency cap (=1).
- **Migration**: không cần — mọi thay đổi additive về log field và client model field.
