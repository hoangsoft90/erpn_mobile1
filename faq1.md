## Mỗi câu hỏi dsh có tạo phiên mới không? Chống ngợp context thế nào?

Mỗi câu hỏi = 1 tiến trình `dsh` HOÀN TOÀN MỚI. `dsh` chạy ở chế độ headless one-shot, `DSH_HOME` được tạo mới tinh mỗi lần rồi xoá sạch sau khi xong. Bản thân `dsh` **không hề nhớ gì** giữa các lần gọi

Nhưng có 1 lớp "giả lập liên tục" ở tầng Gateway qua `conversation_id`:

- Giữ tối đa **6 lượt hỏi-đáp gần nhất** cho mỗi `conversation_id`
- Chống ngợp context có sẵn, thiết kế cẩn thận: giới hạn cứng 6 lượt (lượt cũ hơn tự rớt), hết hạn sau 30 phút không hoạt động, giới hạn 200 hội thoại đồng thời. và mỗi câu hỏi tối đa 2000 ký tự

=&gt; an toàn, không lo phình context theo thời gian dùng lâu.

## App không có hai kênh song song “chat thường” và “phân tích AI” cho mọi nghiệp vụ.


| Đường                 | Cách test                                  | Ghi chú                                                                    |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| **Chat text / voice** | Gõ hoặc nói → `/ask` → router + capability | Cùng classifier; voice chỉ là input, auto-send vẫn `/ask`                  |
| **OCR (camera)**      | Chụp → user chọn sales/purchase            | Chỉ map **SO / PO draft**, không phủ hết READ/WRITE                        |
| **Drawer P4**         | Menu → Tóm tắt ngày → drill                | **HTTP** `/read/daily-summary` **+** `/read/drill`, **không** qua câu chat |


### Nghiệp vụ đã ship — test được thế nào?


| Nghiệp vụ              | Chat (gõ/nói)                           | “AI phân tích” riêng?    | Đường khác       |
| ---------------------- | --------------------------------------- | ------------------------ | ---------------- |
| Công nợ / khách        | ✅                                       | Không tách — cùng `/ask` | Drill A1 có thể  |
| Tồn kho                | ✅                                       | Không                    | —                |
| Lịch sử thu / HĐ       | ✅                                       | Không                    | —                |
| Thu tiền / tạo PE      | ✅ → proposal → xác nhận                 | Không                    | —                |
| Đơn bán SO             | ✅ (+ OCR sales)                         | Không                    | —                |
| Báo giá QT             | ✅                                       | Không                    | —                |
| Đơn mua PO             | ✅ (+ OCR purchase)                      | Không                    | —                |
| **Tóm tắt ngày / két** | ❌ **Không** (và không thiết kế để chat) | Không                    | ✅ **Chỉ drawer** |


### Chat thường vs Phân tích AI — “chia sẻ chung”


|                                     | Chat thường (`/ask`)      | Phân tích AI (DSH / `/dsh/ask`)       |
| ----------------------------------- | ------------------------- | ------------------------------------- |
| **READ** (công nợ, tồn, HĐ, phiếu…) | ✅                         | ✅ cùng skill qua tool `copilot_ask`   |
| **WRITE** (thu tiền, SO, QT, PO)    | ✅ card → xác nhận         | ❌ **cố ý chặn** (`DSH_WRITE_BLOCKED`) |
| **Tóm tắt ngày**                    | ❌ (`triggers: []`)        | ❌ không có skill tổng hợp             |
| **Drawer ngày**                     | ✅ đường riêng `/read/...` | —                                     |


## AI “không linh hoạt” + lỗi tools/list

- DSH **chỉ** được đăng ký MCP tool **copilot_ask** (stdio) — **không** có tool HTTP tên tools/list.  
tools/list là method **JSON-RPC MCP** trên process copilot-server.mjs, không phải API 8788.
- Câu *“báo cáo hôm nay”* **không** map ops.daily_summary (triggers rỗng) → model bịa / trả “MCP không hỗ trợ”.
- AI **không** được gọi ERPNext thô — chỉ được copilot_ask("câu cụ thể").

Cách hỏi đúng trên AI:

chị Lan còn nợ bao nhiêu · tồn cám heo · phiếu thu chị Lan — không hỏi báo cáo tổng hợp một phát.

## Chat AI chậm + curl 8788 + stream

- **Chat thường** = POST [http://127.0.0.1:8788/ask](http://127.0.0.1:8788/ask) — **không stream**, một JSON cuối.
- **AI** = spawn DSH + LLM + có thể nhiều lần copilot_ask + timeout — **chậm hơn hẳn**, không phải vì thiếu SSE trên /ask.



&nbsp;