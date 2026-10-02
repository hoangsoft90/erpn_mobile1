# CLAUDE.md

**Toàn bộ quy tắc vận hành agent nằm trong [`AGENTS.md`](AGENTS.md) — đọc file đó, không nhân bản nội dung tại đây.**

Project: ERPNext Vietnamese Voice Copilot (`erpn_mobile1`) — Flutter client +
Node copilot (MCP ERPNext read-only) + Python NLP bridge.

## Tóm tắt 7 rule quan trọng nhất (chi tiết + lý do trong AGENTS.md)

1. An toàn số tiền > độ phủ — tiền chỉ COPY từ ERPNext; code chạm tiền không tự duyệt/commit.
2. Read-only đến Phase 7 (Go/No-Go gate).
3. Secrets chỉ trong `.env` (git-ignored, chmod 600); check-ignore trước staging.
4. Verify-first: đọc contract thật trước khi đoán; unit xanh ≠ chạy thật (skill `erpn-verify-first`).
5. Không tự cài service/tool còn thiếu; không build APK trên VPS (GH Actions).
6. Pin `@casys/mcp-erpnext@3.0.4` + stdio; mock/real switch qua env, sai config → hard error.
7. Flutter blueprint khóa: Riverpod codegen + GoRouter + Feature-first; package mới phải hỏi user.

## Bắt đầu phiên

1. Đọc `context.md` (bức tranh hiện tại) + `working.md` (đang làm gì) + `operating_rules.md`.
2. Trạng thái tiến độ: `next.md`, `checklist.md` · kiến trúc: `.project/README.md`.
3. Test nhanh: `PYTHONPATH=src python3 -m unittest discover -s tests` (root) ·
   `cd mcp-erpnext && node --test` · `cd apps/mobile && flutter analyze && flutter test`
   (Flutter cần `export PATH="/google/flutter/bin:$PATH"`).
