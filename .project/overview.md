# ERPNext Vietnamese Voice Copilot — Mobile App

> **Tóm tắt 1 câu:** App Flutter giúp chủ tienda/chủ hàng nói tiếng Việt (bắt đầu bằng text chat, sau này là giọng nói) để **đọc** công nợ, hóa đơn, tồn kho từ ERPNext — không gõ phím ERP, không nhầm số tiền.

## Mục tiêu

Xây **lớp AI UI trên ERPNext**: `understand → plan → act → verify → report`.
Chat/voice chỉ là phương thức nhập liệu — giá trị thật là pipeline chuẩn hóa
tiếng Việt + guard an toàn tiền chạy **trước LLM**, cố định bằng code.

## Đối tượng người dùng

Chủ tiệm/cửa hàng bán cám & thức ăn chăn nuôi ở Việt Nam (3 miền), ít dùng
máy tính, trả lời khách bằng câu nói tự nhiên: *"chị Lan còn nợ bao nhiêu"*,
*"trong kho còn bao nhiêu cám heo"*. Bắt đầu 1 user (chủ), multi-user là
Phase 10.

## Tech Stack

| Lớp | Công nghệ | Ghi chú |
|---|---|---|
| App | **Flutter 3.47.2 stable** / Dart 3.13.2 | `apps/mobile`, org `com.erpn` |
| Android SDK | minSdk 24 · targetSdk 36 · compileSdk 36 | mặc định Flutter, chưa override |
| State | Riverpod 3 (codegen `@riverpod`) | blueprint khóa, xem `patterns.md` |
| Router | GoRouter 18 | 1 route `/chat` |
| HTTP | dio 5 | timeout 15s |
| Local storage | shared_preferences 2 | key versioned `chat_history_v1` |
| Backend copilot | Node 24 (`mcp-erpnext/src/http-ask.mjs`, port 8788) | skill layer read-only |
| NLP bridge | Python 3.12 (`nlp_service/server.py`, port 8787) | stdlib, zero dependency |
| ERPNext MCP | `@casys/mcp-erpnext@3.0.4` + stdio | pin, né breaking change 3.0.0 |
| CI | GitHub Actions | build APK trên GH, KHÔNG build trên VPS |

## Tài liệu điều hướng

| File | Nội dung |
|---|---|
| [`architecture.md`](architecture.md) | Kiến trúc code, cấu trúc thư mục, data flow |
| [`state-routing.md`](state-routing.md) | Riverpod providers, GoRouter, deep link |
| [`modules/`](modules/) | 1 file mỗi feature/module (API + storage) |
| [`integrations.md`](integrations.md) | 3rd party + CI/CD + secrets |
| [`design-system.md`](design-system.md) | Tokens màu/spacing/typography + widgets |
| [`patterns.md`](patterns.md) | Pattern code đang dùng + lý do |
| [`openspec.md`](openspec.md) | Tiến độ phases, bugs, todos |

## Tài liệu root (nguồn sự thật khi làm việc)

- `AGENTS.md` — nguyên tắc vận hành agent (verify-first, vùng tiền, commit)
- `context.md` — bức tranh hiện tại, đọc đầu mỗi phiên
- `working.md` — nhật ký việc đang làm
- `operating_rules.md` — rule cứng riêng project
- `next.md` / `checklist.md` — roadmap + trạng thái từng mục
- `result*.txt` — bằng chứng lệnh + output thật theo từng phase
- `handoff_*.md` — bàn giao giữa các phiên

## Trạng thái rút gọn (cập nhật: 2026-09-14)

- ✅ Phase 0–2 + Flutter chat MVP — committed tới `590b1b2`
- ⏳ Chờ: GitHub repo (push + build APK) · rotate ERPNext key · swap mock LLM
- ❌ Chưa có: STT (Phase 4), AI Gateway (Phase 5), write ops (Phase 7+)

Chi tiết đầy đủ: [`openspec.md`](openspec.md).
