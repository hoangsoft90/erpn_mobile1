# Pattern Code đang dùng + Lý do

## Pattern áp dụng

| Pattern | Áp dụng ở | Cụ thể |
|---|---|---|
| **Feature-first** | toàn bộ `lib/features/` | `chat/{data,application,presentation}`; `domain/` chỉ khi có entity thật |
| **Repository/Service** | `data/` | `CopilotApiClient` (HTTP), `ChatHistoryService` (storage) — widget không biết dio/prefs tồn tại |
| **Dependency Injection** | `app/providers.dart` | Riverpod Provider — override được trong test (`overrideWithValue`) |
| **Notifier (MVVM-lite)** | `application/` | `ChatController` giữ state + logic; widget "dumb" chỉ build từ state |
| **Sealed exception** | `CopilotException` | `sealed class` + 3 subclass — UI map lỗi thành message tiếng Việt mà không thấy DioError |
| **Factory/env-switch** | `pickServerScript()` | mock/real ERPNext chọn theo env; sai config → hard error, không fallback âm thầm |
| **Fail-safe null-answer** | `answerQuestion()` | không route/không thấy khách → `answer: null` + `reason` — không bao giờ bịa dữ liệu |
| **Versioned storage key** | `chat_history_v1` | đổi schema → bump version, không phá dữ liệu cũ |
| **Whitelist guard in-code** | `readonly-guard.mjs` | chặn write ở tầng CODE; ID chỉ đến từ tool result (`assertKnownId`); output ERPNext bọc `markUntrusted` |
| **Safety Gateway single door** | `safety-gateway.mjs` (P0) | mọi WRITE qua `runExecute()` — idempotency + verify + reconcile; test tĩnh no-bypass quét `src/`+`scripts/` |
| **Contract-driven authorization** | `authorization.mjs` (P8) | permission/company scope đọc từ `capabilities.json`; server-first; prompt KHÔNG là quyền; identity suy từ principal (một nguồn "ai") |
| **Command_id idempotency** | `idempotency.mjs` | client sinh UUID 1 lần/proposal; retry cùng id = replay; record mang actor (P8) |
| **Fail-closed refusal có copy** | `uncertainty.mjs` (P2) | mọi refusal ra user phải map được vào taxonomy + copy tiếng Việt; unknown raw ⇒ null (không chế) |
| **Human-approved learning** | `learning-log.mjs` (P4) | pipeline KHÔNG bao giờ tự sửa contract; thêm trigger chỉ qua người duyệt + regression gate |
| **Voice là input modality** | `speech_service.dart` (P6) | STT chỉ đổ text vào ô input; interface không có method gửi/execute ⇒ không đường voice → WRITE |
| **Snapshot frozen at ask-time** | F7-2 | cờ submit/giá trị user thấy được đóng băng vào proposal lúc hỏi — đổi setting giữa chừng không làm lệch lúc bấm |

## Quyết định thiết kế quan trọng (và lý do)

| # | Quyết định | Lý do | Bị loại |
|---|---|---|---|
| 1 | **Riverpod (codegen) thay vì Bloc/Redux/setState** | blueprint khóa của skill `architecture` cho project này; codegen loại bỏ boilerplate provider; AsyncNotifier đủ cho state dạng danh sách + loading; Bloc thừa cho MVP 1 screen | Bloc (verbosely cho 1 screen), setState (logic dính UI) |
| 2 | **GoRouter thay vì Navigator 1.0** | cùng blueprint; declarative + deep link sau này (proposal card Phase 6+) miễn phí | Navigator.push rời rạc (cấm theo skill) |
| 3 | **shared_preferences thay vì Hive/SQLite** | user duyệt 2026-09-14; lịch sử chat là convenience (không query, không relational) — key-value + JSON đủ; Hive thêm dependency + adapter cho 0 lợi ích tại thời điểm này | Hive/SQLite (over-engineering cho history) |
| 4 | **dio thay vì http** | trong danh sách package duyệt của blueprint; interceptor + timeout + typed error tốt hơn `http` | package `http` |
| 5 | **Cầu nối Python ↔ Node = HTTP localhost** (chốt 2026-09-13) | 1 nguồn logic NLP duy nhất; không port sang Dart/JS → không bao giờ lệch số giữa 2 implementation; 2 service restart độc lập | Dart port của NLP (2 nguồn sự thật), subprocess (khó debug, lifecycle rối) |
| 6 | **stdlib `http.server` thay vì Flask/FastAPI** cho NLP bridge | 2 endpoint; máy có Flask nhưng thêm dependency không mua được gì (Ponytail) | Flask/FastAPI |
| 7 | **Mock-first MCP** (mock server đúng shape 3.0.4) | phát triển + test không cần credential; nối thật = chỉ đổi binary spawn, logic 0 thay đổi; contract test là spec sống | viết code thẳng vào server thật |
| 8 | **Pin `@casys/mcp-erpnext@3.0.4` + stdio** | breaking change 3.0.0 nằm ở HTTP transport (stateless, đòi protocol-version mới); stdio né hẳn; lockfile chốt | upgrade theo `next` (3.1.0-beta) |
| 9 | **dsh làm Agent Runtime thay vì tự viết agent loop** | quyết định kiến trúc Phase 0; MCP client built-in; 2 trigger tách lớp đã chốt rõ | tự viết agent loop (YAGNI) |
| 10 | **LLM ngoài pipeline read path (MVP)** | câu hỏi công nợ/tồn kho route được bằng bảng từ khóa cố định → deterministic, không tốn token, không bịa; LLM chỉ cần cho entity resolution phức tạp (Phase 6) | đưa LLM vào mọi câu hỏi |
| 11 | **An toàn số tiền > độ phủ** (nguyên tắc gốc) | sai tiền = mất niềm tin vĩnh viễn; ambiguous → từ chối + hỏi lại là recoverable | đoán số cho "đủ case" |
| 12 | **KHÔNG build APK trên VPS** (user chốt) | VPS không UI; CI GH Actions chuẩn hóa + lưu artifact | build tại chỗ |
| 13 | **AGENTS.md duy nhất ở repo root** | không tạo bản thứ hai; `.project/` là knowledge item, không phải rule agent | trùng lặp rule nhiều file |
| 14 | **An toàn tiền = nhiều lớp độc lập** (P0–P8) | contract → authz → amount → kill switch → freshness → idempotency → verify; mỗi lớp có test + falsify riêng; lớp nào gỡ ra cũng phải đỏ đúng chỗ | gộp hết policy vào 1 chỗ |
| 15 | **phases2 thay phase cũ** (`.plan/phases2/` supersede `.plan/phases/` phase-04/08/10–15) | P0–P8 giữ 8787/8788 + payment nháp, nâng theo Capability Contract; **cấm** `unknown → DSH`, không đường ghi thứ hai | làm lại theo phase-04/10 cũ (lỗi thời) |

## Anti-pattern đã từng mắc (không lặp)

- Whitelist tool theo tên **đoán** (`get_list/get_doc`) thay vì đọc source
  → 125 tool thật tên `erpnext_*` — xem skill `erpn-verify-first`
- Copy YAML từ `read_url` (bị flatten indentation) → luôn curl raw + `cat -A`
- Widget "trông đúng" trong code nhưng answer không bao giờ render → bắt
  bug bằng test in trạng thái thật, không tin code đọc qua
- Dead code giữ lại "phòng khi" (`ChatTurn.error` không ai gọi) → xóa
