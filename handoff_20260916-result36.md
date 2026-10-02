# Handoff — 2026-09-16 (Phiên: result36 — bảo trì nhỏ, MVP đóng)

> Đọc thêm: `result36.txt` (bằng chứng), `result35.txt`, `next.md`,
> `checklist.md`, `handoff_20260916-result35.md` (phiên trước).

## 1. Mốc hiện tại

- **HEAD = `31d485c` ĐÃ PUSH** (`change/flutter-chat-mvp`). Working tree: 5 docs
  modified (docs-sync result35 + fix `uuidgen`→`node -p randomUUID` trong demo
  doc) + untracked result35/36 + 2 handoff + rác (.gemini/.opencode/initp —
  không stage). Chưa commit — sẽ đi cùng lần duyệt kế.
- Suite: **Python 60/60 · Node 119/119 · Flutter 34/34 · analyze 0**.
- **MVP kỹ thuật Phase 7 + 9 an toàn ĐÓNG** — không còn việc kỹ thuật trong
  scope; mọi nhánh đọc/ghi/banner/restore đã có code + test + runbook.
- **2 runbook người thật**: `docs/demo-payment-draft.md` (demo ghi phiếu nháp,
  TTL/STALE/EXPIRED/replay/cancel) · `docs/device-test-checklist.md` (mới —
  cài APK → đọc → ghi nháp → restart → STALE/EXPIRED, 1 trang).
- KHÔNG đụng ERPNext thật · không saga · không Phase 4/8/10/11/15.

## 2. Chờ user (không phải việc agent)

Duyệt saga §7 (mới code REVERSING/REVERSED) · SUBMIT phiếu thu · dán 3 giá trị
GitHub Settings (COPILOT_BASE_URL / COPILOT_AUTH_USER / COPILOT_AUTH_PASSWORD)
→ CI APK · test APK thiết bị thật (device-test-checklist.md) · demo ghi phiếu
nháp (demo-payment-draft.md) · thu audio 150 câu · rotate key ERPNext ·
review `.project/ai-rules.md`.

## 3. Việc kế tiếp kỹ thuật — CHỈ khi user ra lệnh

Saga code §7 · thought_signature live (`E2E_LLM_MODEL=real-gemini`, thử cơ hội,
không probe) · bất kỳ phase mới nào — ĐỀ XUẤT khi user yêu cầu rõ ràng.

## 4. Nguyên tắc giữ nguyên

Verification-before-completion (lệnh + output thật) · không tự commit/tự ký
duyệt vùng tiền · falsify khi sửa vùng tiền · đọc source thật trước khi code ·
Python test từ repo root (PYTHONPATH=src) · không báo "xong" bằng lời ·
KHÔNG đề xuất sprint phase mới khi chưa có lệnh user.
