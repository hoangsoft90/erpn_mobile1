# human.md — Việc CHỈ người thật làm được

> Danh sách này chỉ chứa việc **agent không thể làm thay** (cần tay người, quyết định của chủ dự án,
> hoặc tài khoản/thiết bị thật). Việc đã xong thì **xoá khỏi file** — không giữ lại để tránh bàn lại.
> Trạng thái kỹ thuật của app nằm ở `next.md` / `checklist.md`; bằng chứng ở `result*.txt`.
> Cập nhật lần cuối: **2026-09-19** (sau phiên DSH final mini-sprint — `result58.txt`).
>
> Đã xoá các mục XONG ở những lần trước: test APK tại điểm bán · diễn tập kill-switch ·
> rotate key ERPNext · **thu 150 câu audio** (gate đã bỏ — P6 dùng STT của OS, không cần corpus) ·
> **verify `thought_signature` với Gemini thật** (agent đã chạy 1 session live 2026-09-19: 3 lượt
> LLM, `messages:7`, trả đúng 171.800đ/4 chứng từ — `result58.txt` §4).

---

## 1. Quyết định chặn việc kỹ thuật (agent KHÔNG tự quyết)

- [ ] **Duyệt commit đợt DSH** (đụng gateway + vùng chặn ghi → agent không tự commit). Hai đợt
      đang treo, chưa stage gì:
      **(a)** `result57` — AI mode phía Flutter + gateway DSH (`dsh-gateway.mjs`, route `/dsh/ask`)
      **(b)** `result58` — pin runtime `@deepseek-ai/dsh@0.1.5-rc.1`, topology remote
      (`DSH_MODE` + `scripts/dsh-remote-runner.mjs`), 6 script E2E, 7 defect review đã sửa.
      Message đề xuất (tách 3 cụm) ở `result58.txt` §15 + phần cuối báo cáo phiên.

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

- [ ] **Bật lại tunnel trên máy Mac** — việc này đang **chặn** phần "DSH chạy trên Mac" (topology
      remote, `.plan/dsh_prompt_check.md` §2). Bằng chứng hiện tại (agent đo, không đoán):
      `curl https://llm9000.loca.lt/v1/models` → **`503 Tunnel Unavailable`**; khi đó router báo
      `all upstreams failed (tried: mac-custom)` ⇒ mọi phiên dùng `mac-custom` đều 502.
      Cần người làm: chạy lại `lt -s llm9000 --port <cổng LLM trên Mac>` (URL phải khớp
      `DSH_REMOTE_URL`/`mac-custom.baseUrl` — nếu localtunnel trả URL khác thì gửi lại URL mới
      để agent cập nhật config), và tuỳ chọn chạy runner của gateway trên Mac:
      `DSH_REMOTE_TOKEN=<random ≥16 ký tự> node scripts/dsh-remote-runner.mjs --port 8799`.
      Sau đó agent chạy lại `bash scripts/check-dsh-topology.sh` để đóng mục BLOCKED này.
      ⚠️ Đừng để phiên chạy ở máy khác bị hiểu là "đã verify trên Mac" — mọi response đều mang
      `runtime: local|remote` từ giờ.

- [ ] **Cài APK mới nhất lên máy thật và smoke mic + TTS (P6 + TTS).** APK hiện có = run #20
      [`35414524990`](https://github.com/hoangsoft90/erpn_mobile1/actions/runs/35414524990)
      (`8d2055c`, success, artifact `erpn-chat-debug-apk` **84.213.013 bytes**, hết hạn 2026-12-17) —
      đã chứa nhóm P6 UX (`f55d557`) + TTS (`1401f16`).
      Cần người làm:
      (a) **mic**: bấm 🎙 trên máy có Gboard tiếng Việt ⇒ đọc ra đúng chữ trong ô nhập, **KHÔNG**
      hiện dòng nào về "tiếng Việt", thu hồi quyền micro thì vẫn phải hiện "Chưa được cấp quyền micro…";
      (b) **switch "Tự gửi sau khi nói xong"**: để TẮT ⇒ đọc xong **không** tự gửi; bật ON ⇒ câu hỏi
      **tự được gửi**, nhưng câu "thu tiền cho…" **vẫn phải bấm Xác nhận** (auto-send không bao giờ
      tự xác nhận);
      (c) **TTS "Đọc câu trả lời"**: ⚙️ bật ⇒ nghe được câu trả lời bằng giọng máy;
      tắt ⇒ im. Cần xác nhận thêm: máy **không có gói tiếng Việt** ⇒ app **im lặng** (không lỗi);
      đọc đề xuất thu tiền **không** tự bấm Xác nhận; 2 câu liên tiếp ⇒ giọng sau **ngắt** giọng
      trước; cuộn/tắt app giữa lúc đọc ⇒ không kẹt UI.
      Checklist 7 bước: `.plan/phases2/p6-result.md` mục "Human smoke".
      ⚠️ Bằng chứng APK là **gián tiếp** (shell agent không có token để tải artifact ra grep binary).

- [ ] **Smoke chế độ "Phân tích bằng AI" (DSH) trên máy thật** — *chỉ làm được SAU KHI commit +
      push đợt DSH và có APK mới*: chọn "Phân tích bằng AI" trong app → hỏi một câu đọc (vd "khách
      … còn nợ bao nhiêu") ⇒ phải trả lời được; hỏi câu ghi ("thu tiền cho …") ⇒ phải hiện câu
      **từ chối của gateway** (chỉ ĐỌC) và **không** có nút Xác nhận nào.
      Agent đã verify đường HTTP thật (`result58.txt` §4/§7) nhưng **chưa** verify UI trên thiết bị.

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
  *(Lưu ý: **địa chỉ `erpn8788.loca.lt` cũng do localtunnel cấp** — nếu tunnel của gateway bị tắt/đổi
  URL thì phải nhập lại URL mới trong Settings; đừng coi là việc agent tự sửa được.)*
- **Zen (billing-blocked)**: để sau — giữ nguyên config, không bật lại, không xử lý billing.
- **Gemini free tier**: chấp nhận flaky (429/503 là bình thường của free tier); **không** nâng paid.
- **Saga/compensation (phase-09 §7)**: chỉ có plan, **chưa duyệt code**. Không tự triển khai.
- **P9 (skill WRITE mới hàng loạt)**: gate kỹ thuật đã mở (Golden 0 miss) nhưng **chờ lệnh user**.
- **`review .project/ai-rules.md`** + **duyệt app icon** (`result43` addendum): chờ user xem.

---

## Cách cập nhật file này

Thêm việc mới khi phát hiện việc thuộc nhóm "chỉ người làm được"; **xoá ngay** khi việc đó xong
(kèm commit/result làm bằng chứng ở `result*.txt`). Không để việc đã xong nằm lại gây hiểu nhầm
là còn phải làm.
