# FAQ — Những chỗ người dùng DỄ HIỂU SAI khi dùng app

> **Cách đọc file này.** Mỗi mục là một câu hỏi thật, kèm **ví dụ cụ thể** và
> **"app thực sự làm gì"** — tất cả đã kiểm bằng lệnh/probe thật ngày **2026-09-16**,
> không suy đoán. Chỗ nào app còn thiếu thì ghi thẳng là *thiếu*, không hứa.
> Bằng chứng đầy đủ: `result25/26/27.txt`. Cách tự chạy lại: xem §8.
>
> **Ba hiểu nhầm nghiêm trọng nhất, nếu bạn chỉ đọc 3 dòng này:**
> 1. **Bấm [Xác nhận] xong công nợ KHÔNG giảm** — phiếu thu được tạo ở dạng **NHÁP**,
>    chưa submit. Không phải app ghi sai.
> 2. **Nút [Xác nhận thu tiền] chỉ hiện khi bạn ra LỆNH ghi** — nói "thu tiền cho
>    <tên khách> <số tiền>" thì app tạo đề xuất thu tiền (🔴 Cần xác nhận); câu hỏi
>    đọc ("còn nợ bao nhiêu") thì không bao giờ có nút này.
> 3. **Tên khách trùng với từ chỉ số** ("bác **Hai**", "chị **Bảy**") từng làm số tiền
>    sai gấp nhiều lần — đã vá 2026-09-16, nhưng đây là loại lỗi phải luôn cảnh giác.

---

## 1. Số tiền — app đọc được gì, không đọc được gì

### 1.1 Những cách nói app hiểu ĐÚNG (đã chạy thật)

| Bạn nói | App hiểu (VND) |
|---|---|
| `mười triệu` | 10.000.000 |
| `10 triệu` · `10tr` · `1tr5` | 10.000.000 · 10.000.000 · 1.500.000 |
| `một chục triệu` | 10.000.000 |
| `hai trăm ba mươi nghìn` · `230k` · `230.000` | 230.000 |
| `năm trăm nghìn` · `500 ngàn` | 500.000 |
| `0.5 triệu` · `12,5 triệu` | 500.000 · 12.500.000 |
| `10 triệu 500 nghìn` · `1 500 000` · `1.500.000` | 10.500.000 · 1.500.000 |
| `một trăm hai mươi lăm triệu` | 125.000.000 |
| `2 triệu rưỡi` · `2tr5` | 2.500.000 |
| `2 trẹo` · `2 chai` (miền Nam) | 2.000.000 |

### 1.2 Những câu app CỐ Ý không đọc ra số (trả về "không có số tiền")

| Bạn nói | App | Vì sao | Nên nói thế nào |
|---|---|---|---|
| `tám trăm` | *(không ra số)* | thiếu đơn vị lớn → không dám coi là tiền | `800 ngàn` hoặc `800k` |
| `một triệu hai` | *(không ra số)* | số "treo" ở cuối, đọc sai 10 lần dễ hơn đúng 1 lần | `1 triệu 200` / `1,2 triệu` |
| `2tr5k` | *(không ra số)* | hai đơn vị dính nhau = lỗi gõ/nghe, app từ chối thay vì nhân bừa | `2 triệu 500k` |
| `hơn 10 triệu` | 10.000.000 | **cờ "khoảng/hơn" chưa có** — chữ "hơn" bị bỏ qua | nói số chính xác |
| `2 bạc` | *(không ra số)* | "bạc" chưa chốt mệnh giá (đang chờ quyết định) | `200 ngàn` |

> **Nguyên tắc:** app thà **không ra số** (rồi hỏi lại) hơn là đoán sai số tiền. Với tiền,
> "không trả lời" là trạng thái an toàn, "trả lời sai" thì không.

### 1.3 ⚠️ Tên khách trùng từ chỉ số — lỗi thật, đã vá

`Hai`, `Ba`, `Tư`, `Bảy`… vừa là **tên người** vừa là **số**. Trước 2026-09-16:

| Câu bạn nói | Trước khi vá | Sau khi vá |
|---|---|---|
| `bác Hai 500 ngàn` | ❌ **2.500.000** | ✅ 500.000 |
| `chị Bảy 300 ngàn` | ❌ **7.300.000** (7 đọc từ tên!) | ✅ 300.000 |
| `ghi nợ cho bác Hai 300 ngàn` | ❌ 2.300.000 | ✅ 300.000 |
| `1 500 000` (số cách nhau, hợp lệ) | ✅ 1.500.000 | ✅ 1.500.000 |

