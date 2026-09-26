# features.md — ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Danh sách tính năng hiện tại và tương lai. Cập nhật khi hoàn thành 1 nhóm tính năng lớn.
Bằng chứng code + test: `resultNN.txt`, `.plan/phases/phase-0N-result.md`, `checklist.md`.

## next3 — Đang làm / tương lai (2026-09-23)

**M1 — Tạo khách mới bằng nút (WRITE #10, master data — ✅ ĐÃ XONG + E2E THẬT ĐẠT, commit `7ca1409`):**
- **Luồng thiết kế**: `thêm khách <tên>` hoặc khách chưa có khi bán/thu ⇒ app **đề xuất** + form Tên*/SĐT/MST ⇒ user bấm **[Tạo khách mới]** ⇒ qua Safety Gateway ⇒ Customer record **thật** trên ERPNext ⇒ trả id, KHÔNG tự tạo đơn/phiếu thu.
- **An toàn**: pre-check trùng (tên chính xác / SĐT / MST / tên gần giống `⊂`) — trùng ⇒ **từ chối + nêu khách đã có, không clone**; field `custom_ai_action_id` trên Customer chống trùng server-side — site chưa có field ⇒ executor từ chối ghi.
- **Trạng thái đo được (2026-09-25)**: backend (contract + skill + route + offer + mock) ✅ · **Flutter form/card/nút ✅** · test suite riêng **30/30** ✅ · falsify **16/16** ✅ · **bỏ hardcode `customer_group: "Múa"`** (site không có group đó ⇒ **mọi** create hỏng — mock dễ dãi hơn site nên không thấy) · **fix fuzzy theo TỪ** (site có customer tên đúng chữ "A" ⇒ `name.includes(have)` chặn **mọi** tên chứa chữ "a") · **E2E THẬT**: `/ask` → `/execute` → Customer thật **"Khách Test App M1"** → hỏi công nợ OK → đếm site 123→**124** ✅. Còn lại: checklist máy thật 28 case (cần APK).

**HĐĐT XML — upload file trong app (A2, 2026-09-25):** nút **"HĐĐT XML" cạnh nút camera** (cả 2 layout)
⇒ chọn file `.xml` nhận từ NCC ⇒ app **không đọc file**, chỉ gửi nguyên văn cho server
(`POST /input/einvoice`) ⇒ hiện **form slots của chính kênh camera** (NCC resolve theo **MST**, dòng hàng
khớp item thật, số tiền trên file **chỉ để đối chiếu**) ⇒ user sửa ⇒ gửi câu qua `/ask` ⇒ đề xuất đơn mua
⇒ **[Xác nhận]** ⇒ **NHÁP**. **Giá luôn từ ERPNext**, MST không có trên site = **cảnh báo + chọn đối tác đã
có** (KHÔNG tự tạo nhà cung cấp/mặt hàng). Trạng thái: ✅ **ĐÃ COMMIT `8a692f1`** (2026-09-25) — code + 20 test (**Flutter 310/310** · analyze 0); còn test tay máy thật. Bằng chứng: `.plan/next4/flutter-xml-upload-result.md`.

**HĐĐT PDF có lớp chữ (A3, 2026-09-25 — ✅ ĐÃ COMMIT `7ca1409`, nút chọn file ở `8a692f1`):** cùng MỘT nút HĐĐT,
giờ nhận luôn `.pdf` ⇒ app gửi **nguyên byte** (`{pdf_base64, kind}` — KHÔNG parse trên máy) ⇒ server đọc lớp chữ
bằng bộ đọc thuần/đồng bộ/0 dependency (`src/einvoice/einvoice-pdf.mjs`: FlateDecode bằng stdlib `zlib` ·
**ToUnicode CMap** cho font CID/Type0 để ra dấu tiếng Việt · ngắt dòng theo **vị trí y**) ⇒ trả **đúng schema slots
như kênh XML** ⇒ form sửa được ⇒ `/ask` ⇒ đề xuất ⇒ **[Xác nhận]** ⇒ **NHÁP**. Nguyên tắc: **một con số KHÔNG đọc
được thì KHÔNG được điền vào** (dòng `qty × rate ≠ amount` ⇒ từ chối cả request). Từ chối **theo tên**:
`NOT_A_PDF · TOO_LARGE · ENCRYPTED · NO_TEXT · COMPRESSED_OBJECTS · TEXT_UNMAPPED · UNSUPPORTED_FILTER · BROKEN`.
**PDF là ảnh scan ⇒ 422 `EINVOICE_PDF_NO_TEXT`** + câu tiếng Việt **trỏ người dùng sang nút camera** (không bịa số).
Gửi cả `xml` lẫn `pdf_base64` ⇒ 400 `EINVOICE_INPUT_AMBIGUOUS` (hai cách ĐỌC của một tài liệu).
**Đo trên site THẬT (chỉ đọc)**: PDF ToUnicode → **200**, `source=einvoice_pdf`, NCC resolve **theo MST** ra NCC thật,
2 dòng khớp item thật kho, không lộ bề mặt ghi. ⚠️ **3 lỗ hổng đã đo, CHƯA sửa** (review vòng 2 — `.plan/next4/A3-result.md` §9.5):
`invoice_no` rác từ nhánh regex `so` trần (khớp "mã **số** thuế") — **chạm khoá chống trùng của B** · `inflateSync`
KHÔNG trần đầu ra (đo 294×, RSS +541 MB) · `readDate` lấy ngày đầu tiên không nhãn (sai khoá chống trùng).

**Chống trùng theo TỜ hoá đơn (`business_doc_key`, next3/B — 2026-09-25):** cùng một tờ HĐĐT gửi 2 lần
(qua file XML) ⇒ **1 nháp**, lần thứ hai bị **TỪ CHỐI 409 kèm tên đơn mua cũ** (mở đơn cũ để sửa). Khóa =
`loại chứng từ + MST/party + số HĐ + ngày`, sinh ở server, **không** chứa số tiền, **không** đọc từ câu nói
(số HĐ đi **ngoài** câu vì pipeline đọc `00049` thành số tiền). Khác hẳn 2 lớp sẵn có: `custom_ai_action_id`
chống **cùng một lệnh** xác nhận 2 lần, còn `business_dedup` chỉ **cảnh báo** trong 15 phút. Trạng thái: ✅ **ĐÃ COMMIT `7ca1409`** (2026-09-25) — Node **10/10** · falsify **8/8 RED** · Flutter **310/310**;
**migration `custom_business_doc_key` trên Purchase Order ĐÃ CHẠY + VERIFY** trên site thật (tạo ⇒ `VERIFIED type=Data
unique=1 search_index=1`; chạy lại ⇒ **no-op**; kiểm chứng độc lập bằng REST thấy cột trong meta; probe chỉ-đọc ⇒
`field_unavailable:false` ⇒ **gate đã mở**). Giới hạn: đường BÁN chưa có lớp này; kênh ẢNH chưa phát định danh.
Bằng chứng: `.plan/next4/B-dedupe-result.md`.

**Phiếu thu/chi NHÁP phủ bớt nợ (P9-D, 2026-09-25 — ✅ ĐÃ COMMIT `f82f656`, commit RIÊNG vì vùng SỐ TIỀN):**
sau khi đã có **phiếu thu/chi NHÁP chưa submit** cho một khoản nợ, `/ask` lần sau **KHÔNG** đề xuất lại đúng số tiền
đó nữa. Vì sao cần: ERPNext **chỉ giảm nợ khi SUBMIT**, nên nháp là "tiền vô hình" — đo thật cho thấy nháp 1.000.000
vẫn để `/ask` đề xuất **2.500.000** hai lần ⇒ bấm xác nhận lần hai sẽ dựng **phiếu thứ hai cùng trả một khoản nợ**.
Nay số đề xuất là **phần CÒN LẠI** (sau khi trừ phiếu nháp), cảnh báo **nêu tên phiếu nháp** để biết đi submit/hủy phiếu nào,
và nếu phiếu nháp bị submit/hủy ở giữa chừng thì lần xác nhận bị **từ chối** (`PROPOSAL_STALE`) chứ không ghi im lặng.
Vẫn giữ số GL nguyên văn để đối chiếu (`raw_outstanding_vnd`). Không auto-submit, không thêm đường ghi nào.
Bằng chứng: `.plan/next4/P9D-result.md`.

**Tương lai (chưa làm):** **sửa A3 H1/M1/M2** (định danh `invoice_no` · trần inflate · `readDate` — chờ user quyết) ·
M2/M3 Supplier/Item create (ngoài M1) · mở rộng `business_doc_key` sang đường BÁN (khai ở `sales_order.create` + migrate Sales Order) ·
kênh ẢNH phát định danh (`source_document`) · falsify riêng cho A3 · giải nén ObjStm · vòng XML THẬT 2 lần cùng file.

**Cấm (giữ nguyên):** OCR/XML/LLM tự tạo Customer · Supplier/Item trong M1 · sửa/xoá Customer · JE/bypass gateway · Zalo/Viber connector.

## Đã hoàn thành thêm — WRITE skills nháp (plan3 + P9, 2026-09-22)

- **5 đường GHI đang có, tất cả đều là NHÁP + phải user bấm xác nhận + qua Safety Gateway**: phiếu thu (`payment.create`) · đơn bán (`sales_order.create`) · báo giá (`quotation.create`) · đơn mua (`purchase_order.create`) · **phiếu giao hàng (`delivery.create`)**.
- **Phiếu giao hàng (P9-A2)**: nói *"giao hàng cho Lan"*, *"giao 5 bao cám gà cho Lan"* (dạng lệnh này trước đây bị trả lời bằng **số tồn kho** — đã đóng) hay *"xuất hàng cho …"* ⇒ app tìm **đơn bán ĐÃ SUBMIT** của khách rồi đề xuất **phiếu giao NHÁP** theo đúng dòng hàng của đơn đó (chỉ giao được phần **còn chờ giao** = `qty − delivered_qty`; nêu vượt ⇒ từ chối chứ không kẹp số). Khách có **nhiều đơn** ⇒ **không tự chọn đơn**, hỏi lại. Phiếu **KHÔNG tự submit** (submit mới trừ kho — làm trên ERPNext); câu **hỏi** (*"đã giao chưa"*, *"giao bao nhiêu"*) vẫn là câu đọc, không mở thẻ ghi.

## Đã hoàn thành thêm — plan5 (2026-09-22)

- **Phân loại lỗi submit + hướng dẫn xử lý**: khi ERPNext từ chối nộp phiếu thu, app nói rõ **ai cần liên hệ** (quyền Submit · kỳ kế toán đã khoá · chờ duyệt workflow), message gốc của ERPNext vẫn hiện nguyên văn.
- **Badge NHÁP / ĐÃ NỘP** trên thẻ đề xuất + dấu đầu dòng kết quả đổi theo cùng trạng thái (⚠️ khi submit bị từ chối, trước đây luôn là ✅).
- **Lay chọn ngày phiếu thu** nay đóng băng theo lúc hỏi (không theo lúc bấm xác nhận) và **được kiểm lại server-side** trước khi ghi.
- **Voice-first (tuỳ chọn, mặc định TẮT)**: bật "Tự gửi sau khi nói xong" ⇒ nút micro thành nút chính, to hơn, **ô nhập chữ vẫn luôn hiển thị và dùng được**; có nút **Huỷ** bỏ câu vừa nói (khác bấm lại micro — vẫn giữ điều vừa nói để đọc/sửa rồi tự bấm Gửi); giới hạn **25 giây** mỗi lần nói.
- Không đổi: voice vẫn **chỉ** là cách nhập — tự gửi chỉ đi qua `/ask`, **không bao giờ** tự xác nhận đề xuất hay ghi ERPNext.

**Chưa làm (P5-5, backlog):** push-to-talk · đo tiếng ồn/fallback banner · VAD theo loại nghiệp vụ · xem trước 500ms trước khi tự gửi · draft aging.

**Ý tưởng sản phẩm (1 câu):** nói chuyện với ERPNext như nói chuyện với một nhân viên kế toán/bán hàng —
`"Anh Nam vừa trả 10 triệu tiền cám"` → AI tra khách, kiểm tra công nợ, đề xuất phiếu thu, chờ user xác nhận, rồi ghi vào ERPNext.

**Trạng thái tổng (mới nhất 2026-09-18):** **phases2 P0–P8 ĐÃ ĐÓNG và commit hết** — P0 `b4acdb1` · P1 `ee93f13` · P2 `33ff725` · P3 `c38e4ea` · P4 `d7e9ba9` · P5 `6318eca` · P6 `9b54d35` · P7 `3e6240a` · P8 `90401f0` · P10-slice `7cb2798`/`21d77ff`/`d6295ab` (tất cả đã push, branch `change/flutter-chat-mvp` sạch). Suite cuối: **Python 62 · Node 267 · Flutter 107 · analyze 0**. Sau đó: **bugfix P6 locale** `77e2b57` (+docs `bbca7ca`) — APK CI run `35367603981` đã build lại và **đã xác minh binary chứa bản fix**. Còn lại: **P9** (skill mới — gate ĐÃ MỞ, chờ lệnh user) · P10 full (DR drill/dashboard/load test — infra) · human gates (P8 deployment credentials, P6 smoke mic máy thật).

**Trạng thái tổng (lịch sử MVP):** xong **Phase 0 + 1 + 2 (read-only, ERPNext thật, **accuracy thật 18/18 = 100%** — `result9.txt`) + cầu nối dsh + **Flutter chat MVP** (`result7.txt`, commit `590b1b2`). 6 commits đã push GH; **CI XANH 2 lần liên tiếp** (run #2 `4c5bd26`, run #3 `c3d74c3` — result10/11). **Endpoint /ask có bảo mật bind + basic auth, verify thật 401→200→269.000đ** (`result11.txt`). **Phase 5: sign-off đã ký (không scrub) + LLM Router đã nối upstream thật — Gemini verify generate 200, Zen billing-blocked, E2E dsh flaky do free tier** (`result15.txt`). Chưa có STT; chờ user: dán 3 giá trị GitHub Settings + chọn đường endpoint + cài APK thiết bị thật + quyết định upstream LLM (result15).

---

## Hoàn thành

### Phase 0 — Foundation & Verification (không code)
- Verify mọi external dependency trước khi viết dòng code nào (bài học từ `plan1_review1.md` chứa repo bịa)
- Chốt **Agent Runtime = DeepSeek Harness (dsh)** trên VPS chạy chung ERPNext; MCP client built-in (`@deepseek-ai/dsh-mcp-client`)
- Chốt **2 trigger tách lớp khỏi dsh**: (1) có ≥2 user cần credential khác nhau chạy đồng thời; (2) dsh breaking change làm hỏng production
- Chốt pin `@casys/mcp-erpnext@3.0.4` + transport **stdio** (né breaking change HTTP của 3.0.0)
- Chốt thứ tự STT: Web Speech API → Cohere Transcribe → Whisper API → PhoWhisper/whisper.cpp CPU
- Chốt **Xây mới** Vietnamese NLP + LLM Router (không có OmniRoute/9Router/TAXPRO trên máy)
- Gate cứng **Mandatory Sign-off** cho PII/free tier (Nghị định 13/2023) trong `phase-05`

### Phase 1 — Vietnamese NLP Pipeline (Python, `src/vietnamese_nlp/`)
Lớp chuẩn hóa chạy **TRƯỚC** LLM, cố định bằng code chứ không phụ thuộc prompt engineering.

- **Number normalizer → integer VND.** Hỗ trợ: `"mười triệu"`, `"10 triệu"`, `"10tr"`, `"1tr5"`, `"230k"`, `"1k5"`, `"mười củ"`, `"một chục triệu"`, `"hai trăm ba mươi nghìn"`, `"một trăm hai mươi lăm triệu"`, `"500 ngàn"`, `"0.5 triệu"`, `"230.000"`, `"1,500,000"`, `"1 500 000"`, `"10 triệu 500 nghìn"`, `"2 triệu rưỡi"`, `"nửa triệu"`, `"một trăm linh/lẻ năm nghìn"`, `"1 tỷ 200 triệu"`, hậu tố `đồng`/`đ`/`vnd`/`₫`
- **Fail-safe (điểm quan trọng nhất):** amount chỉ sinh khi có bằng chứng mạnh — big scale word, ≥4 chữ số, hoặc hậu tố tiền tệ. `"Bác Hai"`, `"hai trăm"`, `"anh Nam trả 10"`, `"2 triệu 500"` → **không** sinh số, thay vì đoán sai
- **Tiếng lóng miền Nam (thêm 2026-09-13):** `trẹo` = `chai` = triệu → `"hai trẹo"` = 2.000.000, `"một trẹo rưỡi"` = 1.500.000
- **Shape guard — “trông giống số nhưng không phải tiền” (thêm 2026-09-13):** SĐT (`0` + 9–11 số), năm 1900–2099 trần, số sau từ định danh (`nhà`/`mã số`/`số lượng`), và `củ`/`chai` khi là **củ cải / chai nước** (vật thật, không phải triệu). Mọi guard fail theo hướng **không có amount**
- **Chỉ guard từ định danh KHÔNG mơ hồ** — danh từ vừa là định danh vừa là từ thường (`đơn`, `bàn`, `lô`…) **cố ý** không guard, để `"mỗi đơn 5000"` vẫn ra 5000
- **Hậu tố tiền tệ DÍNH LIỀN số (fix 2026-09-13):** `"2000đ"`, `"5000vnd"`, `"500đồng"`, `"2tr5đ"`, `"230.000đ"`, `"1 500 000đ"` — tất cả parse đúng (trước fix: None, và `"1 500 000đ"` im lặng trả **1500**)
- **Chặn merge rác (cùng đợt):** `"2tr5k"`, `"2tr50"`, `"2024năm"`, `"2024rưỡi"`, `"2024linh"`, `"500năm"` → **không có amount** thay vì đoán (`"2tr5k"` trước fix nhân đột biến thành 2.500.000.000)
- **Kinship stripper** — 21 title (Anh/Chị/Em/Cô/Chú/Bác/Ông/Bà/Cậu/Dì/Mợ/Thím/Dượng/Bố/Ba/Má/Mẹ/Con/Cháu/Cụ/Thầy), trả title ra riêng để dùng cho context/gender
- **Birth-order nickname là TÊN, `mươi` thì không** — `"Bác Hai"`, `"Cô Ba"`, `"Thím Mười"` strip đúng; nhưng `"ba mươi nghìn"` không bị hỏng
- **Domain synonym mapper** — 10 nhóm intent: `payment`, `credit_sale`, `receivable`, `purchase`, `delivery`, `sale`, `stock_level`, `unit_price`, `advance_payment`, `offset`
- **Sản phẩm KHÔNG bị map thành intent** — `"cám heo"` giữ nguyên (là Item cần tra ERPNext, không phải intent)
- **Quantity extractor** — `20 bao`, `25 ký`/`kg`, `tấn`, `tạ`, `yến`, `thùng`, `gói`, `lọ`, `hộp`, `cái`, `chiếc`, `bịt`, `can`, `khối`, `lít`
- **`normalize(text) -> NormalizedResult`** với `text` sạch, `amount`, `amounts`, `money_matches` (có offset), `quantities`, `titles`, `intents`, `synonyms`
- **CLI độc lập** — `python -m vietnamese_nlp --pretty "..."` → JSON; đọc stdin hoặc `--file`
- **Zero runtime dependency** (stdlib thuần) — chạy trên VPS cạnh ERPNext/dsh không thêm gì
- **Corpus 3 miền** (Bắc/Trung/Nam) **259 money** (37 negative) + 30 kinship + 45 synonym case, và **challenge set 11 case** ghi rõ dạng chưa hỗ trợ
- **58/58 test PASS** · **money accuracy 259/259 = 100%** trên corpus 3 miền

### Phase 2 (read-only, chạy trên mock ERPNext) + Cầu nối dsh — 2026-09-13/14 (`result4.txt`, `result5.txt`)
- **Skill layer** (`mcp-erpnext/`): readonly-guard chặn mọi write verb ở tầng CODE (không phụ thuộc prompt), whitelist 12 tool đọc THẬT `erpnext_*`, chống bịa ERPNext ID (`assertKnownId` — ID chỉ đến từ tool result), dữ liệu ERPNext luôn bọc `markUntrusted`
- **Router intent** — bảng từ khóa cố định, KHÔNG embedding; 4 nhóm skill business-level (customer / sales / payment / inventory)
- **Cầu nối Python HTTP** (`nlp_service/server.py`): `normalize()` expose trên 127.0.0.1 (stdlib, không thêm dependency), `/health` + `/normalize`, lỗi trả JSON sạch không traceback
- **Copilot MCP server** (`copilot-server.mjs`): tool `copilot_ask` chuẩn MCP stdio cho dsh đăng ký — pipeline đầy đủ normalize → route → ERPNext(mock) → câu trả lời tiếng Việt; số tiền COPY từ dữ liệu ERPNext, không chỗ nào tự tính
- **File đăng ký dsh** (`dsh.cordis.patch.yml`) đúng format example chính thức + driver transcript `scripts/ask-copilot.mjs`
- **25/25 node --test PASS** (gồm 6 E2E spawn thật 3 process) — chưa gồm chân dsh Web UI (dsh chưa cài trên máy, chưa có LLM key/runtime)

### Nối ERPNext thật + dsh smoke — 2026-09-14 (`result6.txt`)
- **Env-switch real/mock** (`pickServerScript`): đủ 3 biến `ERPNEXT_*` → spawn server 3.0.4 thật; thiếu → mock; cấu hình sai → hard error (không bao giờ âm thầm rơi về mock). 5 unit test pin contract này
- **ERPNext thật qua ngrok**: probe 125 tools + customer_list + sales_invoice_list trả dữ liệu thật; auth `token key:secret` xác nhận từ source package trước khi gọi
- **dsh thật (0.1.5-rc.1) chạy headless** với patch copilot + mock LLM OpenAI-compatible (`scripts/mock-llm.mjs`, không dependency): transcript thật — *"Khách smoke 2026-09-13-p1done còn nợ 269.000đ (3 hóa đơn chưa trả)"* khớp đúng 3 hóa đơn thật (hóa đơn outstanding=0 bị loại đúng)
- **resolveCustomer chống trùng tên**: ưu tiên candidate khớp ĐÚNG 1 khách (longest-prefix-first), câu trả lời mang cảnh báo khi trùng — 4 unit test

### Đo accuracy thật + đợt fix Phase 2 — 2026-09-14 (`result9.txt`)
- **Batch accuracy 18 câu tiếng Việt qua `answerQuestion()` với ERPNext THẬT** (đúng exit-criteria phase-02): 27.8% → 61.1% → **100%** sau 2 vòng fix; expected lấy từ ground-truth dump cùng ngày (26 khách / 37 hóa đơn / 29 phiếu thu / 14 dòng tồn kho)
- **5 nhóm lỗi mà unit xanh không bắt được** (đã fix, có unit test bám theo):
  1. Router: nhóm customer (từ khóa rộng) check trước specific → nuốt câu hỏi hóa đơn/kho; + `"khách hàng"` bị keyword `hàng` ăn → specific trước customer + replaceAll
  2. nameCandidates chỉ sinh tiền tố → tên khách giữa câu không bao giờ được thử (dù tồn tại trong DB) → mọi token substring, dài nhất trước + fetch list 1 lần/câu
  3. Kinship strip title giữa câu phá tên thật `"Công trình nhà ông An"` → chỉ strip cụm xưng hô đầu câu
  4. Payment tool: 417 (site chặn field `currency`) → fallback `erpnext_doc_list`; rồi đòi `party_type` khi lọc theo party → thêm param
  5. Inventory trả cả kho → lọc theo item hỏi (word-prefix dài nhất, 2 passes)
- **Fail-safe củng cố**: ambiguous-fallback chỉ nhận fragment ≥ 2 từ; khách không tồn tại / fragment 1 từ khớp 19 khách → trả null + lý do, KHÔNG chọn hộ khách (an toàn tiền đo được bằng chính batch)
- Test hermetic: E2E test strip `ERPNEXT_*` khi spawn (env leak làm mock chạm nhầm server thật)

### Endpoint /ask bảo mật + APK cài được + kịch bản thu âm — 2026-09-14 (`result10.txt`, `result11.txt`)
- **Bind policy + basic auth** (`http-ask.mjs`): non-loopback BẮT BUỘC `ASK_USER`/`ASK_PASSWORD` (server TỪ KHỞI ĐỘNG nếu thiếu); interface public cần thêm `ASK_ALLOW_PUBLIC=1` (quyết định tường minh); so sánh timing-safe; auth phủ cả `/health`. Flutter client gửi Basic auth qua dart-define (không fallback âm thầm anonymous)
- **Verify thật trên interface mạng**: 401 không auth → 200 có auth → `POST /ask` trả đúng 269.000đ qua ERPNext thật. ⚠️ Port 8788 bị cloud firewall hosting chặn từ internet (không phải lỗi code) — 3 đường chọn: Tailscale (khuyến nghị, đã cài chờ login) / hosting mở port / ngrok từ VPS
- **CI build APK cài được**: dart-define `COPILOT_BASE_URL` + auth từ repo Variables/Secret — không hardcode endpoint vào repo (chờ user dán 3 giá trị; token hiện tại chỉ-đọc)
- **Kịch bản thu âm 150 câu 3 miền** (`docs/audio-collection-script.md`): 7 nhóm A–G có ground truth, hướng dẫn thiết bị/môi trường/metadata — chuẩn bị Phase 4, CHỈ tài liệu
- **Mandatory Sign-off Phase 5 đã soạn** (`SIGNOFF-phase5-pii.md`): 4 phương án scrubbing khảo sát, bảng quyết định 0/4 — **gate ĐÓNG, chờ ký**
- Test: Node 48/48 (thêm 8 test auth) · Python 58/58 · Flutter 13/13 · analyze 0 issue

### Phase 5 — AI Gateway core (bản đơn giản theo sign-off) — 2026-09-14/15 (`result14.txt`, `result15.txt`)
- **Sign-off ĐÃ KÝ 2026-09-15 (Hoàng, trao đổi trực tiếp): KHÔNG PII scrubbing, KHÔNG 2-tier** — gửi thẳng tên/số tiền cho LLM, free tier được dùng (rủi ro pháp lý chủ dự án chấp nhận, ghi minh bạch trong `SIGNOFF-phase5-pii.md`) → **gate MỞ**, phạm vi còn: router đơn giản + audit
- **LLM Router** (`scripts/llm-router.mjs`): proxy OpenAI-compatible 127.0.0.1:8900; fallback chain config-driven JSON (mock → zen → gemini-openai); cooldown upstream lỗi 429/5xx/timeout; audit JSONL **không chép nội dung câu hỏi** (có test); `LLM_ROUTER_DEBUG=1` in reqHead + body lỗi upstream (dsh nuốt body → không có cái này không bóc được lỗi thật)
- **Upstream thật (result15):** endpoint chính thức điền xong (zen `opencode.ai/zen/v1` · gemini `generativelanguage.googleapis.com/v1beta/openai`); **Gemini verify generate thật 200** qua router ("250000 nhân 1000 bằng 250000000."); **Zen bị chặn billing** (CreditsError: No payment method — glm-5.3-flash PAID, big-pickle chỉ chạy trong OpenCode client)
- **2 bug router tự bắt khi chạy thật:** https upstream gọi bằng http.request (`Protocol not supported`) → chọn module theo protocol; Gemini từ chối field OpenAI-only `store` dsh gửi → `stripFields` per-upstream trong config. Router tests 7/7 · mcp-erpnext 49/49
- **Cơ chế dsh thật đào ra từ source** (khác công thức result6): cordis **patch row override theo id** (`- id: llm-pi-ai`), `models` là list object — mock qua router chạy thật 269.000đ; đóng gói thành skill `erpn-dsh-setup`
- **E2E THẬT XANH end-to-end (result17 §K, 2026-09-15 14:40)**: `dsh → router → Gemini 3.6-flash → MCP tool copilot_ask → Vietnamese NLP → ERPNext THẬT` trả nguyên văn *"Khách hàng **Khách làm tròn 2026-09-15-p1b-wf1-2** hiện còn nợ **457.875đ** (1 hóa đơn chưa thanh toán)."* — khớp chính xác ground truth lấy độc lập từ ERPNext (ACC-SINV-2026-00047). Session chịu **7 lần provider 503 high-demand** mà vẫn xong.
- **Cooldown không được vô hiệu hoá đường duy nhất (result17)**: 1 spike 503 từng làm chain RỖNG → 6/8 request bị router từ chối *không thử gì* (`attempts: []`) → session chết. Fix: `candidates()` — healthy trước, cooldown chỉ đổi thứ tự; error type phân biệt `llm_router_no_model_match` vs `llm_router_all_failed` (trước đây báo "all upstreams failed (tried: none)" cho những lần thử chưa xảy ra).
- **Gateway mang `thought_signature` của Gemini 3.x (result17 §L)**: mọi function-call replay cần `tool_calls[].extra_content.google.thought_signature`; dsh (OpenAI-shaped) drops field này → turn thứ hai 400 *"Function call is missing a thought_signature"*. `ThoughtSignatureCache` + capture stream (SSE/JSON) + inject lại theo tool_call id; bật theo upstream `geminiThoughtSignatures`. **Router 19/19** (gồm integration test: SSE trả signature → turn sau upstream NHẬN được).
- **Harness E2E durable trong repo** (trước ở /tmp, mất mỗi reboot): `mcp-erpnext/dsh-e2e.patch.yml` (default MOCK · `E2E_TARGET=real` mới chạm ERPNext thật) + `scripts/llm-router.e2e.json` (1 upstream)
- **E2E dsh → router → Gemini:** flaky do **free tier 20 req/phút** (1 session dsh tốn 2–3 calls: session-title + agent) — 429 quota + 503 high demand là THIẾT KẾ free tier, nguyên văn trong result15 §6
- **Upstream `mac-custom` — LLM tự host trên máy Mac, KHÔNG quota (result20)**: `https://llm9000.loca.lt/v1` model `gemini/gemini-3.6-flash` (**DRIFT 2026-09-19**: tên cũ `oc/big-pickle` đã bị Mac khai tử — 403; id mới đã verify sống + có `tool_calls` thật; giữ tiền tố `gemini/` vì router so khớp model CHÍNH XÁC), đặt **ĐẦU chain ở cả 2 config** (dev hàng ngày); `timeoutMs: 120000` (model reasoning chậm) + `cooldownMs: 15000` (tunnel flaky); KHÔNG bật `geminiThoughtSignatures` (khác giao thức). `gemini-openai` GIỮ NGUYÊN trong chain chỉ để verify tương thích provider thật; patch dsh chọn model qua env `E2E_LLM_MODEL` (router route theo TÊN MODEL nên không có cách nào khác nếu không sửa file). E2E thật: dsh exit 0. ⚠️ **ĐÍNH CHÍNH (result22 §9B)**: phần audit của phiên đó ("5 req, 2 turn replay đều 200") **không còn kiểm chứng được** — bằng chứng mac-custom hợp lệ duy nhất là **result22** (4×200, `attempts=['mac-custom']`).
- **Số tiền là NET, credit note phải được tính (result21)**: `listUnpaidInvoices` lọc `outstanding_amount !== 0` (KHÔNG phải `> 0`) — credit note (`is_return`) mang outstanding ÂM, lọc `> 0` biến "còn nợ" thành công nợ GỘP. Ca thật: khách có credit note −97.200đ → trước fix báo 269.000đ/3, sau fix **171.800đ/4 ✓**. Câu trả lời đổi nhãn "hóa đơn chưa trả" → "**chứng từ** chưa thanh toán" + có nhánh "hiện dư X" khi outstanding âm; nhánh liệt kê in từng dòng kèm số có dấu. Test hồi quy: `copilot.test.mjs` + mock có SINV-0004 (−320.000 → CUST-00002 = 7.180.000đ/2).
- **Unit suite phải hermetic + không được tự chạy batch thật (result21)**: `node --test` discover MỌI file trong `test/` ⇒ 2 batch runner (18 câu + dump khách/hóa đơn THẬT) bị chạy như unit test; trong shell đã `source .env` chúng sẽ bắn vào ERPNext THẬT và in tên khách/số tiền thật. Đã thêm guard theo `NODE_TEST_CONTEXT` (chạy trực tiếp vẫn nguyên đường dẫn tài liệu: `node test/batch-accuracy.mjs`). Test cũng strip `ASK_*` cùng `ERPNEXT_*` và đặt mọi setup trong try/finally — trước đó leak `ASK_USER/ASK_PASSWORD` làm file test throw trong SETUP, rò child Python và **treo cả suite >120s** thay vì fail nhanh.

---

### DSH final mini-sprint: pin + topology Mac↔backend + real Gemini — 2026-09-19 (`result58.txt`)

- **Chế độ "Phân tích bằng AI" (DSH opt-in)** đã có đường ĐẦY ĐỦ từ gateway tới ERPNext, kèm bằng chứng
  có mã định danh: `/dsh/ask` → dsh runtime → LLM Router → `copilot_ask` → NLP → ERPNext.
- **Runtime được PIN** (`@deepseek-ai/dsh@0.1.5-rc.1` trong `package.json` root) và **resolve từ package
  đã cài**, không hardcode đường dẫn của một máy ⇒ máy mới chỉ cần `npm run dsh:check` là biết chạy được hay không.
- **Hai topology** (`DSH_MODE`): `local` (spawn trên máy gateway) và `remote` (gọi runner trên Mac qua
  tunnel, `scripts/dsh-remote-runner.mjs`). Remote **không bao giờ** tự hạ cấp về local, và mọi response
  (kể cả thất bại) đều nói rõ `runtime: local|remote` — một lần chạy ở máy này không thể bị báo cáo nhầm
  thành "đã verify trên Mac".
- **Provider thật đã verify sống**: 1 session qua `gemini-openai` trả **171.800đ / 4 chứng từ** khớp ground
  truth, với 3 lượt LLM (≥2 vòng tool-call) — tức đường đa-lượt mà cơ chế `thought_signature` từng làm gãy
  đã chạy xanh.
- **6 script kiểm tra/E2E có exit code thật** (`dsh:check`, `check:topology`, `dsh:e2e:read`,
  `dsh:e2e:write-block`, `check:ask-normal`) — thay cho việc đọc log bằng mắt.
- **Chưa verify được (BLOCKED_EXTERNAL, không phải lỗi code)**: hop thật `backend → Mac qua tunnel` —
  localtunnel của Mac đang tắt (`503 Tunnel Unavailable`). Cần người bật lại `lt` trên Mac.
- **Giới hạn cố ý**: đường DSH CHỈ đọc — câu lệnh ghi bị từ chối ở gateway **trước khi spawn** (đo được:
  ~100ms so với ~20s của một session thật), không sinh proposal, không có nút xác nhận.

### Trụ D — Drawer READ (plan4 V1 → next5 hoàn thiện) — 2026-09-21 → 2026-09-26 (`result-p4-done.txt` → `.plan/next5/`)

Số tiền ở màn này **COPY từ ERPNext**, không chỗ nào tự tính; **không nút ghi nào** trên màn.

- **Capability `ops.daily_summary`** (READ, no-confirm, không có keyword route — drawer tới bằng **id**) +
  route `GET|POST /read/daily-summary` (auth như `/ask`, bucket READ, company resolve **server-side**,
  partial đi thẳng) — P4-1/P4-2.
- **Drawer** + màn `Tóm tắt ngày` mặc định: SO **submitted \| draft tách bạch** · HĐ **sau VAT** ·
  thu tách `Tiền mặt`/`Chuyển khoản` **và** `Theo hóa đơn`/`Ứng trước` · chi + chú thích
  **`Chưa gồm chi qua Journal Entry`** · công nợ **hiện tại** + quá hạn · nháp **do app tạo** ·
  `Két tiền mặt (dự kiến)` · footer **REAL \| MOCK** + URL + giờ đọc · cache 45s — P4-3.
- **Drill-down structured** (`/read/drill`): drill id **cố định** trong contract (9 id sau next5), **không classifier** (không inject free-text),
  list ≤10, Back — P4-4. **Block nháp app**: chỉ nháp có `custom_ai_action_id`, giá trị **COPY** từ chứng từ
  (money side hiện `—` chứ không `0đ`) — P4-5. **Hôm nay / Hôm qua**: chọn ngày cho **bán/thu** —
  thẻ hiện **đúng số của ngày đang xem** (đọc lỗi ⇒ trạng thái *"Chưa đọc được ngày hôm qua"* + `Thử lại`,
  KHÔNG hiện số ngày khác); công nợ luôn là số hiện tại — P4-6.
- **Bằng chứng**: 12/12 case §7 có test (xem `result-p4-done.txt`) · Node **525 (523 pass, 2 fail dsh từ B0)** ·
  Flutter **248/248** · analyze **0** · Python **62** · falsify **10/10 harness ALL ALIVE**
  (c0 ✓ · c1 ✓ · c2 10/10 · execute-id-types ✓ · issue1×2 ✓ · p4-ops 15/15 · p42 15/15 · p43 11/11 · p44 20/20) ·
  **vòng lặp thật**: drill ↔ summary **ALL MATCH**, 2 ngày **`partial=false`**, công nợ 2 ngày **giống hệt**, cross-check REST khớp.
- **Ranh giới (VẤN CÒN)**: **két chỉ READ** (§3.6) — không WRITE · không Redis/cache phân tán ·
  không câu hỏi tổng hợp tuần/tháng · không submit/xoá từ drawer.
- **Hàng chờ commit**: P4-1→P4-6 (lúc đó máy chưa có git; vùng đọc SỐ TIỀN ⇒ AI không tự ký duyệt).

**next5 — Drawer READ hoàn thiện (2026-09-25/26, `.plan/next5/next5-drawer-done.md`)** — 5/5 mục drawer bấm được, exit criteria §8 **10/10 ĐẠT**; **không `/execute`, không free-text `/ask`, không MOCK fallback** từ drawer. Các mục:

- **Công nợ (lối tắt)** (`receivable_customers`) — mọi khách còn nợ toàn công ty, sort outstanding DESC.
- **Nợ quá hạn / Nợ lâu** (`overdue_top`) — cùng tập SI quá hạn, sort **`days_overdue` DESC** (nợ lâu trước).
- **HĐ chưa trả** (`unpaid_invoices`) — MỖI DÒNG = 1 SI `docstatus=1 & outstanding>0` (loại sẵn credit note), không "PE-able abstraction".
- **Tồn kho nóng** (`stock_low`) — kho pin tường minh `COPILOT_DEFAULT_WAREHOUSE` (user chốt; thiếu pin ⇒ config error `STOCK_WAREHOUSE_UNPINNED`, CẤM `warehouses[0]`); qty render unit-less, sort qty tăng.
- **Nháp hôm nay** (`app_drafts_today`, alias `/read/app-drafts`) — MỘT aggregate server-side (4 doctype có `custom_ai_action_id`, `docstatus=0`, ngày do server tính); dedupe theo action id do server chọn canonical; 1 doctype chết ⇒ `partial` + banner, 0/4 đọc được ⇒ 503 (không "partial rỗng").

**REAL-only + provenance (D0.5 GATE PASS)**: `MOCK`/unknown ⇒ panel **thay** số, không render tiền; `erp_target` đi trên mọi read view; ERP chết ⇒ refusal/error, không bao giờ "list rỗng đội lốt 0". **Footnote công nợ verbatim (§3.1)**: *"Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp)."* — số drawer = **GL raw KHÔNG trừ Draft PE**; nháp chỉ đi dòng phụ optional `draft_hint` (P9-D giữ số effective trên chat). **Polish D4**: pull-to-refresh chắc chắn chạy cả list ngắn (bug thật: `RefreshIndicator` im lặng trên ListView vừa khung); tiêu đề drill ngày do **server** ghép theo ngày thực đọc (`day_scoped` trong contract, drill toàn công ty giữ nguyên title); đổi server/user ⇒ clear cache + màn đang mở đọc lại; badge nháp optional fail-safe (không request, ẩn khi 0); bound đọc **7s** client-side. **Mỗi list ≥1 verify ERPNext thật** (probe chỉ-đọc, expected từ REST): công nợ 461.505.625đ/47 khách khớp từng khách dù site có **13 nháp PE (162.092.570đ) không bị trừ**; HĐ chưa trả 283 HĐ khớp từng dòng; Bin kho pin khớp từng dòng; nháp 25/09 khớp 3 PO; title ngày 7/7 đúng + độ trễ ≤1,33s < 7s. **Số đo**: Node **820/818/2** (2 fail dsh từ B0) · Flutter **333/333** · analyze **0** · falsify drill **37 ca ALL RED**. Ranh giới: row-level permission **NO-GO môi trường** (D1.5); dedupe D3 chỉ unit test; aging buckets/activity log là backlog. ✅ **ĐÃ COMMIT `17d6f9b`** (2026-09-26, chưa push).

**Fix P4-6 "Tóm tắt ngày Hôm qua" — ✅ ĐÃ COMMIT `ed79f77` [VÙNG SỐ TIỀN]** (2026-09-26): khi chọn "Hôm qua", 2 thẻ (Hóa đơn đã xuất · Tiền khách trả) nay hiện **ĐÚNG số của HÔM QUA** (trước đó tiêu đề đổi nhưng số vẫn hôm nay); **bỏ hẳn** dòng delta. Hôm qua chưa đọc được ⇒ thẻ hiện `_DayNotRead` ("Đang đọc…"/"Chưa đọc được…" + `Thử lại`) — **fail-closed, KHÔNG rơi về số hôm nay**; drill date lấy `d.meta.date` của server. **Flutter 333/333 · analyze 0 · falsify `p44-read-drill` 38/38 RED**. ⚠️ **Chưa sửa (chờ user, vùng số tiền)**: `onRefresh` + `_BlockError.onRetry` trong `daily_summary_screen.dart` reload HÔM NAY thay vì ngày đang xem khi đang xem "Hôm qua" (M1/M2 — `result74.txt` §3).

**NEXT6 — Session isolation (WRITE #? / hardening) — ⏳ MỚI, mới xong audit** (2026-09-26, `.plan/next6-audit1.md`): 11 gap G1–G11 — store key session = `conversation_id` đơn độc (**không principal**) · không lock per-conversation · `sessionContext` global cross-user · `begin()` replay không kiểm `user_id` · proposal không bind principal · 429 thiếu `Retry-After` · `DSH_MAX_SESSIONS` chưa dùng · Flutter conversation id không persist (`chat_controller.dart:124`) · thiếu endpoint clear · log `/ask` thiếu `conversation_id`. **Chưa code** — sẽ tạo change `next6-session-isolation` ở đầu Prompt-2.

## Chưa làm / Tương lai

### Giao diện & kênh truy cập
- **Phase 3 — MVP text chat (read-only) bằng Flutter** — ✅ XONG + COMMITTED `590b1b2` + CI XANH (result7, result10/11). Còn lại là vận hành: user dán 3 giá trị GitHub Settings → APK cài được; xử lý endpoint (Tailscale/mở port/ngrok); cài thiết bị thật
- **Flutter client track chi tiết** — ⚠️ **VẪN CHƯA có phase riêng** (phase-03 chỉ là màn hình chat đầu tiên): navigation, state management, design token, đồng bộ native. Đây là **khoảng trống lớn nhất** của roadmap; `phase-04` (STT) và `phase-15` (ads) đều phụ thuộc vào nó
- **Cầu nối Python ↔ Flutter/dsh** — ✅ XONG toàn chuỗi: `nlp_service` (Python) + `copilot-server.mjs` (Node) + `/ask` HTTP + Flutter client gọi thật (result7/11)
- Native integration (đồng bộ native — yêu cầu gốc trong `checklist.md`)

### Voice
- **Phase 4 — Voice input/STT (hybrid):** interface `SpeechRecognitionProvider`, luồng bắt buộc 🎤 → STT → **user xem lại/sửa text** → Gửi; đo accuracy theo từng miền. **Kịch bản 150 câu đã sẵn sàng** (`docs/audio-collection-script.md`) — chỉ chờ người thật thu
- **Phase 8 — TTS readback** (đọc kết quả), gắn với background job

### Tích hợp ERPNext
- **Chân dsh Web UI (browser):** `dsh web --patch mcp-erpnext/dsh.cordis.patch.yml` (chân headless đã chạy thật; cần LLM thật thì swap settings.yaml)
- **Swap mock LLM → gateway OpenAI-compatible thật:** chỉ sửa `settings.yaml` (baseURL + apiKeyEnv), không đụng code; mock giữ lại làm contract test
- **Phase 7 — Write đầu tiên `create_payment_entry` + idempotency** ⚠️ Go/No-Go gate
- **Phase 11 — Mở rộng write skills:** sales order, inventory, purchase

### An toàn & tin cậy (không cắt để rút ngắn thời gian)
- **P0 phases2 — Capability Contract + Safety (✅ ĐÃ COMMIT `b4acdb1`):** `capabilities.json` single source of truth (7 capability, validate fail-closed) · Safety Gateway là cửa DUY NHẤT cho WRITE + test tĩnh no-bypass (quét cả `scripts/`) · kill switch `503 SYSTEM_MAINTENANCE` (không đốt `command_id`) · `custom_ai_action_id` (unique+indexed trên ERPNext demo) ghi khi tạo PE + reconcile theo field · Golden Dataset v1 200 câu/6 bucket (6/6 đạt ngưỡng) · `document.delete` cấm trên AI path (`403 FORBIDDEN_IN_AI_PATH`)
- **P1 phases2 — Entity Execution Resilience (✅ ĐÃ COMMIT `ee93f13`):** entity 4 trạng thái (`EXACT/FUZZY_SINGLE/AMBIGUOUS/NO_MATCH` theo contract) · WRITE HIGH **không** auto-select fuzzy; AMBIGUOUS → **candidate picker** Flutter (`entity_picker.dart`) → `/ask` nhận `entity_id`, server re-validate trên fresh read · **immutable proposal snapshot** (`proposal_id`/`version`/`expires_at`) · mã tách `PROPOSAL_EXPIRED` vs `PROPOSAL_VERSION_STALE`/`PROPOSAL_ENTITY_CHANGED` (Flutter banner phân biệt) · `UNKNOWN_EXECUTION_STATE` → RECONCILING theo `custom_ai_action_id` · **business dedup** fingerprint warn + `dedup_ack` (không thay `command_id`) · **NLP down → chặn WRITE** phụ thuộc amount (fail-closed). Suite: Node 172 · Flutter 67 · Python 60 · analyze 0 (result45)
- **P2 phases2 — Session context + Uncertainty UX (✅ ĐÃ COMMIT `33ff725`):** uncertainty taxonomy 11 mã + copy tiếng Việt BẮT BUỘC (`uncertainty.mjs`; unknown raw ⇒ null, không chế) · session context provenance+TTL (customer 30m/invoice 10m; hết hạn = XOÁ, không trả "cũ dùng được") · WRITE fail-closed chỉ nhận context `user_selected`/exact — derived (fuzzy READ) không bao giờ seed payment, hết hạn → hỏi lại · `KNOWN_INTENT_UNIMPLEMENTED` cho capability stub (tín hiệu học cho P4) · Flutter `PipelineProgress` 4 pha (hiểu → tra khách → kiểm tra → chờ xác nhận) thay spinner trần · falsify 3 luật trên /tmp. Suite: Python 60 · Node 181 · Flutter 69 · analyze 0 (`.plan/phases2/p2-result.md`)
- **P3 phases2 — LLM Classifier (async) + Regression gate (✅ ĐÃ COMMIT `c38e4ea`):** câu keyword-router KHÔNG hiểu → classifier hỏi LLM Router (Phase 5) lấy **intent/slots semantic-only** rồi route qua ĐÚNG skill/Safety path cũ (không agent loop, không DSH) · **không bao giờ trả ERP id** (2 lớp: regex `*_id`/`docname` + allowlist text-only) · intent ngoài Capability Contract bị từ chối, forbidden (`document.delete`) không được nêu · confidence không bypass confirm/authz; thấp → `LOW_CONFIDENCE`; LLM down/timeout → rule-only `UNKNOWN_INTENT` (không 500 mù) · untrusted-data wrap trước khi vào prompt · **CI gate mới** `classifier-cases.json` + mock LLM (không quota). Suite: Python 60 · Node 195 · Flutter 69 · analyze 0 (`.plan/phases2/p3-result.md`)
- **P4 phases2 — Learning loop có người duyệt (✅ ĐÃ COMMIT `d7e9ba9`):** log tín hiệu JSONL never-throw (`learning-log.mjs`, thư mục repo-local — KHÔNG `/tmp`) · `scripts/learning-cluster.mjs` **chỉ ĐỌC**, `npm run learning:cluster` gom nhóm câu bị từ chối (UNKNOWN_INTENT / KNOWN_INTENT_UNIMPLEMENTED) thành báo cáo người xem · **pipeline KHÔNG BAO GIỜ tự sửa Capability Contract**: thêm trigger chỉ qua quy trình người duyệt (`docs/learning-loop-workflow.md`) + regression gate · vòng thử thật: cluster phát hiện "doanh số" chưa route → thêm keyword vào contract + 2 case golden (7/7). Suite: Node 204
- **P5 phases2 — DSH explicit opt-in, chỉ ĐỌC (✅ ĐÃ COMMIT `6318eca`):** `dsh-optin.mjs` — dsh **chỉ** chạy khi được spawn NGOÀI pipeline với `COPILOT_DSH_CONTEXT=1`; `/ask` KHÔNG có đường nào spawn dsh (test tĩnh quét `src/` + assertion kiến trúc) · trong context dsh mọi WRITE bị `DSH_WRITE_BLOCKED` TRƯỚC skill factory (proposal null, không đụng ERPNext) · `docs/dsh-optin.md`. LUẬT D2/D8: DSH không bao giờ là fallback của `/ask`. Suite: Node 212
- **P7 phases2 — Background job queue (✅ ĐÃ COMMIT `3e6240a`):** lệnh GHI đã CONFIRM nhưng ERP tạm không tới được ⇒ xếp hàng (`job-queue.mjs`, JSONL repo-local) và tự thử lại; enqueue **chỉ** khi verdict `retry_same_command_id` (lỗi trước khi ghi) · retry có hạn + crash-recovery RUNNING→RETRYING · **`startJobRunner()` nối vào `main()`** (trước đó job enqueue mà không ai drain — exit criteria chỉ đúng trong test) · `GET /jobs` trả pending + completed · `/execute/cancel` gọi `release()` nhả job · **không double payment**: mọi lần thử đi lại đúng Safety Gateway + idempotency/reconcile sẵn có. Suite: Node 228
- **P10 slice — Rate limit + Correlation trail (✅ ĐÃ COMMIT `7cb2798` + `21d77ff`):** enforce luật ĐÃ KHAI trong contract (read 30/phút · write_proposal 10/phút · write_execute 5/phút · `payment.create` 20/giờ) — vượt ⇒ **429 + Retry-After + câu tiếng Việt**, charge **TRƯỚC** Safety Gateway nên **không đốt `command_id`** · câu ĐỌC không tiêu ngân sách ghi · correlation §17 (`request_id/user_id/command_id/action_id/erp_document_id/latency_ms`) trên `/ask` + `/execute` + job runner · `COPILOT_RATE_LIMIT=off` là opt-out duy nhất, config hỏng ⇒ fallback default THẬT (không tắt cổng lặng lẽ) · **`docs/kill-switch-runbook.md`** (2 lớp storage, bảng kỳ vọng từng đường, §4 F7). Suite: Node 241 · falsify 5 guard
- **P6 phases2 — Voice dictation qua STT của OS (✅ ĐÃ COMMIT `9b54d35`):** `speech_to_text` 7.5.0 — mic → transcript đổ vào **CHÍNH ô nhập editable** → user sửa → Gửi qua `POST /ask` như gõ tay; **không auto-Send**, interface `SpeechService` không có method gửi/execute ⇒ không tồn tại đường voice → WRITE · quyền `RECORD_AUDIO` + `<queries>` RecognitionService (Android; iOS keys ghi lại trong result vì repo chưa có target ios) · locale: **luôn xin `vi_VN`** (kể cả khi máy không liệt kê `vi` — `locales()` chỉ phủ recognizer ON-DEVICE), máy thiếu `vi` **không hiện gì về locale** (bugfix `77e2b57` + UX follow-up: bỏ cả gợi ý nhẹ — chỉ cảnh báo THẬT denied/unavailable/error_language_* mới hiện) · dictation giữa lúc đang gõ không xoá chữ; partial thay không nối; `dispose()` đóng mic · guard chống kết quả STT muộn ghi đè ô nhập đã gửi (session token ở service) + chống double-tap mở 2 phiên. **Flutter 118** · falsify 15 guard
- **P6 UX — Settings "Tự gửi sau khi nói xong" (✅ ĐÃ COMMIT `f55d557`):** switch mặc định OFF; ON ⇒ nói xong (kết quả **final**, ô nhập có text, không đang loading) là gửi qua **cùng** đường `POST /ask` — partial/transcript rỗng không gửi; **không** auto-confirm đề xuất thu tiền, không đụng `/execute`. Key `settings_voice_auto_send_v1` (fail-safe OFF). `result55.txt` §10
- **Chế độ AI — "Phân tích bằng AI" (DSH, chỉ đọc) (✅ ĐÃ COMMIT `b61df0a` backend + `868be04` client):** thanh chọn chế độ TRÊN ô nhập, **mặc định "Chat thường"** và **không ghi nhớ** lựa chọn (mỗi câu tự quyết — không có câu nào thành phiên agent vì câu trước đó đã chọn) · chọn AI ⇒ `POST /dsh/ask` (timeout riêng) — đường **agent** tách khỏi `/ask` tất định, **chưa bao giờ** là fallback của `/ask` · chỉ trả lời: **không** card đề xuất, **không** nút xác nhận, **không** đường tới `/execute` · câu lệnh ghi bị **từ chối ở gateway TRƯỚC khi spawn** (đo 0.0105s so với ~19.7s một phiên thật) · NLP chết ⇒ fail-closed · gateway **từ chối spawn patch thiếu `COPILOT_DSH_CONTEXT`** (lỗ hổng thật tìm bằng cách chạy thật: patch thiếu cờ ⇒ cổng chặn ghi không bao giờ chạy) · mọi response — kể cả lỗi — mang `runtime: local|remote` + `erpnext_target` · runtime **pin** `@deepseek-ai/dsh@0.1.5-rc.1` (root `package.json`), resolver 6 mức **KHÔNG hardcode máy nào**: `DSH_ENTRY` → `DSH_COMMAND` → package local → **`npx --yes @deepseek-ai/dsh@<pin>`** → `/tmp/dsh-run` (*chỉ khi file tồn tại thật*) → unavailable (`result59.txt`) · `DSH_MODE=remote` (Mac qua tunnel, token `timingSafeEqual`) **không bao giờ** hạ cấp về local · 6 script có exit code = nguồn sự thật (`npm run dsh:check` / `check:topology` / `dsh:e2e:read` / `dsh:e2e:write-block` / `check:ask-normal`) · sửa kèm bug CÓ SẴN: ghi `state` sau khi provider dispose ⇒ `UnmountedRefException` (9 guard `ref.mounted`). **Node 313 · Flutter 150 · Router 19** · `result57.txt` + `result58.txt` + `result59.txt`
### Ghi chứng từ #2–#4 (Trụ B) & Camera→proposal (Trụ C) — phases3 (2026-09-20)
> **Trạng thái chung:** KỸ THUẬT XONG + đã test/falsify, **CHỜ DUYỆT COMMIT** (máy này KHÔNG có git). Tất cả đường ghi hiện **mock-only** — chưa ghi ERPNext thật (chờ user ghi "cho phép ERPNext thật"). Deliverable ở `.plan/phases3/*-result.md` (bị gitignore) + `result62.txt`.
- **B0 — P9 readiness gate (✅ GO):** đo lại toàn suite + checklist 10/10 (contract · authz · entity · immutable/TTL · idempotency · `custom_ai_action_id`+reconcile · false-write≈0 · duplicate→1 doc · golden · kill-switch/rate-limit không đốt `command_id`). Probe read-only ERPNext thật phát hiện **G1: chưa doctype WRITE mới nào có field `custom_ai_action_id`** (script migrate cũ hardcode "Payment Entry"). 2 fail Node = `dsh-gateway` cần runtime dsh (môi trường); 1 fail Flutter = probe P2b tạm. (`.plan/phases3/B0-result.md`)
- **A1 — UX-READ drill-down (✅ kỹ thuật xong):** `ui_screens` trong contract (loader validate fail-closed) → `/ask` trả `ui` có cấu trúc cho nhóm ĐỌC → nút bubble → `POST /read/list` (throttle → screen∈contract → `authorize()` → **re-validate entity trên dữ liệu vừa đọc** → đọc tươi, hàng bounded 5–10 theo contract, `truncated`) → `ReadListScreen` (loading/lỗi/**kéo-làm-mới**, chú thích "chỉ để xem"). Verify ERPNext THẬT (read-only): khách `P1A-ACCEPT` → nút/màn `96.399.500đ / 95 chứng từ`, **MATCH answer==screen**. (`.plan/phases3/A1-result.md`)
- **B1 — Item/Supplier/UOM resolvers (✅ kỹ thuật xong):** `src/uom.mjs` 6 mã quyết định (chỉ hệ số **TRỰC TIẾP**, mọi CONVERT bắt buộc có `display`, mặc định fail-closed ASK); `uom_policy` validate fail-closed trong contract; Item dùng `classifyEntityResolution` 4 trạng thái + picker; **Supplier API** = capability READ `supplier.lookup` + route group `supplier` (+ `erpnext_supplier_list` vào `READ_ONLY_TOOLS`, test canh 2 chiều); dùng lại parser Python làm nguồn chính. **3 probe read-only ERPNext thật đảo ngược 3 giả định của plan3_review3** (Item.uom 417 · UOM Conversion Factor GLOBAL không per-item · site KHÔNG có Cây/Tạ/Bó/Cuộn/Tấm/Pallet, chỉ Tấn→Kg=1000, Bao→Kg=25). (`.plan/phases3/B1-result.md`)
- **B2 — `sales_order.create` (WRITE #2, ✅ kỹ thuật xong):** executor thứ hai qua CÙNG Safety Gateway (registry literal, không entry ⇒ `EXECUTOR_NOT_REGISTERED` fail-closed) · deny-list `notIf` cho "giao hàng/báo giá/câu hỏi về đơn" · `rate_source` refuse `utterance` (giá từ client ⇒ `PROPOSAL_VERSION_STALE`) · probe correlation field TRƯỚC khi ghi · action-id trùng ⇒ `SO_DUPLICATE_ACTION` **409 + existing_doc** · create `docstatus:0`, verify lệch ⇒ 503 PENDING + `retry_same_command_id` · golden 8 ca `o01–o08` · Flutter card "Xác nhận tạo đơn (NHÁP)" + dòng quy đổi `(=1000 Kg)`. **3 bug thật bắt được** (TDZ nuốt bởi try/catch trong mock ⇒ state file không bao giờ đọc lại ⇒ đơn thứ hai GHI THẬT; 409 vs 500; formatter TIỀN render SỐ LƯỢNG). (`.plan/phases3/B2-result.md`)
- **B3 — `quotation.create` (WRITE #3, ✅ kỹ thuật xong):** turnover toolkit SO dùng chung; taxonomy `QT_*` riêng; `QT_DUPLICATE_ACTION: 409`; nhóm router `quotation_write` + deny-list câu HỎI; golden 8 ca `q01–q08`; Flutter card nhánh `create_quotation`. **2 bug thật**: (1) gộp nhánh làm **mất SHAPE tham số** ⇒ mọi câu đặt hàng `SO_CUSTOMER_UNRESOLVED` (E2E B2 bắt, unit B3 không thấy); (2) `_confirmableActions` (Dart) thiếu `create_quotation` ⇒ card không có nút xác nhận. (`.plan/phases3/B3-result.md`)
- **B4 — `purchase_order.create` (WRITE #4, ✅ kỹ thuật xong):** pattern B2/B3; disambiguation `mua/nhập/nhận`; supplier API tái dùng B1; golden PO; regress payment+SO. (`.plan/phases3/B4-result.md`)
- **C0 — OCR foundation (✅ ĐÃ DUYỆT):** interface `OcrProvider` → `raw_text` (+ optional confidences/blocks) · **mock bắt buộc cho CI** (deterministic 0 network; thiếu env ⇒ mock, env sai ⇒ hard error) · MVP `router-vision` (ảnh → LLM router, `mac-custom` self-host 0 quota) · `ocr_policy` trong contract validate **một chiều** (`log_raw_image:true` ⇒ contract invalid) · untrusted wrap **trước** classifier/LLM (`prepareOcrText`) · mime allowlist + trần ảnh 8 MB (2 lỗ tự tìm ở review) · **CẤM** `/execute`/ghi ERPNext/log raw image/skill WRITE mới (test tĩnh quét `src/ocr/**`). 2 lỗ tự tìm: `mimeType` chưa allowlist; không trần kích thước ảnh. (`.plan/phases3/C0-result.md`)
- **C1 — Camera UI + fallback (✅ ĐÃ DUYỆT):** `image_picker ^1.2.3` (user duyệt) + `POST /ocr` riêng · nén **trên máy** dưới trần `MAX_BODY` 1 MB (1600px/q80 → retry 1024px/q60, trần 700 KB) ⇒ không nới trần server · sheet text sửa-được + confidence + nhãn "bản đọc THỬ" khi mock · **[Nhập tay từ ảnh]** khi LOW_CONFIDENCE/NO_TEXT · **không auto-send** kể cả khi `voiceAutoSend` bật (setting dictation, có test riêng) · lỗ thiết kế vá trong phiên: validate chỉ ở provider ⇒ **mock trả hóa đơn bịa 200 OK cho `POST /ocr {}`** ⇒ dời validate lên ROUTE. (`.plan/phases3/C1-result.md`)
- **C2 — Camera → proposal SO/PO (✅ kỹ thuật xong, CHỜ DUYỆT — vùng ghi):** §0 đo trước: **ảnh không có động từ mệnh lệnh** (mọi ảnh chụp rơi vào đường ĐỌC) ⇒ **kind do USER chọn** trên sheet (`[Đơn bán]`/`[Đơn mua]`), map kind→capability nằm trong contract (`ocr_policy.document_kinds`, validate fail-closed) · slots dùng **CHUNG parser với builder** (`src/line-parse.mjs` PURE) ⇒ form hiện đúng cái builder sẽ dựng · party photo **CHẶT hơn chat** (tên cắt cụt ⇒ candidates không auto-pick; word-boundary chống "Hà Tiên 20 Bao" nhặt "Hà Tiên 2") · provenance gate fail-closed 4 lớp (status lạ/LOW/mock/confidence thiếu) · tiền trên ảnh chỉ HIỂN THỊ · câu đã sửa gửi `/ask` = user's own turn → card confirm CŨ (không đường ghi thứ hai) · **review vòng 2 bắt 1 lỗ THẬT đã vá**: `/ocr/slots` nhận `body.text` 1 MB không chặn ⇒ `assertSlotsText()` + 400 `OCR_READ_TOO_LONG`. Falsify C2 10/10 RED. (`.plan/phases3/C2-result.md`)

- **P8 phases2 — Multi-user / RBAC / company scope (✅ ĐÃ COMMIT `90401f0`):** `authorization.mjs` — phân quyền server-side đọc từ `capabilities.json` (`payment.create` cần "Accounts User"), không hardcode · 2 chế độ: `multi_user` (`COPILOT_USERS` tường minh; user lạ ⇒ read-only; JSON hỏng ⇒ ném lỗi) / `single_tenant` mặc định giữ hành vi cũ (đo thật: gỡ miễn trừ ⇒ 33 test đỏ) · company **server-first** + allow-list; multi-user thiếu company ⇒ `COMPANY_SCOPE_REQUIRED` (map về copy P2) · wire: `/ask` chặn trước skill factory (không proposal, 0 ERPNext read) · `/execute` 403 **không tiêu `command_id`** · `/jobs` lọc theo actor · `/execute/cancel` chỉ chủ lệnh/người có quyền · job replay mang actor gốc, phân quyền tính lại lúc ghi · audit `user_id`+`company` vào record idempotency + job; identity suy từ principal (một nguồn "ai"). **Node 267** · falsify 13 guard
- **Phase 5 — AI Gateway core:** ✅ bản đơn giản ĐÃ XONG theo sign-off (không scrub): auth, LLM Router config-driven, audit log; client mobile **không bao giờ** giữ ERPNext/LLM key. Còn: user quyết upstream thật (Zen payment / Gemini free-paid)
- **Phase 6 — Entity resolution + Action Proposal card:** "Anh A" → đúng customer nào khi trùng tên/liên chi nhánh; card xác nhận tiếng Việt dễ hiểu + Risk Level
- **Phase 7 — Idempotency** — chống double-tap ghi tiền 2 lần
- **Phase 9 — Proposal state machine:** expiry (TTL 10 phút → 409 `PROPOSAL_EXPIRED`) + re-validation (drift → 409 `PROPOSAL_STALE`, không clamp im lặng) + khoá ý định trùng PENDING (409 kèm `clash_command_id`) + **route `/execute/cancel`** (chỉ huỷ PENDING sau khi reconcile xác nhận 0 chứng từ — giải zombie PENDING; cancel bọc try/catch chống crash khi race) — phần an toàn ✅ commit `eea0411`; cancel + review fix ✅ commit `bda54cf` (`result29.txt` + `result31.txt` §11); còn thiếu (nâng cao): saga/compensation (undo không phải `delete document` — plan §7 chờ duyệt)
- **Nối ghi vào luồng chat (Phase 7b — ✅ XONG + commit `bda54cf`):** `routeIntent()` nhận nhóm `payment_write` (anchor `startsWith` đầu câu + `notIf` deny-list câu hỏi lịch sử — review result31 §11-F1: "thanh toán gần nhất..." normalize cũng bắt đầu bằng "payment") ⇒ "thu tiền cho <khách> <số tiền>" → proposal `create_payment_entry`/HIGH → nút [Xác nhận] hiện thật trên Flutter (widget test với JSON server trả về verbatim); thiếu số tiền ⇒ đề xuất thu hết nợ (vẫn HIGH); câu trả lời nhóm payment ĐỌC đã bỏ chữ cũ "Phase 2 chỉ đọc"; kết thúc khoảng trống result28 §3. Review vòng 2 sửa thêm: `store.cancel()` bọc try/catch (F2 — tránh crash process khi race với /execute) · reason dùng `rawText` (F3). Suite: Node 119/119 · Python 60/60 · Flutter 29/29 · analyze 0
- **Phase 9 UI STALE (✅ ĐÃ COMMIT `31d485c`, result32–34):** thẻ bị từ chối hiển thị banner ⏰ EXPIRED / 🔄 STALE + `problems[]` (theme colors), **thay thế** nút [Xác nhận] (fail-closed — không confirm trên số cũ); `rejectionCode`/`rejectionProblems` ghim vào `toJson` ⇒ banner sống qua khôi phục history; **review result33 bắt 1 bug thật**: dio mặc định THROW với non-2xx ⇒ 409 không bao giờ đến `res.data` ⇒ banner vô hình trên đường wire thật — vá nhánh `on DioException` đọc `err.response?.data` + stamp cục bộ + `didUpdateWidget` xoá stamp khi instance swap; test wire 409 thật qua mock adapter + falsify (gỡ nhánh → FAIL đúng assertion); **F4**: model Dart thiếu `params` ⇒ mọi confirm từ app thật sẽ bị 400 tại money-shape gate — đã round-trip `params` (unmodifiable) + `attachRejection` mang theo khi rebuild. **Flutter 34/34 · analyze 0**

### Vận hành & quy mô
- **P9 — Skill mới hàng loạt (sales/inventory/purchase READ)** — gate ĐÃ MỞ (Golden 0 miss, P0–P3 acceptance đạt); chờ lệnh user
- **P10 full — Production hardening còn lại:** backup/restore drill · chạy thử kill-switch runbook trên gateway thật (human) · load/smoke test + APK device · dashboard/log query · rate-limit store phân tán (hiện in-process)
- **Saga §7 (phase-09 nâng cao):** REVERSING/REVERSED có kiểm soát (undo ≠ delete document) — plan đã viết, CHỜ DUYỆT riêng
- **Phase 12 — Multi-tenant readiness:** tenant isolation cho entity resolution + PII mapping + skill group (chỉ nếu có ý định SaaS)
- **Phase 13 — Production hardening + beta pilot:** chaos test mở rộng, đo success rate end-to-end
- **Phase 14 — Publish & compliance:** store submission, PII/Nghị định 13 sign-off thủ công

### Monetization — Phase 15 (đã bù vào roadmap 2026-09-13)
- **Tính năng pro mở khoá bằng xem ads**, hiệu lực trong ngày, **reset mỗi ngày** (yêu cầu gốc trong `checklist.md`)
- Không giới hạn tính năng cơ bản — chỉ gate nhóm tính năng pro; ad không được chèn vào luồng xác nhận giao dịch tiền
- ⚠️ Còn 4 câu phải quyết trước khi implement: ad provider · múi giờ tính "hết ngày" · danh sách tính năng pro · có IAP bỏ ad hay không
- ⚠️ `phase-15` **phụ thuộc vào Flutter client track** (chưa định nghĩa)

### Nợ kỹ thuật / dạng chưa hỗ trợ (Phase 1)
- Golden Dataset phơi 3 gap Phase 1 (đã truy nguyên nhân, chưa sửa): `k18` "Con Linh" không strip "Con" (FILLERS chứa "linh") · `m15` "một triệu hai" chưa hỗ trợ shorthand 1.2M · `k36` "Bác sĩ Nam" strip nhầm "Bác" (không biết từ ghép "bác sĩ") — hiện lại mỗi lần chạy Golden để không quên
- ~~Tiếng lóng miền Nam `trẹo`/`chai`~~ ✅ đã làm 2026-09-13; còn `bạc` (không rõ mệnh giá) + viết tắt `m` (= triệu, nhưng `m` cũng = mét)
- ~~Hậu tố tiền tệ dính liền số~~ ✅ đã fix 2026-09-13 (58/58 PASS, 259/259 = 100% — `result3.txt`)
- Cờ `approximate`/so sánh: `"khoảng 10 triệu"`, `"hơn 10 triệu"`
- Số âm / hoàn tiền: `"trả lại 500 nghìn"`
- Input **không dấu** — cố ý không hỗ trợ (nếu match thì `"nam"` sẽ khớp `"năm"` = 5)
- Phân biệt câu hỏi vs câu lệnh → Phase 6
- Số trần ở cuối câu (`"2 triệu 500"`, `"1 triệu 5"`) → cố ý từ chối

### Khoảng trống roadmap
- **Flutter client track chưa được định nghĩa** (xem mục "Giao diện & kênh truy cập") — khoảng trống lớn nhất

---

## Notes

- **Nguyên tắc xuyên suốt roadmap:** Read trước Write · không tin external reference chưa verify · tái dùng trước khi xây mới · **an toàn > tốc độ** · mỗi phase có exit criteria đo được.
- **Go/No-Go gate quan trọng nhất:** trước Phase 7 (write đầu tiên chạm tiền), Phase 1–6 phải đạt exit criteria đầy đủ.
- **Trước Phase 14:** Phase 9 (race condition/saga) + PII scrubbing (Phase 5) phải pass audit thủ công — nghĩa vụ pháp lý, không phải chất lượng sản phẩm.
- Quyết định kiến trúc đã chốt (khác khuyến nghị 5 review gốc): dùng **dsh** làm runtime thay vì tự viết agent loop; **không tách MCP skill layer riêng** ngay từ đầu (YAGNI), có 2 trigger rõ ràng để tách.
- **Chốt với user 2026-09-13:** client đích = **Flutter** · cầu nối Python↔Flutter/dsh = **HTTP service nội bộ** · `"công nợ"` → `receivable` · **an toàn số tiền > độ phủ** · monetization **có làm** (`phase-15`).
