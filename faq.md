# FAQ — Những chỗ người dùng DỄ HIỂU SAI khi dùng app

> **Cách đọc file này.** Mỗi mục là một câu hỏi thật, kèm **ví dụ cụ thể** và
> **"app thực sự làm gì"** — tất cả đã kiểm bằng lệnh/probe thật ngày **2026-09-16**
> (các mục bổ sung sau đó ghi ngày riêng; **§6.11** kiểm ngày **2026-09-19**),
> không suy đoán. Chỗ nào app còn thiếu thì ghi thẳng là *thiếu*, không hứa.
> Bằng chứng đầy đủ: `result25/26/27.txt` (và `result57/58.txt` cho §6.11). Cách tự chạy lại: xem §8.
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

### 2.4b "App hỏi lại chọn khách" (danh sách ứng viên) — chọn 1 cái là xong

- Khi tên khớp **nhiều khách**, lệnh GHI (thu tiền) sẽ **không tự chọn** — app hiện
  danh sách ứng viên để bạn bấm chọn đúng người (P1).
- Bấm chọn xong app **gửi lại đúng câu cũ** với khách đã chọn — câu lệnh không bị đổi ý.
- Nếu bạn gõ tay `CUST-00001` vào câu (thay vì bấm chọn) — id chỉ là **gợi ý**:
  server luôn đọc lại danh sách khách từ ERPNext trước khi nhận; id không nằm trong
  danh sách vừa đọc ⇒ bị từ chối (app không tự bịa khách). (§2.5)

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

### 4.3 "Hôm nay thu được bao nhiêu" — hỏi trong CHAT thì chưa, nhưng ĐÃ CÓ MÀN RIÊNG

**Hỏi trong chat** vẫn không được: câu hỏi tổng hợp không nêu tên khách **chưa có đường**
trong chat (chạy thật: `hôm nay thu được bao nhiêu` → **không có câu trả lời** — đây là
*chưa làm*, không phải app treo).

**Nhưng số đó đã có sẵn ở màn khác**: mở **☰ drawer → `Tóm tắt ngày`** (mục đầu tiên,
đánh dấu *Mặc định*) — xem **§10** để biết cách đọc. Nếu bạn đang tìm "hôm nay thu được
bao nhiêu" thì **đừng hỏi chat**, mở màn đó.

Muốn xem phiếu thu **theo tên khách** thì vẫn hỏi chat: `chị Lan đã trả bao nhiêu`.

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

> ⚠️ **Có HAI nguồn "429" khác nhau — đừng lẫn:** (1) **429 của nhà cung cấp LLM** (hết quota
> miễn phí) và (2) **429 của chính gateway app** (bạn hỏi/bấm quá nhanh — xem §6.8).
> Cả hai đều là "chờ rồi thử lại", không phải dữ liệu sai.

### 6.8 ⏱️ "429 — bạn thao tác quá nhanh": gateway có giới hạn thật (từ 2026-09-18)

Trước đây luật giới hạn chỉ nằm trong tài liệu, **chưa ai chặn**; từ đợt P10 gateway enforce thật:

| Loại việc | Giới hạn |
|---|---|
| Câu hỏi ĐỌC (công nợ, tồn kho…) | 30 / phút |
| Tạo đề xuất GHI (thẻ [Xác nhận] hiện ra) | 10 / phút |
| Bấm [Xác nhận] (thực sự ghi) | 5 / phút |
| Riêng ghi phiếu thu (`payment.create`) | 20 / giờ |

**Hiểu đúng:**
- Vượt hạn mức → app trả **429 kèm câu tiếng Việt** + header `Retry-After`. Chờ rồi thử lại.
- ❗ **Bị 429 KHÔNG "đốt" lệnh của bạn**: gateway chặn TRƯỚC khi ghi, nên `command_id` vẫn nguyên
  (đã đo thật: store không có bản ghi, 0 phiếu thu nào được tạo). Mở lại cửa sổ rồi bấm lại ⇒ vẫn
  đúng **1 phiếu**, không ghi 2 lần.
- Câu hỏi ĐỌC **không** tiêu mất ngân sách ghi (2 sổ riêng).
- Hủy lệnh (`/execute/cancel`) **không bao giờ** bị giới hạn — cần hủy là hủy được ngay.
- Nếu bạn cố tình tắt giới hạn khi test: `COPILOT_RATE_LIMIT=off`. Config bị viết hỏng thì hệ thống
  **tự quay về hạn mức mặc định** (không tắt cổng lặng lẽ).

### 6.9 📥 "ERP sập giữa lúc tôi vừa xác nhận" — lệnh được xếp hàng, không ghi 2 lần

Nếu gateway kịp **nhận lệnh nhưng chưa kịp ghi** (ERPNext tạm không tới được), gateway **xếp lệnh
vào hàng đợi** và tự thử lại sau, thay vì trả "thành công" giả:

- Lệnh chỉ xếp hàng khi lỗi xảy ra **TRƯỚC khi ghi** — nếu đã ghi được thì không xếp hàng, không ghi lại.
- Mọi lần thử lại đi qua **đúng đường ghi cũ** + idempotency ⇒ dù bạn bấm lại hay hệ thống tự thử lại,
  **kết quả vẫn là 1 phiếu duy nhất**.
- Trạng thái lệnh xem được ở `GET /jobs` (đang chờ / đã xong / thất bại).
- ⚠️ **Thiếu ở app (đã ghi nhận, chưa làm):** app **chưa** tự poll `/jobs` — gặp lỗi bạn sẽ thấy
  thông báo lỗi và phải **tự bấm lại** nút [Xác nhận]. Bấm lại là **an toàn** (replay cùng lệnh,
  không ghi phiếu thứ hai).

