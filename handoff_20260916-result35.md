# Handoff — 2026-09-16 (Phiên: result35 — commit 31d485c + đóng vòng)

> Đọc thêm: `result35.txt` (bằng chứng đầy đủ), `result34.txt`, `result33.txt`,
> `next.md`, `checklist.md`, `handoff_20260916-result34.md` (phiên trước).

## 1. Mốc hiện tại

- **HEAD = `31d485c` ĐÃ PUSH** (`change/flutter-chat-mvp`, 15 files +1006/−22):
  UI STALE banner qua HTTP 409 thật (dio) + F4 params round-trip + test wire +
  falsify + result32/33/34 + 3 handoff + runbook `docs/demo-payment-draft.md`.
  Secret scan CLEAN; không stage .env/store/.plan/.gemini/.opencode/initp.
- **MVP kỹ thuật Phase 7 + 9 an toàn ĐÃ XONG + ĐÃ COMMIT** (bda54cf + 31d485c).
- Suite sau commit: **Python 60/60 · Node 119/119 · Flutter 34/34 · analyze 0**.
- Demo doc đã rà khớp code (TTL 10p · STALE+problems[] · /execute/cancel ·
  replay); sửa doc duy nhất: `uuidgen` → `node -p '…randomUUID()'` (host không
  có uuidgen; shape khớp UUID_RE server).
- KHÔNG đụng ERPNext thật · không saga · không Phase 4/8/11.

## 2. Việc kế tiếp kỹ thuật — CHỈ khi user duyệt

- **Saga plan §7** (phase-09: REVERSING/REVERSED, REVERSAL-<command_id>,
  CRITICAL double-confirm, 5 test mock) — CHỈ code khi user duyệt rõ ràng.
- `E2E_LLM_MODEL=real-gemini` — thought_signature live (thử cơ hội, không probe).

## 3. Việc chỉ user làm được

Duyệt saga §7 · SUBMIT phiếu thu (quyết riêng) · dán 3 giá trị GitHub Settings
(COPILOT_BASE_URL / COPILOT_AUTH_USER / COPILOT_AUTH_PASSWORD) → CI APK · test
APK thiết bị thật · thu audio 150 câu (docs/audio-collection-script.md) ·
rotate key ERPNext · review `.project/ai-rules.md`.

## 4. Nguyên tắc giữ nguyên

Verification-before-completion (lệnh + output thật) · falsify từng fix vùng
tiền · không tự commit/tự ký duyệt vùng tiền · đọc source thật trước khi code ·
không báo "xong" bằng lời · Python test chạy từ repo root (PYTHONPATH=src) ·
KHÔNG đề xuất phase mới khi chưa có lệnh user.
