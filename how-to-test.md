# how-to-test.md — Hướng dẫn test nghiệp vụ (ví dụ cụ thể)

> **Cập nhật:** 2026-09-24  
> Thay **tên khách / mặt hàng / kho / NCC** bằng data **site của bạn**.  
> Chi tiết P9 + curl: `.plan/next1/how-test-p9.md`.

---

## 0. Chuẩn bị 5 phút

- [ ] ERPNext mở được trên máy tính  
- [ ] Copilot **8788** + NLP **8787** sống (`curl /health`)  
- [ ] App Settings đúng URL  
- [ ] Biết 1 khách có nợ, 1 item có tồn, 1 NCC (nếu test mua/chi)  
- [ ] Ghi số Customer / số nháp PE trước khi test ghi (để đếm +1)

---

## 1. READ — chỉ hỏi, không card ghi

| # | Gõ / nói | Kỳ vọng |
|---|----------|--------|
| 1 | `chị Lan còn nợ bao nhiêu` | Số tiền + có thể nút xem HĐ |
| 2 | Bấm nút xem chứng từ (nếu có) | List HĐ, limit ~5–10, Back về chat |
| 3 | `còn bao nhiêu bao cám heo` | Tồn theo kho |
| 4 | `nhà cung cấp Hà Tiên` | Tìm NCC |
| 5 | `phiếu thu chị Lan` | Lịch sử thu |
| 6 | `đã chi cho Hà Tiên bao nhiêu` | Lịch sử chi (không card tạo phiếu) |

**Drawer:** Menu → **Tóm tắt ngày** → hôm nay/hôm qua — không gõ `báo cáo hôm nay` trên chat.

---

## 2. WRITE — có card, chưa bấm = chưa ghi

Với mỗi case: (1) gửi câu (2) **chưa** Xác nhận → ERPNext không thêm doc (3) Xác nhận → +1 nháp (4) Xác nhận lại cùng lệnh → không nhân đôi.

### 2.1 Thu tiền

```text
thu tiền chị Lan 500 nghìn
nhận 1 triệu của anh Minh
```

Kỳ vọng: card **Thu** · Xác nhận → Payment Entry **Receive** nháp (hoặc ĐÃ NỘP nếu Settings bật submit).

### 2.2 Chi tiền NCC

```text
chi tiền NCC Hà Tiên 2 triệu
trả tiền NCC Hà Tiên 2 triệu
```

Kỳ vọng: card **Chi** · Pay + Supplier.  

```text
chi xăng 200 nghìn
```

Kỳ vọng: **từ chối** (không NCC) — không tạo phiếu.

### 2.3 Đơn bán / báo giá

```text
tạo đơn cho chị Lan 10 bao cám heo
báo giá anh Minh 5 bao cám heo
```

Kỳ vọng: card dòng hàng + giá ERPNext · nháp SO / Quotation.

### 2.4 Đơn mua / nhập

```text
đặt mua Hà Tiên 20 bao cám heo
nhập hàng 10 bao cám heo từ Hà Tiên
```

Kỳ vọng: PO nháp · PR nháp (thường gắn PO nếu policy vậy).

### 2.5 Giao hàng / hóa đơn

```text
giao hàng cho chị Lan 5 bao cám heo
xuất hóa đơn cho đơn SAL-ORD-…
```

Kỳ vọng: DN / SI **nháp**; SI **theo đơn**, không tự bịa giá.

Câu hỏi (không ghi):

```text
đơn hàng chị Lan giao chưa
```

### 2.6 Kho — xuất hủy (cẩn thận)

```text
xuất hủy 1 bao <mã-item> ở <tên-kho-đúng>
```

Kỳ vọng: thiếu kho → từ chối + gợi ý kho; vượt tồn → từ chối; đủ → card → nháp (chưa trừ kho đến khi submit trên Desk nếu policy vậy).

### 2.7 Tạo khách mới (M1)

```text
thêm khách Nguyễn Văn Tèo
```

Hoặc lệnh bán với tên **chưa có** → offer **[Tạo khách mới]**.

| Bước | Kỳ vọng |
|------|--------|
| Chưa bấm | Số Customer ERPNext không đổi |
| Bấm tạo | +1 Customer, hiện mã CUST-… |
| Hỏi công nợ tên mới | 0đ / chưa nợ |
| Tạo trùng SĐT/tên policy | Không clone — báo khách cũ |

Checklist dài: `.plan/next3/M1-real-device-checklist.md`.

---

## 3. Voice & OCR (smoke)

| # | Việc | Kỳ vọng |
|---|------|--------|
| 1 | Mic → nói `chị Lan còn nợ bao nhiêu` | Ra text đúng hướng |
| 2 | Bật “tự gửi” (nếu có) | Gửi sau khi nhận dạng xong |
| 3 | Camera → OCR → chọn Đơn bán/mua | Form sửa → confirm → nháp SO/PO |
| 4 | OCR fail | Có **Nhập tay từ ảnh** |

---

## 4. Cố ý fail (an toàn)

| Gõ | Kỳ vọng |
|----|--------|
| `xóa hóa đơn vừa tạo` | Từ chối, không card xóa |
| `thu tiền chị Lan 500 nghìn` trên **chế độ AI** | Chặn WRITE |
| `báo cáo tài chính hôm nay` trên chat | Không ra tóm tắt ngày (dùng drawer) |
| Tên khách mơ hồ / trùng nhiều người | Picker hoặc hỏi lại |

---

## 5. Checklist 15 phút (máy thật)

1. [ ] Health + 1 câu công nợ  
2. [ ] 1 thu tiền **chưa** confirm → site không đổi  
3. [ ] Confirm thu → +1 PE  
4. [ ] 1 SO nháp  
5. [ ] Drawer tóm tắt ngày  
6. [ ] (Optional) thêm khách mới +1 Customer  
7. [ ] (Optional) mic 1 câu  

---

## 6. Đánh giá mức độ code (tóm tắt 2026-09-24)

| Khối | Mức |
|------|-----|
| READ + payment R/P + SO/QT/PO | Vững (test + falsify trong result P9) |
| DN / PR / SI / stock issue hẹp | Đã ship P9-A…E; cần smoke site thật |
| customer.create | Code skill có; `M1-result.md` có thể chưa nằm repo — dùng checklist máy thật |
| XML HĐĐT | Plan next3 — chưa coi là feature user-facing xong |
| Commit/push / migration SO-QT-PO | Việc human |

**Suite tham chiếu (P9-G):** Node ~656 pass (2 fail dsh env) · Flutter 270 pass · analyze sạch.
