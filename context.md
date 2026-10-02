# context.md — ERPNext Vietnamese Voice Copilot

> Bức tranh tổng quan project. Tương đối tĩnh — chỉ cập nhật khi thay đổi lớn
> về bản chất. Nhật ký việc cụ thể: `working.md`. Chi tiết kiến trúc: `.project/`.

## Project là gì

App (Flutter) + backend copilot (Node/Python) cho chủ tiệm bán cám & thức ăn
chăn nuôi: hỏi **công nợ / hóa đơn / tồn kho** ERPNext bằng tiếng Việt tự nhiên
(`"chị Lan còn nợ bao nhiêu"` → `"Nguyễn Thị Lan còn nợ 2.500.000đ (1 hóa đơn
chưa trả)."`). Bắt đầu bằng text chat; voice/STT là Phase 4.

Sản phẩm định vị: **lớp AI UI trên ERPNext** — `understand → plan → act →
verify → report`, không phải "chatbot ERPNext".

## Tech stack (khóa)

| Tầng | Công nghệ |
|---|---|
| App | Flutter 3.47.2 (minSdk 24, target/compile 36), Riverpod codegen, GoRouter, dio, shared_preferences |
| Copilot | Node 24 — HTTP `/ask` (:8788) + MCP server stdio cho dsh |
| NLP | Python 3.12 stdlib — bridge HTTP :8787 + `vietnamese_nlp` (zero dependency) |
| ERP | `@casys/mcp-erpnext@3.0.4` (pin) + stdio, ERPNext thật qua ngrok |
| CI | GitHub Actions build APK debug (artifact `erpn-chat-debug-apk`) |

## Cấu trúc thư mục chính

```
apps/mobile/          # Flutter app (features/chat/, app/, core/)
mcp-erpnext/          # skill layer: http-ask, copilot-server, readonly-guard,
                      #   client, mock-server, router, skills/{customer,sales,...}
nlp_service/          # Python HTTP bridge (normalize)
src/vietnamese_nlp/   # NLP pipeline thuần (money/kinship/synonyms/quantity)
scripts/              # ask-copilot, mock-llm (dsh smoke)
.github/workflows/    # android-debug-apk.yml
.plan/phases/         # kế hoạch phase (tham chiếu — KHÔNG commit)
.project/             # knowledge item cho phiên mới (entry: README.md)
result*.txt           # bằng chứng lệnh + output theo phase
```

## Quyết định kiến trúc quan trọng nhất (chi tiết + lý do: `.project/patterns.md`)

1. **Agent Runtime = dsh** (deepseek-harness) — 2 trigger tách lớp đã chốt.
2. **Pin MCP ERPNext 3.0.4 + stdio** — né breaking change HTTP 3.0.0.
3. **Cầu nối Python ↔ Node = HTTP localhost** — 1 nguồn logic NLP, không port sang Dart.
4. **Mock-first MCP** — mock đúng shape thật; nối thật = đổi binary spawn.
5. **An toàn số tiền > độ phủ** — ambiguous → `answer: null` + reason.
6. **LLM ngoài read path** (MVP) — bảng từ khóa cố định; LLM chỉ cần từ Phase 6.
7. **Client = Flutter** (không PWA); build APK trên GH Actions, không trên VPS.

## Trạng thái hiện tại (2026-09-14)

- Branch `change/flutter-chat-mvp`, commits: `33f9dc0` (P1) → `0ac8e61` (P2) → `590b1b2` (P3).
- Tests xanh: Node 36/36 · Python 58/OK (money 259/259 = 100%) · Flutter 13/13 + analyze 0 issue.
- Đã nối ERPNext THẬT (dsh headless + mock LLM trả đúng số tiền từ hóa đơn thật).
- 2 project skills: `erpnext-mcp-connect`, `erpn-verify-first` (`.agents/skills/`, local-only).

## Tool env này

- Flutter: `export PATH="/google/flutter/bin:$PATH"` (SDK ở `/google/flutter`).
- Android SDK cài đủ để cấu hình nhưng **không build APK** trên VPS (quyết định user).
- VPS không chạy được Flutter desktop (thiếu clang/cmake/ninja/libgtk-3-dev).
- AgentMemory/MCP cocoindex/codebase-memory/OCR/Simplenote: không khả dụng —
  làm thủ công theo graceful degradation trong AGENTS.md.