**Hiểu đúng:** dù đã vá, khi tên khách là số thì **luôn nói kèm đơn vị** (`500 ngàn`,
`500k`) để người đọc lại cũng không nhầm.

### 1.4 Định dạng số: `2.500.000` là hai triệu rưỡi, không phải 2,5

App in số kiểu Việt Nam: **dấu chấm = ngăn nghìn**. Nếu bạn copy `2.500.000` sang Excel
hay phần mềm đang để locale tiếng Anh (dấu phẩy mới là ngăn nghìn), nó sẽ đọc thành
**2,5** ⇒ sai **1000 lần**. Kiểm tra ô đó trước khi dùng số để tính toán.

VND không có đơn vị lẻ: số luôn được làm tròn về số nguyên (`12,5 triệu` → 12.500.000).

---

## 2. Danh xưng & tên khách

### 2.1 Vì sao app bỏ danh xưng?

ERPNext lưu tên không kèm danh xưng (`Nguyễn Văn Nam`, không phải `Anh Nam`), nên app
bỏ danh xưng trước khi tìm: `Anh Nam` → tìm **Nam**.

**Nhưng** app chỉ bỏ danh xưng ở **đầu câu**, vì ở giữa câu danh xưng thường **là một
phần tên thật** (`Công trình nhà ông An`, `Anh Ba — xây nhà`). Hệ quả thật:

- `chị Lan còn nợ bao nhiêu` → tìm **Lan**
- `thu tiền cho chị Lan 500 ngàn` → chữ **"chị" còn lại** trong câu (đúng thiết kế)

### 2.2 🔴 Tên khách chứa danh xưng — lỗi thật, đã vá

Site demo có khách tên đúng là **`Chị Tư — thầu nhỏ`**. Trước khi vá, khi bạn hỏi
`thu tiền cho chị Lan 500 ngàn`, app trả lời về **Chị Tư** — sai khách, và **không có
cảnh báo nào**, vì mảnh `chị` khớp duy nhất một khách.

**Đã vá:** danh xưng đứng **một mình** không còn được coi là tên khách. Sau khi vá:

- `thu tiền cho chị Lan 500 ngàn` → `Lan` khớp đúng khách tên chứa "Lan" **nếu có duy nhất một khách như vậy** (bộ test: `Nguyễn Thị Lan`) ✅
- nếu chỉ có khách `Chị Tư — thầu nhỏ` mà bạn hỏi "chị Lan" → app báo **không tìm thấy**
  (đúng, an toàn) thay vì trả lời về người khác ✅
- vẫn hỏi được khách đó bằng tên đầy đủ: `Chị Tư — thầu nhỏ còn nợ bao nhiêu` ✅

### 2.3 "Không tìm thấy khách" ≠ app hỏng

Ví dụ thật trên site demo: `chị Lan còn nợ bao nhiêu` →
`không tìm thấy khách hàng trong "Lan receivable bao nhiêu"`.
Nghĩa là **site này không có khách nào tên chứa "Lan"** (sau khi bỏ danh xưng), chứ không
phải app lỗi. Cách xử lý: nói tên đầy đủ hoặc tên đặc trưng hơn (`Nguyễn Thị Lan`).

### 2.4 Tên trùng nhau → app HỎI LẠI, không đoán

- Mảnh tên **1 từ** khớp **nhiều khách** ⇒ app trả về **danh sách ứng viên** để bạn chọn.
- Mảnh tên **≥2 từ** khớp nhiều khách ⇒ app lấy kết quả đầu **và kèm cảnh báo**
  `⚠️ tên khách trùng nhiều kết quả — đã lấy kết quả đầu tiên`.
  **Hãy đọc cảnh báo này** — nó nghĩa là "tôi chưa chắc".

### 2.5 `CUST-00001` không phải mã khách của bạn

Card đề xuất hiển thị `entity.id` = **ID nội bộ ERPNext**. Đừng dùng nó như mã khách
hàng trong chứng từ hay hợp đồng.

---

## 3. Câu hỏi ĐỌC hay lệnh GHI? (nguồn hiểu nhầm lớn nhất)

