# human.md — Việc CHỈ người thật làm được

> Danh sách này chỉ chứa việc **agent không thể làm thay** (cần tay người, quyết định của chủ dự án,
> hoặc tài khoản/thiết bị thật). Việc đã xong thì **xoá khỏi file** — không giữ lại để tránh bàn lại.
> Trạng thái kỹ thuật của app nằm ở `next.md` / `checklist.md`; bằng chứng ở `result*.txt`.
> Cập nhật lần cuối: **2026-09-19** (sau khi commit nhóm P6 UX `f55d557` + TTS "Đọc câu trả lời"
> `1401f16` — xem `result55.txt` §9–§11 và `result56.txt`).
>
> Đã xoá các mục XONG ở những lần trước: test APK tại điểm bán · bật tunnel · diễn tập kill-switch ·
> rotate key ERPNext · **thu 150 câu audio** (gate đã bỏ — P6 dùng STT của OS, không cần corpus).

---

## 1. Quyết định chặn việc kỹ thuật (agent KHÔNG tự quyết)

- [ ] **Bật cài đặt "Cho phép nộp phiếu thu thật" hay không (F7-2).** Cơ chế đã có trong app:
      ⚙️ Settings → checkbox **mặc định TẮT**; bật ON phải qua dialog xác nhận riêng. Khi TẮT,
      xác nhận trên đề xuất chỉ tạo phiếu **NHÁP** (`docstatus 0`) — công nợ **không** giảm.
      Khi BẬT, xác nhận sẽ tạo **và NỘP** phiếu — công nợ giảm ngay; submit lỗi giữa chừng được
      báo rõ "đã tạo nháp, submit lỗi" (không mất dấu giao dịch). Quyết định bật/để tắt thuộc
      chủ dự án, agent không tự bật.

- [ ] **Switch "Tự gửi sau khi nói xong" + cửa sổ ngập ngừng 3 giây (P6 UX — phát hiện khi
      review 2026-09-18).** Khi switch BẬT, `pauseFor: 3s` quyết định "đọc xong": doc của plugin
      ghi rõ *"after that it automatically stops the listen for you"*, và **Android có thể ép
      ngắn hơn (1–3 giây) không override được**. Hệ quả: người dùng **ngập ngừng giữa câu** ⇒ câu
      **nửa vời** bị gửi ngay và phiên nghe kết thúc (muốn nói tiếp phải bấm 🎙 lại). Hành vi này
      **đúng** đặc tả bạn đưa ("final ⇒ gửi") nhưng có thể không phải ý bạn. Ba lựa chọn:
      (a) giữ nguyên và ghi rõ cửa sổ 3 giây trong copy Settings;
      (b) tăng `pauseFor` khi switch đang BẬT (chờ lâu hơn trước khi chốt câu);
      (c) chỉ auto-send khi người dùng **bấm dừng mic**, không auto-send khi recognizer tự chốt.
      Agent **chưa tự đổi** hành vi — cần bạn chọn.

## 2. Việc tay chân (cần người + thiết bị/tài khoản thật)