### 6.10 🛠️ "Hệ thống đang bảo trì" (503 `SYSTEM_MAINTENANCE`) — app làm gì?

Chủ dự án có thể bật **kill switch** để chặn mọi thao tác GHI (ví dụ đang sửa dữ liệu ERPNext).
**Hiểu đúng:**

- Câu hỏi ĐỌC vẫn trả lời bình thường; **chỉ đường GHI bị chặn**: bấm [Xác nhận] ⇒ 503 kèm câu báo bảo trì.
- ❗ **Lệnh bị chặn KHÔNG tiêu `command_id`** — hết bảo trì bấm lại là chạy (đúng 1 phiếu).
- **Hủy lệnh vẫn chạy** trong lúc bảo trì (để dọn lệnh đang treo).
- Chi tiết vận hành: `docs/kill-switch-runbook.md`.
- ✅ **Lệnh đang chờ trong hàng gặp bảo trì thì sao? (đã sửa theo quyết định của chủ dự án, 2026-09-18):**
  nó **ở lại hàng chờ** — không bị đánh "thất bại", không mất lượt thử — vì bảo trì chặn **TRƯỚC** khi
  thử ghi (chưa hề thử thì không tính là thử). Tắt bảo trì xong, hệ thống **tự chạy lại** lệnh đó ở
  lần dò kế tiếp: **không cần bấm lại nút [Xác nhận]**. Kết quả vẫn đúng **1 phiếu duy nhất**.

### 6.3 Dữ liệu demo lẫn trong site — đừng nhầm là khách thật

Site demo có các khách do quá trình kiểm thử tạo ra, ví dụ: `Khách smoke 2026-09-15-p1b-wf1-2`,
`Khách làm tròn 2026-09-15-p1b-wf1-2`, `Chị Tư — thầu nhỏ`, và **2 phiếu thu nháp demo**
(`ACC-PAY-2026-00114/00115`, 10.000đ). Các phiếu này **không** làm giảm công nợ (còn nháp).

> Đừng nhầm "dữ liệu demo" với "dữ liệu cài sẵn trong app": những khách này nằm **trong
> ERPNext**, app đọc ra như mọi khách khác — xem **§6.11** (app không giữ bản sao tĩnh).

### 6.4 ⚠️ Dữ liệu khách được gửi thẳng cho LLM (chưa che tên/số tiền)

Theo sign-off Phase 5 (2026-09-15), dự án **chốt KHÔNG che (scrub) tên khách/số tiền**
trước khi gửi cho LLM, và dữ liệu còn đi qua tunnel công cộng. Với dữ liệu **khách thật**,
hãy cân nhắc lại quyết định này trước khi dùng rộng rãi.

### 6.5 Mỗi máy một lịch sử riêng — và chuyện "ai được hỏi"

Lịch sử chat lưu **cục bộ trên máy**. Xoá app / đổi máy = mất lịch sử (không đồng bộ).

Về quyền truy cập (đã cập nhật 2026-09-19 — mục này từng ghi "chưa có", nay đã có):

- **Gateway tự bảo vệ lớp vận chuyển**: bind ra ngoài loopback **BẮT BUỘC** basic auth
  (`ASK_USER` + `ASK_PASSWORD`, mật khẩu ≥ 8 ký tự) — thiếu là **từ chối khởi động**; bind ra
  interface công cộng còn phải khai thêm `ASK_ALLOW_PUBLIC=1`. Bind loopback thì **cấm** đặt
  `ASK_*` (lỗi cứng). Có auth ⇒ sai/thiếu ⇒ **401**.
- **Phân quyền theo hợp đồng** (P8): đặt `COPILOT_USERS` (JSON) ⇒ chế độ `multi_user` — mỗi tài
  khoản có `permissions` + `company` riêng; thiếu quyền ⇒ từ chối **trước** khi tạo đề xuất
  (không tốn `command_id`). Không đặt ⇒ `single_tenant` (một người vận hành — giữ hành vi cũ).
- **Còn lại thì sao:** ở chế độ mặc định (một người vận hành) hoặc khi bạn đưa máy đã lưu sẵn
  endpoint+auth của mình cho người khác, **ai cầm máy là hỏi được công nợ khách**. Muốn siết:
  bật auth khi expose + khai `COPILOT_USERS` + cấp thiết bị riêng theo người.

### 6.6 Nhật ký chứa tên khách & số tiền — đừng copy đi đâu

`llm-router-audit/` (JSONL) và `idempotency-store/` nằm trong thư mục dự án và đã bị
git-ignore: chúng ghi tên khách/số tiền phục vụ đối soát. **Đừng** đặt chúng vào `/tmp`
(trên máy dev này /tmp bị xoá khi container khởi động lại → mất bằng chứng đối soát).

### 6.7 Khoá API ERPNext không nằm trong app

Khoá nằm ở phía máy chủ (`.env`), không nhúng vào APK (đã quét artifact APK: 0 lần xuất hiện).
Nếu cần thu hồi/đổi khoá, đổi ở `.env` — **không** cần cập nhật app.

### 6.11 🔄 Dữ liệu (khách, mặt hàng, tài khoản, công nợ…) lấy ĐỘNG từ ERPNext — app KHÔNG giữ bản sao tĩnh

**Câu hỏi thật:** *“Mọi dữ liệu từ tài khoản, mặt hàng, khách hàng… đến nội dung khác đều
được lấy động từ ERPNext site đúng không? Vì dữ liệu có thể thay đổi từ ERPNext nên không
thể lấy mẫu rồi tạo tĩnh trên app được.”* — **Đúng.** Đã kiểm bằng grep/lệnh, không phải
lời hứa:

| Kiểm cái gì | Kết quả thật |
|---|---|
| App Flutter có asset dữ liệu? | `apps/mobile/assets/` **không tồn tại**; `pubspec.yaml` không khai `assets:`; không có `.json/.csv` nào trong `lib/` |
| App có nhúng số tiền/tên khách? | grep mẫu số tiền (`1.500.000`…) trong `apps/mobile/lib` ⇒ **0 hit**; tên khách chỉ xuất hiện dưới dạng **câu ví dụ trong copy hướng dẫn** ("chị Lan còn nợ bao nhiêu" là gợi ý trong ô nhập), không phải dữ liệu |
| Ai đọc ERPNext? | đúng **4 file**: `client.mjs` (spawn MCP server), `copilot-server.mjs`, `readonly-guard.mjs`, `safety-gateway.mjs` — không file nào khác |
| Đọc bằng gì? | mỗi câu hỏi gọi tool ERPNext **tại thời điểm hỏi**: `erpnext_customer_list`/`_get` · `erpnext_sales_invoice_list` · `erpnext_payment_entry_list` · `erpnext_item_list` · `erpnext_stock_balance` · `erpnext_account_list` · `erpnext_doc_list`/`_get` |
| Read skill có cache không? | grep `cache\|memo` trong `src/skills/*.mjs` ⇒ **0 hit** ⇒ câu sau hỏi lại ERPNext. `knownIds` chỉ là tập ID gom trong **cùng một request**, không sống sang câu sau |
| Số tiền ở đâu ra? | **COPY** nguyên từ dữ liệu ERPNext trả về — không chỗ nào tự tính, không hằng số tiền nào trong code |

**Vậy tại sao vẫn có tình huống thấy "số cũ"?** Có đúng **3 chỗ** app *cố ý* giữ lại —
cả 3 đều có hạn, và không chỗ nào là bản sao dữ liệu nghiệp vụ:

| Chỗ giữ | Giữ gì | Hạn | Khi ERPNext đã đổi thì sao |
|---|---|---|---|
| **Session context** (trong RAM) | chỉ *đang nói về khách NÀO* (id + tên) để câu sau khỏi nói lại tên | khách **30 phút**, hoá đơn **10 phút** — hết hạn là **xoá** và app hỏi lại từ đầu | câu tiếp theo đọc lại từ ERPNext; context **hết hạn không bao giờ** được dùng để nuôi lệnh GHI (chỉ `user_selected`/`exact` trong hạn mới được) |
| **Thẻ đề xuất thu tiền** (proposal snapshot) | số tiền + khách + hoá đơn **đóng băng lúc bạn ra lệnh** | TTL **10 phút** (đổi được bằng `PROPOSAL_TTL_MS`) + **re-validate** trước khi ghi | ⚠️ **CỐ Ý**: bấm [Xác nhận] khi nợ đã đổi ⇒ app **TỪ CHỐI** (`PROPOSAL_STALE`/`PROPOSAL_EXPIRED`), **không** ghi theo số cũ và **không** tự sửa số im lặng |
| **Sổ lệnh ghi** (`idempotency-store`) | `command_id` + kết quả lệnh đã xử lý | state bền theo thiết kế | chỉ để chống ghi 2 lần — **không** chứa công nợ/tồn kho |

**Mock thì sao?** Dữ liệu mẫu (`Cash`, `Chuyển khoản`, khách "smoke…") chỉ nằm trong
**`mock-server.mjs`** — dùng cho test và cho máy chưa có credential:

- **Không có** biến `ERPNEXT_*` nào ⇒ chạy **mock** (chế độ dev).
- **Có một phần** ⇒ **lỗi cứng**, nêu tên biến còn thiếu (không im lặng dùng mock).
- **URL sai định dạng** ⇒ **lỗi cứng** (`INVALID_ERPNEXT_URL`), không âm thầm rơi về mock.

⇒ Muốn biết câu trả lời vừa rồi đọc ERPNext **thật** hay mock: xem field `erpnext_target`
(`REAL`/`mock`) trong response — **đừng đoán theo câu chữ của câu trả lời**.

**Hệ quả thực tế (điều cần nhớ):** đổi tên khách / sửa hoá đơn / nhập thêm hàng trên ERPNext
⇒ **câu hỏi sau đọc đúng ngay**, không phải build lại app, không phải deploy lại gì. Ngược lại,
app **không có** (và không nên có) danh sách khách/vật tư cài sẵn — mọi danh sách bạn thấy,
kể cả danh sách chọn khi trùng tên, đều là kết quả đọc live trong chính câu hỏi đó.

**Một "bẫy grep" nên biết:** nếu bạn grep cả repo sẽ thấy tên khách và **số tiền cụ thể**
(vd `457.875`, `171.800`) trong `mcp-erpnext/test/*` và `tests/*.py` — đó là **dữ liệu mẫu của
bộ test** (`batch-accuracy.mjs`, mock server…) để chạy được khi không có ERPNext, **không** phải
nội dung app hiển thị. Phân biệt: `src/` và `apps/mobile/lib/` = code chạy thật (0 dữ liệu cứng);
`test/` + `mock-server.mjs` = dữ liệu giả để kiểm thử.

> Tự kiểm nhanh (xem §8 để biết cách chạy):
> `grep -rn "cache\|memo" mcp-erpnext/src/skills/` → phải **rỗng** (không cache),
> và `grep -c erpnext_target <response>` → phải có (biết đang đọc thật hay mock).

### 6.12 🚀 "Đẩy code lên GitHub rồi mà **không thấy APK mới**" — vì sao?