### 3.1 "Thu tiền cho chị Lan 500 ngàn" — app có ghi phiếu thu không?

**Không ghi ngay.** Câu này là LỆNH ghi — app tạo **đề xuất** thu tiền (thẻ 🔴 HIGH
kèm nút [Xác nhận thu tiền]) và DỪNG LẠI ĐÓ. Chưa bấm nút = chưa ghi gì cả; bấm nút
rồi app mới gọi `/execute` tạo phiếu thu (NHÁP) trên ERPNext.

⚠️ Trước 2026-09-16, câu này từng rơi vào nhóm ĐỌC và trả lời "chưa có phiếu thu nào
... Phase 2 chỉ đọc" — chữ cũ đã được thay bằng đường lệnh ghi thật (xem §3.2).

> Câu hỏi ĐỌC về lịch sử có thể bắt đầu bằng động từ synonym — "**thanh toán gần nhất
> của chị Lan là bao nhiêu**" là câu HỎI (xem lịch sử phiếu thu), KHÔNG phải lệnh ghi;
> app phân biệt qua từ nghi vấn (bao nhiêu/gần nhất/mới nhất...). Câu lệnh ghi thật
> luôn có khách + số tiền ở sau động từ.

### 3.2 Vậy nút [Xác nhận thu tiền] xuất hiện khi nào?

**Chỉ khi bạn ra lệnh thu tiền**, ví dụ: *"thu tiền cho chị Lan 500 ngàn"* — câu lệnh
đi qua router (nhóm `payment_write`) và sinh đề xuất `action = create_payment_entry`,
risk **🔴 HIGH**. Câu hỏi ĐỌC ("còn nợ bao nhiêu", "đã trả bao nhiêu", "tồn kho mấy")
thì **không bao giờ** có nút này — đề xuất của chúng là mức 🟢 chỉ đọc.

Đề xuất thu tiền được tạo bằng `buildPaymentProposal()` và **dừng lại ở dạng thẻ xác
nhận**: bạn bấm [Xác nhận thu tiền] thì app mới gọi `/execute` ghi phiếu thu (NHÁP)
trên ERPNext. Chưa bấm = chưa ghi gì cả.

### 3.3 Câu trả lời ghi "Phase 7 — Phase 2 chỉ đọc" là chữ đã CŨ

Chữ này **đã được xoá** khỏi câu trả lời (2026-09-16). Giờ khi bạn xem lịch sử phiếu
thu, câu trả lời gợi ý đúng cách ghi: *"Để ghi phiếu thu mới, hãy nói 'thu tiền cho
<tên khách> <số tiền>'"* — và làm theo đúng câu đó thì app sẽ tạo đề xuất thu tiền
thật (xem §3.2).

### 3.4 "Ghi nợ" hiểu theo app KHÁC hiểu theo kế toán

App hiểu `ghi nợ` = `credit_sale` = **bán chịu** (khách lấy hàng chưa trả tiền).
Trong kế toán, "ghi nợ" còn nghĩa là **bút toán Nợ (debit)** — hoàn toàn khác.
Và app **chưa ghi được bán chịu**: hỏi `ghi nợ cho chị Lan 5 triệu` → app trả lời **đọc**
(`... không còn chứng từ nào chưa thanh toán`), **không có chứng từ nào được tạo**.

### 3.5 `công nợ` trong app = "khách còn nợ mình" (receivable)

Spec Phase 1 từng liệt kê `công nợ` ở 2 nhóm nghĩa; đã **chốt = receivable**.
Nếu bạn có nghiệp vụ "công nợ phải trả nhà cung cấp", app **không** trả lời được câu đó.

### 3.6 `trả tiền cho khách X` bị hiểu là phiếu THU của khách

App xếp `trả tiền / thanh toán / phiếu thu` vào nhóm **payment** = phiếu thu **của khách**.
Nếu bạn định hỏi "mình trả tiền cho nhà cung cấp", câu này sẽ bị hiểu **ngược chiều**.

### 3.7 `nhập hàng / mua hàng` thuộc nhóm TỒN KHO

App xếp vào nhóm tồn kho (xem/kiểm kho), **không** phải nghiệp vụ mua hàng – công nợ phải trả.

---

## 4. Đọc kết quả công nợ

### 4.1 Tổng nợ là số NET (đã trừ hàng trả lại)

