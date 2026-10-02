# todo-test.md — Phase 11 · Acceptance máy thật (A1–A9)

> Việc **NGƯỜI THẬT** phải làm trên **APK release** cài ở điện thoại. Agent đã làm
> hết phần tự động (regression + harness); các bước dưới cần mic / camera / mắt
> đọc số ⇒ **agent không bịa PASS**. Điền kết quả vào bảng ở
> `.plan/next8/phase11-result.md` §2 (cột `kết quả · ảnh/logcat · ngày`).

## 0. Chuẩn bị (owner)

- [ ] Đã nạp 4 secret ký (`docs/release-build.md`) → CI `android-release-apk` xanh.
- [ ] Đã đưa điện thoại vào **tailnet** (Tailscale) trỏ tới gateway Mac:
      `http://mac-mini-ca-hoang.tail54c58.ts.net:8788`.
- [ ] Gateway trên Mac đã **restart** nạp credential mới (`ai-copilot@…`) và bind
      **non-loopback** (P10 §BLOCK#1) + đã bật basic auth (`ASK_USER`/`ASK_PASSWORD`).
- [ ] Tải `erpn-chat-release-apk` từ artifact; xác nhận **không debug-signed**.
- [ ] Cài APK: `adb install -r app-release.apk` (bật "cài nguồn không xác định").
- [ ] Trên điện thoại: **KHÔNG** có Metro/dev server — app phải tự chạy (F3).

## A1 — Cold start · endpoint production
- [ ] Mở app từ trạng thái chưa chạy (cold start) → **không crash**.
- [ ] Vào ⚙️ Cài đặt → server hiển thị **endpoint production** (KHÔNG phải `127.0.0.1`).
- [ ] Bấm **"Kiểm tra kết nối"** → báo *"Kết nối OK — …"*.
- [ ] Nếu endpoint còn loopback ⇒ **FAIL** (báo ngay, không tự sửa ở đây).

## A2 — Chat ĐỌC · số khớp ERPNext (đối chiếu tay ≥ 2 số)
- [ ] "chị Lan còn nợ bao nhiêu" → số tiền khớp **REST/Desk ERPNext** (mở Desk đối chiếu tay).
- [ ] "hoá đơn chưa trả" / "tồn kho" / "tóm tắt hôm nay" → mỗi số khớp sổ.
- [ ] Ghi lại **2 con số** đối chiếu được (app vs ERPNext).

## A3 — Mic / giọng nói tiếng Việt
- [ ] Bấm mic, nói 1 câu hỏi (vd "chị Lan còn nợ bao nhiêu") → nhận đúng chữ.
- [ ] Câu hỏi đúng ý; **không tự chế số**.
- [ ] Thử "Tự gửi sau khi nói xong" (nếu bật) → gửi đúng 1 lần.

## A4 — Ảnh/PDF chứng từ (OCR)
- [ ] Chụp/đính 1 ảnh hoá đơn → OCR trích field (số tiền, ngày, mã).
- [ ] App **hỏi xác nhận** trước khi dùng — bấm xác nhận mới đi tiếp.
- [ ] Số trích ra khớp hoá đơn giấy.

## A5 — Collect (NHÁP) · lock 6.1
- [ ] "thu tiền cho <khách> <số>" → card 🔴 HIGH tóm tắt khách + số + hoá đơn.
- [ ] Gạch hoá đơn + chọn **1** phương thức → xác nhận → "Đã ghi phiếu thu NHÁP …".
- [ ] Kiểm Desk: phiếu **DRAFT**, công nợ hoá đơn **chưa đổi** (đúng thiết kế).
- [ ] Thử chọn **Tiền mặt + Chuyển khoản** cùng lúc → app hướng sang **2 lần thu** (chặn > 1).

## A6 — Sales/Purchase (NHÁP)
- [ ] "bán hàng cho <khách> …" → mở màn Bán → tạo **NHÁP** SI, công nợ hiển thị đúng.
- [ ] "nhập hàng từ <NCC> …" → màn Mua → **NHÁP** PI (+PE nếu trả trước), giá MUA ≠ giá bán.
- [ ] Desk: cả hai là **DRAFT**, KHÔNG submit.

## A7 — Trạng thái lỗi (tiếng Việt, không số bịa)
- [ ] Bật máy bay → hỏi → thông báo lỗi tiếng Việt, **không số bịa**, giữ text đã gõ.
- [ ] Tắt gateway trên Mac → hỏi lại → lỗi rõ ràng + [Thử lại] (không list rỗng giả).
- [ ] Sửa endpoint sai trong Cài đặt → hỏi → lỗi, không treo.

## A8 — Kill switch (Phase 10)
- [ ] Tạo `mcp-erpnext/control/read-only.flag` trên Mac → `/execute` bị **chặn** (503 SYSTEM_MAINTENANCE), ĐỌC vẫn chạy.
- [ ] Xoá flag → ghi lại được.

## A9 — Ngoài miền ERP (Phase 8)
- [ ] Nói câu ngoài phạm vi (vd "bật đèn phòng khách") → trả lời rõ là ngoài phạm vi, **không bịa**.

## Kết thúc
- [ ] Ghi **phiên bản APK (run #) + sha256 + giờ test + máy** vào phase11-result §2.
- [ ] Mọi FAIL: ghi vào `.project/openspec.md` §bugs + quay lại **phase gốc** sửa gốc rễ (KHÔNG vá tại chỗ).
- [ ] Dọn chứng từ NHÁP đã tạo khi test (giữ 1 bản làm bằng chứng nếu muốn).
- [ ] **Không** submit bất kỳ chứng từ nào.
