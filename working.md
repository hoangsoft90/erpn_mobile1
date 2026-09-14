# working.md — Nhật ký đang làm

> Việc cụ thể gần đây, format ngày `YYYY-MM-DD`. Dọn mục đã xong quá 1–2 tuần
> (nội dung cũ nằm trong `result*.txt` + `.project/openspec.md`).

## Đang mở (chờ ngoài / việc nhỏ tiếp theo)

- [ ] **Chờ user duyệt commit đợt fix result9** (Phase 2 pipeline + CI workflow fix) → push lại → GH Actions build APK run 2 → tải artifact `erpn-chat-debug-apk`
- [ ] **Rotate ERPNext key/secret ĐÚNG trên server** — verify 2026-09-14: key cũ vẫn hợp lệ (HTTP 200); user chọn chạy tiếp với key cũ, rotation = chưa xong
- [ ] **Chờ user cấp LLM gateway thật** (OpenAI-compatible) → chỉ sửa `/tmp/dsh-home/settings.yaml`, không đụng code
- [ ] Sau khi APK chạy thật OK: sync + archive OpenSpec change `flutter-chat-mvp`, merge branch về master
- [ ] Khi AgentMemory sống lại: `/remember` pointer tới 2 skill `erpnext-mcp-connect` + `erpn-verify-first`

## Đã xong gần đây

- [2026-09-14] Xong: **đo batch accuracy thật Phase 2** (`result9.txt`): 18 câu qua ERPNext thật, 27.8% → 61.1% → **18/18 = 100%** sau khi fix 5 nhóm lỗi; test cuối 40/40 node · 58/58 Python; 14 file modified chờ user duyệt commit (vùng tiền)
- [2026-09-14] Xong: **push `change/flutter-chat-mvp` lên GitHub** (remote tự setup từ `.env` GH_REPO_URL/GH_TOKEN — repo trước đó không có remote); run CI đầu FAILURE ở Analyze (gitignore `*.g.dart`) → workflow thêm step build_runner (chưa commit)
- [2026-09-14] Xong: tạo bộ knowledge item `.project/` (9 file) + `CLAUDE.md` pointer + điền phần PROJECT trong `AGENTS.md` + `context.md`/`working.md`/`operating_rules.md`
- [2026-09-14] Xong: 2 project skills — `erpnext-mcp-connect` + `erpn-verify-first` (`.agents/skills/`, local-only; làm rõ "aki mcp" = ERPNext MCP qua ask_user)
- [2026-09-14] Xong + commit **590b1b2**: Phase 3 Flutter chat MVP (64 files) — apps/mobile + `http-ask.mjs` + GH Actions workflow; UI-checkpoint user duyệt; Node 36/36, Flutter 13/13, analyze 0 issue; 4 bug thật sửa (quan trọng nhất: ChatBubble không render answer)
- [2026-09-14] Xong: Task 1 `/ask` wrapper + tests; Task 3 workflow CI (validate YAML)
- [2026-09-14] Xong: cài 7 skills `flutter/agent-plugins` (bộ tối thiểu, user chọn) → thỏa điều kiện tiên quyết `flutter-coding`
- [2026-09-14] Xong: OpenSpec change `flutter-chat-mvp` (proposal/spec/design/tasks — valid 4/4) + branch `change/flutter-chat-mvp`
- [2026-09-14] Xong: hoàn thiện Android SDK trên VPS (cmdline-tools + platform/build-tools 36) — chỉ cấu hình, KHÔNG build APK
- [2026-09-14] Xong + commit **0ac8e61**: Phase 2 thật — env-switch mock/real, resolver chống trùng tên, dsh smoke (mock LLM), `result6.txt`
- [2026-09-14] Xong + commit **33f9dc0**: Phase 1 NLP pipeline (root commit 55 files)

## Việc kế tiếp khi user sẵn sàng (thứ tự)

1. Duyệt commit result9 → push → CI APK run 2 → cài máy thật (LAN: service `--host 0.0.0.0`, app `--dart-define=COPILOT_BASE_URL=http://<IP>:8788`)
2. Rotate key ERPNext đúng cách trên server (verify 2026-09-14: key cũ vẫn hợp lệ)
3. Thu 100–200 câu audio thật 3 miền (blocker Phase 4)
4. Phase 5 AI Gateway — nhưng 🛑 Mandatory Sign-off PII (NĐ13) phải xong trước khi code router
