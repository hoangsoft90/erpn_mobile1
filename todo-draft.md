* [next10] Test chat thường: Mỗi route bạn hãy tạo ra nhiều biến thể/câu hỏi prompt đa dạng thực tế người dùng hay hỏi để test. Đảm bảo nhận dạng đúng route. Sau khi test xong, ghi lại báo cáo vào file .md (gồm full các mẫu câu hỏi cho từng route, route nào đã ok, route nào chưa ok)

Tôi test qua thấy không test được: 
+ Lịch sử thu
+ NCC
+ card xác nhận
  "[Tên] trả 50 nghìn" : ra route:payment ko phải "route:payment_write"
  "bán [Tên] 1 bao [item]": ra "route:sales" chứ ko ra sales_order.create
  "đặt hàng NCC": ra route:sales_order_write chứ ko ra purchase_order.create



----------------------------------------------------
* [next9] lỗi chồng chéo.
chat thường: tôi test các bước sau:
1. hỏi "tạo khách hàng Lê Lợi" -> nhấn xác nhận để tạo khách mới (ok)
2. hỏi "thu tiền Lê lợi 10.000đ" -> thì ra tên lan để thu tiền. Khách hàng Lan thì đang nợ thật, bubble thì hiển thị lại nút đã xác nhận tạo khách hàng Lợi trước đó => đang bị chồng chéo (râu ông này cắm cằm bà kia). thoát app & mở lại thì lại được. Tìm nguyên nhân.

tôi muốn hỏi cái gì thì trả lời chính xác cái đó. vd: hỏi khách lan, nếu ko tìm thấy thì ko đc trả kết quả tên khách khác. Ko có khách lan thì trả lời là ko có.
----------------------------------------------------
* [next8] show card list danh sách chọn.
Nếu tìm ra nhiều hoá đơn, chứng từ, khách hàng...thì show card list danh sách chọn, chứ ko lấy dữ liệu mới nhất. Khi chọn item, thì ra hành động tiếp theo. vd như thế này là bị lỗi, gõ "nhà cung cấp" thì ra danh sách các nhà cung cấp, chọn 1 NCC thì lại lặp lại vẫn ra danh sách là sai.

Bổ xung next8: copilot phải thông minh kiểu workflow, ko cần chính xác. vd: 
"thu tiền cho anh ba 12.000đ", "thu tiền anh ba", "anh ba trả tiền",..

- xác định nghiệp vụ phải đúng. ở đây có ["thu tiền","trả tiền"] -> thì phải là route:payment_write
- tên khách là ["anh ba", "ba", "anh"] nếu có nhiều tên thì hiển thị danh sách để chọn.
- (optional) số tiền là 12.000đ : trường hợp ko có số tiền thì hiển thị form để điền.
- sau khi chọn đúng khách, nếu khách đó có nhiều hoá đơn cần thanh toán thì phải list danh sách để chọn, chứ ko lấy 1 hoá đơn.

các nghiệp vụ khác cũng thiết kế kiểu như vậy. Note: (required) câu hỏi chứa từ để nhận dạng route & đối tượng (nếu có ) để danh sách chọn ko được vượt quá 10 items.

----------------------------------------------------
* [issue6] hướng dẫn pin company, đặt COPILOT_COMPANY ..?
----------------------------------------------------
* [next7] Chat AI nhận WRITE → card xác nhận trên cùng mode. Tự gửi khi nói xong. Skill sales.summary
----------------------------------------------------