- [ ] **Cài APK mới nhất lên máy thật và smoke phần mic (P6).** APK đã build + đã xác minh
      chứa bản fix locale (xem `result55.txt` §8):
      run [`35367603981`](https://github.com/hoangsoft90/erpn_mobile1/actions/runs/35367603981)
      · artifact `erpn-chat-debug-apk` (84.169.705 bytes, hết hạn 2026-12-17)
      · commit `77e2b57` + `bbca7ca`.
      Cần người làm: **bấm 🎙 trên máy có Gboard tiếng Việt** và xác nhận
      (a) đọc tiếng Việt ra đúng chữ trong ô nhập, (b) **KHÔNG hiện dòng nào về "tiếng Việt"**
      nữa (cả câu "không có bộ nhận dạng tiếng Việt" lẫn gợi ý "Máy không liệt kê…" đều đã bỏ),
      nhưng khi **thu hồi quyền micro** thì vẫn phải hiện "Chưa được cấp quyền micro…",
      (c) không có gì tự gửi / tự nộp phiếu. Checklist 7 bước: `.plan/phases2/p6-result.md`
      mục "Human smoke" (mục 7 đã sửa theo bugfix + UX follow-up).
      ✅ **CÓ APK MỚI HƠN — dùng bản này** thay cho run cũ ở trên: run #20
      [`35414524990`](https://github.com/hoangsoft90/erpn_mobile1/actions/runs/35414524990)
      (`8d2055c`, success, artifact `erpn-chat-debug-apk` **84.213.013 bytes**, hết hạn 2026-12-17) —
      bản này **đã chứa** cả nhóm P6 UX (`f55d557`: bỏ gợi ý locale + switch "Tự gửi sau khi nói xong")
      **lẫn TTS** (`1401f16`). ⇒ Test theo APK này, không cần build lại.
      ⚠️ Lưu ý về bằng chứng: APK mới **chưa được mở ra grep binary** (tải artifact cần token, shell
      agent không có) — mới chỉ xác minh gián tiếp (commit TTS nằm trong cây đã build + APK tăng
      43.308 bytes). Nếu muốn chắc ở mức binary, user tự mở APK sau khi tải.
      Thêm 2 điểm cần thử khi có switch mới: (d) để **TẮT** (mặc định) ⇒ đọc xong **không** tự gửi;
      (e) bật **ON** trong ⚙️ Settings → đọc một câu hỏi ⇒ câu hỏi **tự được gửi** ngay, và với câu
      "thu tiền cho…" thì **vẫn phải bấm Xác nhận** trên card (auto-send không bao giờ tự xác nhận).
      *Đây là exit criteria còn lại của P6 — agent không có mic/thiết bị.*

- [ ] **Nghe thử TTS "Đọc câu trả lời" trên máy thật** (exit criteria của `.plan/next2/tts-implementation-plan.md`,
      đã code + test xong ở commit `1401f16`). Cần **APK mới** (build từ `1401f16` trở đi — APK cũ chưa có TTS).
      Cách thử: ⚙️ Settings → bật **"Đọc câu trả lời"** → hỏi một câu thật qua `/ask` ⇒ phải **nghe được**
      câu trả lời bằng giọng máy (Google Text-to-Speech `vi-VN`). Tắt switch ⇒ hết giọng đọc, mọi thứ khác
      không đổi. Cần xác nhận thêm: (a) máy **không có gói tiếng Việt** ⇒ app **im lặng**, câu trả lời vẫn
      hiển thị bình thường và **không** hiện lỗi nào; (b) đọc đề xuất thu tiền **không** tự bấm Xác nhận —
      nút "Xác nhận thu tiền" vẫn nằm đó chờ bấm tay; (c) hỏi 2 câu liên tiếp ⇒ giọng sau **ngắt** giọng
      trước, không chồng tiếng; (d) cuộn/tắt app giữa lúc đang đọc ⇒ không kẹt UI. *Agent không có loa/thiết bị.*

> Ghi chú: **user ERPNext thứ 2** cho P8 (multi-user thật) vẫn chưa có — P8 đã đóng kỹ thuật
> bằng **fake principal**; chỉ cần tài khoản thật khi nào có ý định chạy nhiều người thật
> (lúc đó mở lại, không chặn gì hiện tại).

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
- **`thought_signature` với Gemini thật**: chưa verify live (free-tier quota) — thử cơ hội khi
  thuận tiện, **không** probe trước (bài học result19), chỉ báo khi có kết quả khác 429/503.

---

## Cách cập nhật file này

Thêm việc mới khi phát hiện việc thuộc nhóm "chỉ người làm được"; **xoá ngay** khi việc đó xong
(kèm commit/result làm bằng chứng ở `result*.txt`). Không để việc đã xong nằm lại gây hiểu nhầm
là còn phải làm.