Bằng chứng thật (`result20`): khách có 4 chứng từ, trong đó **1 phiếu trả hàng âm
−97.200đ** → app trả `171.800đ / 4 chứng từ`. Nếu bạn tự cộng tay **các hóa đơn dương**,
bạn ra **269.000đ**. Hai số khác nhau **là đúng** — số của app đã trừ hàng trả lại.

### 4.2 Dòng số ÂM / "hiện dư" nghĩa là khách đang dư tiền

Chứng từ trả hàng (credit note) có `outstanding_amount` **âm** và **vẫn được tính**
(nó làm giảm nợ). Vì vậy app nói **"chứng từ chưa thanh toán"** chứ không nói "hóa đơn":
một dòng âm không phải "hóa đơn khách chưa trả".

### 4.3 "Hôm nay thu được bao nhiêu" — chưa hỗ trợ

App **không có bộ lọc theo ngày / câu hỏi tổng hợp không nêu tên khách**. Chạy thật:
`hôm nay thu được bao nhiêu` → **không có câu trả lời** (rỗng). Đây là *chưa làm*, không
phải app treo. Muốn xem phiếu thu: hỏi theo **tên khách** (`chị Lan đã trả bao nhiêu`).

### 4.4 Tồn kho: con số hiển thị là **actual_qty**, chưa trừ hàng đã giữ chỗ

App in `MÃ: <actual_qty> (kho <warehouse>)`. Hàng đã reserve cho đơn khác **chưa bị trừ**.
Ngoài ra:

- nếu tên vật tư khớp **nhiều** mặt hàng ⇒ app hiện **tất cả** + cảnh báo
  `⚠️ tên vật tư khớp nhiều mặt hàng` ⇒ phải tự chọn đúng mã;
- nếu **không** khớp vật tư nào ⇒ app hiện **toàn bộ** tồn kho (không lọc) ⇒ **đừng** đọc
  dòng đầu tiên rồi coi là mặt hàng mình đang hỏi.

---

## 5. Ghi tiền (khi nút [Xác nhận] hoạt động)

### 5.1 Bấm [Xác nhận] thành công… công nợ vẫn nguyên. Vì sao?

Phiếu thu được tạo ở trạng thái **NHÁP** (`docstatus 0`). Bằng chứng thật: sau khi ghi
2 phiếu 10.000đ, hóa đơn `ACC-SINV-2026-00047` **vẫn** `outstanding_amount = 457.875`,
trạng thái `Unpaid`. **Muốn tiền vào sổ phải SUBMIT** — và app **chưa làm** bước này
(đây là quyết định của bạn, không phải bước tự động).

### 5.2 Bấm [Xác nhận] hai lần có ghi hai phiếu không?

**Không.** Lần thứ hai trả về đúng kết quả của lần đầu và gắn nhãn **"chống trùng"**.
Điều này đúng cho cả 3 trường hợp: bấm lại, **mất mạng rồi bấm lại**, và **app restart
rồi bấm lại trên cùng card** (khoá chống trùng được lưu cùng lịch sử chat).
Chỉ khi bạn **hỏi lại câu khác** (card mới) mới là một lệnh mới.

### 5.3 Khi nào app TỪ CHỐI ghi (và như vậy là ĐÚNG)

| Tình huống | Kết quả |
|---|---|
| Số tiền 0 / âm / không phải số | từ chối ngay, **không chiếm** mã lệnh |
| Không xác định được khách trong ERPNext | từ chối, yêu cầu tìm khách trước |
| Hóa đơn đã hết nợ (có người thu trước) | từ chối, **không** ghi |
| Không xác định được tài khoản / phương thức thanh toán | từ chối — **không tự chọn đại** một phương thức khác |
| Kết quả ghi không đọc lại được / ERPNext không trả lời | **không** coi là xong; lần sau hệ thống tự đối soát lại |

### 5.4 "Chống trùng" không phải lỗi

Nó nghĩa là: lệnh này **đã được xử lý**, hệ thống trả lại kết quả cũ và **không ghi thêm**.
Đây là cơ chế an toàn chống thu tiền 2 lần — không phải app bị treo hay bấm hụt.

### 5.5 Tiền vào tài khoản nào? Tên phương thức thanh toán có thể bị đổi

- Tiền ra khỏi **tài khoản phải thu của chính hóa đơn**; tiền vào **tài khoản của
  phương thức thanh toán** — cả hai đọc từ ERPNext lúc xác nhận, không hardcode.
