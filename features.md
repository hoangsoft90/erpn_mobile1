# features.md — ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Danh sách tính năng hiện tại và tương lai. Cập nhật khi hoàn thành 1 nhóm tính năng lớn.
Bằng chứng code + test: `resultNN.txt`, `.plan/phases/phase-0N-result.md`, `checklist.md`.

**Ý tưởng sản phẩm (1 câu):** nói chuyện với ERPNext như nói chuyện với một nhân viên kế toán/bán hàng —
`"Anh Nam vừa trả 10 triệu tiền cám"` → AI tra khách, kiểm tra công nợ, đề xuất phiếu thu, chờ user xác nhận, rồi ghi vào ERPNext.

**Trạng thái tổng:** xong **Phase 0 + 1 + 2 (read-only, ERPNext thật, **accuracy thật 18/18 = 100%** — `result9.txt`) + cầu nối dsh + **Flutter chat MVP** (`result7.txt`, commit `590b1b2`). 6 commits đã push GH; **CI XANH 2 lần liên tiếp** (run #2 `4c5bd26`, run #3 `c3d74c3` — result10/11). **Endpoint /ask có bảo mật bind + basic auth, verify thật 401→200→269.000đ** (`result11.txt`). **Phase 5: sign-off đã ký (không scrub) + LLM Router đã nối upstream thật — Gemini verify generate 200, Zen billing-blocked, E2E dsh flaky do free tier** (`result15.txt`). Chưa có STT; chờ user: dán 3 giá trị GitHub Settings + chọn đường endpoint + cài APK thiết bị thật + quyết định upstream LLM (result15).

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
- **Upstream `mac-custom` — LLM tự host trên máy Mac, KHÔNG quota (result20)**: `https://llm9000.loca.lt/v1` model `oc/big-pickle`, đặt **ĐẦU chain ở cả 2 config** (dev hàng ngày); `timeoutMs: 120000` (model reasoning chậm) + `cooldownMs: 15000` (tunnel flaky); KHÔNG bật `geminiThoughtSignatures` (khác giao thức). `gemini-openai` GIỮ NGUYÊN trong chain chỉ để verify tương thích provider thật; patch dsh chọn model qua env `E2E_LLM_MODEL` (router route theo TÊN MODEL nên không có cách nào khác nếu không sửa file). E2E thật: dsh exit 0. ⚠️ **ĐÍNH CHÍNH (result22 §9B)**: phần audit của phiên đó ("5 req, 2 turn replay đều 200") **không còn kiểm chứng được** — bằng chứng mac-custom hợp lệ duy nhất là **result22** (4×200, `attempts=['mac-custom']`).
- **Số tiền là NET, credit note phải được tính (result21)**: `listUnpaidInvoices` lọc `outstanding_amount !== 0` (KHÔNG phải `> 0`) — credit note (`is_return`) mang outstanding ÂM, lọc `> 0` biến "còn nợ" thành công nợ GỘP. Ca thật: khách có credit note −97.200đ → trước fix báo 269.000đ/3, sau fix **171.800đ/4 ✓**. Câu trả lời đổi nhãn "hóa đơn chưa trả" → "**chứng từ** chưa thanh toán" + có nhánh "hiện dư X" khi outstanding âm; nhánh liệt kê in từng dòng kèm số có dấu. Test hồi quy: `copilot.test.mjs` + mock có SINV-0004 (−320.000 → CUST-00002 = 7.180.000đ/2).
- **Unit suite phải hermetic + không được tự chạy batch thật (result21)**: `node --test` discover MỌI file trong `test/` ⇒ 2 batch runner (18 câu + dump khách/hóa đơn THẬT) bị chạy như unit test; trong shell đã `source .env` chúng sẽ bắn vào ERPNext THẬT và in tên khách/số tiền thật. Đã thêm guard theo `NODE_TEST_CONTEXT` (chạy trực tiếp vẫn nguyên đường dẫn tài liệu: `node test/batch-accuracy.mjs`). Test cũng strip `ASK_*` cùng `ERPNEXT_*` và đặt mọi setup trong try/finally — trước đó leak `ASK_USER/ASK_PASSWORD` làm file test throw trong SETUP, rò child Python và **treo cả suite >120s** thay vì fail nhanh.

---

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
- **Phase 5 — AI Gateway core:** ✅ bản đơn giản ĐÃ XONG theo sign-off (không scrub): auth, LLM Router config-driven, audit log; client mobile **không bao giờ** giữ ERPNext/LLM key. Còn: user quyết upstream thật (Zen payment / Gemini free-paid)
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
