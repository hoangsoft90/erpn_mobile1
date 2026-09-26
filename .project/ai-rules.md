# AI Rules — quy tắc vận hành agent cho project này

> **LƯU Ý CHO CHỦ DỰ ÁN:** file này KHÔNG tồn tại trước 2026-09-14 — agent phát hiện
> khi được yêu cầu "tuân thủ quy tắc trong .project/ai-rules.md" (verify trước, không
> đoán). Nội dung dưới đây được TỔNG HỢP từ `AGENTS.md` + `operating_rules.md` + thực
> tế vận hành đã được duyệt qua các phiên (result1→11). **Cần bạn review/duyệt hoặc sửa**
> — nếu quy tắc bạn định đặt khác với nội dung này, sửa file này; sau đó agent coi đây
> là nguồn quy tắc số 1 của thư mục `.project/`.

## 1. Nguồn sự thật — mỗi loại thông tin đúng 1 nơi

| Thông tin | Nguồn duy nhất |
|---|---|
| Trạng thái đã làm / chưa làm / chờ ai | `checklist.md` (root) |
| Roadmap + thứ tự phase + gate | `next.md` (root) |
| Tính năng hiện tại/tương lai | `features.md` (root) |
| Bằng chứng (lệnh + output thật) | `resultNN.txt` (root, mới nhất = số lớn nhất) |
| Nhật ký việc đang mở | `working.md` (root) |
| Handoff phiên | `handoff_<YYYYMMDD-HHmm>.md` (root, mới nhất) |
| Kiến thức tĩnh (kiến trúc/design/patterns/modules) | `.project/*.md` (KHÔNG chứa progress) |
| Tiến độ OpenSpec change | `openspec/changes/<change>/tasks.md` |
| Quy tắc agent | `.project/ai-rules.md` (file này) + `AGENTS.md` (hạ tầng chung) + `operating_rules.md` |

Quy tắc: **không nhân bản progress vào `.project/`** — `.project/openspec.md` là pointer.
Cập nhật docs theo từng cụm: sau mỗi thay đổi lớn → `resultNN.txt` + `checklist.md` +
`features.md` + `next.md` + `working.md` + `handoff_<ts>.md` (cùng 1 lượt, không để lệch).

## 2. An toàn — các đường đỏ (KHÔNG vượt kể cả khi user nói chung chung)

1. **Vùng tiền/số/phân quyền**: không tự ký duyệt, không tự commit — chờ user review
   rõ ràng (một câu "tiếp đi" chung chung không đủ; phải là duyệt cho commit/duyệt code).
2. **Secrets**: không bao giờ đưa key/token/password vào file bất kỳ (code, docs, skill,
   result, test fixture). Secrets chỉ sống trong `.env` (git-ignored) hoặc GitHub Secrets.
   Nếu phát hiện secret lọt vào file evidence → REDACT ngay trước commit (đã xảy ra với
   result9.txt — redact `<OLD-KEY-VALUE>`).
3. **Endpoint public**: service trả dữ liệu công nợ/tên khách thật KHÔNG BAO GIỜ bind
   public không auth. Server phải tự từ chối cấu hình unsafe (đã code trong http-ask.mjs).
4. **Gate pháp lý Phase 5 (PII/NĐ13)**: KHÔNG code LLM Router/PII scrubbing cho tới khi
   `SIGNOFF-phase5-pii.md` được ký. Đây là gate ký duyệt, không phải gate kỹ thuật.
5. **Read trước Write**: không phase write nào bắt đầu trước khi phase read-only đạt
   exit criteria đo thật (chuẩn tham chiếu: result9 đo 18/18 trên server thật).
6. **ERPNext**: chỉ read-only đến hết Phase 6; write đầu tiên (Phase 7) sau Go/No-Go gate.

## 3. Quy trình kỹ thuật bắt buộc

1. **Verification-before-completion**: không báo "xong" bằng lời — mọi claim kèm lệnh +
   output thật. Unit xanh ≠ chạy thật: sau unit xanh phải chạy ≥1 loop thật với dữ liệu
   thật (chi tiết: skill `erpn-verify-first`).
2. **Đọc trước khi sửa/đoán**: đọc source/file lấy nguyên văn trước str_replace; đọc
   contract (tool name/env/response shape) từ source thật, không đoán từ tên.
3. **Trạng thái máy bằng lệnh**: `git remote -v` / `ls` / `grep` / `ip addr` trước khi
   tin mô tả trong prompt/handoff (kể cả mô tả của chính agent từ phiên trước).
4. **CI đối chiếu gitignore**: bất kỳ codegen/artifact nào bị gitignore → CI phải tự
   sinh; "xanh" phải ghi rõ môi trường nào xanh.
5. **Test hermetic**: test không được phụ thuộc env của shell persistent (strip
   `ERPNEXT_*` khi spawn); không đụng server thật từ mock test.
6. **Targeted testing**: chạy test cho đúng vùng sửa + caller quan trọng; full suite
   khi chạm shared core hoặc trước commit lớn.
7. **Graceful degradation**: tool down → retry đúng 1 lần → fallback, báo user, KHÔNG
   tự cài lại/restart service.

## 4. Hợp tác với user

- Hỏi khi quyết định không rõ ràng; làm tiếp không hỏi khi việc đã được duyệt
  ("không bị chặn cứ làm tiếp").
- Sau mỗi phiên: cập nhật bộ docs (mục 1) + handoff; trước khi kết thúc phiên phải
  dọn untracked không cần thiết và tóm tắt commit đề xuất chờ duyệt.
- Phạm vi commit: KHÔNG commit `.env`, `.plan/`, `.gemini/`, `.opencode/`, `initp`,
  `node_modules`, build artifacts. `.agents/` bị gitignore bởi repo (cố ý) — skills
  sống local-only.
- Commit message: conventional (`feat:`/`fix:`/`docs:`), nêu intent + bằng chứng test.

## 5. Môi trường đã biết (đừngDiscovery lại)

- Linux VPS container: `eth0` 10.88.0.4/16 · public IP là NAT (không bind trực tiếp
  được) · tailscale cài nhưng cần login · ngrok KHÔNG có · port từ internet chỉ mở
  những gì host map sẵn (8788 hiện bị firewall hosting chặn từ ngoài).
- Flutter build APK CHỈ trên GitHub Actions (không build trên VPS).
- AgentMemory/MCP cocoindex/codebase-memory/OCR/Simplenote: không khả dụng trong env
  này → review thủ công.