- Bạn nói `Tiền mặt`, ERPNext có thể lưu là `Cash` → app báo lại
  `mode_substituted_from: "Tiền mặt"`. **Đây là thay thế có kiểm soát**, không phải lỗi.
- Nếu site **không có** phương thức nào khớp ⇒ app **từ chối ghi** (không tự chọn phương
  thức khác) vì ghi tiền vào sai tài khoản còn tệ hơn không ghi.

### 5.6 Số tiền ghi luôn ≤ nợ thật tại thời điểm xác nhận

Đề xuất chỉ là **ý định**; lúc ghi, app đọc lại nợ thật. Đề xuất vượt nợ ⇒ bị kẹp về đúng
nợ (kèm cảnh báo trong đề xuất). Riêng số tiền **sai định dạng** thì bị **từ chối**, không
bị "kẹp" thành số to hơn.

### 5.7 Hiện chỉ dùng cho VND (một loại tiền)

Phiếu thu đang tạo với tỷ giá **1:1** — đúng cho shop chỉ dùng VND. Site đa tiền tệ
**chưa dùng được** (phải đọc tỷ giá thật trước).

### 5.8 Phiếu thu có dấu vết gì?

- `reference_no` = mã lệnh (`command_id`) — dùng để đối soát, chống trùng;
- có dòng **phân bổ (allocation)** gắn vào đúng hóa đơn;
- `remarks` ghi rõ: `ERPNext Voice Copilot · xác nhận bởi người dùng · command_id …`.

---

## 6. Môi trường & vận hành — khi "app im lặng" thì hiểu thế nào

### 6.1 App không trả lời ≠ dữ liệu sai

Bản demo hiện chạy: **ERPNext + LLM trên máy Mac, mở ra ngoài bằng ngrok/localtunnel**.
Tunnel chỉ sống khi lệnh mở tunnel còn chạy trên Mac. Tunnel tắt ⇒ app im lặng hoặc báo lỗi
mạng — **không phải** công nợ trong ERPNext sai.

### 6.2 Thỉnh thoảng lỗi "429/503" là chuyện bình thường của gói miễn phí

LLM miễn phí (Gemini) có giới hạn theo phút/ngày. Gặp lỗi này **thử lại sau ~60 giây**;
không phải số liệu sai. Khi dev hằng ngày hiện đã trỏ sang LLM tự host (không giới hạn).

### 6.3 Dữ liệu demo lẫn trong site — đừng nhầm là khách thật

Site demo có các khách do quá trình kiểm thử tạo ra, ví dụ: `Khách smoke 2026-09-15-p1b-wf1-2`,
`Khách làm tròn 2026-09-15-p1b-wf1-2`, `Chị Tư — thầu nhỏ`, và **2 phiếu thu nháp demo**
(`ACC-PAY-2026-00114/00115`, 10.000đ). Các phiếu này **không** làm giảm công nợ (còn nháp).

### 6.4 ⚠️ Dữ liệu khách được gửi thẳng cho LLM (chưa che tên/số tiền)

Theo sign-off Phase 5 (2026-09-15), dự án **chốt KHÔNG che (scrub) tên khách/số tiền**
trước khi gửi cho LLM, và dữ liệu còn đi qua tunnel công cộng. Với dữ liệu **khách thật**,
hãy cân nhắc lại quyết định này trước khi dùng rộng rãi.

### 6.5 Mỗi máy một lịch sử riêng

Lịch sử chat lưu **cục bộ trên máy**. Xoá app / đổi máy = mất lịch sử (không đồng bộ).
Hiện **chưa có đăng nhập/phân quyền**: ai cầm được máy là hỏi được công nợ khách.

### 6.6 Nhật ký chứa tên khách & số tiền — đừng copy đi đâu

`llm-router-audit/` (JSONL) và `idempotency-store/` nằm trong thư mục dự án và đã bị
git-ignore: chúng ghi tên khách/số tiền phục vụ đối soát. **Đừng** đặt chúng vào `/tmp`
(trên máy dev này /tmp bị xoá khi container khởi động lại → mất bằng chứng đối soát).

### 6.7 Khoá API ERPNext không nằm trong app

Khoá nằm ở phía máy chủ (`.env`), không nhúng vào APK (đã quét artifact APK: 0 lần xuất hiện).
Nếu cần thu hồi/đổi khoá, đổi ở `.env` — **không** cần cập nhật app.

