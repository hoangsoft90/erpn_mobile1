# human.md — Việc CHỈ người thật làm được

> Danh sách này chỉ chứa việc **agent không thể làm thay** (cần tay người, quyết định của chủ dự án,
> hoặc tài khoản/thiết bị thật). Việc đã xong thì **xoá khỏi file** — không giữ lại để tránh bàn lại.
> Trạng thái kỹ thuật của app nằm ở `next.md` / `checklist.md`; bằng chứng ở `result*.txt`.
> Cập nhật lần cuối: **2026-09-18** (sau commit `7cb2798` / `21d77ff` / `d6295ab`).

---

## 1. Quyết định chặn việc kỹ thuật (agent KHÔNG tự quyết)

- [ ] **F7 — chính sách khi lệnh đang xếp hàng mà gặp bảo trì.** Hiện tại: job QUEUED gặp kill switch
      bị đánh `FAILED` ngay sau 1 lần và ngừng thử lại, dù **chưa từng thử ghi**. An toàn tiền không
      bị ảnh hưởng (chưa ghi gì; bấm lại đúng `command_id` sau bảo trì là chạy đúng 1 phiếu), nhưng
      nhãn "thất bại" là **báo sai bản chất**. Chọn 1:
      **(a)** coi bảo trì là "không phải một lần thử" ⇒ job ở lại hàng chờ, không tiêu lượt thử;
      **(b)** giữ fail-fast nhưng đổi trạng thái thành `BLOCKED_MAINTENANCE`.
      → Bằng chứng probe + phân tích: `docs/kill-switch-runbook.md` §4 · `result52.txt` §2.
- [ ] **SUBMIT phiếu thu thật hay không.** Hiện luồng ghi chỉ tạo phiếu **NHÁP** (`docstatus 0`) —
      công nợ **không** giảm cho tới khi người thật submit trên UI ERPNext. Quyết định này thuộc
      chủ dự án, agent không tự bật.

## 2. Việc tay chân (cần người + thiết bị/tài khoản thật)

- [ ] **Thu 150 câu audio 3 miền** — kịch bản đã sẵn: `docs/audio-collection-script.md`
      (có ground truth để đo accuracy sau này). **Đây là thứ đang chặn P6 (voice/STT)** — không có
      audio thì không đo được, không mở phase được.
- [ ] **Test APK tại điểm bán thật** — checklist 1 trang: `docs/device-test-checklist.md`.
      Đã làm: cài APK lên máy + debug qua adb (đã báo vài lỗi thật và đã sửa). Còn lại: chạy tại
      điểm bán, và **xem icon + tên app trên máy có ưng không**.
- [ ] **Bật tunnel khi cần test app trên máy** (vận hành, không phải code):
      `lt -s erpn8788 --port 8788` trên máy Mac + ERPNext (ngrok) đang sống. Tunnel tắt ⇒ app im lặng
      hoặc báo lỗi mạng — **không phải** số liệu ERPNext sai.
- [ ] **Diễn tập kill-switch trên gateway thật** (bật flag → thấy 503 `SYSTEM_MAINTENANCE` → tắt lại),
      theo `docs/kill-switch-runbook.md`. Chưa lần nào chạy trên môi trường thật.
- [ ] **Dán 3 giá trị vào GitHub Settings** (chưa xác nhận đã làm):
      Variables `COPILOT_BASE_URL` + `COPILOT_AUTH_USER`, Secret `COPILOT_AUTH_PASSWORD`.
      *Không bắt buộc nữa*: APK vẫn dùng được bằng cách nhập ngay trong **⚙️ Settings** của app
      (`https://erpn8788.loca.lt` + auth) — không cần build lại APK.
- [ ] **Rotate key ERPNext** — **đã xong trước đó** (ghi trong `working.md`: "Đã xong trước đó:
      sign-off Phase 5 ký 2026-09-15 · rotate key ERPNext"; key cũ đã được redact khỏi `result10.txt`).
      ⇒ **Không còn là việc phải làm.**

## 3. Treo theo QUYẾT ĐỊNH của user — đừng tự làm, đừng tự hỏi lại

- **Endpoint/VPS production**: HOÃN tới sau khi app xong. Cloud Shell hiện tại = workspace dev
  (biết trước là ephemeral); ERPNext + LLM trên Mac qua ngrok/localtunnel chỉ là demo tạm.
  ⇒ Không tự thiết kế kiến trúc production, không tự chọn endpoint lâu dài.
- **Zen (billing-blocked)**: để sau — giữ nguyên config, không bật lại, không xử lý billing.
- **Gemini free tier**: chấp nhận flaky (429/503 là bình thường của free tier); **không** nâng paid.
- **Saga/compensation (phase-09 §7)**: chỉ có plan, **chưa duyệt code**. Không tự triển khai.

---

## Cách cập nhật file này

Thêm việc mới khi phát hiện việc thuộc nhóm "chỉ người làm được"; **xoá ngay** khi việc đó xong
(kèm commit/result làm bằng chứng ở `result*.txt`). Không để việc đã xong nằm lại gây hiểu nhầm
là còn phải làm.
