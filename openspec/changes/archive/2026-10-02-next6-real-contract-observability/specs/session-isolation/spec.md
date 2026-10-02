## Purpose

Khả năng `session-isolation` (delta Prompt-5 NEXT6): log audit của đường DSH mang đủ correlation để trace request → conversation → outcome mà không lộ secret, và client persist đúng `conversation_id` mà server trả.

## ADDED Requirements

### Requirement: DSH audit log carries full correlation

Mỗi log line phase `dsh_ask` (refused / failed / answered) MUST mang: `request_id`, `user_id` (principal server-authoritative), `conversation_id`, `dsh_in_flight` (trạng thái concurrency), `outcome`, `latency_ms`. Log MUST NOT chứa password/token/secret/env.

#### Scenario: log line đủ trace
- **WHEN** một request `/dsh/ask` hoàn tất (bất kể outcome)
- **THEN** log line tương ứng có đủ 6 trường trên, và raw line không match `/password|token|secret|api[_-]?key/i`

#### Scenario: refuse/fail cũng mang correlation
- **WHEN** request bị refused (WRITE pre-screen) hoặc failed (runtime/session)
- **THEN** log line vẫn có `user_id` + `conversation_id` + `dsh_in_flight` — correlation không chỉ có ở nhánh thành công

### Requirement: client persists the server-issued conversation id

Response `/dsh/ask` mang `conversation_id` (server trả — gồm cả trường hợp client omitted và server tự sinh) MUST được Flutter model parse, và controller MUST cập nhật id đang dùng khi server trả id khác, để lượt hỏi tiếp theo nối đúng context server đã dùng.

#### Scenario: server trả id khác id client gửi
- **WHEN** client gửi `conversation_id = X` nhưng response trả `conversation_id = Y`
- **THEN** client cập nhật id hiện dùng thành `Y` và persist cho scope `(server, user)` hiện tại

#### Scenario: server trả cùng id
- **WHEN** response trả `conversation_id = X` trùng id client đang dùng
- **THEN** id không đổi (không persist thừa)

### Requirement: REAL-only runtime unchanged (regression guard)

Runtime path `/dsh/ask` MUST NOT fallback sang mock khi ERPNext config thiếu/unreachable; mock chỉ tồn tại ở test boundary (`COPILOT_MOCK_OK=1` opt-in tường minh).

#### Scenario: thiếu ERPNext config
- **WHEN** gateway khởi động không có `ERPNEXT_*` và không có `COPILOT_MOCK_OK=1`
- **THEN** khởi động FAIL với `ERPNEXT_NOT_CONFIGURED` (không âm thầm dùng mock)

#### Scenario: ERPNext unavailable giữa chừng
- **WHEN** ERPNext không truy cập được khi xử lý request
- **THEN** request FAIL với mã lỗi có cấu trúc — không trả 0/số giả, không fallback mock
