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

### Requirement: An toàn đọc (giữ nguyên hợp đồng Phase 2)

App MUST NOT chứa bất kỳ code write nào và MUST NOT tự tính toán/số hóa lại số tiền.

#### Scenario: Câu trả lời chỉ đọc
- **WHEN** người dùng hỏi bất kỳ điều gì
- **THEN** app chỉ hiển thị dữ liệu trả về từ copilot; mọi số tiền hiển thị nguyên văn từ trường `answer`/`outstanding_vnd` của payload, app không tự cộng/trừ/định dạng lại số tiền