CI build APK **chỉ chạy khi có thay đổi trong `apps/mobile/**`** (`paths` filter của
`.github/workflows/android-debug-apk.yml`). Một đợt chỉ sửa backend (`mcp-erpnext/`,
`scripts/`) hoặc tài liệu ⇒ **không** sinh APK mới, dù push thành công.

- Muốn có APK cho đợt chỉ-sửa-backend: kích tay
  `gh workflow run android-debug-apk.yml --ref change/flutter-chat-mvp`
  (hoặc sửa 1 file bất kỳ trong `apps/mobile/`).
- Thấy dấu ✅ xanh trên GitHub **chưa đủ** để tin nội dung APK đúng: agent đã tự tải
  artifact, băm `sha256` và grep marker code trong binary (lần gần nhất: run #22,
  `app-debug.apk` **165.117.508 bytes**, label app `Nghiệp Vụ AI` tìm thấy trong
  `AndroidManifest.xml`).

### 6.13 🤖 Chế độ "Phân tích bằng AI" — cần gì mới chạy được?

- **Không cần cài gì trên từng máy**: runtime tự resolve theo chuỗi
  `DSH_ENTRY` → `DSH_COMMAND` → package local → **`npx --yes @deepseek-ai/dsh@<pin>`**
  (pin đọc từ `package.json`) → `/tmp/dsh-run` (chỉ khi tồn tại). Máy mới chỉ cần
  Node + mạng; kiểm bằng `npm run dsh:check` (exit code là câu trả lời).
- Muốn biết **đang chạy nguồn nào**: `/dsh/health` trả `source` (`npx-pinned`,
  `legacy-tmp`, …) + `version` chạy `--version` THẬT (không suy luận từ sự tồn tại file).
- Chế độ AI **không bao giờ** là đường dự phòng: khi chọn "Chat thường", câu hỏi luôn
  đi đường tất định `/ask`; câu lệnh ghi trong chế độ AI bị từ chối **trước khi spawn**
  (`DSH_WRITE_BLOCKED`) nên ≤ 1 giây, không phải chờ ~20 giây mới biết bị chặn.
- Lỗi phiên AI trả kèm `log_tail` = **lý do thật** (vd `llm-router: all upstreams failed`)
  thay vì chỉ "lỗi phiên" — đọc dòng đó trước khi báo lỗi.

### 6.14 📷 Chụp ảnh hóa đơn/phiếu → app có **tự** tạo đơn/phiếu không?

