## Purpose

Chặn rò rỉ context dev ra ngoài qua child dsh và chặn câu hỏi lạc đề TRƯỚC LLM, mà vẫn giữ
`copilot_ask` gọi ERPNext thật và hành vi "anh khánh" đi qua resolver (không refuse cứng).

## ADDED Requirements

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
