# ERPNext Vietnamese Voice Copilot — Mobile App

> **Tóm tắt 1 câu:** App Flutter giúp chủ tiệm/chủ hàng nói tiếng Việt (gõ, đọc bằng giọng qua STT của OS, hoặc **chụp ảnh chứng từ**) để **đọc** công nợ/hóa đơn/tồn kho/**tóm tắt ngày** từ ERPNext và **tạo chứng từ qua đề xuất có xác nhận** — 6 loại (thu tiền · đơn bán · báo giá · đơn mua · phiếu giao · phiếu nhận), **tất cả NHÁP** (`docstatus: 0`), số tiền chỉ COPY từ ERPNext.

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
| App | **Flutter 3.47.2 stable** / Dart 3.13.2 | `apps/mobile`, org `com.erpn` — tên hiển thị **"Nghiệp Vụ AI"** |
| Android SDK | minSdk 24 · targetSdk 36 · compileSdk 36 | quyền `RECORD_AUDIO` cho P6 |
| STT | `speech_to_text` 7.5.0 (OS) | P6 — không corpus, không tự host model; voice-first layout + cap 25s (P5-4) |
| TTS | `flutter_tts` 4.2.5 (on-device) | Chỉ đọc `turn.answer` + `proposal.summary`, gỡ markdown trước khi đọc |
| Markdown | `flutter_markdown_plus` 1.0.12 | Bubble câu trả lời render markdown |
| Camera/ảnh | `image_picker` 1.2.3 | Trụ C: ảnh → text (OCR) → form slot → đề xuất; KHÔNG auto-submit |
| State | Riverpod 3 (codegen `@riverpod`) | blueprint khóa, xem `patterns.md` |
| Router | GoRouter 18 | routes `/chat`, `/settings` |
| HTTP | dio 5 | timeout; gateway URL/auth đọc từ Settings mỗi request |
| Local storage | shared_preferences 2 | history versioned + AppSettingsService |
| Backend copilot | Node 24 (`mcp-erpnext/src/http-ask.mjs`, port 8788) | gateway: rate limit + authz + Safety Gateway + job queue |
| NLP bridge | Python 3.12 (`nlp_service/server.py`, port 8787) | stdlib, zero dependency |
| ERPNext MCP | `@casys/mcp-erpnext@3.0.4` + stdio | pin, né breaking change 3.0.0 |
| Agent runtime (chế độ AI) | `@deepseek-ai/dsh@0.1.5-rc.1` (pin ở root `package.json`) | opt-in **chỉ đọc**; resolver `npx --yes …@<pin>` — không hardcode đường dẫn một máy (`npm run dsh:check`) |
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

## Trạng thái rút gọn (cập nhật: 2026-09-22)

- ✅ **Phases2 P0–P8 + DSH đã commit** (P0 `b4acdb1` … P8 `90401f0` · P10-slice `7cb2798` · DSH `b61df0a`/`868be04` + runtime `dc60a4e`) — nền tảng đang chạy
- ✅ **Chế độ AI "Phân tích bằng AI"** (chỉ đọc, opt-in): Flutter → `/dsh/ask` → dsh runtime (resolver) → LLM Router → `copilot_ask`; câu lệnh ghi bị chặn TRƯỚC khi spawn; **không** là fallback của `/ask`
- ✅ **6 loại chứng từ tạo được qua đề xuất** (đều NHÁP, qua đúng 1 Safety Gateway + idempotency + verify + reconcile): thu tiền (PE) · đơn bán (SO) · báo giá (Quotation) · đơn mua (PO) · **phiếu giao (DN)** · **phiếu nhận (PR)** — submit CHỈ có ở Payment Entry, setting riêng mặc định OFF
- ✅ **Tóm tắt ngày + drill** (P4) và **camera/OCR → đề xuất** (Trụ C) — cả hai đều không có đường ghi riêng
- 🔶 Đợt 2026-09-20→22 (phases3 A1–C2 · plan4 · plan5 · P9-A/B) **CHƯA commit** — máy hiện không có git; chờ user duyệt (vùng số lượng/kho + chứng từ mua, AI không tự ký duyệt). Bằng chứng: Node **584** (582 pass, 2 fail môi trường `dsh-gateway`) · **Flutter 265** · analyze 0
- ⏳ Còn lại: ERPNext **thật** cho 4 WRITE mới (cần user cho phép + migration `custom_ai_action_id` trên DN/PR) · submit DN/PR/SO/QT/PO (Go/No-Go riêng) · saga §7 (chờ duyệt) · P10 full (infra) · **device smoke** (mic + chế độ AI + camera) + P8 deployment credentials (human — xem `human.md`)

Chi tiết đầy đủ: [`openspec.md`](openspec.md) + root `checklist.md`/`next.md`.