---

## 7. Ranh giới hiện tại — app KHÔNG làm những việc này

- ❌ **Submit** phiếu thu (vì vậy công nợ chưa giảm), **hủy/xoá** chứng từ.
- ❌ Tạo/sửa **khách hàng**, **hóa đơn**, **đơn hàng**; ghi **bán chịu / ghi nợ**.
- ❌ **Nhập/xuất kho** (mới chỉ xem tồn).
- ❌ Câu hỏi **tổng hợp theo ngày/tuần/tháng**.
- ❌ **Giọng nói** (Phase 4 — đang chờ bộ audio thật 3 miền) và **đọc thành tiếng** (Phase 8).
- ❌ **Nhiều người dùng / phân quyền** (Phase 10).
- ✅ Đang làm được: **đọc** công nợ · chứng từ chưa thanh toán · lịch sử phiếu thu · tồn kho,
  và **(máy móc)** ghi **1 phiếu thu nháp** khi có đề xuất HIGH + người xác nhận.

---

## 8. Tự kiểm lại các ví dụ trong file này

```bash
# 1. Số tiền đọc thế nào (không cần LLM/ERPNext)
PYTHONPATH=src python3 -c "
from vietnamese_nlp import normalize
for t in ['bác Hai 500 ngàn','chị Bảy 300 ngàn','1 500 000','2 triệu rưỡi','tám trăm']:
    print(t, '->', normalize(t).amount)"

# 2. Toàn bộ test (Python + Node + Flutter)
PYTHONPATH=src python3 -m unittest discover -s tests
cd mcp-erpnext && node --test && cd ../apps/mobile && flutter test

# 3. Hỏi thử end-to-end (cần NLP service + ERPNext; xem mcp-erpnext/LOCAL-TEST.md)
python3 -m nlp_service.server            # terminal 1
cd mcp-erpnext && node src/http-ask.mjs --port 8788   # terminal 2
curl -X POST http://127.0.0.1:8788/ask -H 'Content-Type: application/json' \
     -d '{"text":"chị Lan còn nợ bao nhiêu"}'

# 4. Thử đề xuất GHI (item 2): đề xuất HIGH trả về, CHƯA ghi gì cho tới khi
#    bấm [Xác nhận] (gọi /execute) — thử bằng câu:
curl -X POST http://127.0.0.1:8788/ask -H 'Content-Type: application/json' \
     -d '{"text":"thu tiền cho chị Lan 500 ngàn"}' | python3 -m json.tool | grep -A4 '"proposal"'

# 5. Route /execute/cancel: chỉ huỷ lệnh PENDING khi ERPNext xác nhận 0 chứng từ
curl -X POST http://127.0.0.1:8788/execute/cancel -H 'Content-Type: application/json' \
     -d '{"command_id":"<uuid-của-lệnh-đang-pending>"}'
```

---

## 9. Còn treo — cần quyết định (ảnh hưởng trực tiếp tới các hiểu nhầm trên)

| Việc | Vì sao quan trọng |
|---|---|
| ~~Nối "câu tiếng Việt → đề xuất thu tiền HIGH"~~ | ✅ ĐÃ XONG 2026-09-16 (item 2 + review vòng 2 F1: câu hỏi lịch sử "thanh toán gần nhất..." đã được phân biệt khỏi lệnh ghi bằng deny-list từ nghi vấn): "thu tiền cho <khách> <số tiền>" → đề xuất HIGH + nút [Xác nhận] thật (§3.2) |
| ~~Sửa câu trả lời còn ghi "Phase 2 chỉ đọc"~~ | ✅ ĐÃ XOÁ 2026-09-16 (item 2, §3.3) |
| Quyết định **submit** phiếu thu | không submit thì công nợ không bao giờ giảm (§5.1) |
| "bạc" = mệnh giá nào · có nhận "m" = triệu không | hai cách nói phổ biến hiện **không** ra số (§1.2) |
| Cờ "khoảng/hơn" cho số tiền | hiện "hơn 10 triệu" bị hiểu là **đúng** 10 triệu (§1.2) |
| Route `/execute/cancel` đã có (huỷ lệnh PENDING khi ERPNext xác nhận chưa ghi) | giải quyết "đề xuất treo" — giờ có đường thoát, không còn phải chờ vô hạn |
