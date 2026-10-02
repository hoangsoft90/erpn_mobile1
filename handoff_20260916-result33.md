# Handoff — 2026-09-16 (Phiên: result33 — UI STALE review + fix wire 409)

> Đọc thêm: `result33.txt` (bằng chứng đầy đủ), `result32.txt`, `result31.txt`
> (§11 review vòng 2), `next.md`, `checklist.md`, `handoff_20260916-1105.md`
> (phiên trước).

## 1. Mốc hiện tại

- **HEAD = `bda54cf`** (đã push). Diff chưa commit = đợt UI STALE (result32)
  + fix mới của phiên này (result33): **10 file chờ duyệt commit** —
  4 Dart (chat_models / chat_controller / proposal_card / proposal_card_test)
  + 4 docs root + result32.txt + handoff_20260916-1105.md. Secret scan CLEAN.
- **UI STALE (Phase 9) XONG kỹ thuật, ⏳ CHỜ DUYỆT COMMIT**: banner ⏰ EXPIRED /
  🔄 STALE + problems[] thay thế nút [Xác nhận] (fail-closed); rejection ghim
  vào toJson ⇒ sống qua khôi phục history.
- **🔴 BUG THẬT TÌM THẤY + ĐÃ VÁ (result33 §4)**: dio mặc định THROW
  DioException với non-2xx ⇒ 409 PROPOSAL_STALE/EXPIRED không bao giờ tới
  `res.data` ⇒ banner VÔ HÌNH trong production. 3 test cũ bơm rejection thẳng
  vào model (không qua wire) nên suite xanh ảo. Fix: `_handleRefusal()`
  (stamp cục bộ + persist qua attachRejection) + nhánh `on DioException` đọc
  `err.response?.data` (connection drop giữ thông báo mạng — retry vẫn an toàn
  cùng command_id) + `didUpdateWidget` xoá stamp khi proposal instance swap.
  **Test wire mới**: mock adapter trả 409 THẬT → banner + nút biến mất.
  **Falsify**: gỡ nhánh → FAIL đúng assertion; khôi phục → grep 0 marker.
- Suite: **Python 60/60 · Node 119/119 · Flutter 34/34 · analyze 0**
  (Flutter 32 → 34: +1 test wire 409 + +1 test F4 body gửi đi).
- **F4 (review vòng 2, vùng tiền)**: Dart `ActionProposal` THIẾU field
  `params` ⇒ `toJson()` không gửi ⇒ bấm [Xác nhận] từ app thật luôn bị
  400 tại money-shape gate (`proposal.params.amount_vnd`, http-ask.mjs:309;
  drift check cũng đọc params). Node test không bắt được (tự dựng JSON có
  sẵn params), Dart test chỉ assert response. Fix: model thêm `params`
  (unmodifiable) + toJson gửi ngược + attachRejection rebuild mang theo +
  test assert BODY GỬI ĐI qua mock adapter; falsify: gỡ khỏi toJson →
  FAIL `Expected: <500000> Actual: <null>`, khôi phục grep 0 marker.
- Bài học mới vào `.agents/skills/erpn-verify-first` (77 hàng): ① mỗi nhánh
  xử lý lỗi HTTP client cần ≥1 test QUA wire (status thật qua adapter);
  ② model echo-back phải round-trip ĐỦ field server gate đọc + cần test
  assert body GỬI ĐI; model-level test chỉ dùng cho render.
- KHÔNG đụng ERPNext thật (0 write call) · KHÔNG code saga (plan §7 chờ duyệt).

## 2. CHỜ USER DUYỆT COMMIT (không tự commit — vùng tiền)

10 file như trên. Message đề xuất:
```
feat: phase 9 UI — stale/expired cards show the refusal banner (code +
problems[] persist through history restore); saga plan §7
```
Cần user duyệt thêm: **saga plan §7** (`.plan/phases/phase-09-proposal-state-machine.md`
— REVERSAL-<command_id>, CRITICAL double-confirm, 5 test mock) thì mới code
REVERSING/REVERSED.

## 3. Việc kế tiếp kỹ thuật (sau khi commit được duyệt)

- Saga code thật (REVERSING/REVERSED + reverse skill) — CHỈ khi duyệt §7.
- Rà banner trên màn hình thật khi có APK (widget test đã che logic + wire).
- `E2E_LLM_MODEL=real-gemini` — thought_signature live (thử cơ hội, không probe).

## 4. Vẫn treo — KHÔNG phải việc agent

SUBMIT phiếu thu (quyết riêng) · dán 3 giá trị GitHub Settings (COPILOT_BASE_URL /
COPILOT_AUTH_USER / COPILOT_AUTH_PASSWORD) · test APK thiết bị thật · thu audio
150 câu · rotate key ERPNext · review `.project/ai-rules.md`.

## 5. Nguyên tắc giữ nguyên

Verification-before-completion (lệnh + output thật) · falsify từng fix (assert
đổi-thật trước, khôi phục grep sau — marker tạm phải verify 0 hit) · vùng tiền
không tự commit/tự ký duyệt · đọc source/model thật trước khi code · không báo
"xong" bằng lời.
