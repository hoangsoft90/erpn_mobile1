## Purpose

Khả năng `chat-client`: giao diện chat Flutter read-only đầu tiên của copilot — người dùng gõ câu hỏi tiếng Việt, nhận câu trả lời từ pipeline Phase 1+2 qua HTTP bridge, với lịch sử lưu local và trạng thái lỗi rõ ràng.

## ADDED Requirements

### Requirement: Gửi câu hỏi và nhận câu trả lời

App MUST cho phép người dùng nhập câu hỏi tiếng Việt thô (ví dụ "Khách X còn nợ bao nhiêu"), gửi tới HTTP service nội bộ, và MUST hiển thị câu trả lời nhận về.

#### Scenario: Câu hỏi có khách khớp trong ERPNext
- **WHEN** người dùng gửi một câu hỏi mà pipeline resolve ra đúng 1 khách hàng
- **THEN** app hiển thị câu trả lời tiếng Việt chứa số tiền nguyên văn từ ERPNext (ví dụ "còn nợ 269.000đ (3 hóa đơn chưa trả)") kèm nhãn nhóm skill đã route (customer/sales/payment/inventory)

#### Scenario: Câu hỏi ngoài phạm vi router
- **WHEN** pipeline trả `answer: null` kèm `reason` (không route / không tìm thấy khách)
- **THEN** app hiển thị nguyên nhân trung thực (không bịa câu trả lời) và KHÔNG ghi dòng này vào "đúng" khi đo baseline

### Requirement: Trạng thái chờ và lỗi

App MUST thể hiện rõ trạng thái chờ và mọi lỗi thao tác theo yêu cầu gốc `checklist.md`.

#### Scenario: Đang chờ câu trả lời
- **WHEN** request HTTP đang chạy
- **THEN** UI hiện loading indicator (ngăn gửi thêm câu hỏi trong lúc chờ) và không block vẽ UI

#### Scenario: Service không truy cập được
- **WHEN** HTTP service không phản hồi (mất mạng / sai địa chỉ / service chưa chạy)
- **THEN** app hiện toast lỗi tiếng Việt trong ~3 giây, không crash, câu hỏi giữ lại trong ô nhập để gửi lại

### Requirement: Lịch sử hội thoại local

Lịch sử chat MUST được lưu trên thiết bị (local storage), không phụ thuộc server, và MUST được phục hồi khi mở lại app.

#### Scenario: Khởi động lại app
- **WHEN** người dùng đóng rồi mở lại app
- **THEN** các lượt hội thoại trước vẫn hiển thị đúng thứ tự, với trạng thái lỗi/giữ nguyên như lúc lưu

### Requirement: Địa chỉ service cấu hình được, không secret trong app

Địa chỉ HTTP service MUST được cung cấp lúc build qua `--dart-define`, với giá trị mặc định cho dev; app MUST NOT nhúng secret nào.

#### Scenario: Build với địa chỉ tùy chỉnh
- **WHEN** build APK với `--dart-define=COPILOT_BASE_URL=http://192.168.x.x:8787`
- **THEN** app dùng địa chỉ đó cho mọi request; khi thiếu define, dùng giá trị dev mặc định và hiển thị địa chỉ đang dùng ở màn hình chat (dòng nhỏ, không phải popup)

### Requirement: An toàn số tiền và đường ghi duy nhất có xác nhận

App MUST NOT tự tính toán/số hóa lại số tiền, MUST NOT giữ credential ERPNext, và MUST NOT ghi
trực tiếp ERPNext. Mọi thao tác ghi MUST đi qua `POST /execute` với proposal **do server dựng**
(bất biến: server là nguồn duy nhất của số/đối tượng), sau khi người dùng bấm [Xác nhận], và MUST
chỉ tạo chứng từ **nháp** (`docstatus: 0`) — không có đường nào tự submit.

#### Scenario: Câu trả lời chỉ đọc
- **WHEN** người dùng hỏi bất kỳ điều gì
- **THEN** app chỉ hiển thị dữ liệu trả về từ copilot; mọi số tiền hiển thị nguyên văn từ trường `answer`/`outstanding_vnd` của payload, app không tự cộng/trừ/định dạng lại số tiền

#### Scenario: Đề xuất ghi cần xác nhận
- **WHEN** pipeline trả một proposal (thu tiền · đơn bán · báo giá · đơn mua · phiếu giao · phiếu nhận)
- **THEN** app hiện card đề xuất kèm mức rủi ro và nút [Xác nhận]; **không** gửi `/execute` cho tới khi người dùng bấm, và kết quả hiển thị rõ chứng từ **NHÁP** (submit chỉ khi setting riêng BẬT và CHỈ với phiếu thu)

#### Scenario: Đường nhập liệu không mở được đường ghi
- **WHEN** câu hỏi đến từ giọng nói (STT), chế độ AI (`/dsh/ask`) hoặc chụp ảnh (OCR)
- **THEN** không đường nào tự gọi `/execute` hay tự xác nhận proposal; voice/OCR chỉ tạo text/slot, chế độ AI bị chặn ghi ở server (`DSH_WRITE_BLOCKED`)

#### Scenario: Số của tóm tắt ngày do server cộng
- **WHEN** người dùng mở Tóm tắt ngày
- **THEN** client chỉ render số server trả; nhánh nào lỗi thì hiện "chưa lấy được" (**không** hiện 0 giả) và không tự cộng bù
