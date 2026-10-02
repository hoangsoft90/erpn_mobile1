## Đã ra đúng route, nhưng cần test thêm

- xuất kho ID NAME
- nhận hàng NCC
- xuất hóa đơn bán
- trả hàng hoá đơn ACC_..
- xuất hủy / hàng hỏng 

## Khách

- Báo cáo doanh thu hôm nay: chọn cty

## Sửa

- route:payment_write : hiển thị danh sách các hoá đơn để chọn.
- 

--------------------------------------
- [next10] Test chat thường: Mỗi route bạn hãy tạo ra nhiều biến thể/câu hỏi prompt đa dạng thực tế người dùng hay hỏi để test. Đảm bảo nhận dạng đúng route. Sau khi test xong, ghi lại báo cáo vào file .md (gồm full các mẫu câu hỏi cho từng route, route nào đã ok, route nào chưa ok)

Tôi test qua thấy không test được: 
+ Lịch sử thu
+ NCC
+ card xác nhận
  "[Tên] trả 50 nghìn" : ra route:payment ko phải "route:payment_write"
  "bán [Tên] 1 bao [item]": ra "route:sales" chứ ko ra sales_order.create
  "đặt hàng NCC": ra route:sales_order_write chứ ko ra purchase_order.create

- [next9] chat thường: tôi test các bước sau:
1. hỏi "tạo khách hàng Lê Lợi" -> nhấn xác nhận để tạo khách mới (ok)
2. hỏi "thu tiền Lê lợi 10.000đ" -> thì ra tên lan để thu tiền. Khách hàng Lan thì đang nợ thật, bubble thì hiển thị lại nút đã xác nhận tạo khách hàng Lợi trước đó => đang bị chồng chéo (râu ông này cắm cằm bà kia). thoát app & mở lại thì lại được. Tìm nguyên nhân.

tôi muốn hỏi cái gì thì trả lời chính xác cái đó. vd: hỏi khách lan, nếu ko tìm thấy thì ko đc trả kết quả tên khách khác. Ko có khách lan thì trả lời là ko có.

- [next8] Nếu tìm ra nhiều hoá đơn, chứng từ, khách hàng...thì show card list danh sách chọn, chứ ko lấy dữ liệu mới nhất. Khi chọn item, thì ra hành động tiếp theo. vd như thế này là bị lỗi, gõ "nhà cung cấp" thì ra danh sách các nhà cung cấp, chọn 1 NCC thì lại lặp lại vẫn ra danh sách là sai.

- [issue6] hướng dẫn pin company, đặt COPILOT_COMPANY ..?

- [next7] Chat AI nhận WRITE → card xác nhận trên cùng mode. Tự gửi khi nói xong. Skill sales.summary