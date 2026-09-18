# human.md — Việc CHỈ người thật làm được

> Danh sách này chỉ chứa việc **agent không thể làm thay** (cần tay người, quyết định của chủ dự án,
> hoặc tài khoản/thiết bị thật). Việc đã xong thì **xoá khỏi file** — không giữ lại để tránh bàn lại.
> Trạng thái kỹ thuật của app nằm ở `next.md` / `checklist.md`; bằng chứng ở `result*.txt`.
> Cập nhật lần cuối: **2026-09-18** (phiên F7-2 submit switch). Đã xoá các mục xong: test APK tại
> điểm bán · bật tunnel · diễn tập kill-switch · rotate key ERPNext.

---

## 1. Quyết định chặn việc kỹ thuật (agent KHÔNG tự quyết)

- [ ] **Bật cài đặt "Cho phép nộp phiếu thu thật" hay không (F7-2).** Cơ chế đã có trong app:
      ⚙️ Settings → checkbox **mặc định TẮT**; bật ON phải qua dialog xác nhận riêng. Khi TẮT,
      xác nhận trên đề xuất chỉ tạo phiếu **NHÁP** (`docstatus 0`) — công nợ **không** giảm.
      Khi BẬT, xác nhận sẽ tạo **và NỘP** phiếu — công nợ giảm ngay; submit lỗi giữa chừng được
      báo rõ "đã tạo nháp, submit lỗi" (không mất dấu giao dịch). Quyết định bật/để tắt thuộc
      chủ dự án, agent không tự bật.

## 2. Việc tay chân (cần người + thiết bị/tài khoản thật)

- [ ] **Thu 150 câu audio 3 miền** — kịch bản đã sẵn: `docs/audio-collection-script.md`
      (có ground truth để đo accuracy sau này). **Đây là thứ đang chặn P6 (voice/STT)** — không có
      audio thì không đo được, không mở phase được.

## 3. Treo theo QUYẾT ĐỊNH của user — đừng tự làm, đừng tự hỏi lại

- **Endpoint/VPS production**: HOÃN tới sau khi app xong. Cloud Shell hiện tại = workspace dev
  (biết trước là ephemeral); ERPNext + LLM trên Mac qua ngrok/localtunnel chỉ là demo tạm.
  ⇒ Không tự thiết kế kiến trúc production, không tự chọn endpoint lâu dài.
- **Dán 3 giá trị vào GitHub Settings** (COPILOT_BASE_URL / COPILOT_AUTH_USER / COPILOT_AUTH_PASSWORD):
  HOÃN theo quyết định user — không còn là việc treo. APK vẫn dùng được bằng cách nhập ngay trong
  **⚙️ Settings** của app (`https://erpn8788.loca.lt` + auth), không cần build lại.
- **Zen (billing-blocked)**: để sau — giữ nguyên config, không bật lại, không xử lý billing.
- **Gemini free tier**: chấp nhận flaky (429/503 là bình thường của free tier); **không** nâng paid.
- **Saga/compensation (phase-09 §7)**: chỉ có plan, **chưa duyệt code**. Không tự triển khai.

---

## Cách cập nhật file này

Thêm việc mới khi phát hiện việc thuộc nhóm "chỉ người làm được"; **xoá ngay** khi việc đó xong
(kèm commit/result làm bằng chứng ở `result*.txt`). Không để việc đã xong nằm lại gây hiểu nhầm
là còn phải làm.