- **Có chụp được, nhưng KHÔNG tự ghi gì.** Icon 📷 cạnh mic → chụp/chọn ảnh → app
  **nén ảnh trên máy** (dưới trần 1 MB của server) → gửi `/ocr` → hiện **chữ nhận dạng
  để bạn SỬA** + độ tin cậy. Bấm `[Đưa vào ô chat]` = chữ vào **ô nhập** như bạn gõ tay; **không**
  tự gửi, **không** tự xác nhận, **không** tự tạo chứng từ (kể cả khi "Tự gửi sau khi nói
  xong" đang bật — đó là setting của mic, có test riêng).
- **Độ tin cậy thấp / không đọc được chữ** ⇒ app **chỉ cho [Nhập tay từ ảnh]**, không có
  nút đưa vào chat (fail-closed: thà bắt gõ lại hơn đoán bừa). Ảnh chụp luôn được dán nhãn
  **"bản đọc THỬ"** khi server đang chạy provider giả (mock) — đừng tin số trên bản thử.
- **Muốn từ ảnh ra đề xuất đơn bán/đơn mua**: sau khi có chữ, bạn **tự chọn loại chứng từ**
  (`[Đơn bán]` / `[Đơn mua]`) trên sheet → app điền sẵn form (khách/NCC · mặt hàng · số
  lượng · đơn vị) **mọi ô sửa được** → bạn sửa → gửi → card **Xác nhận** như bình thường.
  Lý do phải tự chọn: **ảnh không có "động từ mệnh lệnh"** (đo thật: hóa đơn in ra luôn rơi
  vào đường ĐỌC), nên ý định do **bạn** quyết, không phải do OCR đoán.
- **Tiền trên ảnh chỉ để HIỂN THỊ** — giá/số tiền dùng cho chứng từ luôn lấy từ ERPNext
  (`rate_source: erpnext`), app **không** tin số tiền đọc từ ảnh.
- ⚠️ **Trạng thái (2026-09-20):** camera/OCR (C0–C2) và 3 loại **nháp** mới (`sales_order`,
  `quotation`, `purchase_order`) **kỹ thuật đã xong + đã test**, nhưng đang **chờ duyệt commit**
  và hiện **chạy mock, chưa ghi ERPNext thật**. Tới khi site thật được chạy migration thêm field
  `custom_ai_action_id` cho SO/Quotation, lệnh ghi SO thật sẽ báo `SO_CORRELATION_FIELD_MISSING`
  — đó là hành vi **đúng** (fail-closed), không phải lỗi.

---

## 7. Ranh giới hiện tại — app KHÔNG làm những việc này

- ❌ **Submit** phiếu thu (vì vậy công nợ chưa giảm), **hủy/xoá** chứng từ.
- ❌ Tạo/sửa **khách hàng**, **hóa đơn**; ghi **bán chịu / ghi nợ**.
- ❌ **Nhập/xuất kho** (mới chỉ xem tồn).
- ❌ Câu hỏi **tổng hợp theo ngày/tuần/tháng** trong **chat** — nhưng **tổng hợp NGÀY đã có** ở màn `Tóm tắt ngày` (§10). Tuần/tháng thì chưa có ở đâu cả.
- ❌ **Submit** tự động (xem §5.1): app chỉ tạo **nháp**, trừ khi bạn tự bật switch
  "Cho phép nộp phiếu thu thật" trong ⚙️ Settings.

**Những thứ TRƯỚC ĐÂY ghi là "chưa làm" nhưng NAY ĐÃ CÓ** (cập nhật 2026-09-20 — đừng đọc
bản FAQ cũ mà tưởng là tính năng thiếu):

- ✅ **Giọng nói (nhập bằng mic)**: `speech_to_text` thiết bị, tiếng Việt (`vi_VN`) — gồm cả
  tuỳ chọn "Tự gửi sau khi nói xong" (mặc định **OFF**). Không cần bộ audio 150 câu nữa.
- ✅ **Đọc câu trả lời thành tiếng (TTS)**: `flutter_tts` thiết bị, tiếng Việt — bật trong
  ⚙️ Settings (mặc định **OFF**).
- ✅ **Nhiều người dùng / phân quyền**: có (P8) — xem §6.5; chỉ cần khai `COPILOT_USERS`.
- ✅ **Chế độ "Phân tích bằng AI"** (đường agent, **chỉ đọc**): thanh chọn trên ô nhập,
  mặc định "Chat thường"; chọn AI mới gọi agent — **không bao giờ** tạo đề xuất/ghi.
- ✅ **Chụp ảnh hóa đơn/phiếu (OCR)**: đọc chữ để **bạn sửa rồi dùng** — xem §6.14; **không**
  tự tạo/sửa chứng từ.
- ✅ **Tạo NHÁP đơn bán / báo giá / đơn mua** (Trụ B, mock): từ câu hoặc từ ảnh → card xác nhận
  → `/execute` tạo **nháp** (`docstatus:0`); chưa submit, chưa ghi ERPNext thật — xem §6.14.

- ✅ Đang làm được: **đọc** công nợ · chứng từ chưa thanh toán · lịch sử phiếu thu · tồn kho,
  và **(máy móc)** ghi **nháp** phiếu thu · đơn bán · báo giá · đơn mua khi có đề xuất HIGH +
  người xác nhận.

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
| **Lệnh giống lệnh vừa ghi (fingerprint trùng)** — app cảnh báo "giao dịch trùng lặp?" | P1: xác nhận lần 2 phải kèm "tôi biết là trùng" (`dedup_ack`) — chống bấm nhầm 2 lần; vẫn **không** ghi 2 phiếu nhờ `command_id` idempotency (§3.1) |
| **Card hết hạn/tức thời đổi** — banner phân biệt: ⏰ hết hạn (quá 10 phút) vs 🔄 dữ liệu đã đổi (số nợ/khách lệch lúc bấm) | P1: tách mã `PROPOSAL_EXPIRED` (hết hạn) khỏi `PROPOSAL_VERSION_STALE`/`PROPOSAL_ENTITY_CHANGED` (dữ liệu đổi) — đọc banner là biết phải làm lại đề xuất hay kiểm tra hóa đơn |
| **Bật lại tunnel trên Mac** (`llm9000.loca.lt` trả 503 Tunnel Unavailable) | chặn verify chế độ AI qua topology thật + `npm run dsh:check` trên chính Mac — không phải lỗi app (§6.13) |
| **Thiết bị thật chưa chạy được APK** | user đã chốt "để sau" — chưa có `.github/workflows` trên remote + thiếu Android SDK trên máy build; mọi số liệu UI hiện được chứng minh bằng widget test + vòng HTTP thật, chưa có ảnh màn hình máy thật |

---

## 10. Màn `Tóm tắt ngày` (drawer) — đọc thế nào

> Không phải chat. Mở **☰ → `Tóm tắt ngày`**. Màn này **chỉ đọc**: không có nút thu/chi/
tạo/submit/xoá nào — mọi thay đổi tiền vẫn qua chat + card xác nhận.

### 10.1 Bốn mục chính nghĩa là gì

| Mục trên màn | Nghĩa | Hay bị đọc sai thành |
|---|---|---|
| `Đơn hàng (Sales Order)` | **đơn đã chốt** (submitted) hôm nay | "doanh thu" — **không**: đơn không phải tiền đã thu |
| `… — gồm nháp` | phần **nháp** của cùng mục đó, tách riêng | "đơn thật" — nháp chưa vào sổ |
| `Hóa đơn đã xuất` | hóa đơn hôm nay, **số sau VAT** | "tiền vào két" — chưa chắc khách đã trả |
| `Tiền khách trả hôm nay` | chia `Tiền mặt` / `Chuyển khoản`, và `Theo hóa đơn` / `Ứng trước (đặt cọc)` | "tổng thu = lãi" — không phải |
| `Tiền chi hôm nay` | phiếu chi ra tiền | "đủ mọi khoản chi" — có dòng ghi chú **`Chưa gồm chi qua Journal Entry`** |
| `Công nợ hiện tại (phải thu)` | nợ **tại lúc mở màn** (không phải nợ của ngày đang xem) + phần quá hạn | "nợ hôm nay" — xem §10.3 |
| `Nháp do app tạo hôm nay` | nháp do **app** tạo (có mã liên kết), không phải mọi draft trên ERPNext | "mọi bản nháp trên site" |
| `Két tiền mặt (dự kiến)` | tiền mặt đầu ngày + thu tiền mặt − chi tiền mặt | "số dư két thật" — là **dự kiến**, và **ẩn** nếu ERPNext chưa khai tài khoản két |

### 10.2 Ba thứ tuyệt đối đừng đọc sai

1. **Màn này KHÔNG có chữ "Doanh thu".** Đó là chủ ý: "doanh thu" gộp 3 thứ khác nhau
   (đơn / hóa đơn / tiền thu) vào một từ, và người bán cám hiểu sai ngay. Mỗi mục là
   **một sự thật riêng** — muốn biết tiền đã vào thì đọc `Tiền khách trả hôm nay`.
2. **`Lỗi · chưa đọc được mục này (MÃ)` KHÔNG phải 0.** Đó là "chưa đọc được", khác hẳn
   "hôm nay không có". App **không bao giờ** hiện 0 cho mục nó không đọc được (vì 0 là
   một lời khẳng định về tiền). Bấm **`Thử lại`** để đọc lại.
3. **`DỮ LIỆU CŨ` = số của lần đọc trước**, không phải số vừa xong (app đang offline hoặc
   ERPNext chưa trả lời). Số vẫn đúng tại thời điểm nó được đọc; nhãn nói rõ điều đó.

Ngày **thật sự trống** chỉ được nói khi app đọc được **đủ mọi mục**: *"Chưa có phát sinh
nào trong ngày (không bán, không thu, không chi)."* Nếu **một mục** lỗi thì app **im lặng**
chứ không dám kết luận hôm nay trống.

### 10.3 Xem `Hôm qua` — thẻ bán/thu hiện ĐÚNG số của ngày đó, CÔNG NỢ THÌ KHÔNG

- Nút **`Hôm nay` / `Hôm qua`** đổi ngày cho **bán** và **thu**: chọn `Hôm qua` thì **thẻ
  `Hóa đơn` / `Tiền khách trả` hiện số của HÔM QUA**, đúng với tiêu đề của nó.
- Nếu **hôm qua chưa đọc được** (mạng lỗi, hoặc đang đọc): thẻ ghi *"Chưa đọc được ngày hôm
  qua"* kèm nút **`Thử lại`** — **không** hiện số hôm nay thay vào. Một tiêu đề "hôm qua"
  không bao giờ đứng trên số của ngày khác.
- **`Công nợ hiện tại` luôn là số hiện tại** ở cả hai chế độ — ERPNext không lưu "công nợ
  của hôm qua" ở đường đọc này. Màn có ghi chú để bạn không đọc nhầm.
- **Dòng so sánh "so với hôm qua" đã bỏ** (2026-09-26): khi thẻ đã hiện đúng số của ngày
  đang xem thì một dòng "so với hôm qua" gắn lên số hôm qua là vô nghĩa. Muốn so hai ngày,
  tự bấm qua lại nút `Hôm nay` / `Hôm qua`.

### 10.4 Bấm vào một chỉ số

Bấm `Đơn hàng` / `Hóa đơn` / `Tiền khách trả` / `Công nợ` → mở **danh sách tối đa 10 dòng**
(theo ngày đang xem) để bạn tự đối chiếu, có **Back** quay lại. Danh sách này **cũng chỉ
đọc** — mở nó **không** gọi bất kỳ lệnh ghi nào.

### 10.5 Footer `REAL | MOCK`

Cuối màn có **nguồn dữ liệu + URL + giờ đọc**. `REAL` = đang nói chuyện với ERPNext thật;
`MOCK` = dữ liệu giả để thử. Nếu bạn thấy số lạ, **đọc dòng này trước tiên**.

---

## §11 — Nói bằng giọng nói (cập nhật 2026-09-22, P5-4)

**H: Bật "Tự gửi sau khi nói xong" thì màn hình thay đổi thế nào?**
A: Nút micro **to hơn, thành nút chính**; **ô nhập chữ vẫn còn nguyên và vẫn gõ được**.
Tắt setting thì trở lại y như cũ. App **không** thiết kế lại màn hình — chỉ đổi nút chính.

**H: Bấm lại micro và bấm "Huỷ" khác nhau ra sao?**
A: **Bấm lại micro = dừng nói nhưng GIỮ lại điều bạn vừa nói** (trong ô nhập) để bạn đọc/sửa
rồi tự bấm Gửi. **Huỷ = bỏ hẳng câu vừa nói**, ô nhập quay về đúng như trước khi bạn bắt đầu
nói. Nút Huỷ chỉ hiện khi đang nghe và khi bạn đã bật chế độ tự gửi.

**H: Vì sao app tự dừng sau khoảng 25 giây?**
A: Giới hạn cứng cho mọi lần nói, để micro không ghi lẫn câu chuyện bên ngoài (quyền riêng tư).
Hết 25 giây app dừng như khi bạn bấm lại micro — **điều vừa nói vẫn được giữ** trong ô nhập,
app không tự bỏ và **không tự gửi**.

**H: Bật tự gửi có nghĩa là app tự xác nhận luôn phiếu thu / tự ghi vào ERPNext không?**
A: **Không.** Tự gửi chỉ gửi **câu hỏi** của bạn đi (giống bấm Gửi). Mọi đề xuất ghi dữ liệu
(phiếu thu, đơn, báo giá) vẫn phải bấm **[Xác nhận]** bằng tay — không có đường nào tự chạy.

**H: Sau khi bấm xác nhận, thấy nhãn vàng "NHÁP" nghĩa là gì?**
A: Phiếu **đã tạo trên ERPNext nhưng CHƯA được nộp** (công nợ khách chưa giảm). Ngay dưới đó
app ghi rõ phải liên hệ ai:
- *"không có quyền nộp… liên hệ quản trị viên ERPNext"* ⇒ tài khoản thiếu quyền Submit.
- *"Kỳ kế toán đã khoá… liên hệ kế toán"* ⇒ ngày đó đã khoá sổ.
- *"Chứng từ cần được duyệt trước khi nộp"* ⇒ phiếu đang ở bước duyệt trong ERPNext.
Nhãn **xanh "ĐÃ NỘP"** mới là đã nộp thật. (Có thêm công tắc **"Cho phép nộp (submit)
Payment Entry trên ERPNext"** — TẮT = chỉ tạo nháp.)

**H: Phiếu thu ghi vào ngày nào?**
A: **Ngày tại tiệm lúc bạn HỎI** (không phải lúc bấm xác nhận, không phải giờ máy chủ) — nên
một đề xuất tạo lúc 23:59 và bấm xác nhận lúc 00:01 vẫn vào đúng ngày cũ. Đề xuất quá cũ —
quá 10 phút, hoặc ngày lệch quá ±1 ngày — bị **từ chối và không ghi gì**, app nói lý do.

## §12 — Tạo khách mới (M1 — ✅ đã có trên app từ 2026-09-25, commit `7ca1409` + `8a692f1`)

**H: Nói "thêm khách chị Hoa" là app tạo khách luôn?**
A: KHÔNG. Luồng thiết kế là **đề xuất + form + nút [Tạo khách mới]** — AI không bao giờ tự tạo. VÀ tính năng này **đã có trên app** (từ 2026-09-25): lượt `/ask` đụng khách chưa tồn tại sẽ hiện **thẻ tạo khách** thay cho thẻ đề xuất — một lượt chỉ có **MỘT** thẻ (không bao giờ hai nút tạo trên cùng một tin nhắn) — hoặc bạn nói thẳng *"thêm khách chị Hoa"*.

**H: Trùng tên/SĐT thì sao?**
A: Thiết kế: **từ chối tạo bản sao** và nêu khách đã có (kèm id) — kể cả tên "gần giống" ("Lan" vs "Nguyễn Thị Lan") cũng dừng để bạn quyết. Trên ERPNext thật, hai khách trùng tên hoàn toàn hợp lệ — nên lớp chặn nằm ở app, không phải ERPNext.

**H: Tạo khách xong app tự lập đơn bán luôn không?**
A: KHÔNG — chỉ trả id khách; câu tiếp theo của bạn quyết định (đặt hàng/thu tiền vẫn phải đề xuất + bấm xác nhận như mọi lệnh ghi).

**H: Sao trên site chưa có field `custom_ai_action_id` cho Customer thì không tạo được?**
A: Field đó là **chống trùng phía server** (lệnh ghi hai lần chỉ tạo một khách). Thiếu nó mà vẫn cho ghi ⇒ mất lớp chống trùng cuối — app từ chối có chủ đích (khác với lỗi hệ thống).

**H: Tại sao trước đây thêm khách LUÔN lỗi?**
A: Hai lỗi thật đã đo trên site: (1) app hardcode `customer_group: "Múa"` mà site **không có** nhóm đó ⇒ ERPNext trả LinkValidationError cho **mọi** lần tạo (nay phân loại được resolve từ chính site, fail-closed); (2) site có một khách tên đúng chữ **"A"**, và luật chống trùng cũ so bằng `name.includes()` ⇒ *"khách test app m1"* chứa chữ "a" nên bị coi là trùng ⇒ **chặn mọi tên**. Nay so khớp theo **TỪ nguyên vẹn**.

## §13 — Gửi hoá đơn điện tử từ file (`.xml` / `.pdf`) — 2026-09-25

**H: Gửi file hoá đơn vào app thì app có tự tạo đơn mua không?**
A: KHÔNG. File chỉ đổi **cách nhập liệu**: app gửi nguyên file cho server, server đọc ra **form** (nhà cung cấp theo MST, dòng hàng, số tiền trên file **chỉ để đối chiếu**), bạn sửa form rồi câu lệnh vẫn đi đường cũ: `/ask` → đề xuất → **[Xác nhận]** → **NHÁP**. Không có đường ghi nào mới, **giá luôn lấy từ ERPNext**, không lấy từ file.

**H: App có đọc file hoá đơn trên máy không?**
A: KHÔNG — có 2 test "tripwire" quét mã nguồn app để đảm bảo **không** có bộ đọc XML hay PDF nào trên máy. Lý do: hai cách đọc cùng một tài liệu là nguồn của "người dùng xác nhận một đằng, file nói một nẻo". `.xml` gửi dạng **text**, `.pdf` gửi dạng **byte**.

**H: Gửi cả `.xml` và `.pdf` cùng lúc?**
A: Bị từ chối (`EINVOICE_INPUT_AMBIGUOUS`) — đó là hai cách **ĐỌC của cùng một** tài liệu, app phải biết bạn muốn cách nào. Bạn chọn file nào thì đi đường đó, không đoán, không fallback.

**H: Hoá đơn giấy chụp bằng điện thoại (PDF scan) gửi vào được không?**
A: ĐƯỢC nhận nhưng **bị từ chối đọc**: server trả **422 `EINVOICE_PDF_NO_TEXT`** và nói rõ *"PDF không có lớp chữ đọc được (bản scan/ảnh) — dùng nút camera…"*. Đây là **cố ý**: thà chỉ bạn sang nút camera (đường OCR) còn hơn bịa ra một cách đọc. PDF cần có **lớp chữ** (xuất từ phần mềm hoá đơn, không phải ảnh chụp).

**H: Gửi cùng một tờ hoá đơn hai lần có tạo hai đơn mua không?**
A: KHÔNG (từ 2026-09-25) — lần thứ hai bị **từ chối 409 kèm tên đơn mua đã tạo**, để bạn mở đơn cũ mà sửa thay vì tạo bản trùng. Khoá nhận dạng = **loại chứng từ + MST/đối tác + số hoá đơn + ngày**, và **số hoá đơn không đi qua câu nói** (pipeline đọc "00049" thành 49đ) mà đi kèm riêng. Lưu ý: **hoá đơn bán (`sales_invoice`) chưa có lớp này**.

**H: Nút đó tên gì, ở đâu?**
A: **"HĐĐT"** cạnh nút camera (cả 2 layout), chọn được `.xml` **và** `.pdf`.

## §14 — "Thu tiền cho chị Lan 2 triệu" bấm xác nhận hai lần thì sao? (P9-D, 2026-09-25)

**H: Tôi đã làm một phiếu thu NHÁP 1.000.000đ cho chị Lan (chưa nộp). Hỏi lại "thu tiền cho chị Lan 2 triệu" thì app đề xuất bao nhiêu?**
A: **Phần CÒN LẠI** — trước đây là 2.500.000 (như nháp không tồn tại), nay là **1.500.000**, kèm cảnh báo *"đã có phiếu thu NHÁP chưa submit (PE-…) phủ SINV-… 1000000đ — đề xuất dưới đây là phần CÒN LẠI"*. Vì sao quan trọng: ERPNext **chỉ giảm nợ khi NỘP phiếu**, nên nháp là "tiền vô hình" — bấm xác nhận lần hai sẽ dựng **phiếu thứ hai cùng trả một khoản nợ**.

**H: Nếu tôi nộp (hoặc huỷ) phiếu nháp đó ở giữa chừng, sau khi app đã đề xuất?**
A: Lần bấm **[Xác nhận]** sẽ bị **từ chối** (`PROPOSAL_STALE`) và **không ghi gì** — app đọc lại đúng phép tính lúc xác nhận. Bấm lại để lấy đề xuất mới.

**H: Con số "còn nợ" trong câu trả lời giờ là số nào?**
A: **Số sau khi trừ phiếu nháp đang chờ** (số bạn thực sự còn phải thu/trả). Số GL nguyên văn vẫn được giữ trong đề xuất (`raw_outstanding_vnd`) và **cả hai** đều được nêu khi chúng khác nhau — nên khi đối chiếu sổ sách vẫn thấy đủ cả hai.

## §15 — Vì sao có việc phải duyệt riêng, không "AI tự làm hết"?

**H: Lần này có commit nào phải duyệt riêng không?**
A: Có — **P9-D (`f82f656`)** phải duyệt riêng vì chạm **vùng SỐ TIỀN** (số dư công nợ hiển thị + số tiền ghi vào chứng từ); message commit mở đầu bằng `⚠️ VÙNG SỐ TIỀN`. Nguyên tắc: code chạm tiền **không tự commit, không tự ký duyệt**.

**H: 3 lỗ hổng A3 đã đo, vì sao chưa sửa luôn?**
A: Vì chúng chạm **định danh tài liệu** (`invoice_no`) và **khoá chống trùng** — sửa sai sẽ tạo chứng từ trùng hoặc gắn sai tờ hoá đơn. Đã đề xuất cụ thể (`.plan/next4/A3-result.md` §9.5) và **chờ bạn quyết**.

## §16 — Fix "Hôm qua" xong rồi, còn chỗ nào cần để ý? (2026-09-26, commit `ed79f77`)

**H: Fix "Hôm qua" (`ed79f77`) đã sửa hết chưa?**
A: **Số tiền đã đúng** rồi (xem §10.3), nhưng còn **2 chỗ CHƯA sửa** — cố ý dừng vì chạm **vùng SỐ TIỀN**, chờ bạn quyết:

- **M1 — Kéo-làm-mới (pull-to-refresh) khi đang xem "Hôm qua":** chỉ đọc lại **HÔM NAY**, không làm mới ngày hôm qua đang xem. Nếu nghi ngờ số hôm qua cũ, tạm thời bấm qua lại nút `Hôm nay` / `Hôm qua` để đọc lại.
- **M2 — Nút `Thử lại` trên thẻ lỗi khi đang xem "Hôm qua":** đọc lại **HÔM NAY**, không phải ngày đang xem.

Cả hai là **ranh giới đã khai**, không phải bug ẩn: đã ghi trong `result74.txt` §3 (Code Review) và `checklist.md`.

**H: Vì sao vẫn có chỗ làm mới sai ngày dù vừa sửa thẻ?**
A: Vì fix chỉ đổi **dữ liệu mà thẻ hiển thị** (`_yesterday`), chưa đồng bộ **mọi đường reload** (`onRefresh` và `onRetry` vẫn gọi `_load(force)` cho ngày hôm nay). Bài học đã vảo skill (`erpn-verify-first`): *đổi dữ liệu một thẻ ⇒ phải rà **MỌI** đường refresh/retry, không chỉ đường hiển thị.*

**H: Có phải AI tự sửa xong rồi tự báo "xong"?**
A: Không. Sửa xong thẻ (số tiền) + test xanh + review thủ công, rồi **dừng** ở M1/M2 để hỏi bạn — vì đây là vùng số tiền. Không tự commit phần chưa quyết.

**H: Sao phiên này không có bằng chứng chạy công cụ review tự động (OCR / AgentMemory)?**
A: Đúng — phiên này **không tool review nào khả dụng** (OCR `open-code-review` · AgentMemory · `codebase-memory-mcp` · `cocoindex-code` · Simplenote MCP đều không gọi được). Vì vậy Code Review chạy **thủ công** qua `git diff`/grep, và không ghi được bài học cross-project vào Simplenote/AgentMemory. Đã ghi rõ trong `result74.txt` §3 + handoff để phiên sau biết.
