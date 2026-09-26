# how-to-test.md — Test tay Drawer READ (next5) trên app + ERPNext thật

Checklist test tay cho **Drawer READ** sau next5 (D0→D5). Bổ sung cho `device-test-checklist.md` (chat/voice/ghi).
Điều kiện: APK cài trên máy thật (hoặc `flutter run`), gateway chạy code mới với env từ `.env`
(`set -a; . ./.env; set +a; node mcp-erpnext/src/http-ask.mjs --port 8788 --host <IP>`), ERPNext site thật qua ngrok.

**Luật nền cần nhớ khi test** (vi phạm bất kỳ ⇒ bug):
- Drawer **chỉ đọc** — không nút ghi/submit/xác nhận nào; không ô nhập tự do.
- Số tiền **COPY từ ERPNext**; footer/giờ đọc hiển thị; `REAL \| MOCK` theo nguồn thật.
- ERP lỗi ⇒ màn hình lỗi + [Thử lại] — **không bao giờ** danh sách rỗng im lặng hay số 0 giả.

## 1. Mở drawer — cấu trúc

- [ ] Từ màn chat, mở drawer: đủ nhóm **THEO DÙI** (Tóm tắt ngày · Nháp hôm nay · Công nợ · Nợ quá hạn / Nợ lâu · HĐ chưa trả · Tồn kho nóng) + **CÀI ĐẶT** (Server/đăng nhập).
- [ ] Không còn mục nào chữ "Sắp có" / `soon`.
- [ ] Mở drawer **không sinh request nào** (badge nháp lấy từ dữ liệu đã đọc — nếu chưa đọc summary thì không có badge, không treo).

## 2. Từng mục — mở + số khớp ERPNext

Mở Desk/REST độc lập (cùng company pin) để đối chiếu số; app phải khớp **từng dòng**, không "tổng ước lượng".

- [ ] **Tóm tắt ngày** — số hôm nay khớp sổ (SO submitted | draft tách bạch, HĐ sau VAT, thu/chi tách, footer REAL + giờ đọc); kéo xuống làm mới được.
- [ ] **Công nợ (lối tắt)** — danh sách khách còn nợ; dòng phụ "Có N phiếu nháp chưa nộp (…đ)" chỉ khi server gửi; **footnote** hiện đúng chữ: *"Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp)."*; tổng = GL raw (không trừ nháp — so với REST SI outstanding).
- [ ] **Nợ quá hạn / Nợ lâu** — khách nợ lâu nhất đứng **trước**; mỗi dòng nêu "Nợ lâu nhất N ngày".
- [ ] **HĐ chưa trả** — mỗi dòng = 1 mã HĐ (SINV-…), tên khách, còn nợ, hạn; tiền lớn trước, hạn gần trước khi cùng tiền.
- [ ] **Tồn kho nóng** — header "Tồn thấp — Kho: {tên kho pin}"; mỗi dòng ghi đúng kho; **số lượng không có chữ "đ"**; qty tăng dần.
- [ ] **Nháp hôm nay** — chỉ chứng từ do app tạo (nháp Desk không hiện); cùng lúc chỉ 1 dòng cho 1 lệnh app (dedupe server).

## 3. Deep-link ngày + tiêu đề (D4)

- [ ] Tóm tắt ngày → chuyển **Hôm qua** → bấm thẻ Hóa đơn/Đơn hàng/Phiếu thu: drill mở đúng **ngày hôm qua** và **tiêu đề nêu đúng "hôm qua"** (không bao giờ viết "hôm nay" khi đang đọc hôm qua).
- [ ] Xem ngày cũ hơn (vd. 3 ngày trước): tiêu đề dạng "ngày YYYY-MM-DD" — không bịa "hôm nay/hôm qua".
- [ ] Drill toàn công ty (HĐ chưa trả, Nợ quá hạn, Tồn kho nóng, Công nợ): tiêu đề **giữ nguyên** dù request có mang ngày.

## 4. Refresh + fresh read

- [ ] List **NGẮN** (1–2 dòng hoặc rỗng): kéo xuống vẫn **kích hoạt làm mới** (đây là bug thật đã sửa — RefreshIndicator im lặng trên list vừa khung).
- [ ] List dài: kéo xuống → request mới → giờ đọc/footer cập nhật.
- [ ] Vào lại cùng mục lần 2: dữ liệu đọc lại (fresh GET), không dùng cache cũ.

## 5. Lỗi / rỗng / phân quyền (error ≠ empty)

- [ ] **Tắt gateway** (hoặc bật máy bay) → mở 1 mục drawer: màn lỗi + [Thử lại]; không có số 0, không list rỗng giả. Bật lại → [Thử lại] → sống lại.
- [ ] **Gateway chậm** (>7s, vd. tunnel nghẽn): app hiện trạng thái timeout của riêng mình ([Thử lại]) sau ~7s — không spin vô hạn.
- [ ] **Xóa `COPILOT_DEFAULT_WAREHOUSE` khỏi `.env` + restart gateway** → mở "Tồn kho nóng": thông báo cấu hình + hướng dẫn (nói rõ chưa pin kho, không tự đoán) — **không** hiện kho bừa.
- [ ] **List rỗng có thật** (vd. ngày không có nháp app): câu rỗng **có hành động** ("Nói trong chat…") — khác với màn lỗi.
- [ ] **Section hỏng một phần** (kho mô phỏng: chặn 1 doctype): banner "Chưa đọc được: …" nêu **tên section**, phần còn lại vẫn hiện. (Ca này khó tạo trên site thật — có thể bỏ, đã cover bằng test tự động.)
- [ ] Sai tài khoản/quyền (basic auth sai): lỗi đăng nhập rõ ràng, không treo.

## 6. Đổi server / đổi user (D4)

- [ ] ⚙️ Settings → **đổi gateway URL** → Save → mở lại Tóm tắt ngày: số của **server mới** (không giữ cache công ty cũ); drawer mở mục nào cũng đọc tươi từ server mới.
- [ ] Đổi **tài khoản** (user/password): tương tự — cache ngày bị xoá.
- [ ] Đổi setting KHÔNG liên quan (số tin nhắn chat hiển thị): Tóm tắt ngày **không** bị ép đọc lại vô nghĩa.

## 7. Badge nháp (optional, fail-safe)

- [ ] Chat chưa hỏi gì tạo nháp → mở drawer: **không badge**.
- [ ] Hỏi tạo 1 nháp trong chat (không cần xác nhận tới cùng — nháp tồn tại là được) → đọc Tóm tắt ngày → mở drawer: badge số nháp hôm nay (chỉ khi **> 0**).
- [ ] Ngày không có nháp (badge = 0): **không** hiện badge "0".

## 8. Ranh giới (phải CẤM đúng luật)

- [ ] Bấm mọi mục drawer + mọi dòng: **không có đường nào** tới `/execute` hay mở form ghi; không có nút Thu/Trả/Submit.
- [ ] Drawer không có ô nhập tự do (không free-text `/ask`).
- [ ] Nếu có thể mô phỏng ERP fail: app **không bao giờ** hiện số MOCK thay số REAL (REAL-only — `MOCK`/unknown ⇒ panel thay số).

---
Bằng chứng tự động tương ứng: `.plan/next5/D1-result.md` … `D4-result.md`, `next5-drawer-done.md`; probe thật `dN-verify-real.py` (chỉ đọc). Suite: Node 820/818/2 · Flutter 333/333 · analyze 0 · falsify drill 37 ca ALL RED.
