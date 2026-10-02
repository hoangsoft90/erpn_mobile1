## Purpose

Khả năng `session-isolation`: context/session DSH và WRITE action được scope theo **principal + conversation**, sao cho hai người dùng/cuộc trò chuyện độc lập không thể đọc hoặc ghi đè context/WRITE của nhau — trong khi DSH global concurrency vẫn giữ = 1. NEXT 6 **không** triển khai multi-user authentication; nó chuẩn bị ranh giới session/write để một lớp auth theo từng user sau này gắn vào an toàn.

## ADDED Requirements

### Requirement: Session key includes principal

Session DSH MUST được khoá theo **`principal/user_id` + `conversation_id`** (tối thiểu). `conversation_id` đơn độc MUST NOT là key. Principal MUST lấy từ authentication/bind-policy server-side, MUST NOT lấy từ body.

#### Scenario: A dùng conversation A, B dùng conversation B
- **WHEN** principal A hỏi với conversation `C-A`, rồi principal B hỏi với conversation `C-B`
- **THEN** mỗi principal thấy context của chính mình; A tiếp tục `C-A` vẫn thấy context A, B tiếp tục `C-B` vẫn thấy context B

#### Scenario: B gửi conversation_id của A
- **WHEN** principal B gửi đúng `conversation_id` mà A đã dùng
- **THEN** B KHÔNG nhận context/lịch sử của A (session của B bắt đầu rỗng hoặc lỗi contract), KHÔNG bao giờ trả history của A

#### Scenario: cùng principal, hai conversation khác nhau
- **WHEN** principal A hỏi với `C1` rồi `C2`
- **THEN** context `C1` và `C2` không trộn lẫn

### Requirement: Identity is server-authoritative and not authentication

Hệ thống MUST lấy principal từ bind-policy/Basic Auth hiện có. Bất kỳ định danh do client cung cấp MUST NOT được coi là authentication; nếu dùng nó cho scoping thì MUST ghi rõ là convenience-only, spoofable, không phải security boundary.

#### Scenario: body gửi user_id giả
- **WHEN** client gửi `user_id`/`X-Device-ID`/`X-User-Email` trong body/header và principal thật khác
- **THEN** server dùng principal từ auth, bỏ qua `user_id` client

### Requirement: Deterministic session lifecycle

Store MUST có cap đọc từ config (`DSH_MAX_SESSIONS`, mặc định 200). Eviction MUST deterministic (LRU theo `last_used_at`), MUST NOT evict session đang xử lý. Khi hết ứng viên evict MUST trả mã deterministic (`SESSION_LIMIT_EXCEEDED` hoặc tương đương), MUST NOT random/hard crash. TTL MUST config-driven.

#### Scenario: đầy cap thì evict LRU, giữ active
- **WHEN** store đạt cap và cần thêm session mới
- **THEN** session ít được dùng nhất (`last_used_at` cũ nhất) bị loại; session đang xử lý request KHÔNG bị loại

#### Scenario: mọi session đều đang xử lý
- **WHEN** đạt cap mà mọi session đều active
- **THEN** tạo session mới trả `SESSION_LIMIT_EXCEEDED` (không loại bừa session đang chạy)

### Requirement: Same-conversation serialization

Hai request cùng `principal + conversation` MUST NOT chạy đồng thời theo cách đảo thứ tự context (lost update). Request thứ hai MUST đợi request thứ nhất (hoặc nhận busy state theo contract), và context cuối MUST phản ánh thứ tự request.

#### Scenario: hai request gần như đồng thời cùng conversation
- **WHEN** hai request cùng principal/conversation gửi gần như đồng thời (không áp global cap)
- **THEN** chúng chạy nối tiếp; context cuối chứa cả hai lượt, không mất lượt nào

### Requirement: Session clear scoped to caller

Xoá session (nếu có) MUST chỉ trong namespace của caller (`principal` của caller), MUST NOT xoá hay ảnh hưởng namespace của principal khác.

#### Scenario: A xoá session của A
- **WHEN** principal A xoá conversation của A
- **THEN** chỉ session của A bị xoá; session của B còn nguyên

### Requirement: Restart behavior documented, not faked

Nếu store là memory-only, hành vi khi process restart (mất context DSH) MUST được document; MUST NOT tuyên bố continuity sau restart nếu chưa persistent.

#### Scenario: restart process
- **WHEN** gateway process restart
- **THEN** context DSH memory-only mất sạch; tài liệu nói rõ điều này (không giả vờ persistent)

### Requirement: WRITE isolation across principals

Replay/execute WRITE MUST NOT cross principal. `begin()` khi `command_id` đã tồn tại của principal khác MUST từ chối (không trả kết quả của người khác). Proposal MUST mang principal và `runExecute` MUST kiểm lại.

#### Scenario: B replay command_id của A
- **WHEN** principal B gửi `command_id` đã COMPLETED của principal A
- **THEN** request bị từ chối (mã riêng), KHÔNG trả `result` của A

#### Scenario: proposal của A không execute được bởi B
- **WHEN** B gửi proposal (JSON) được build cho A, kèm `command_id` mới
- **THEN** execute bị từ chối vì proposal không thuộc principal B

### Requirement: DSH global concurrency stays 1

NEXT 6 MUST NOT tăng `DSH_MAX_CONCURRENT` mặc định (giữ = 1). Isolation MUST đạt được mà không cần tăng concurrency.

#### Scenario: mặc định
- **WHEN** không set env
- **THEN** `dshGatewayConfig().maxConcurrent === 1`

### Requirement: No new runtime mock

MUST NOT thêm mock/fake runtime. Fixture chỉ được dùng trong test boundary, không bật mặc định, không dùng để chứng minh hành vi REAL.

#### Scenario: thiếu cấu hình ERPNext thật
- **WHEN** process không có `ERPNEXT_*` và không đặt `COPILOT_MOCK_OK=1`
- **THEN** khởi động từ chối (`ERPNEXT_NOT_CONFIGURED`), KHÔNG âm thầm dùng fixture
