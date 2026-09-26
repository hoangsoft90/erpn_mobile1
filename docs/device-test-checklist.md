# Device Test Checklist — APK thật tại điểm bán (exit criteria Phase 3)

> Checklist 1 trang cho người thật. Chỉ checklist — không code server, không
> ERPNext write. Chuẩn bị TRƯỚC khi xuống điểm bán:
> - `lt` đang chạy trên Mac: `lt -s erpn8788 --port 8788`
> - ERPNext demo sống (ping `ERPNEXT_URL` → 200)
> - GitHub Variables/Secret đã dán (`COPILOT_BASE_URL=https://erpn8788.loca.lt` /
>   `COPILOT_AUTH_USER` / `COPILOT_AUTH_PASSWORD`) → CI build APK có endpoint + auth
> - Tải APK debug từ artifact GH Actions `erpn-chat-debug-apk` (run mới nhất SUCCESS)

## A. Cài đặt

- [ ] Cài APK lên máy Android (cho phép "cài từ nguồn không xác định" nếu được hỏi)
- [ ] Mở app → thấy empty state + footer hiện `COPILOT_BASE_URL` đúng tunnel
- [ ] Máy 4G/WiFi của điểm bán (KHÁC mạng VPS) — đúng kịch bản thật

## B. Đọc (READ — an toàn tuyệt đối)

- [ ] Hỏi: "chị Lan còn nợ bao nhiêu" → bubble trả lời có số tiền + số chứng từ
- [ ] Hỏi sai tên (vd "chị Lan Anh") → app hỏi lại danh sách candidate, KHÔNG chọn hộ
- [ ] Hỏi khách không tồn tại → trả lý do "không tìm thấy", không bịa số
- [ ] Tắt `lt` trên Mac → hỏi lại → SnackBar lỗi giữ nguyên text đã gõ (không mất input)

## C. Ghi (WRITE — phiếu NHÁP)

- [ ] Hỏi: "thu tiền cho <khách> <số tiền>" → hiện proposal card 🔴 HIGH tóm tắt
      khách + số tiền + chứng từ (KHÔNG phải JSON thô)
- [ ] Bấm [Xác nhận thu tiền] → "Đã ghi phiếu thu: ACC-PAY-… — <số>đ"
- [ ] Kiểm tra ERPNext UI: phiếu thu tồn tại, trạng thái **DRAFT (nháp)** —
      KHÔNG submit; công nợ hóa đơn CHƯA đổi (đúng thiết kế)
- [ ] Bấm xác nhận THÊM LẦN NỮA trên cùng thẻ → "Đã ghi nhận trước đó
      (chống trùng)" — KHÔNG có phiếu thứ hai trên ERPNext

## D. Khôi phục / An toàn

- [ ] Kill app → mở lại → lịch sử còn nguyên; thẻ đã ghi vẫn hiện kết quả;
      bấm lại (nếu còn nút) → replay, vẫn chỉ 1 phiếu
- [ ] (Demo STALE) tạo proposal rồi đổi nợ trên UI ERPNext trước khi xác nhận
      → banner 🔄 "đề xuất đã lệch" + lý do — KHÔNG ghi, nút xác nhận biến mất
- [ ] (Demo EXPIRED) để thẻ quá 10 phút rồi xác nhận → banner ⏰ hết hạn
- [ ] Toàn bộ thao tác lỗi đều hiện toast/SnackBar, app không bao giờ crash/đóng

## Kết thúc

- [ ] Ghi lại: phiên bản APK (run #), giờ test, các bước FAIL (nếu có) + screenshot
- [ ] Phiếu nháp demo: giữ làm bằng chứng hoặc xoá tay trên UI ERPNext
