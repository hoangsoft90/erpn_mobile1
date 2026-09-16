# Handoff — 2026-09-16 (Phiên: result38 — review 2f7ec1f + fix F6, CHỜ DUYỆT)

> Đọc thêm: `result38.txt` (bằng chứng đầy đủ), `result37.txt`, `next.md`, `checklist.md`,
> `working.md`, `handoff_20260916-result37.md` (phiên trước).

## 1. Mốc hiện tại

- **HEAD = `2f7ec1f`** (`change/flutter-chat-mvp`, đã push) — commit docs đóng MVP:
  result35/36 + `docs/device-test-checklist.md` + demo runbook sync.
- **Review `2f7ec1f`**: scope docs-only đúng (grep `^(apps/|mcp-erpnext/src/|...)` → NONE);
  docs khớp code bằng grep thật (TTL 10' · STALE/EXPIRED · `/execute/cancel`).
- **F6 (VÙNG TIỀN) đã fix — CHỜ USER DUYỆT COMMIT (không tự commit)**:
  `answerQuestion()` gọi `resolveCustomer()` 2 lần cho cùng câu `thu tiền cho <khách> <số>`
  (guard ngoài dòng 291 + nhánh `payment_write`). Nhánh write nay REUSE binding từ guard.
  Diff: `mcp-erpnext/src/copilot-server.mjs` −1/+5 (chỉ comment + bỏ call trùng).
  File mới: `mcp-erpnext/test/copilot-dup-resolve.test.mjs`.
- **Hành vi KHÔNG đổi**: test E2E thật `copilot.test.mjs:251` vẫn xanh
  (`entity.name="Nguyễn Thị Lan"`, `params.amount_vnd=500_000`, `invoice="SINV-0001"`).
- **Falsify**: chèn lại `await resolveCustomer(skills, nlp.text)` → test FAIL `found 2`;
  gỡ marker → grep marker = 0, call site = 1.
- **Lỗi của chính agent trong phiên** (đã ghi vào skill `erpn-verify-first`): test hồi quy
  đầu tiên ĐỎ trên code ĐÚNG vì regex `/resolveCustomer\(skills/` khớp cả dòng ĐỊNH NGHĨA hàm
  ⇒ đếm 2; sửa thành `/await resolveCustomer\(skills/g`.

## 2. Bằng chứng suite (lệnh + output thật, sau fix)

```
PYTHON   PYTHONPATH=src python3 -m unittest discover -s tests → Ran 60 tests — OK
NODE     cd mcp-erpnext && node --test → ℹ tests 120 · pass 120 · fail 0   (119 → 120)
FLUTTER  cd apps/mobile && flutter test → 00:04 +34: All tests passed!
         flutter analyze → No issues found! (ran in 6.4s)
```

## 3. Đang chờ user (không phải việc agent)

1. **Duyệt commit F6** (vùng tiền) — message đề xuất:
   `fix: payment_write reuses the outer customer resolve (one round-trip per question, no second resolveCustomer call)`
2. Duyệt saga plan §7 (phase-09) — duyệt mới code REVERSING/REVERSED.
3. SUBMIT phiếu thu (quyết riêng) · dán 3 giá trị GitHub Settings
   (`COPILOT_BASE_URL`/`COPILOT_AUTH_USER`/`COPILOT_AUTH_PASSWORD`) · test APK thiết bị thật
   (`docs/device-test-checklist.md`) · thu audio 150 câu (`docs/audio-collection-script.md`) ·
   rotate key ERPNext · review `.project/ai-rules.md`.

## 4. Rác / không commit

`.gemini/` · `.opencode/` · `initp` — rác local, không stage.
Không stage `.env` / `idempotency-store` / `.plan`.

## 5. Việc kỹ thuật còn lại trong scope

- Không còn khoảng trống trong scope MVP (Phase 7 + 9 an toàn đã đóng).
- Phase 4 chặn audio · Phase 8/10–15 chưa mở (không tự mở).
