# working.md — Nhật ký đang làm

> Việc cụ thể gần đây, format ngày `YYYY-MM-DD`. Dọn mục đã xong quá 1–2 tuần
> (nội dung cũ nằm trong `result*.txt` + `.project/openspec.md` là pointer).

## Đang mở (chờ người thật / việc nhỏ tiếp theo)

- [ ] **Chờ user dán 3 giá trị GitHub Settings** (token chỉ-đọc, PUT 404 — result11 §6): Variables `COPILOT_BASE_URL=http://35.194.130.120:8788` + `COPILOT_AUTH_USER` (=`ASK_USER` trong `.env`) + Secret `COPILOT_AUTH_PASSWORD` (=`ASK_PASSWORD` trong `.env`) → CI build APK cài được luôn
- [ ] **Chờ user chọn + xử lý đường endpoint** (result11 §5): Tailscale login trên VPS (link trong `tailscale status`, khuyến nghị) / hosting mở port 8788 / ngrok từ VPS. Hiện port 8788 bị cloud firewall hosting chặn từ internet; service nội bộ đã verify 401→200→269.000đ
- [ ] **Chờ user ký `SIGNOFF-phase5-pii.md`** — gate pháp lý Phase 5 ĐÓNG; KHÔNG code LLM Router/PII scrubbing cho tới khi có chữ ký
- [ ] **Chờ user rotate key ERPNext** (Hoàng làm trực tiếp trên server; key cũ vẫn hợp lệ — result9 §1)
- [ ] **Chờ người thật thu audio 150 câu** — kịch bản sẵn: `docs/audio-collection-script.md` (blocker Phase 4)
- [ ] Sau khi APK chạy thật OK: sync + archive OpenSpec change `flutter-chat-mvp` (task 4.3), merge branch về master
- [ ] Khi AgentMemory sống lại: `/remember` pointer tới 2 skill `erpnext-mcp-connect` + `erpn-verify-first`

## Đã xong gần đây

- [2026-09-14] Xong + commit **c9bc64d**: `result11.txt` + checklist — endpoint security verified (401→200→269.000đ thật), firewall finding, kịch bản thu âm
- [2026-09-14] Xong + commit **c3d74c3**: endpoint security (bind policy + basic auth, 8 test mới → Node 48/48) + Flutter client auth qua dart-define (Flutter 13/13, analyze 0) + CI APK từ repo Variables/Secret + `docs/audio-collection-script.md` (150 câu 3 miền có GT) — CI run #3 SUCCESS
- [2026-09-14] Xong: **APK nối được VPS** — bind policy tự từ chối unsafe config; verify thật trên 10.88.0.4; phát hiện firewall hosting chặn port từ ngoài + token GH chỉ-đọc (2 finding môi trường, không phải lỗi code)
- [2026-09-14] Xong: tạo `.project/ai-rules.md` (file KHÔNG tồn tại trước đó — verify-first bắt được; tổng hợp từ AGENTS.md + operating_rules + thực tế duyệt qua result1→11; CHỜ USER REVIEW) + cập nhật skill `erpn-verify-first` với 7 bài học result11
- [2026-09-14] Xong + commit **2946206**: `result10.txt` (CI run #2 SUCCESS + APK artifact về VPS) + `SIGNOFF-phase5-pii.md` (draft, gate ĐÓNG)
- [2026-09-14] Xong + commit **4c5bd26**: viết lại checklist/next 1 lần cho nhất quán + `.project/` + memory files
- [2026-09-14] Xong + commit **119edd4**: fix result9 — accuracy thật 27.8%→100% (5 nhóm lỗi) + CI codegen step; redact secret khỏi result9.txt trước commit
- [2026-09-14] Xong + commit **590b1b2**: Phase 3 Flutter chat MVP (64 files) — UI-checkpoint user duyệt; Node 36/36, Flutter 13/13; 4 bug thật (quan trọng nhất: ChatBubble không render answer)
- [2026-09-14] Xong + commit **0ac8e61**: Phase 2 thật — env-switch mock/real, resolver chống trùng tên, dsh smoke (mock LLM), `result6.txt`
- [2026-09-14] Xong + commit **33f9dc0**: Phase 1 NLP pipeline (root commit 55 files)

## Việc kế tiếp khi user sẵn sàng (thứ tự)

1. User: dán 3 giá trị GitHub Settings + chọn đường endpoint (Tailscale/mở port/ngrok) → re-run CI → tải APK cài thiết bị thật
2. User: ký `SIGNOFF-phase5-pii.md` → mở gate Phase 5 (AI Gateway: PII scrub + LLM Router + audit)
3. Người thật: thu audio 150 câu theo `docs/audio-collection-script.md` → mở khóa Phase 4 (STT)
4. Rotate key ERPNext (Hoàng, trên server) → verify key cũ bị vô hiệu
