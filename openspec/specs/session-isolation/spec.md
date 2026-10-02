# session-isolation Specification

## Purpose
Khả năng `session-isolation`: context/session DSH và WRITE action được scope theo **principal + conversation**, sao cho hai người dùng/cuộc trò chuyện độc lập không thể đọc hoặc ghi đè context/WRITE của nhau — trong khi DSH global concurrency vẫn giữ = 1. NEXT 6 **không** triển khai multi-user authentication; nó chuẩn bị ranh giới session/write để một lớp auth theo từng user sau này gắn vào an toàn.

## Requirements

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

### Requirement: DSH runtime is isolated from the dev workspace

Child dsh MUST chạy với cwd KHÔNG chứa tài liệu dev (`AGENTS.md`, `CLAUDE.md`, `working.md`,
`operating_rules.md`, `.plan/`) — qua `DSH_CWD` env hoặc fallback `tmpdir()/dsh-gw-cwd`.
MCP server path trong patch MUST resolve bằng env TUYỆT ĐỐI (`ERPN_COPILOT_SERVER`,
`ERPN_REPO_ROOT`) nên hoạt động dưới mọi cwd; `copilot_ask` MUST vẫn gọi ERPNext thật sau khi
đổi cwd. Route credential của dsh MUST là placeholder không-bí-mật (`DSH_ROUTER_CREDENTIAL`);
router tự thay Authorization per-upstream; provider key thật không bao giờ nằm trong env của dsh.

#### Scenario: sentinel trong tài liệu dev không lọt tới model

- **WHEN** đặt dòng sentinel tạm vào `AGENTS.md`/`working.md`/`operating_rules.md` rồi hỏi qua `/dsh/ask`
  với cwd đã cô lập, dùng probe-LLM tất định
- **THEN** output chứa `PROBE_SENTINEL=NO_LEAK` (config cũ trước thay đổi cho ra `LEAK` — đã đo
  104472 chars so với 52248 chars)

#### Scenario: copilot_ask vẫn thật sau khi cô lập cwd

- **WHEN** hỏi "chị Lan còn nợ bao nhiêu" qua `/dsh/ask` với cwd cô lập
- **THEN** câu trả lời chứa số liệu ERPNext thật và envelope mang `erp_target=REAL`

### Requirement: Clear off-topic asks are refused by code before the LLM

`dshQuestionGate()` MUST trả `DSH_OFF_TOPIC` cho câu hỏi lạc đề RÕ RÀNG (kiến thức chung, code/dev
của chính app, thời tiết/tin tức, tài chính không liên quan) khi ERP router KHÔNG nhận diện câu.
Deny-list MUST fold dấu tiếng Việt (case/accent-insensitive) và MUST chỉ áp dụng cho câu không
được router nhận diện (câu ERP thật thắng deny-list). "ERPNext là gì?" MUST trả câu cố định
`DSH_META_INFO` (không để LLM tự giải thích). Câu có dạng thực thể ("anh khánh") MUST đi QUA gate
cho resolver xử lý (MISSING_ENTITY), không refuse cứng.

#### Scenario: câu lạc đề rõ ràng bị chặn trước LLM

- **WHEN** hỏi "cách nuôi con lợn?" / "viết code Flutter cho app này" / "thời tiết hôm nay" qua gate
- **THEN** bị từ chối `DSH_OFF_TOPIC` BY CODE, không spawn dsh

#### Scenario: câu ERP thật không bị deny-list chặn oan

- **WHEN** hỏi "cám heo tồn bao nhiêu?" (từ "nuôi" không xuất hiện nhưng câu được router nhận diện)
- **THEN** gate cho qua (`ok: true`)

#### Scenario: câu dạng thực thể đi qua resolver

- **WHEN** hỏi "anh khánh"
- **THEN** gate cho qua; resolver trả MISSING_ENTITY/câu hỏi làm rõ, không bịa persona dev

### Requirement: DSH system prompt carries the ERP domain boundary

Patch dsh MUST cấu hình row `system-prompt` (qua `@deepseek-ai/dsh-system-prompt`,
`personaPrefix`) với ranh giới phạm vi ERP (công nợ/hóa đơn/tồn kho/đơn hàng, từ chối ngắn gọn
các chủ đề khác) — đây là DEFENCE IN DEPTH, KHÔNG thay thế code gate; workspace instructions
inject ở user-role KHÔNG override được lớp system này.

#### Scenario: ranh giới system tới được model

- **WHEN** chạy probe-LLM với patch mới
- **THEN** probe thấy message `role=system` chứa marker `ERP_BOUNDARY_V1` (`PROBE_BOUNDARY=FOUND`)
