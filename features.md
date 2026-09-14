# features.md — ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Danh sách tính năng hiện tại và tương lai. Cập nhật khi hoàn thành 1 nhóm tính năng lớn.
Bằng chứng code + test: `resultNN.txt`, `.plan/phases/phase-0N-result.md`, `checklist.md`.

**Ý tưởng sản phẩm (1 câu):** nói chuyện với ERPNext như nói chuyện với một nhân viên kế toán/bán hàng —
`"Anh Nam vừa trả 10 triệu tiền cám"` → AI tra khách, kiểm tra công nợ, đề xuất phiếu thu, chờ user xác nhận, rồi ghi vào ERPNext.

**Trạng thái tổng:** xong **Phase 0 + Phase 1 + Phase 2 (read-only, ĐÃ NỐI ERPNext THẬT) + cầu nối dsh** (`result6.txt`). Chưa có giao diện (Flutter Phase 3), chưa có STT.

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

---

## Chưa làm / Tương lai

### Giao diện & kênh truy cập
- **Phase 3 — MVP text chat (read-only) bằng Flutter** — file phase đã sửa từ PWA sang Flutter (2026-09-13): màn hình chat, lịch sử hội thoại, query công nợ/tồn kho/đơn hàng, gọi HTTP service nội bộ trên VPS (không nhúng key vào app), build APK debug test máy thật
- **Flutter client track chi tiết** — ⚠️ **VẪN CHƯA có phase riêng** (phase-03 chỉ là màn hình chat đầu tiên): navigation, state management, design token, đồng bộ native. Đây là **khoảng trống lớn nhất** của roadmap; `phase-04` (STT) và `phase-15` (ads) đều phụ thuộc vào nó
- **Cầu nối Python ↔ Flutter/dsh** — ✅ phía Python+Node đã xây xong (`nlp_service` + `copilot-server.mjs`, result5); còn chân **Flutter** gọi vào cầu nối này (Phase 3)
- Native integration (đồng bộ native — yêu cầu gốc trong `checklist.md`)

### Voice
- **Phase 4 — Voice input/STT (hybrid):** interface `SpeechRecognitionProvider`, luồng bắt buộc 🎤 → STT → **user xem lại/sửa text** → Gửi; đo accuracy theo từng miền
- **Phase 8 — TTS readback** (đọc kết quả), gắn với background job

### Tích hợp ERPNext
- **Chân dsh Web UI (browser):** `dsh web --patch mcp-erpnext/dsh.cordis.patch.yml` (chân headless đã chạy thật; cần LLM thật thì swap settings.yaml)
- **Swap mock LLM → gateway OpenAI-compatible thật:** chỉ sửa `settings.yaml` (baseURL + apiKeyEnv), không đụng code; mock giữ lại làm contract test
- **Phase 7 — Write đầu tiên `create_payment_entry` + idempotency** ⚠️ Go/No-Go gate
- **Phase 11 — Mở rộng write skills:** sales order, inventory, purchase

### An toàn & tin cậy (không cắt để rút ngắn thời gian)
- **Phase 5 — AI Gateway core:** auth, **PII scrubbing trước LLM**, LLM Router config-driven, audit log; client mobile **không bao giờ** giữ ERPNext/LLM key
- **Phase 6 — Entity resolution + Action Proposal card:** "Anh A" → đúng customer nào khi trùng tên/liên chi nhánh; card xác nhận tiếng Việt dễ hiểu + Risk Level
- **Phase 7 — Idempotency** — chống double-tap ghi tiền 2 lần
- **Phase 9 — Proposal state machine:** expiry, re-validation, saga/compensation (undo không phải `delete document`)

### Vận hành & quy mô
- **Phase 8 — Background jobs + push notification:** "ra lệnh rồi đi chỗ khác" (job queue, thông báo kèm mã phiếu)
- **Phase 10 — Multi-user, RBAC, on-behalf-of:** mỗi user 1 ERPNext API key riêng (encrypted), Role → Skill group mapping, disable user → invalidate session ngay (**Trigger #1 tách khỏi dsh**)
- **Phase 12 — Multi-tenant readiness:** tenant isolation cho entity resolution + PII mapping + skill group (chỉ nếu có ý định SaaS)
- **Phase 13 — Production hardening + beta pilot:** chaos test (mất mạng, timeout, app bị kill, server restart, partial transaction), đo success rate end-to-end
- **Phase 14 — Publish & compliance:** store submission, PII/Nghị định 13 sign-off thủ công

### Monetization — Phase 15 (đã bù vào roadmap 2026-09-13)
- **Tính năng pro mở khoá bằng xem ads**, hiệu lực trong ngày, **reset mỗi ngày** (yêu cầu gốc trong `checklist.md`)
- Không giới hạn tính năng cơ bản — chỉ gate nhóm tính năng pro; ad không được chèn vào luồng xác nhận giao dịch tiền
- ⚠️ Còn 4 câu phải quyết trước khi implement: ad provider · múi giờ tính "hết ngày" · danh sách tính năng pro · có IAP bỏ ad hay không
- ⚠️ `phase-15` **phụ thuộc vào Flutter client track** (chưa định nghĩa)

### Nợ kỹ thuật / dạng chưa hỗ trợ (Phase 1)
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
