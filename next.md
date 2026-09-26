# next.md — Roadmap ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Đường đi tính năng đã hoàn thành và sắp tới. Bằng chứng từng phase: `result*.txt`.
Trạng thái tóm tắt (đã làm/chưa làm/chờ ai): `checklist.md` — hai file này không nhân bản nhau.

## Trạng thái mới nhất (2026-09-26)

> **2 commit phiên này (branch `change/flutter-chat-mvp`, KHÔNG push):** `17d6f9b` feat(ops)
> drawer READ REAL-only + provenance, hoàn tất next5 (D0–D5) (39 file) · `ed79f77` fix(ops)
> Tóm tắt ngày "Hôm qua" hiện ĐÚNG số của ngày đó **[VÙNG SỐ TIỀN]** (8 file).
> Suite: **Node 820/818/2** (2 fail `dsh-env` từ B0) · **Flutter 333/333** · analyze **0** ·
> falsify drill **37 ca ALL RED** + `p44` **38/38 RED**.

**P4-6 — Tóm tắt ngày "Hôm qua" hiện ĐÚNG số — ✅ ĐÃ COMMIT `ed79f77` [VÙNG SỐ TIỀN]**: user chốt
hướng **(A)**: xem "Hôm qua" ⇒ 2 thẻ (Hóa đơn đã xuất · Tiền khách trả) hiện **số của HÔM QUA**;
**bỏ hẳn** dòng delta. `_DayNotRead` fail-closed khi chưa đọc được hôm qua (tiêu đề + "Đang đọc…"/
"Chưa đọc được…" + `Thử lại` — **KHÔNG** rơi về số hôm nay; keys `summary-day-not-read-*`). Drill date
đổi sang `d.meta.date` (ngày của server). Xoá `_deltaLine()` + keys `invoices-delta`/`receipts-delta`.
**Số đo**: Flutter **333/333** · analyze **0** · falsify `p44-read-drill` **38/38 RED**. ⚠️ **Review thủ công
(mọi tool review KHÔNG khả dụng) để lại M1/M2 CHƯA sửa** — refresh/retry (`daily_summary_screen.dart:265`
+ `_BlockError.onRetry`) reload HÔM NAY thay vì ngày đang xem; chạm vùng số tiền ⇒ **chờ user quyết**.
Chi tiết: `result74.txt` §2–§3.

**NEXT6 — audit session isolation (Prompt-1, AUDIT-ONLY) — ✅ xong audit, CHƯA code**: `.plan/next6-audit1.md`
(277 dòng) khoanh 11 gap **G1–G11**: store key = `conversation_id` đơn độc (**không principal**) · không lock
per-conversation · `sessionContext` global cross-user · `begin()` replay không kiểm `user_id` · proposal không
bind principal · 429 thiếu `Retry-After` · `DSH_MAX_SESSIONS` chưa dùng · Flutter `_dshConversationId`
(`chat_controller.dart:124`) không persist · thiếu endpoint clear · log `/ask` thiếu `conversation_id`.
File dự kiến sửa: `dsh-gateway.mjs` · `http-ask.mjs` · `idempotency.mjs` · `safety-gateway.mjs` ·
`copilot-server.mjs` · tests · `chat_controller.dart` (KHÔNG chạm `payment-write.mjs`/`authorization.mjs`).
**Chưa tạo** change `next6-session-isolation` (sẽ tạo ở đầu Prompt-2 trước khi code).

### Trạng thái mới nhất (2026-09-25 — đợt next4)

> **4 commit của đợt next4 (branch `change/flutter-chat-mvp`, KHÔNG push):** `7ca1409` feat(mcp-erpnext)
> A3 PDF + B + M1-site · `8a692f1` feat(mobile) kênh FILE `.xml`/`.pdf` + thẻ tạo khách + fix 401 confirm ·
> `47558ce` docs(next4) · `f82f656` fix(payment) P9-D — commit RIÊNG, user duyệt riêng vì **vùng SỐ TIỀN**.
> Suite sau commit: **Node 793** (791 pass, 2 fail `dsh-env` từ B0) · **Flutter 310/310** · analyze 0.

**next5 — DRAWER READ ĐÃ ĐÓNG (D0→D5, 2026-09-26) — ✅ exit criteria §8 10/10 ĐẠT**: 5/5 mục drawer bấm được (Công nợ `receivable_customers` · Nợ quá hạn/Top `overdue_top` sort `days_overdue` DESC · HĐ chưa trả `unpaid_invoices` mỗi dòng = 1 SI `outstanding>0` · Tồn kho nóng `stock_low` kho pin `COPILOT_DEFAULT_WAREHOUSE` fail-closed `STOCK_WAREHOUSE_UNPINNED`, không `warehouses[0]` · Nháp hôm nay `app_drafts_today` = MỘT aggregate `/read/app-drafts` alias cùng code path, partial + sections + dedupe server); **REAL-only** (D0.5 GATE PASS: MOCK/unknown ⇒ panel thay số, không render tiền; ERP chết ⇒ refusal, không 0 giả); **footnote công nợ verbatim §3.1** + số = **GL raw KHÔNG trừ Draft PE** (site có 13 nháp PE 162.092.570đ mà drawer vẫn = REST GL 461.505.625đ/47 khách); **D4 polish**: refresh chạy cả list ngắn (bug thật RefreshIndicator), tiêu đề drill ngày do server ghép (`day_scoped` trong contract, drill toàn công ty giữ nguyên), clear cache khi đổi server/user + màn đang mở đọc lại, badge nháp fail-safe không request, bound đọc 7s (đo thật ≤1,33s); **mỗi list ≥1 verify ERPNext thật** (probe chỉ-đọc, expected từ REST — d1/d1c/d2/d3/d4-verify-real.py); **Node 820/818/2** (2 fail dsh từ B0) · **Flutter 333/333** · analyze **0** · falsify drill **37 ca ALL RED**. Ranh giới đã khai: row-level permission **NO-GO môi trường** (D1.5); dedupe D3 chỉ unit test. Docs D5: `features.md` mục Trụ D + `docs/how-to-test.md` + `.plan/next5/next5-drawer-done.md` + README next5. ✅ **ĐÃ COMMIT `17d6f9b`** (2026-09-26, chưa push). ✅ **Phát hiện ngoài scope "Tóm tắt ngày Hôm qua" ĐÃ SỬA** — commit `ed79f77` (xem đầu file).

**next5/D1 — CÔNG NỢ (lối tắt) + NỢ QUÁ HẠN / NỢ LÂU — ✅ ĐẠT, 2 mục drawer ĐÃ BẬT (2026-09-25)**: contract += `receivable_customers` + `overdue_top`; số = **GL raw KHÔNG trừ Draft PE** (§9) — nháp đi dòng phụ optional `draft_hint {count, amount}` company-wide (không khớp allocation; P9-D giữ effective trên chat); footnote verbatim *"Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp)."* do server gửi; sort `days_overdue` DESC (oldest due_date từng khách, suy server-side từ `due_date`); tái dụng nguyên trạng `DrillListScreen` + provenance gate D0.5. **Verify thật**: drawer == REST **từng khách + tổng** (461.505.625đ · 47 khách · 283 SI · quá hạn 17.764.500) trong khi site có **13 nháp PE (162.092.570đ)** mà số KHÔNG giảm; fresh GET mỗi lần mở (2 `generated_at` khác nhau); truncated trung thực 10/47. **Node 810/808/2** (2 fail dsh từ B0) · `p44` 15/15 · **Flutter 318/318** · analyze 0 · falsify drill **20/20 RED**. Còn `soon`: D1c (HĐ chưa trả) · D2 (Tồn kho nóng — chờ user chốt nguồn kho) · D3 (Nháp hôm nay). Chi tiết: `.plan/next5/D1-result.md`. **Chưa commit.**

**next5 — DRAWER READ (roadmap 5 mục: Công nợ · Nợ quá hạn/Top · HĐ chưa trả · Tồn kho nóng · Nháp hôm nay) — D0 ✅ · D0.5 **PASS** ⇒ CỔNG D1 ĐÃ MỞ**: `D0` map xong 5 mục vào surface READ hiện có + đo site thật ⇒ **2/5 mục dùng được ngay** (Nợ quá hạn · Nháp hôm nay), **3 mục thiếu drill id** (`receivable_customers` · `unpaid_invoices` · `stock_low`), 1 mục cần đổi contract; `custom_ai_action_id` đã có **`search_index=1`** trên 9 doctype ⇒ **D0.7 không cần làm**; **default warehouse MÂU THUẪN** (`Stock Settings` = `Stores - S` **thuộc SANLOAN**) ⇒ D2 phải pin tường minh, **chờ user quyết**. `D0.5` (REAL-only audit) lần đầu **FAIL** đúng luật (payload `MOCK`/không rõ nguồn vẫn render **số tiền** trên 4 path) ⇒ dừng hỏi user; user chốt **(A) ẩn số** ⇒ đã sửa **11 file**: (a) server mang `erp_target` tới `/read/drill` + `/read/list` bằng **cùng biểu thức** `/read/daily-summary` dùng, (b) client thêm **cổng provenance dùng chung** `apps/mobile/lib/core/widgets/data_provenance.dart` gắn vào **3 màn tiền** — `MOCK`/`unknown` ⇒ panel **THAY** số chứ **không** dán nhãn trên số. **Verify trên site THẬT** (gateway restart, env từ `.env`): `/read/drill` → `erp_target "REAL"` (6 khách quá hạn) · `/read/list` → `"REAL"` (42.692.500 · 5 dòng · `truncated`) · process **MOCK** → `"MOCK"` cho phần phục vụ được và **503 `ERP_UNAVAILABLE` / 404 `CUSTOMER_NOT_FOUND`** cho phần không phục vụ được ⇒ **"ERP fail → MOCK success" KHÔNG xảy ra** (đúng thứ §2.2 cấm). **Số đo: Flutter 315/315 (+5) · analyze 0 · Node full 807/805/2** (2 fail `dshGateway*` từ B0). **Phát hiện phụ cho D1**: fixture **chưa hỗ trợ toán tử `>`** (`mock supports only = (got >)`) ⇒ mục "Nợ quá hạn/Top" **không thể** test bằng mock, chỉ verify được trên site thật; `/read/drill` chưa hiện mốc thời gian; 403 chưa có câu riêng; authz chưa có dữ liệu quyền để test negative. Chi tiết: `.plan/next5/D0-result.md` + `.plan/next5/D0.5-result.md`. **Chưa commit.** *(Còn 2 phase chờ quyết trước D1: nguồn kho cho D2 + cách ly company/user trong Settings.)*

**next3/B — Chống trùng theo TỜ hoá đơn (`business_doc_key`) — ✅ ĐÃ COMMIT `7ca1409` (MIGRATION ĐÃ VERIFY)**: cùng MỘT tờ HĐĐT gửi 2 lần ⇒ **1 nháp**; lần thứ hai bị **409 `PO_DUPLICATE_DOC` + nêu tên đơn mua cũ** (mở đơn cũ để sửa, KHÔNG retry được). Khóa `bdk_<sha256>` = `loại chứng từ (đọc từ CONTRACT) + party (MST ưu tiên, fallback id ERPNext) + số HĐ + ngày`: MST thì bỏ separator (định dạng), **số HĐ so chính xác** (bỏ separator = gộp 2 số khác nhau), **không** chứa tiền, **không** gồm series (OCR sau này có thể không đọc được ⇒ lệch khóa giữa 2 kênh = trượt trùng). Định danh đi **NGOÀI câu nói** (`source_document` trên body `/ask`) vì A-result đã đo NLP đọc `00049` thành **49đ**; validate fail-closed **cả 2 đầu** (client thiếu số HĐ/ngày/MST ⇒ gửi KHÔNG có; server ⇒ 400 `SOURCE_DOCUMENT_INVALID` + `reason`). Executor probe trước mọi thứ: có ⇒ 409; **site thiếu cột ⇒ `PO_DOC_KEY_FIELD_MISSING`, KHÔNG ghi** (500 = site misconfig); đọc lại sai khóa ⇒ `PO_WRITE_UNVERIFIED`. Vẫn giữ `command_id`/`custom_ai_action_id` (lớp THÊM, không thay) và **KHÔNG chặn mua nhiều lần với số HĐ khác** (câu nói thường vẫn tạo 2 nháp). **Node mới 10/10 · Node full 765/763/2 (2 fail dsh-env từ B0) · falsify 8/8 RED (A–H, gồm 2 ca Dart) · M1 falsify vẫn 16/16 · Flutter 304/304 (+5) · analyze 0**. **Chờ user**: (1) chạy migration `custom_business_doc_key` trên Purchase Order (1 lệnh, có `--plan-only`/`--dry-run`; trước khi migrate, gửi file XML sẽ bị TỪ CHỐI chứ không ghi thiếu dấu), (2) duyệt commit (chạm đường GHI), (3) cho phép vòng XML THẬT 2 lần cùng file (tạo 1 nháp thật). Giới hạn đã ghi rõ: đường BÁN chưa có lớp này · kênh ẢNH chưa phát định danh · đơn đã hủy vẫn giữ khóa (`unique=1`) · race thật chưa đo. Chi tiết: `.plan/next4/B-dedupe-result.md` + `result68.txt`.

**next3/A3 — HĐĐT PDF có LỚP CHỮ → cùng slots → cùng pipeline nháp — ✅ ĐÃ COMMIT `7ca1409`**, nút chọn `.pdf` phía Flutter ✅ `8a692f1`: **✅ 3 LỖ HỔNG ĐÃ ĐO — NAY ĐÃ SỬA** (2026-09-25, user duyệt "sửa đi"; review vòng 2 ở `.plan/next4/A3-result.md` §9.5, bản sửa + số đo ở **§9.6**): **H1** `invoice_no` rác ⇒ nay chặn theo ngữ cảnh + bắt buộc có chữ số + luật "dòng dưới nhãn phải LÀ giá trị" (probe còn tự tìm thêm 3 ca rác: `"M"` từ dòng MST, `"S"` từ dòng số lượng, `"1"` từ dòng BẢNG) · **M1** có trần OUTPUT (`maxOutputLength` + mã riêng 413; A/B cùng 1 file: 57 ms/+49,1 MB ⇒ **19 ms/+8,5 MB**) · **M2** `readDate` ưu tiên nhãn + chặn theo DÒNG (`Ngày đặt hàng`/`In ngày` không còn thắng) + nhánh `ngày…tháng…năm` nay duyệt xuôi (vá luôn ca Low L2). Thêm **13 test** (`a3` 15→**28/28**) + harness falsify MỚI `scripts/falsify/a3-einvoice-pdf.mjs` (**10/10 RED**, đóng nốt mục "A3 chưa có falsify") · Node full **806/804/2** (2 fail dsh-env từ B0). Còn **4 ca Low + 10 ca đo "không phải bug"** đã ghi ở §9.5. **⏳ CHẬ DUYỆT COMMIT** — **không tự commit** (vùng định danh + trần an toàn). một PDF có lớp chữ đi vào **CÙNG** `/input/einvoice` → cùng schema `slots` → form → câu đã sửa → `/ask` → capability **từ contract** → proposal → confirm → Safety Gateway → **NHÁP** ⇒ **không mở đường ghi mới**. Nguyên tắc: **một con số KHÔNG đọc được thì KHÔNG được điền vào** (dòng `qty × rate ≠ amount` ⇒ **problem** ⇒ TỪ CHỐI). Bộ đọc `src/einvoice/einvoice-pdf.mjs` thuần/đồng bộ/0 dependency (quét object không tin xref · FlateDecode bằng stdlib `zlib` · **ToUnicode CMap** cho font CID/Type0 · ngắt dòng theo **vị trí** · `pdfNumberReadings` trả **mọi cách đọc** — `.` nghìn / `,` thập phân, **KHÁC A1** nên không tái dùng `strictNumber` · **số học của dòng phân xử** mơ hồ). Từ chối theo tên: `NOT_A_PDF · TOO_LARGE · ENCRYPTED · NO_TEXT · COMPRESSED_OBJECTS · TEXT_UNMAPPED · UNSUPPORTED_FILTER · BROKEN`; gửi cả xml+pdf ⇒ 400 `EINVOICE_INPUT_AMBIGUOUS`. Contract += `max_pdf_bytes 650000` · `pdf_reader "text_layer_only"`. **ĐO THẬT (chỉ đọc)**: PDF ToUnicode → **200**, `source=einvoice_pdf`, NCC resolve theo MST (`Đại lý Cám Bình Dương` THẬT, `ambiguous=false`), 2 dòng khớp item THẬT kho, `warnings=[]`, không lộ bề mặt ghi; PDF scan → **422 `EINVOICE_PDF_NO_TEXT`** (chỉ sang camera). **Số thật: Node full 782/780/2 (2 fail dsh-env từ B0) · A3 15/15 · Flutter 304/304 · analyze 0.** **Giới hạn**: không có PDF THẬT của NCC (fixture tự dựng theo cấu trúc provider dùng) · **ObjStm chưa giải nén** (từ chối theo tên) · scan ⇒ camera C · **Flutter CHƯA có nút chọn `.pdf`** (A3 hôm nay đo qua route; thay đổi UI ⇒ cần UI-checkpoint) · chưa có falsify riêng cho A3. Chi tiết: `.plan/next4/A3-result.md` + spike `.plan/next4/A3-pdf-spike.md` + `result69.txt`.

**A2-Flutter — Upload HĐĐT XML trong app — ✅ ĐÃ COMMIT `8a692f1`** (nay nút nhận cả `.pdf` — xem mục A3-Flutter bên dưới): nút **"HĐĐT XML" cạnh camera (cả 2 layout)** ⇒ `file_selector` chọn `.xml` ⇒ `POST /input/einvoice` (JSON `{xml, kind:"purchase"}` — đúng shape route, **không** multipart) ⇒ **form slots SẴN CÓ của camera** (`OcrSlots` + `showOcrSlotsForm`, chỉ đổi wording qua enum `OcrSlotsSource`) ⇒ user sửa ⇒ `OcrCompose` → `/ask` → proposal → **[Xác nhận]** → **NHÁP**. **Không đường ghi mới · không auto-execute · không auto-create master · không parser XML thứ hai** (tripwire tĩnh quét `lib/**.dart`, đã kiểm SỐNG). **Flutter 298/298** (+17, 0 regression) · analyze **0** · `pub get` chỉ +4 package (user duyệt). E2E ERPNext thật của kênh này **không chạy lại** (server đã cover `PUR-ORD-2026-00006`; chạy lại = thêm 1 nháp thật ⇒ cần phép riêng). Chi tiết: `.plan/next4/flutter-xml-upload-result.md` + `result67.txt`.

**next3/M1 — `customer.create` (WRITE #10, master data) — ✅ XONG + E2E THẬT ĐẠT (2026-09-24, M1-site)**: hợp đồng + skill + router/offer + Flutter form/card/nút + test suite riêng (30/30) + falsify (16/16) + `M1-result.md` + **vòng thật**: bỏ hardcode "Múa" (phân loại resolve user→env→site, fail-closed), migration `custom_ai_action_id` đã chạy trên site, pre-check đọc toàn bộ master (`limit:0`), **fix fuzzy theo TỪ** (site có customer tên "A" — substring cũ chặn mọi tên), E2E thật: `/ask` → `/execute` → Customer thật **"Khách Test App M1"** → hỏi công nợ OK → đếm 123→124. **✅ ĐÃ COMMIT `7ca1409`** (2026-09-25, user duyệt) + còn checklist máy thật 28 case (cần APK). Chi tiết: `.plan/next4/M1-site-result.md` + `result66.txt` (M1-SITE).

**P9-D (P9-C-followup) — phiếu thu/chi NHÁP phủ bớt nợ — ✅ ĐÃ COMMIT `f82f656` (2026-09-25, user duyệt RIÊNG vì vùng SỐ TIỀN, KHÔNG push)**: đóng gap §5 của `.plan/result-p9-C.md`. **Đo trước khi sửa**: nháp `PE-M901` 1.000.000 phủ SINV-0001 ⇒ hỏi "thu tiền cho Nguyễn Thị Lan 2 triệu" **2 lần** đều đề xuất **2.500.000** ⇒ bấm xác nhận lần hai = **2 nháp cùng trả 1 khoản nợ** (ERPNext chỉ giảm nợ khi SUBMIT ⇒ nháp là "tiền vô hình"). **Sửa**: builder đọc phiếu NHÁP (`docstatus 0`, limit 10) + `references[]` ⇒ `effective_outstanding` (vẫn giữ GL RAW: `raw_outstanding_vnd`/`draft_cover_vnd`/`draft_cover_docs`); cảnh báo **nêu tên nháp lẫn tên hoá đơn**; phủ hết/phủ quá ⇒ `PAYMENT_DRAFT_COVERED`; executor **đọc lại cùng phép tính** lúc xác nhận ⇒ nháp đổi ở giữa ⇒ `PROPOSAL_STALE`; `detectDrift` so trên giá trị HIỆU DỤNG; trần cứng `requested > liveEffective` ⇒ `PAYMENT_AMOUNT_EXCEEDS_REMAINDER`. Chỉ thêm **2 đường ĐỌC**, không đường ghi mới, không auto-submit. **Số thật**: 6 file test **131/131** · falsify **12/12 RED** (+2 ca MỚI K/L) · Node full **793/791/2** · vòng smoke sau commit trên mock (hỏi 2 lần, KHÔNG submit): 2.500.000 → **1.500.000**, số nháp trong state vẫn **1**. **Giới hạn chưa đo**: race hai phiên cùng bấm · trần 10 nháp áp cho cả hai hướng. Chi tiết: `.plan/next4/P9D-result.md`.

**Bài học đợt next4 → đã lưu vào SKILL (2026-09-25)**: `.agents/skills/erpnext-rest-api-core` §6 (+3 bullet: nháp `docstatus=0` không giảm GL · Link field trỏ giá trị không có trên site + mock dễ dãi hơn site · `limit_page_length: 0` = KHÔNG giới hạn) · `.agents/skills/erpn-verify-first` (+5 dòng bẫy: test dùng lại cùng proposal/khoản nợ cho 2 lần ghi · widget tự POST bằng dio riêng ⇒ bỏ settings ⇒ 401 · guard theo HỆ QUẢ nuốt credit note âm · snapshot lưu giá trị suy-ra nhưng drift so raw · substring gần-trùng lần 3) · **skill MỚI `.agents/skills/untrusted-file-parsing`** (trần OUTPUT khi inflate · regex nhãn có nhánh ngắn trần · không lấy số/ngày ĐẦU TIÊN tìm thấy). ⚠️ **Simplenote MCP không khả dụng** trong phiên này ⇒ bản cross-project (dùng chung nhiều project) **chưa ghi được**.

**P9 (backlog WRITE) ĐÃ XONG tới P9-E + ĐÃ ĐÓNG (P9-G)** — 4 WRITE mới (`delivery.create` WRITE #5, `purchase_receipt.create` WRITE #6,
đều **NHÁP only**), `payment.create` **học hướng CHI** (chi tiền NCC, KHÔNG capability mới),
`sales_invoice.create` (WRITE #7) và `stock.adjustment` (WRITE #8, xuất hủy — đã chạy **loop thật** trên site) + `sales_return.create` (WRITE #9, P9-F — khách trả hàng = SI nháp `is_return=1`).
P9-C đóng một **misroute thật đo được**: Phase 1 gộp `trả tiền`/`thu tiền` vào một nhãn `payment` ⇒ lệnh CHI
đi vào đường THU; nay hướng suy từ **sổ nào giữ tên đối tác**, câu nói chỉ để **phát hiện mâu thuẫn**.
Chi tiết: `.plan/result-p9-0.md` · `result-p9-A1/A2.md` · `result-p9-B.md` · `result-p9-C.md` (P9-C **đã duyệt, chưa push**) · `result-p9-D.md` · `result-p9-E.md` · đóng: `result-p9-done.md`.

**plan5 (P5-0 → P5-4) ĐÃ XONG** — 3 khe hở cụ thể của plan5_final được vá, không thiết kế lại kiến trúc:
`submit_error_kind` + hướng dẫn theo loại lỗi · `posting_date` đóng băng lúc hỏi **và** được validate fail-closed · badge NHÁP/ĐÃ NỘP + glyph cùng trạng thái · copy setting rõ OFF/ON · **voice-first layout thứ hai** (Huỷ + cap 25s + VAD vào config). Chi tiết: `.plan/result-p5-0..4.md` · tóm tắt `checklist.md`.

**Đã push + CI xanh (mới nhất 2026-09-25)**: `9ac14ef..0755441` (9 commit, **fast-forward**, KHÔNG clone/merge) →
run [`36107839795`](https://github.com/hoangsoft90/erpn_mobile1/actions/runs/36107839795) **success** ~5,5 phút →
artifact `erpn-chat-debug-apk` **85.395.565 bytes (81,44 MB)**, hết hạn 2026-12-24.
Bằng chứng binary (`kernel_blob.bin`): `HĐĐT` ×4 · `EINVOICE_PDF_NO_TEXT` ×2 · `pdf_base64` ×3 · `file_selector` ×87 ·
`Tạo khách mới` ×3 · `applySettings` ×14 · `OcrSlotsSource` ×9 · endpoint nhúng `https://erpn8788.loca.lt`.
(Lần push trước: `53e1851` → run `35688782230` → 81,4 MB.)

**Sắp tới, theo thứ tự chờ duyệt:**
1. ✅ **A3 H1/M1/M2 ĐÃ SỬA** (2026-09-25, user duyệt "sửa đi") — `invoice_no` rác · trần OUTPUT khi `inflateSync` · `readDate` lấy ngày đầu tiên. Thêm 13 test (`a3` 15→**28/28**) + harness falsify MỚI `scripts/falsify/a3-einvoice-pdf.mjs` (**10/10 RED**, đóng nốt mục "A3 chưa có falsify"). **⏳ CHỜ USER DUYỆT COMMIT** (vùng định danh + trần an toàn ⇒ AI không tự commit) — `.plan/next4/A3-result.md` §9.6.
1a. ✅ **L1 + L3 ĐÃ SỬA** (2026-09-25, user yêu cầu "sửa nốt"): L1 cap dòng nay chạy **khi dựng** (`EINVOICE_PDF_TOO_MANY_LINES`, HTTP 413, trần `max_lines × 100` = 20.000 dòng) · L3 guard sync/pure nay áp cho **MỌI** module `src/einvoice` (trước chỉ gọi tên `einvoice-xml.mjs`). `a3` **29/29** · `a1`+`a2`+`a3` **54/54** · Node full **807/805/2** · falsify **12/12 RED** (+ca L/M).
1b. **UI-checkpoint** cho nút HĐĐT nhận `.pdf` (commit `8a692f1` đã vào — chưa chụp màn hình cho user duyệt).
1c. ✅ **VÒNG XML THẬT 2 LẦN CÙNG FILE — ĐÃ CHẠY ĐẠT** (2026-09-25, user cho phép ghi): lần 1 `200` ⇒ **`PUR-ORD-2026-00007`** · lần 2 **409 `PO_DUPLICATE_DOC` + `existing_doc` đúng tên đơn đó** · đếm PO độc lập **6 → 7 = +1** · kiểm chứng bản ghi: docstatus 0, khoá `bdk_ca5eaafe…` chỉ 1 đơn mang, tổng 4.175.000 VND (rate từ ERPNext). **⚠️ Bắt được 1 lỗi DEPLOYMENT (đã thêm + verify)**: thiếu `COPILOT_COMPANY` ⇒ `/execute` 500 `PO_COMPANY_UNRESOLVED` (site có 3 company, app không gửi company) — đã thêm `COPILOT_COMPANY="Minh Phát Cám & VLXD"` vào `.env` và **verify chỉ-đọc**: gateway cấp đúng company (`enforced=true`) · executor resolve được company đó trên site · chạy lại đường [Xác nhận] ⇒ **409 `PO_DUPLICATE_DOC` thay vì 500**, PO 7→7 (không ghi gì) — **còn 1 bước vận hành: server đang phục vụ app (`erpn8788.loca.lt`) KHÔNG chạy ở máy này ⇒ phải thêm biến vào môi trường server đó + RESTART** (process đang chạy không đọc lại `.env`). Chi tiết: `result72.txt` + `.plan/next4/B-dedupe-result.md` §10.
1c-bis. ✅ **CHỨNG MINH ĐƯỜNG [XÁC NHẬN] TẠO ĐƯỢC NHÁP (2026-09-25, `result73.txt`)** — đúng việc còn thiếu của 1c (lần trước chỉ chạy tới 409 nên **không phân biệt được** company đã mở hay chưa). Đã **restart stack thật** (`python3 -m nlp_service.server --port 8787` + `node src/http-ask.mjs --port 8788 --host 10.88.0.4`, env lấy từ `.env`; bind IP **private** để giữ basic auth của `.env` mà **không expose public** — loopback + `ASK_USER` thì code **throw**): `ready … "auth":true` · `/health` không auth **401** / có auth **200**. Gửi **file XML MỚI** `C26TYY/0000128` (khoá nghiệp vụ chưa từng có ⇒ cổng chống trùng không thể là thứ trả lời) qua **HTTP thật + basic auth**: `/input/einvoice` 200 → `/ask` 200 (`create_purchase_order`) → **`/execute` 200 ⇒ NHÁP `PUR-ORD-2026-00008`** (**hết 500** `PO_COMPANY_UNRESOLVED`), đếm PO **7 → 8 = +1**; REST độc lập: docstatus **0**, company `Minh Phát Cám & VLXD`, supplier đúng, items `CAM-GA-25KG×12 @270.000` = **3.240.000đ**, khoá `bdk_68055489…` **chỉ 1 đơn**. ⚠️ **Nhưng: `erpn8788.loca.lt` trả 503 + `lt` chưa cài ở máy này** ⇒ server phục vụ **app** vẫn là máy khác, **vẫn phải** thêm `COPILOT_COMPANY` + restart **ở máy đó** thì app mới hết 500. Script `.plan/next4/loop-xml-confirm-draft.mjs` + fixture `.plan/next4/fixtures/xml-new-invoice.xml`.
1c-ter. ❌ **RETEST QUA TUNNEL (`erpn8788.loca.lt`, đúng đường app) — VẪN 500 (2026-09-25, `result73.txt` §6)**. User restart server đầu kia ⇒ tunnel **sống lại** (không auth **401** / có auth **200** — server đó bind non-loopback + auth, đúng như `.env`) NHƯNG gửi file MỚI `C26TYY/0000130` ⇒ `/input/einvoice` 200 → `/ask` 200 → **`/execute` 500 `PO_COMPANY_UNRESOLVED`** (*"có 3 company … và chưa pin company"*), đếm PO **9→9** (fail-closed, không ghi gì). ⇒ **Môi trường của MÁY ĐÓ vẫn thiếu `COPILOT_COMPANY`**; `.env` của repo này có nhưng máy đó không dùng nó. **VIỆC CẦN LÀM (user, ở máy đó)**: thêm `COPILOT_COMPANY="Minh Phát Cám & VLXD"` vào `.env`/unit/export của process gateway → restart → tự kiểm `curl -u … https://erpn8788.loca.lt/health`. Kèm **cảnh báo build APK**: repo hiện **không có Variables/Secrets nào** ⇒ workflow truyền `--dart-define` **rỗng**, mà đo Dart cho thấy define rỗng ⇒ `''` (KHÔNG lấy default) ⇒ APK sẽ không có endpoint
1d. **Nháp THẬT trên ERPNext** cho P9-D (ghi 1 Payment Entry nháp rồi hỏi lại) — GHI thật, cần user cho phép.
1e. **Việc chưa làm của A3**: ~~falsify riêng~~ ✅ đã có (`a3-einvoice-pdf.mjs`) · giải nén ObjStm (hiện từ chối theo tên) · PDF THẬT của NCC (fixture hiện tự dựng byte-by-byte).
2. **USER**: revoke token `ghp_…7aO` (đã lộ qua chat) / hoặc bật deploy key WRITE; duyệt **2 layout P5-4**; test tay auto-send trên máy Android thật; (policy §5 M1 đã áp default: SĐT/MST khuyến nghị, trùng ⇒ từ chối).
3. **Việc còn treo từ plan4**: `docs/plan4-mode-map.md` (P4-0) chưa tạo · idempotency B2/B3/B4 trên site thật · 4 kịch bản `result*.txt` của P4-3/P4-4/P4-5/P4-6 chưa tách (bằng chứng đang nằm trong `.plan/`, mà `.plan/` bị gitignore).
4. **WRITE đầu tiên còn lại của Phase 7** (`create_payment_entry`) v.vẫn phải qua Go/No-Go gate như cũ.

**Định vị sản phẩm:** không phải "chatbot ERPNext", mà là **lớp AI UI trên ERPNext** —
`understand → plan → act → verify → report`. Chat/voice chỉ là phương thức nhập liệu.
Client đích đã chốt: **Flutter** (không phải PWA).

---

## Đã hoàn thành

### P9-C — `payment.create` học hướng CHI (chi tiền NCC), không capability mới — ✅ ĐÃ DUYỆT, CHƯA PUSH (2026-09-23) — `.plan/result-p9-C.md`

> **Đã duyệt (user chốt 2026-09-23, chưa push — máy không có git).** Vùng SỐ TIỀN/HƯỚNG TIỀN.

- **§0 đo được cả một lớp lệnh CHI đi sai đường**: `src/vietnamese_nlp/synonyms.py` gộp `trả tiền` + `thu tiền` vào
  MỘT nhãn `payment`, còn `payment-write.mjs` hardcode `Receive`/`Customer`/`Sales Invoice` ⇒ **"trả tiền NCC …" tạo phiếu THU**
  (NCC trùng tên khách thì ra sai hẳn chứng từ). `chi xăng 200 nghìn` / `chi tiền mặt 500 nghìn` = `UNKNOWN_INTENT`;
  `chi 2 triệu trả NCC Hà Tiên` rơi vào `payment.history` (đọc). ⛔ Không sửa `synonyms.py` (Phase 1 dùng chung mọi đường).
- **User chốt 2026-09-23**: mở rộng `payment.create` (KHÔNG capability mới) · câu chi **không có** đối tác ⇒ **TỪ CHỐI kèm giải thích**.
- **Đã ship**: contract `direction_policy` (không nhận `direction` từ request) · slot `customer` → `party` · skill 2 hướng bằng **một bảng `DIRECTION_SPEC`**
  · resolve tên trên CẢ hai sổ (bỏ số tiền nói ra) · câu nói chỉ kiểm **mâu thuẫn** · READ lịch sử theo hướng · mock sổ phải trả `2110`
  · Flutter nhãn theo hướng (badge P5-3 giữ nguyên, storage key không đổi) · **harness đột biến trong repo** `scripts/falsify/p9c-payment-pay.mjs` (**9/9 RED**).
- **4 lỗ hổng review tìm được, đã sửa**: (1) `verifyWrittenPayment` **không chứng minh hướng tiền** (chỉ so `party`, mà id giống nhau ở cả hai phía) ⇒ thêm `payment_type`/`party_type`;
  (2) ca đột biến G của tôi trỏ sai test (assertion ở tầng E2E, không phải builder) ⇒ sửa `only` + ghi lý do trong harness;
  (3) 2 thông báo lỗi gọi sai sổ cho hướng chi (chỉ đổi chữ, giữ mã) ; (4) `PAYMENT_PARTY_NOT_SUPPLIER` giữ nguyên nhân thật (`readError`).
- **Số thật**: `p9-pay` **19/19** · Node **603 — 601 pass, 2 fail** (`dsh-gateway`, lỗi môi trường DSH từ B0; baseline 584/582 ⇒ +19 test, **0 regression**)
  · Flutter **268/268** + analyze **0** · **9/9 đột biến RED** + restore byte-identical.
- **Giới hạn đã ghi rõ (user chốt "để lại, làm sau")**: nháp chi/thu **không làm giảm** `outstanding_amount` ⇒ hỏi lại lần 2 vẫn thấy đủ nợ
  (khác delivery đã có `openDraftCover`) — xem mục **P9-C-followup** ở `## Sắp tới`. Chưa có picker NHÀ CUNG CẤP (tên mờ ⇒ từ chối, không tự chọn).
  Chi phí cửa hàng không có đường ghi (cố ý — JE ngoài phạm vi).

### ISSUE1 — tắt fallback-mock ngầm (2026-09-21) — `result63.txt`

> KỸ THUẬT XONG, CHỜ DUYỆT COMMIT (vùng loại trừ an toàn: ranh giới tin cậy của nguồn dữ liệu).

- **Gốc**: `pickServerScript()` coi "thiếu `ERPNEXT_*`" là tín hiệu chọn `mock-server.mjs`
  (hard-code `CUST-00001 = "Nguyễn Thị Lan"`) ⇒ launcher `dsh` quên export ⇒ **fail-OPEN duy nhất**
  ⇒ agent kể dữ liệu fixture như ERPNext thật.
- **Fix**: cổng xin phép tường minh `COPILOT_MOCK_OK === "1"` (ĐÚNG chuỗi, truthy lookalike từ chối)
  ⇒ thiếu cấu hình **THROW `ERPNEXT_NOT_CONFIGURED`**; giữ mock cho CI/suite (`npm test` set biến).
- **Khoá**: tripwire tĩnh (không file nào khác được chạm `MOCK_SERVER`) + falsify in-repo 5/5 RED
  + tái hiện bug gốc (exit 2, stdout RỖNG) kèm control.
- **Audit**: không patch dsh nào chứa biến opt-in; host chết VẪN resolve REAL (không hồi sinh mock);
  **không rò secret**. CI workflows không có trong checkout ⇒ chưa sửa được.
- ✅ **Bug resolver ĐÃ SỬA** (user duyệt "fix ngay"): rule 2b — bỏ hit duy nhất khi tên ERPNext còn
  token phía sau + token kế tiếp là name-like (không số, không thuộc từ vựng ý định của router) +
  token đó không có trong tên row; chặn cả vị trí bắt đầu. **Đo ERPNext THẬT 11 câu ⇒ chỉ 1 dòng
  đổi, đúng ca bug** (`Nguyễn Thị B` → `AMBIGUOUS_ENTITY`), 10 ca còn lại y nguyên.
- ✅ **`http-ask` validate lúc BOOT** (user chọn thêm): thiếu cấu hình ⇒ exit 1, không bind cổng.
- ⚠️ **Gap phủ sóng cần task riêng (Phase 6)**: tên nhiều từ thật vẫn MISSING/AMBIGUOUS
  (`Anh Ba — xây nhà`, `Chú Bảy — chăn nuôi`, `Công trình nhà ông An` khớp nguyên văn mà vẫn MISSING);
  một phần do **Phase 1 stripper ăn mất tên** (`'Anh Ba xây nhà'` → `'xây nhà …'`). Không phải lỗ
  hổng an toàn (thận trọng, không sai khách) — `result63.txt` §9.3.

### P4-1 — `ops.daily_summary` (backend skill + test) — ĐÃ DUYỆT, CHỜ MÁY CÓ GIT ĐỂ COMMIT (2026-09-21) — `result-p4-1.txt`

> Vùng **liên quan SỐ TIỀN** ⇒ AI không tự ký duyệt commit (Ponytail loại trừ an toàn nhóm 2).

- **Contract + skill**: capability READ `ops.daily_summary` (`route_group: ops`, no confirm, **không thêm keyword**
  ⇒ đường chat không đổi) · `src/skills/ops-summary.mjs` cộng **server-side** 8 block đúng schema §4.3
  (SO tách `submitted`/`draft`; SI/PE chỉ submitted + `grand_total`; chi chỉ PE Pay + footnote JE;
  két = GL trước 00:00 VN trên `default_cash_account`; Cash|Bank theo **`Account.account_type`** như P4-0 khuyến nghị).
- **Partial §4.3**: một nhánh lỗi ⇒ block `null` + `errors`, **không bao giờ 0 giả** · company **từ session**.
- **Đo trước trên site thật** (đổi cả thiết kế): filter value **phải là string** (số ⇒ TOOL_ERROR) ·
  `count` = **số dòng trả về** (limit 3 → count 3) ⇒ phải thử `limit+1` mới biết bị cắt trang ·
  `custom_ai_action_id` **chỉ có trên Payment Entry**.
- **5 lỗi thật do review bắt rồi sửa**: filter số làm `receivables` chết trên site · `app_drafts`
  `catch {}` báo **0 nháp giả** · có thể **cộng thiếu im lặng** khi trang bị cắt (guard `ERP_TRUNCATED`) ·
  `cashDrawer` trả 0 giả · guard **không falsifiable** ⇒ tripwire tĩnh (strip comment).
- **Bằng chứng**: Node **484 (482 pass, 2 fail dsh-env từ B0)** · P4-1 **23/23** · falsify **12/12 RED** · Python **62 OK**.
- **Vòng lặp THẬT (read-only)**: `receivables 551.910.625` khớp **chính xác** cộng độc lập qua REST (295 HĐ) ·
  két khớp chuỗi 3 ngày liên tiếp ⇒ công thức §3.6 đúng trên dữ liệu thật.
- ✅ **Đã sửa (user duyệt)**: `action_id`/`command_id` do **client** gửi không kiểm kiểu ⇒ nếu là số thì tool thật từ chối ⇒ executor
  **từ chối ghi oan** kèm chẩn đoán sai "ERPNext chưa có field — chạy migration" (fail-closed, không có nguy cơ ghi trùng)
  → validate ở **BIÊN HTTP** (`correlationIdProblem` ⇒ 400 `INVALID_CORRELATION_ID`, đặt trước rate-limiter) + test + falsify MỚI
  `scripts/falsify/execute-id-types.mjs` **3/3 RED**.
- ✅ **Đã sửa**: filter số **cùng lớp ở B2/B3** (`Item Price` `selling = 1` → đọc Item Price CHẾT trên site thật) → `"1"`
  + **tripwire toàn repo** `test/filter-literal-types.test.mjs` (quét mọi `.mjs` trong `src/`) + falsify K/M; site thật: `selling="1"` → 27 dòng Item Price · B2+B3 **41/41**.
- ✅ **Đã đo** (`--dry-run`, chỉ đọc): `custom_ai_action_id` **ĐÃ CÓ trên Payment Entry**, **THIẾU trên Purchase Order / Quotation / Sales Order**
  ⇒ **correlation B2/B3/B4 hiện chỉ đứng với mock**; ❓ chờ user quyết có tạo field trên ERPNext không.
- **Tiếp theo**: P4-2 = route `/read/daily-summary` (**XONG**, xem dưới) → P4-3 Flutter drawer.

### P4-2 — Route `GET|POST /read/daily-summary` — KỸ THUẬT XONG, CHỜ MÁY CÓ GIT + DUYỆT COMMIT (2026-09-21) — `result-p4-2.txt`

> Vùng **đọc SỐ TIỀN** của cả công ty ⇒ AI không tự commit; đây là **route** nên chưa chạm gateway ghi.

- **Route** trong `src/http-ask.mjs`: **không** qua NLP/classifier (capability id cho sẵn) · `date` optional ở body **và** query
  (body thắng) · thiếu/rỗng = **hôm nay tại tiệm** (`Asia/Ho_Chi_Minh`, không phải ngày host) · 400 `INVALID_DATE`
  (regex **không đủ** — `2026-02-30` chặn bằng round-trip lịch).
- **Company server-side tuyệt đối**: pin config → `Global Defaults.default_company` (đo: Single ⇒ `doc_list` 500, `doc_get` OK;
  `User.default_company` 417) · không có ⇒ **503 `COMPANY_UNRESOLVED`** · client gửi `company` khác ⇒ **403 `COMPANY_SCOPE_MISMATCH`**.
- **Auth/limit**: 401 basic-auth non-loopback (giống `/ask`) · `authorize` **trước mọi lần đọc ERP** (403) · bucket **READ** (429) charge sau parse, trước authz.
- **Partial đi thẳng response**: 200 + `meta.partial` + block `null` + `errors` — không viết lại, không gộp 5xx.
- **3 lỗi thật do review bắt rồi sửa**: (1) `pickServerScript`/`createMcpClient` **ngoài `try`** ⇒ ERP chưa cấu hình làm **process chết**
  (kéo cả `/ask` theo) → đưa vào `try` + test "can never take the service down"; (2) mã `TOOL_ERROR` của tầng MCP lộ ra client → whitelist
  theo spec (`ERP_UNAVAILABLE`), log giữ mã thật; (3) **`client.close()` treo vĩnh viễn** khi child đã chết (đo: `TIMEOUT` 3000ms)
  ⇒ handler gọi `close()` trong `finally` không bao giờ return (rò socket+child mỗi request lỗi, mọi route READ) → `close()` **idempotent** + test riêng.
- **Bằng chứng**: Node **505 (503 pass, 2 fail dsh-gateway từ B0)** (+20) · P4-2 **19/19** + client **9/9** · falsify **14/14 RED** · Python **62 OK**.
- **Vòng lặp THẬT (read-only)**: 200 + `date` mặc định = hôm nay VN + `company` từ **session** · `GET == POST` · `partial=true`
  (`app_drafts` null + lỗi Frappe: site thiếu `custom_ai_action_id`) · `2026-02-30` → 400 · claim `SANLOAN` → 403 ·
  **đối chiếu chéo REST độc lập**: `receivables 493.440.625` (286 HĐ) **khớp chính xác**, SI ngày 575.000/1 khớp.
- 🎓 **Bài học (LESSONS nhóm 21)**: env rò giữa test ⇒ test sau xanh **vì lý do khác** (khôi phục đúng key mình chạm) ·
  `--test-name-pattern` khớp **0 test** vẫn exit 0 ⇒ harness escape + đếm test chạy + xanh-**trước**-mutate ·
  client/spawn ngoài `try` trong async handler **giết cả service** · "company của session" phải **đo đường đọc** (Single vs 417).
- **Tiếp theo**: **plan4 V1 ĐÃ KHÉP** — P4-0 → P4-6 xong, P4-7 đóng (12/12 case §7 có test, xem mục đầu). Việc còn lại **không phải code**: **commit** (máy chưa có git) + **B2/B3/B4 idempotency trên site thật** + **APK** (user chốt "để sau").
  ❓ chờ user: duyệt commit hàng chờ P4-1→P4-6.

### Rà harness toàn repo (sau P4-7) — ✅ 10/10 ALIVE, bắt 1 harness chết-im (2026-09-21)

> Chạy đủ 10 harness (c0/c1/c2 · execute-id-types · issue1-mock-optin · issue1-resolver · p4-ops/p42/p43/p44).

- **c2-ocr CHẾT IM**: spawn `node --test` **thiếu `COPILOT_MOCK_OK=1`** (mà `npm test` có) ⇒ baseline đỏ 3 test route ⇒ exit **trước mọi case** ⇒ **0/10 ca C2 được kiểm** mà không ai hay — chỉ an toàn nhờ quy tắc "baseline phải xanh" của chính harness. Đã sửa (`env: {...env, COPILOT_MOCK_OK:"1"}`) ⇒ **ALL C2 GUARDS FALSIFIED (10/10)**.
- **Sentinel 403 bám thêm contract client thật**: grep node_modules 3.0.4 — `FrappeAPIError` **throw** khi `!response.ok` (message `[FrappeClient] … failed: … (HTTP 403)`); thêm test khẳng định regex UI khớp **đúng text thật**, không chỉ wording mock ⇒ p4-ops **25/25** · Node **525 (523 pass, 2 fail dsh từ B0)**.
- **9 harness còn lại: ALL ALIVE** (đã chạy lại đủ sau sửa) · 0 mutation sót (kiểm `.falsify-bak` + `if (false)`).
- 🎓 **Bài học → LESSONS đợt rà-harness (5 bullet) + skill `erpn-verify-first` (+2 hàng)**; openspec `flutter-chat-mvp` ghi STATUS (2 task chờ USER).
- ❓ chờ user: duyệt commit P4-1→P4-6.

### P4-7 — Đóng plan4 V1: §7 đối chiếu 12/12 + docs — ✅ XONG (2026-09-21) — `result-p4-done.txt`

> Việc còn lại của plan4 V1 **không phải code** mà là chứng minh: 12 case §7 ↔ test thật, rồi chốt docs cho người dùng đọc.

- **§7: 12/12 có test** (trước phiên này 11/12). Case thiếu là **§7.6 "thiếu quyền một doctype"** ⇒ đã bổ sung: sentinel `__FORBIDDEN__` trong mock (mô phỏng Frappe PermissionError/403 — trạng thái site thật mà fixture trước đây không thể tái hiện) + test khẳng định block **NULL, không phải 0** (khác biệt này là **tiền**: "chưa bán được gì" vs "không đọc được") + ca falsify **O**.
- **Số thật**: Node **524 (522 pass, 2 fail dsh từ B0)** · Flutter **248/248** · analyze **0** · Python **62** (`PYTHONPATH=src python3 -m unittest discover -s tests -q`) · falsify p4-ops **15/15** · p42 **15/15** · p44 **20/20** · p43 **11/11** — **0 PROBLEM**.
- **2 anchor falsify bị trôi** (code đổi sau khi viết ca): **L** (`appDrafts`, P4-5) và **F** (`http-ask`, P4-4) ⇒ harness báo `anchor missing` (không im lặng bỏ qua) ⇒ sửa cả hai. *Ca bị bỏ qua trông y hệt ca đã pass.*
- **FAQ cho người dùng**: `faq.md` **§10 — cách đọc màn `Tóm tắt ngày`** (từng mục nghĩa gì, 3 thứ không được đọc sai, `Hôm qua` đổi bán/thu và thẻ hiện ĐÚNG số ngày đang xem còn công nợ luôn hiện tại · delta đã bỏ) + sửa 2 chỗ đã lỗi thời (§4.3 "tổng hợp theo ngày chưa có" ⇒ nay có ở drawer; §7 danh sách "không làm").
- **Đúng lệnh dừng**: không skill WRITE mới (P9), không Redis, không két WRITE.
- ❓ chờ user: duyệt commit **P4-1→P4-6** (máy chưa có git) · B2/B3/B4 idempotency trên site thật · APK (user đã chốt "để sau").

### P4-6 — Hôm nay | Hôm qua (đọc theo ngày) — KỸ THUẬT XONG, CHỜ DUYỆT COMMIT (2026-09-21, cập nhật 2026-09-26) — `result-p4-6.txt`

> Selector đổi ngày cho **bán/thu** — thẻ hiện **đúng số của ngày đang xem**; công nợ **luôn là số hiện tại**.

- **Không đụng server**: route đã nhận `date` từ P4-2 (§0 xác nhận bằng đọc code) — P4-6 thuần Flutter.
- **Flutter**: `SegmentedButton` (Hôm nay mặc định / Hôm qua) · chọn Hôm qua ⇒ 2 thẻ bán/thu hiện **số của hôm qua** (đọc lỗi/chưa xong ⇒ *"Chưa đọc được ngày hôm qua"* + `Thử lại`, **không** hiện số hôm nay) · note "công nợ là hiện tại" khi xem Hôm qua · drill truyền ngày đang xem (giữ `null` cho Hôm nay ⇒ server quyết định).
- 🔧 **Cập nhật 2026-09-26 (fix phát hiện ngoài-scope từ next5/D4)**: trước đây chọn Hôm qua **đổi tiêu đề nhưng số vẫn của hôm nay** ⇒ đã sửa cho khớp; **bỏ dòng delta**. Bằng chứng: Flutter **333/333** · analyze **0** · falsify p44 **38/38 RED**.
- **Đọc Hôm qua LƯỜI**: chỉ fetch khi user chọn — vừa giữ 1 lượt ERP/lần mở, vừa sửa bug re-mount làm delta biến mất im lặng.
- **Bằng chứng**: Flutter **248/248** (+6) · analyze **0** · Node **523 (521 pass, 2 fail dsh từ B0)** · falsify **20/20 RED, 0 PROBLEM** (+3 ca) · vòng thật: 2 ngày **200/`partial=false`**, **receivables GIỐNG HỆT ở 2 ngày** ✅ §3.4, cross-check ALL MATCH.
- 🎓 **Bài học**: **kill harness giữa chừng ⇒ mutation sót trên đĩa** (đã thêm restore-on-signal) · case falsify trỏ **sai suite** ⇒ harness báo PROBLEM chứ không RED giả · **assert yếu** ("có request" ≠ "đúng ngày") bị falsify bắt · **field thêm vào model mà không nối vào call site** vẫn là bug · **probe thiếu lọc company** (lần 3) ⇒ nghi mình trước khi nghi server.
- ❓ chờ user: duyệt commit (vùng đọc SỐ TIỀN, máy chưa có git).

### P4-5 — Block nháp app hôm nay — KỸ THUẬT XONG, CHỜ MÁY CÓ GIT + DUYỆT COMMIT (2026-09-21) — `result-p4-5.txt`

> Block `app_drafts` + drill `app_drafts_today` cùng một nguồn; **chỉ nháp CỦA APP** (`custom_ai_action_id` set), không nhầm mọi draft site.

- **Server**: field list **theo doctype** — `grand_total` cho SO/QT/PO, `paid_amount` cho PE (PE **không có** `grand_total` — đo meta thật: DocField rows=0, hỏi ⇒ 417 giết cả cụm); row COPY giá trị chứng từ, không tự tạo 0; giữ filter id + docstatus 0 + trong ngày + company scoping.
- **Flutter**: row nháp dẫn bằng CHỨNG TỪ, money side **"—"** (không 0đ); **CẤM ghi/xoá/submit** từ drill (assert 7 cụm + cấu trúc + log request).
- **Bằng chứng**: server drill **12/12** · Flutter drill **9/9** · falsify **17/17 RED** (+3 ca P4-5) · Node **523 (521 pass, 2 fail dsh từ B0)** · Flutter **242/242** · analyze **0** · vòng thật: drill nháp **200**, drill=block=0 (site chưa có nháp trong ngày), ALL MATCH.
- 🎓 **Bài học (LESSONS đợt P4-4 bổ sung + skill +2 hàng)**: field list cho NHIỀU doctype phải đo meta từng doctype (mock không biết schema thật ⇒ vòng thật là phép kiểm duy nhất) · "không 0 giả" ở TỪNG ROW.
- ❓ chờ user: duyệt commit · P4-6 (optional) hôm qua + delta.

### P4-4 — Drill-down structured — KỸ THUẬT XONG, CHỜ MÁY CÓ GIT + DUYỆT COMMIT (2026-09-21) — `result-p4-4.txt`

> Tap chỉ số trên màn Tóm tắt ngày → list ≤10 theo id CỐ ĐỊNH (không classifier, không /execute).

- **Server**: `drill_screens` 5 id trong contract (fail-closed) · `readDayDrill` dùng lại đúng primitive của `ops-summary` (số dòng luôn khớp block — **guard chống drift** assert tổng = số block trên cùng fixture) · route `/read/drill` (auth/READ bucket/partial như P4-2, company qua helper dùng chung).
- **Flutter**: `DrillListScreen` (Back/retry/truncated trung thực/không affordance ghi) · route `/drill` fail-closed · tap qua `context.go`.
- **Bằng chứng**: Node **519 (517 pass, 2 fail dsh từ B0)** · Flutter **241/241** · analyze **0** · falsify **12/12 RED** (harness lib dùng chung) · Python **62 OK** · vòng thật: **ALL MATCH** (5/5 drill ↔ summary, 2026-09-21).
- 🎓 **Bài học (LESSONS đợt P4-4)**: COUNT SQL gộp null ⇒ đếm bằng list đã lọc · guard drift bắt drift trước vòng thật · test cũ dùng store dùng chung ⇒ độc hại lần chạy sau · `Navigator.pushNamed` không qua GoRouter.
- ❓ chờ user: duyệt commit · **P4-5** nháp block chi tiết (tiếp theo).

### P4-3 — Drawer + màn `Tóm tắt ngày` — KỸ THUẬT XONG, CHỜ MÁY CÓ GIT + DUYỆT COMMIT (2026-09-21) — `result-p4-3.txt`

> Vùng **đọc SỐ TIỀN** ⇒ AI không tự commit. Màn này **chỉ đọc**: mọi thay đổi tiền vẫn qua chat + card xác nhận (§2).

- **Flutter**: `features/ops/` (data/application/presentation) — model parse §4.3 (block `null` ⇒ thẻ lỗi **riêng**, không 0 giả) · cache prefs **45s** · screen + drawer + footer dùng chung.
- **Route `/summary`**: **không** `extra`, **không** tham số (một aggregate server-side; company quyết định ở server).
- **Server (nhỏ, bắt buộc bởi §2)**: `meta.erp_target` = `erpTargetLabel(env)` — **cùng helper** với dòng log khởi động ⇒ footer REAL\|MOCK **không thể** lệch log; không ai nói ⇒ `null` ("không rõ nguồn"), **không** mặc định REAL.
- **Trạng thái §6 đủ**: skeleton · OK + stamp · partial theo từng block + `Thử lại` · offline giữ số cũ + **DỮ LIỆU CŨ** · empty day chỉ khi `partial=false`.
- **Bằng chứng**: analyze **0** · `daily_summary_test` **25/25** · Flutter **233/233 pass** (probe P2b đã xoá theo quyết định user) · falsify **11/11 RED** · Node **508 (506 pass, 2 fail dsh từ B0)** · real loop: `erp_target=REAL` khớp log + cross-check REST **493.440.625 / 575.000** khớp chính xác.
- 🎓 **Bài học (LESSONS nhóm 24/25)**: nhãn provenance phải **dẫn xuất từ 1 hàm** · probe tạm bỏ quên ⇒ đỏ giả (quy trách nhiệm bằng bằng chứng) · fixture `??` ăn mất `null` · falsify bị nhánh khác che ⇒ fixture phải **cô lập đúng biến**.
- **Tiếp theo**: P4-4 drill structured (dùng pattern A1 `/read/list`) · P4-5 nháp chi tiết;
- ✅ **Đã gỡ chốt cùng phiên**: `custom_ai_action_id` **đã tạo trên site thật** cho SO/QT/PO (4/4 doctype `unique=1 search_index=1`, verify độc lập 3 lớp + control âm + idempotent) ⇒ vòng lặp thật nay **`partial=false`**; cross-check REST **488.040.625 / 281 HĐ** khớp. **APK: user chốt để sau** (không push/không `git init`).
  ❓ còn chờ user: duyệt commit (máy chưa có git) · **B2/B3/B4 idempotency trên site thật** (field đã có ⇒ giờ mới chứng minh được, cần chạy ghi thật — chưa được phép ⇒ **vẫn chỉ đứng với mock**).

### P3 (phases3) — Trụ B (WRITE #2–4) + Trụ C (camera) + A1 drill-down — KỸ THUẬT XONG, CHỜ DUYỆT COMMIT (2026-09-20) — `.plan/phases3/*-result.md`, `result62.txt`

> Máy này KHÔNG có git — hàng chờ commit B1→B2→B3→B4→C0→C1→C2 khi repo có. B0: GO + 7 gap.

- **A1 UX-READ drill-down**: `ui_screens` trong contract + `POST /read/list` (throttle → screen∈contract → authz → entity re-validate trên fresh read → limit 5–10) + Flutter nút/màn/Back; static test chặn write surface từ drill-down
- **B1 Item/Supplier/UOM resolvers**: §0 probe ERPNext thật ĐẢO NGƯỢC 3 giả định của plan (Item.uom 417, hệ số GLOBAL không per-item, site thiếu nhiều đơn vị) ⇒ `uom_policy` trong contract fail-closed (`allow_inverse_factor:false`, two-hop:false, missing→**ask**) + `supplier.lookup` + item 4 states + picker
- **B2 sales_order.create (WRITE #2)**: deny-list nhóm `sales_order_write` (đo trước: "giao hàng/báo giá/câu hỏi đơn" misroute vào stock.balance) + line_policy + `rate_source: erpnext` (giá 999 từ client ⇒ PROPOSAL_VERSION_STALE) + card Flutter + execute NHÁP + `EXECUTOR_NOT_REGISTERED` fail-closed + golden o01–o08 + tripwire Dart↔contract
- **B3 quotation.create (WRITE #3) ✅ ĐÃ DUYỆT**: pattern B2, taxonomy `QT_*` riêng, `QT_DUPLICATE_ACTION 409`, toolkit dùng chung từ sales-order-write; golden q01–q08
- **B4 purchase_order.create (WRITE #4)**: pattern B2/B3 + disambiguation mua/nhập/nhận + `price_side: buying` + golden p01–p08 + party-theo-route
- **C0 OCR foundation ✅ ĐÃ DUYỆT**: `OcrProvider` interface + mock CI (deterministic 0 network) + MVP router-vision + `ocr_policy` fail-closed (log_raw_image:true ⇒ contract invalid) + untrusted wrap trước classifier/LLM + mime allowlist + trần ảnh 8 MB; khớp lỗi tự review: mimeType + trần ảnh
- **C1 camera UI + fallback ✅ ĐÃ DUYỆT**: `image_picker ^1.2.3` (duyệt user) + `POST /ocr` riêng + nén trên máy dưới trần 1 MB (1600px/q80 → retry 1024px/q60, trần 700 KB, mime từ plugin → magic bytes → tên file) + sheet text sửa-được + confidence + [Nhập tay từ ảnh] khi LOW/NO_TEXT/mock; **không auto-send kể cả khi voiceAutoSend bật** (setting dictation, có test riêng); lỗ thật vá trong phiên: validate chỉ ở provider ⇒ mock trả hóa đơn bịa 200 OK cho `{}` ⇒ dời validate lên ROUTE
- **C2 camera → proposal (khép vòng Trụ C)**: ảnh KHÔNG có động từ mệnh lệnh (đo trước) ⇒ kind do USER chọn trên sheet (`[Đơn bán]`/`[Đơn mua]`), map kind→capability nằm trong contract `ocr_policy.document_kinds` (validate fail-closed: trỏ stub/submit-capable ⇒ invalid); slots từ parser CHUNG với builder (`src/line-parse.mjs` — nhà chung PURE, C0 static guard `src/ocr/**` ↛ skills/ vẫn xanh) ⇒ form hiện đúng cái builder sẽ dựng; party photo CHẶT hơn chat: tên cắt cụt ⇒ candidates (không auto-pick), word-boundary chống "Hà Tiên 20 Bao" nhặt "Hà Tiên 2"; provenance gate fail-closed 4 lớp (status lạ / LOW_CONFIDENCE / NO_TEXT / **mock** / confidence thiếu dười sàn 0.6); tiền trên ảnh chỉ HIỂN THỊ (`rate_source: erpnext`); câu đã sửa gửi `/ask` = user's own turn → card confirm CŨ; **review vòng 2 bắt 1 lỗ THẬT đã vá**: `/ocr/slots` nhận `body.text` từ client không bị chặn độ dài (trần 5000 chỉ sống ở `/ocr` nơi SẢN XUẤT bản đọc) ⇒ 1 MB text vào NLP + resolver O(n²) — vá `assertSlotsText()` (400 `OCR_READ_TOO_LONG`) + test + falsify guard
- **Suite (sau C2 + vá)**: Python **62 OK** · Node **440 (438 pass, 2 fail dsh-env từ B0)** · Flutter **211 pass, 1 fail = probe P2b cũ** · analyze **0** · golden **7/7 (231 ca)** · falsify C0 9/9 · C1 9/9 · **C2 10/10 RED** (harness in-repo, Node + Dart)

### P0 (phases2) — Capability Contract + Safety foundation + Golden Dataset ✅ ĐÃ COMMIT `b4acdb1` (đã push) — `.plan/phases2/p0-result.md` §10

Lộ trình production trong `.plan/phases2/` (nguồn kiến trúc: `.plan/plan2_final.md`) — **không thay** lịch sử MVP ở `.plan/phases/`.

- **Capability Contract** `mcp-erpnext/capabilities.json` là single source of truth (router + skill + safety + authorization + test cùng đọc) — 7 capability, validate fail-closed
- **Safety Gateway** `src/safety-gateway.mjs` là cửa DUY NHẤT cho mọi WRITE; `/execute` không còn policy trong HTTP layer; có **test tĩnh no-bypass**
- **Kill switch** `global_read_only` (env hoặc flag file) ⇒ `503 SYSTEM_MAINTENANCE`, không tiêu tốn `command_id`
- **`custom_ai_action_id`** (unique+indexed) ĐÃ có trên ERPNext demo; `action_id` ghi khi tạo PE + reconcile theo field
- **Golden Dataset v1** 200 câu/6 bucket, runner chạy lõi deterministic — **6/6 bucket đạt ngưỡng**
- `document.delete` **không** tồn tại trên AI path (`403 FORBIDDEN_IN_AI_PATH`, không sinh proposal)
- **Vòng tự review sau P0 (2026-09-17) — 3 lỗi THẬT trong chính đợt refactor, đã sửa + falsify**: lỗi cấu hình ERPNext từng **giết cả process** (client được tạo NGOÀI `try` ⇒ unhandled rejection), từng **treo vĩnh viễn khoá ý định `(customer|invoice)`** (lỗi config để lại PENDING không `reference_no`), và **rò rỉ process con** khi `initialize()` fail. Kèm gia cố: `params.amount_vnd` thiếu ⇒ **TỪ CHỐI** (không để tầng dưới tự clamp tiền); test tĩnh no-bypass quét thêm `scripts/`. Bằng chứng: `result44.txt` §3–§9.
- Suite: Python 60 · **Node 156** · Flutter 63 · analyze 0

**Bước kỹ thuật tiếp theo = P1 → P2** (đã xong, xem 2 mục bên dưới) — **KHÔNG** nhảy P9 (skill mới) hay P5 (DSH trên `/ask`). Voice (**P6**, `speech_to_text` OS STT) **đã bỏ gate audio** 2026-09-18 — xem mục P6 bên dưới; không mở lại Phase 4/8/10–15 cũ.

### P1 (phases2) — Entity Execution Resilience ✅ ĐÃ COMMIT `ee93f13` (đã push 2026-09-17)

- **Entity 4 trạng thái** (`EXACT_MATCH`/`FUZZY_SINGLE_MATCH`/`AMBIGUOUS_MATCH`/`NO_MATCH`) theo contract `capabilities.json` (policy nằm trong contract, không hard-code) — `src/entity-resolution.mjs`
- **WRITE HIGH không auto-select fuzzy**; AMBIGUOUS → candidate picker Flutter (`entity_picker.dart` + `chat_bubble.dart` render) → `/ask` nhận `entity_id`, server **re-validate trên fresh ERPNext read** (id chỉ là hint, không phải authority)
- **Immutable proposal snapshot** (`proposal_id` + `version` + `expires_at` + entity/amount đóng băng lúc tạo) — confirm gửi kèm snapshot identity
- **Mã từ chối tách rõ**: `PROPOSAL_EXPIRED` (TTL) vs `PROPOSAL_VERSION_STALE` / `PROPOSAL_ENTITY_CHANGED` (re-validate lệch) — Flutter banner phân biệt, không còn gộp chung STALE
- **State machine subset + `UNKNOWN_EXECUTION_STATE` → RECONCILING** theo `custom_ai_action_id` — `src/execution-state.mjs`
- **Business dedup (fingerprint)**: cùng ý định (customer|invoice|amount) cảnh báo trước, confirm phải gửi `dedup_ack: true` — **không thay** `command_id` idempotency — `src/business-dedup.mjs`
- **Degraded: NLP down → chặn WRITE** phụ thuộc amount parse (fail-closed, không đoán số tiền)
- **Review vòng 2 (result45)**: fix harness Flutter `_bodyOf` (dio đưa request Map nguyên vào adapter — cast `as String` ném TypeError bị bọc thành "Không kết nối được máy chủ", capture rỗng); soi 2 điểm wiring: `/execute/cancel` là lock-release CỐ ÊN không qua kill-switch (đúng thiết kế, có comment), `entity_id` re-validate đúng — không sửa gì server
- Suite: Python 60 · **Node 172** · **Flutter 67** · analyze 0 — bằng chứng `result45.txt`

### P2 (phases2) — Session context + Uncertainty UX ✅ ĐÃ COMMIT `33ff725` (đã push)

- **Uncertainty taxonomy** `src/uncertainty.mjs`: 11 mã chuẩn + copy tiếng Việt BẮT BUỘC từng mã; `toUncertaintyCode()` map raw→chuẩn, unknown ⇒ null (không chế); mọi refusal trong copilot-server trả kèm `uncertainty:{code,message,detail}`
- **Session context** `src/session-context.mjs`: customer 30m · invoice 10m; provenance `user_selected`/`derived`; entry hết hạn bị XOÁ khi đọc
- **WRITE fail-closed theo context**: chỉ `user_selected`/exact trong TTL mới seed payment; derived (fuzzy READ) không bao giờ; hết hạn = như lần đầu nhắc (guard P1 hỏi lại)
- **KNOWN_INTENT_UNIMPLEMENTED**: capability stub (sales.summary, skill:null) trả "hiểu nhưng chưa có" — tín hiệu học cho P4; cần thêm "doanh thu" vào routing keywords sales (đã sửa contract)
- **Flutter PipelineProgress**: 4 nhãn pha (hiểu → tra khách → kiểm tra → chờ xác nhận) thay spinner trần; Timer.periodic cancel-in-dispose
- **Falsify 3 luật** (trên /tmp): gỡ provenance check → FAIL đúng assertion; gỡ TTL expiry → FAIL 2 test; hoán vị forbidden/stub → forbidden-path FAIL
- Deliverable 5 (optional, sửa amount trên card) ⏭ bỏ qua có lý do — chờ user
- Suite: Python 60 · **Node 181** · **Flutter 69** · analyze 0 — `.plan/phases2/p2-result.md`

### P3 (phases2) — LLM Classifier (async) + Regression gate ✅ ĐÃ COMMIT `c38e4ea` (đã push)

- **Classifier semantic-only** `src/classifier.mjs`: gọi LLM Router Phase 5 (`POST /v1/chat/completions`, OpenAI-compatible) — **không** agent loop, **không** DSH, **không** tool-call
- **Không bao giờ trả ERP id**: 2 lớp — regex `ID_LIKE_KEY` (`*_id`/`docname`/`erpnext_id`…) + allowlist `SLOT_KEYS` (text-only); ID chỉ từ Entity Resolver
- **Intent ∈ Contract**: `allowedIntents()` = contract trừ forbidden ⇒ model không được nêu `document.delete`; intent lạ ⇒ rơi về rule-only
- **Chỉ route, không hành động**: `routeByCapability(intent)` đưa vào ĐÚNG skill/Safety path cũ (forbidden/stub/Safety Gateway/entity resolver y hệt); confidence không bypass confirm/authz
- **Degraded** (LLM down/timeout 2500ms/malformed) → rule-only `UNKNOWN_INTENT`, không 500 mù; confidence thấp → `LOW_CONFIDENCE` (copy P2, `needs_clarification`)
- **Untrusted-data** wrap trước khi vào prompt (module P0 tái dùng)
- **CI gate mới**: `test/golden/classifier-cases.json` (9 case) + `test/p3-classifier-regression.test.mjs` — **mock LLM** (không provider/quota) ⇒ deterministic; `golden-dataset.json` 200 câu vẫn xanh
- Falsify 3 luật trên /tmp (F4 forbidden-offerable, F1 id-leak, F3 low-confidence) đều đỏ đúng chỗ; fix thêm 1 **test flaky có sẵn** (bucket 15-phút của P1 dedup)
- Suite: Python 60 · **Node 195** (181→195) · **Flutter 69** · analyze 0 — `.plan/phases2/p3-result.md` · `result47.txt`

### P4 (phases2) — Learning loop (human-approved) ✅ ĐÃ COMMIT `d7e9ba9` (đã push)

- **Signal log** `src/learning-log.mjs`: mỗi câu hỏi/câu trả lời → 1 dòng JSONL (`outcome` taxonomy, không secrets, text cap 500, UTC); never-throw (log hỏng không được làm hỏng câu trả lời); dir repo-local `learning-log/` (gitignored, KHÔNG /tmp — bài học result31)
- **Cluster report** `npm run learning:cluster` — READ-ONLY, nhóm UNKNOWN/UNIMPLEMENTED/LOW_CONFIDENCE theo tần suất + ví dụ nguyên văn, có gợi ý trigger để người sửa contract
- **Vòng thử thật**: log 9 câu → cluster chỉ ra `"doanh số …"` chưa route (5 biến thể) → người thêm trigger vào contract + golden +2 case → golden 7/7. Đây là đường DUY NHẤT để contract tiến hoá (không auto-write)
- Review vòng 2 bắt 2 lỗi: `copilotAsk` (đường dsh) chưa qua wrapper log; và claim “E2E 1 call = 1 dòng” chưa có test ⇒ viết test E2E thật (spawn NLP + copilot con)
- Suite: Python 60 · **Node 204** · Flutter 69 · analyze 0 — `result48.txt`

### P5 (phases2) — DSH explicit opt-in READ ✅ ĐÃ COMMIT `6318eca` (đã push)

- `src/dsh-optin.mjs`: dsh CHỈ chạy khi được spawn với `COPILOT_DSH_CONTEXT=1`; **`/ask` không có đường nào spawn dsh** (test tĩnh quét toàn bộ `src/`)
- Trong context dsh: mọi WRITE bị `DSH_WRITE_BLOCKED` TRƯỚC skill factory (`proposal: null`), READ vẫn trả lời bình thường; cả hai vẫn vào learning log
- `docs/dsh-optin.md` (2 chế độ + lệnh smoke); review vòng 2 fix 2 lỗi (`DSH_WRITE_BLOCKED` thiếu trong taxonomy P2; bị xếp nhầm bucket `error`)
- Suite: **Node 212** · `result49.txt`

### DSH RUNTIME DISCOVERY (plan `.plan/dsh_prompt_fix1.md`) ✅ ĐÃ COMMIT `dc60a4e` + PUSH (docs `03338ae`/`7476051`) · CI run #22 success · bằng chứng `result59.txt` + `result60.txt`

- **Lỗi gốc (user báo)**: resolver hardcode `/tmp/dsh-run/node_modules/.../lib/bin.js`;
  máy Mac không cài dsh trong repo mà chạy `npx @deepseek-ai/dsh web` ⇒ `dsh:check`
  báo "entry missing" + `/dsh/health` `available:false`.
- **Fix**: `resolveDshRuntime()` — 6 mức `DSH_ENTRY` → `DSH_COMMAND` → package local →
  **`npx --yes @deepseek-ai/dsh@<pin>`** → `/tmp/dsh-run` (*chỉ khi file tồn tại*) →
  unavailable; pin đọc từ `package.json` lúc chạy; `dshSpawnPlan()` là chỗ DUY NHẤT
  quyết định spawn (argv, không shell) và **dùng chung** với `dsh-remote-runner.mjs`.
- **Bằng chứng**: `npm run dsh:check` PASS (`source=npx-pinned`, `--version ->
  0.1.5-rc.1`) · `/dsh/health` trả thêm `source` · WRITE block 31ms · `/ask` không dính dsh.
- **BLOCKED_EXTERNAL**: lần DSH READ cuối không chạy được vì `llm9000.loca.lt` trả
  **503 Tunnel Unavailable** (người thật bật lại `lt` trên Mac); cùng code đã PASS thật
  trước đó trong phiên (171.800đ/4); dsh spawn thật được chứng minh bằng 7 call router
  + `log_tail` chứa output của chính dsh.
- **CI**: đợt này chỉ sửa backend/docs ⇒ workflow (`paths: apps/mobile/**`) **không tự
  trigger**; đã kích tay `gh workflow run android-debug-apk.yml --ref change/flutter-chat-mvp`
  → **run #22 `35435259669` success** (head `03338ae`), APK verify binary thật — `result60.txt`.
- **Lần sau cần APK cho đợt chỉ-sửa-backend**: dùng đúng lệnh dispatch tay ở trên (đừng
  chờ push; cũng đừng kết luận CI hỏng).

### DSH END-TO-END (plan `.plan/dsh_end_to_end.md`) ✅ ĐÃ COMMIT + PUSH (`868be04` client + docs) — CI run #21 success

- Checklist thi hành: `.plan/dsh_e2e_tasks.md` (A–E, mỗi mục [x] kèm bằng chứng) ·
  toàn bộ log: `result57.txt` (§1–§13).
- **Backend**: `src/dsh-gateway.mjs` + route `POST /dsh/ask` — pre-screen WRITE ở cổng
  (NLP down ⇒ fail closed), guard chống patch thiếu `COPILOT_DSH_CONTEXT` (LỖ HỔNG THẬT
  tìm thấy khi chạy thật), session TTL, concurrency, error map có copy tiếng Việt.
  23 test (`test/dsh-gateway.test.mjs`).
- **Flutter (AI mode)**: `_ModeBar` + `SegmentedButton` (default `Chat thường`, KHÔNG auto,
  KHÔNG persist) → `dshAsk()`; trạng thái đang phân tích; câu từ chối của gateway hiện
  nguyên văn; không card, không `/execute`. 8 test.
- **Real E2E XANH**: `/dsh/ask` → dsh runtime thật → router → **mac-custom (LLM thật)** →
  `copilot_ask` → NLP → **ERPNext THẬT**: trả **171.800đ/4 chứng từ**, khớp ground truth
  lấy live; audit `attempts=['mac-custom'] status=200` ×3.
- **DRIFT môi trường 2026-09-19**: model `oc/big-pickle` của mac-custom **đã bị Mac khai
  tử** (403) → đổi sang `gemini/gemini-3.6-flash` (verify live + `tool_calls` thật) ở
  cả 2 router config + patch dsh + default classifier. Chi tiết `result57.txt` §8.
- **BUG THẬT sửa được (có sẵn từ Phase 3, không phải của DSH)**: ghi `state` sau khi
  provider bị dispose ⇒ `UnmountedRefException` (user rời màn hình giữa lúc chờ) — đã
  thêm 9 guard `ref.mounted` + test hồi quy cho cả 2 đường. `result57.txt` §10.
- Suite: **Python 62 · Node 290 · Flutter 150 · analyze 0** (mốc 2026-09-19).

### DSH FINAL MINI-SPRINT (plan `.plan/dsh_prompt_check.md`) ✅ ĐÃ COMMIT + PUSH (`b61df0a` gateway/scripts/pin) — CI run #21 success

- Bằng chứng đầy đủ: **`result58.txt`** (§1 audit → §15 final verdict, bảng PASS/BLOCKED).
- **§3 PIN runtime**: `package.json` root pin `@deepseek-ai/dsh@0.1.5-rc.1`;
  `resolveDshEntry()` resolve từ package đã cài (trước đó HARDCODE `/tmp/dsh-run/...`
  của một máy ⇒ máy khác "khả dụng" mà không chạy được gì); `npm run dsh:check`.
- **§2 TOPOLOGY** `DSH_MODE=local|remote` + `scripts/dsh-remote-runner.mjs` (chạy trên
  Mac): token bắt buộc/fail-closed, dùng lại `buildDshChildEnv`; remote **không bao giờ**
  hạ cấp về local; response (kể cả thất bại) mang `runtime`.
- **§4 REAL GEMINI PASS**: 1 session qua `gemini-openai` ⇒ **171.800đ/4 chứng từ**,
  audit `messages:7` + `status 200` ×3 (≥2 vòng tool-call) ⇒ verify sống đường đa-lượt
  mà `thought_signature` từng làm gãy.
- **6 defect review đã sửa + 4 falsify**, nặng nhất: **F6 route map từ chối an toàn thành
  502** (giám sát hiểu nhầm thành lỗi hạ tầng) và **F1 parser cắt mất câu trả lời nhiều dòng**.
- **6 script E2E** (`dsh:check` · `check:topology` · `dsh:e2e:read` · `dsh:e2e:write-block`
  · `check:ask-normal`) — exit code là nguồn sự thật.
- ⚠️ **BLOCKED_EXTERNAL**: hop thật backend → Mac qua tunnel không verify được
  (`503 Tunnel Unavailable`) — **việc người thật**: bật lại `lt` trên Mac.
- Suite: **Python 62 · Node 306 · Flutter 150 · analyze 0** (mốc 2026-09-19).

### P7 (phases2) — Background job queue ✅ ĐÃ COMMIT `3e6240a` (đã push)

- `src/job-queue.mjs`: WRITE đã confirm mà ERP tạm down (verdict `retry_same_command_id`) → QUEUED; replay qua ĐÚNG `runExecute` (không có write path thứ hai); bounded retry; crash-recovery `RUNNING → RETRYING`; `release()` khi cancel; `completed()` cho report
- **`startJobRunner()` nối vào `main()`** — trước đó job được enqueue mà không ai drain (exit criteria P7 chỉ đúng khi chạy trong test); `GET /jobs` trả `pending` + `completed`
- Review tìm 5 finding, falsify 4 guard; TTS ⏭ skip có lý do (việc client, không cần cho exit criteria)
- Suite: **Node 228** · `result50.txt` + `.plan/phases2/p7-result.md`

### P10 SLICE — Rate limit + Correlation trail ✅ ĐÃ COMMIT `7cb2798` (đã push)

- **Rate limit thật** (trước đây chỉ khai trong contract, chưa ai enforce): per user (read 30/phút · write_proposal 10/phút · write_execute 5/phút) + per capability (`payment.create` 20/giờ); vượt ⇒ 429 + `Retry-After` + câu tiếng Việt
- **Vượt hạn mức KHÔNG đốt `command_id`**: charge TRƯỚC Safety Gateway (đo thật: `store.status(cid) = null`, 0 chứng từ; sau cửa sổ mở lại ghi đúng 1 lần)
- **Câu ĐỌC không tiêu ngân sách ghi** (`proposalBucketFor()` theo loại contract, vì mọi route ĐỌC cũng trả proposal)
- **Correlation §17** trên `/ask` + `/execute` + job runner qua `logEvent()` (`request_id/user_id/command_id/action_id/erp_document_id/capability/risk/latency_ms`)
- **3 lỗi thật của chính code vừa viết đã sửa**: viết lại `capabilityForAction` với nhánh không tồn tại (limit `payment.create` tắt lặng lẽ) · `export {x} from` không tạo binding (mọi `/ask` 500) · meter theo “có proposal” thay vì theo loại
- Suite: Python 60 · **Node 240** · Flutter 69 · analyze 0 · falsify 4 guard — `result51.txt` + `.plan/phases2/p10-result.md`
- **Gap giành cho P10 full**: restore drill · **chạy thử runbook** (đã viết `docs/kill-switch-runbook.md`, chưa diễn tập trên gateway thật) · dashboard/log query · load test · APK device (human) · compliance note · rate-limit store phân tán (hiện in-process, reset khi restart)
- **Review vòng 3 (2026-09-18, sau commit)**: **F5** đính chính claim "in-app polling" ở P7 (client KHÔNG poll `/jobs` — gap UX, không phải gap an toàn tiền) · **F6** bịt lỗ hổng bằng chứng: thêm test E2E cho đường per-capability (chính chỗ lỗi F1 từng hỏng im lặng) + falsify bằng cách tái tạo lỗi F1 · **F7 → ĐÃ GIẢI QUYẾT (xem dưới)**

- **Commit đợt review vòng 3**: `21d77ff` (test E2E per-capability + `docs/kill-switch-runbook.md`) · `d6295ab` (bài học vòng 3)

**Phases2 đã ĐÓNG: P0 `b4acdb1` · P1 `ee93f13` · P2 `33ff725` · P3 `c38e4ea` · P4 `d7e9ba9` · P5 `6318eca` · P6 `9b54d35` · P7 `3e6240a` · P8 `90401f0` · P10-slice `7cb2798`/`21d77ff`/`d6295ab` (tất cả đã push).**

### P8 (phases2) — Multi-user / RBAC / company scope ✅ ĐÃ COMMIT `90401f0` (đã push)

- **`src/authorization.mjs` (mới)** — boundary phân quyền server-side, đọc từ `capabilities.json` (không hardcode capability nào trong logic): `resolvePrincipal` · `checkPermissions` · `resolveCompanyScope` · `authorize` · `describeAuthorization`
- **2 chế độ**: `multi_user` (`COPILOT_USERS` JSON, tường minh) và `single_tenant` (mặc định — giữ hành vi cũ để **không chặn lệnh ghi khi nâng cấp**; đo thật: bỏ miễn trừ này làm đỏ **33 test**). Company: server-first (principal → `COPILOT_COMPANY` → request); multi-user thiếu company ⇒ `COMPANY_SCOPE_REQUIRED` (map về copy P2 `AUTHORIZATION_DENIED` để user luôn có chữ)
- **Wire**: `/ask` chặn **trước** `route.factory()` (không sinh proposal, không đọc ERPNext) · `/execute` chặn ở bước 1b **trước** idempotency (403, **không tiêu `command_id`**) · `/jobs` lọc theo actor · `/execute/cancel` chỉ chủ lệnh hoặc người có quyền · job replay mang `user_id` gốc ⇒ phân quyền **tính lại tại thời điểm ghi**
- **Audit**: `user_id`+`company` vào record idempotency và job; `logEvent` của `/execute` + `/cancel` nay dùng `principal.user_id` (một khái niệm "ai" duy nhất cho cả rate-limit/audit/job)
- **Test**: `test/p8-authorization.test.mjs` **+17** · **falsify 13 guard** (gồm 1 lần guard **không thể falsify** ⇒ phát hiện nhánh allow-list chưa từng được test) · self-review tìm **5 lỗi thật** (rò `/jobs` chéo user · cancel không kiểm ai · `COMPANY_SCOPE_REQUIRED` không có copy · audit ghi sai người · allow-list không test nào chạm) · **Node 267** (250→267)
- Bằng chứng: `.plan/phases2/p8-result.md`

### F7 + F7-2 + Golden gaps (2026-09-18) ✅ ĐÃ COMMIT `3b41313` · `eb4ba34` · `c5db7cc` (đã push)

- **F7 — policy (a) do user chọn**: refusal bảo trì (`SYSTEM_MAINTENANCE`/`CAPABILITY_DISABLED`) xảy ra **TRƯỚC khi thử ghi** ⇒ không phải một lần thử — `job-queue.mjs` thêm `isTemporaryRefusal()` + nhánh drain: job về lại RETRYING, attempts roll back về 0, backoff hẹn lại, JSONL ghi `TEMPORARY_REFUSAL`; tắt switch ⇒ tự chạy lại VERIFIED đúng 1 lần; lỗi ghi thật giữ nguyên FAILED-terminal. `result53.txt`
- **F7-2 — submit switch**: setting **"Cho phép nộp phiếu thu thật"** (mặc định OFF, dialog xác nhận riêng) · cờ **frozen vào proposal snapshot lúc hỏi** (không đọc lại lúc execute) · ON ⇒ sau draft OK gọi `erpnext_doc_submit` (tool thật, read từ source 3.0.4) qua write gate mở rộng fail-closed; submit lỗi giữa chừng ⇒ **PARTIAL** ("đã tạo nháp, submit lỗi: …, cần submit tay trên ERPNext") — không FAILED · Flutter 80/80 (+11 test) · falsify 3 lớp độc lập
- **Golden gaps k18/m15 sửa xong**: "một triệu hai" = 1.200.000 (shorthand có luật chặt chống va danh xưng); "Con Linh" resolve thành tên "Linh" — Golden runner **0 miss**, gate P9 mở · Python 62
- Suite: **Python 62 · Node 250 · Flutter 80 · analyze 0** — bằng chứng `result53.txt` + `result54.txt`

### P6 (phases2) — Voice / STT (`speech_to_text`) ✅ ĐÃ COMMIT `9b54d35` (đã push)

- **Gate 150 câu audio đã BỎ** (user, 2026-09-18): P6 dùng **STT của OS** (`speech_to_text` 7.5.0), không tự host model, không corpus riêng
- Luồng đúng luật `plan2_final` §20: 🎙 mic → STT → **text vào CHÍNH ô nhập editable** → user nhìn/sửa → **Gửi** → `POST /ask`; STT **không bao giờ tự gửi**, không có đường tới `/execute`
- `lib/features/chat/data/speech_service.dart`: interface mỏng `SpeechService` (mockable — CI không cần mic) + `SystemSpeechService`; `SpeechStatus` tách `denied` vs `unavailable` để thông báo đúng việc user cần làm
- Quyền: `RECORD_AUDIO` + `<queries>` `android.speech.RecognitionService` (Android 11+ package visibility). **Repo không có target iOS** ⇒ keys `Info.plist` ghi lại trong `p6-result.md` khi thêm iOS sau
- Locale: máy có `vi*` thì dùng entry đó; **không có (kể cả list rỗng) vẫn xin `vi_VN`**; dictation giữa lúc đang gõ không xoá chữ đã viết; partial result **thay** không nối; `dispose()` đóng mic
- **21 test**: `test/voice_input_test.dart` (15, mock STT) + `test/speech_service_test.dart` (6, chạy trên **subclass của plugin thật**) + **falsify 8 guard** (auto-send → 3 đỏ; nuốt im lặng khi bị từ chối quyền → 2 đỏ; bỏ qua `unavailable` → 2 đỏ; mic mở sau lưng request → 1 đỏ; **kết quả muộn ghi đè ô nhập → 2 đỏ; double-tap mở 2 phiên → 1 đỏ; cảnh báo che "Đang nghe…" → 1 đỏ; bỏ session token → 3 đỏ**) — khôi phục `diff clean`
- **Self-review sau khi viết tìm 4 lỗi THẬT đã sửa** (xem `p6-result.md` §"Vòng self-review"): kết quả STT đến muộn viết lại câu cũ vào ô vừa gửi (nặng nhất — plugin ghi rõ `stop()` LUÔN bắn thêm 1 kết quả) · `_notice`/`_listening` viết thành `else if` che mất phản hồi "Đang nghe…" · double-tap mở 2 phiên · `cancel()` hứa "không có text sau đó" mà không ai thực thi
- Suite: Python 62 · Node 267 · **Flutter 107** (80→107) · analyze 0 — `.plan/phases2/p6-result.md`
- **Bugfix P6 (2026-09-18) ✅ ĐÃ COMMIT `77e2b57` + docs `bbca7ca` (đã push) — `result55.txt`**: user báo trên máy thật "Gboard hiểu tiếng Việt nhưng app báo *Máy không có bộ nhận dạng tiếng Việt*". Gốc: doc plugin `locales()` ghi rõ danh sách đó **chỉ phủ recognizer ON-DEVICE**, có thể thiếu ngôn ngữ mà recognizer ONLINE vẫn nhận ⇒ coi `locales()` thiếu `vi` = "máy không hỗ trợ" là **suy diễn sai**. Sửa: luôn xin `vi_VN` + tín hiệu `localeVerified` tách khỏi "dùng được hay không" + retry 1 lần với locale mặc định khi platform từ chối + refusal ngôn ngữ **không** tắt service + UI **không hiện gì về locale** (bỏ luôn gợi ý nhẹ — cùng ngày, user yêu cầu; cảnh báo thật denied/unavailable/error_language_* vẫn giữ). +6 test, falsify 5 guard, Flutter 101→107.
- **P6 UX "Tự gửi sau khi nói xong" (✅ ĐÃ COMMIT `f55d557`, đã push)**: switch Settings mặc định OFF; ON ⇒ final STT + ô nhập có text ⇒ gọi cùng `onSend()` (`POST /ask`); partial/transcript rỗng không gửi; không auto-confirm WRITE/`/execute`. +13 test, falsify A/B/C, Flutter 107→**120** (`result55.txt` §10–§11); review vòng 3 gỡ guard chết thứ 3 (`_maybeAutoSend` còn 1 điều kiện) + sửa 2 doc sai + sửa báo-sai-kết-quả-lưu · ❓ **chờ user**: `pauseFor: 3s` ⇒ khi BẬT, ngập ngừng giữa câu là gửi câu nửa vời — chọn (a) giữ + ghi rõ cỡ 3 giây vào copy Settings / (b) tăng `pauseFor` khi BẬT / (c) chỉ auto-send khi user **bấm dừng mic** (`human.md` §1)
- **APK CI: ✅ đã build lại** — run `35367603981` success (artifact `erpn-chat-debug-apk`, 84.169.705 bytes), **xác minh binary chứa bản fix** (câu SAI cũ = 0 lần trong `kernel_blob.bin`) ⇒ plugin native build được trên CI
- **Gap còn lại (chỉ người thật)**: cài APK + smoke mic trên **máy thật có Gboard tiếng Việt** (checklist 7 bước trong `p6-result.md`, mục 7 đã sửa theo bugfix này) — theo dõi ở `human.md` §2

Bước kỹ thuật tiếp theo: **P9** (skill mới — **gate ĐÃ MỞ** sau khi Golden 0 miss, cần user ra lệnh) — riêng **P10 full** (DR drill, dashboard, load test, rate-limit store phân tán) vẫn hoãn.
### F7 — ĐÃ GIẢI QUYẾT (user chọn policy (a), 2026-09-18)

> **Luật mới: bảo trì/kill switch KHÔNG phải một lần thử.**
- `job-queue.mjs` thêm `isTemporaryRefusal()` (`SYSTEM_MAINTENANCE` · `CAPABILITY_DISABLED`): drain gặp
  refusal tạm thời ⇒ job về lại **RETRYING**, **roll back bộ đếm attempt** (chưa hề thử ghi thì không
  tính là thử), **không FAILED**, hẹn `next_attempt_at` theo backoff hiện có, JSONL ghi sự kiện
  `TEMPORARY_REFUSAL`.
- Tắt bảo trì xong ⇒ **lần drain kế tiếp tự nhặt lệnh lên** (polling có sẵn của runner) — không cần
  bấm lại `command_id`; chạy đúng 1 lần ⇒ VERIFIED (attempt đầu tiên THẬT mới được tính).
- Hành vi lỗi GHI THẬT không đổi: non-retryable (vd `PROPOSAL_STALE`) vẫn FAILED-terminal.
- Test: 3 case mới (giữ trạng thái + không tiêu attempt qua nhiều lần bảo trì · tắt switch → VERIFIED
  đúng 1 lần · lỗi thật vẫn FAILED). **Falsify**: gỡ nhánh tạm thời → 2 test ĐỎ đúng assertion
  (`expected RETRYING / actual FAILED`) — khôi phục byte-identical, 19/19 xanh. Bằng chứng `result53.txt`.
KHÔNG lùi về phase-04/08/10–15 cũ.

### Phase 0 — Foundation & Verification ✅ (`result1.txt`)

Không viết code. Chặn fabrication trước khi code (bài học `plan1_review1.md`).

- Pin `@casys/mcp-erpnext@3.0.4` + **stdio** (né breaking change HTTP 3.0.0:
  stateless, đòi `MCP-Protocol-Version: 2026-07-28`)
- **Agent Runtime = dsh** (`deepseek-ai/deepseek-harness`, MCP client built-in).
  Rủi ro ghi nhận: 20/20 version là rc/alpha. 2 trigger tách khỏi dsh:
  (1) ≥2 user cần credential khác nhau → Phase 10; (2) dsh breaking change phá production
- STT order: Web Speech API → Cohere Transcribe → Whisper API → PhoWhisper CPU
- Phát hiện ngược review6: 5 repo "DSH mobile" đều tồn tại thật — vẫn loại vì thẩm định an toàn
- Chốt xây mới NLP + LLM Router; gate **Mandatory Sign-off PII** thêm vào phase-05 (NĐ13/2023)

### Phase 1 — Vietnamese NLP Pipeline ✅ (`result1–3.txt`)

Python `src/vietnamese_nlp/`, stdlib thuần, chạy TRƯỚC LLM — cố định bằng code, không phụ thuộc prompt.

- Number normalizer → integer VND (14/14 dạng bắt buộc + mở rộng: `1tr5`, `230.000`,
  `1 500 000đ`, `0.5 triệu`, `2 triệu rưỡi`, `1 tỷ 200 triệu`, slang `trẹo`/`chai`…)
- **Fail-safe cốt lõi**: `"Bác Hai"`, `"hai trăm"`, `"2 triệu 500"` → KHÔNG sinh số thay vì đoán sai
- Kinship 21 title (birth-order nickname là tên); synonym 10 intent (sản phẩm không bị map:
  `cám heo` giữ nguyên); quantity extractor; CLI độc lập
- **58/58 test · money 259/259 = 100%** sau 2 đợt fix thật (3 bug sai im lặng; 4 false positive +
  hậu tố dính liền + chặn merge rác `2tr5k`)
- Đợt fix result9: kinship chỉ strip cụm xưng hô ĐẦU câu — title giữa câu là phần tên thật
  trong DB (`"Công trình nhà ông An"` có thật trong 26 khách)

### Phase 2 — MCP ERPNext read-only + skill layer + cầu nối + đo thật ✅ (`result4–9.txt`, commits `0ac8e61` + `119edd4`)

- Skill layer: readonly-guard chặn write ở tầng code; 12 tool đọc thật `erpnext_*`;
  `assertKnownId` (ID chỉ từ tool result); `markUntrusted` bọc dữ liệu ERPNext
- Cầu nối Python HTTP (`nlp_service/server.py`, stdlib, 127.0.0.1) — đúng quyết định cầu nối đã khóa
- Copilot MCP server 1 tool `copilot_ask` cho dsh; env-switch real/mock (thiếu var → mock,
  sai config → hard error, không bao giờ âm thầm rơi về mock)
- dsh 0.1.5-rc.1 headless E2E thật với ERPNext thật qua ngrok: *"Khách smoke 2026-09-13-p1done
  còn nợ 269.000đ (3 hóa đơn chưa trả)"* — khớp đúng 3 hóa đơn thật
- **Đo accuracy thật theo exit-criteria phase-02 (result9): 18 câu tiếng Việt đa dạng qua
  `answerQuestion()` với ERPNext thật** — expected lấy từ ground-truth dump cùng ngày
  (26 khách / 37 hóa đơn / 29 phiếu thu / 14 dòng tồn kho):
  **vòng 1 = 27.8% → vòng 2 = 61.1% → vòng 3 = 18/18 = 100%**
- **5 nhóm lỗi mà unit xanh (36/36) không bắt được** — đã fix kèm unit test bám theo:
  ① router nhóm customer (khách/nợ/còn lại) nuốt câu hỏi hóa đơn/kho → specific TRƯỚC customer
  ② nameCandidates prefix-only → tên giữa câu không bao giờ được thử → mọi token substring,
  dài nhất trước, fetch list 1 lần/câu (trước đây tới 100 MCP round-trips)
  ③ kinship strip title giữa câu phá tên thật → chỉ strip vocative đầu câu
  ④ payment tool 417 (site chặn field `currency`) rồi đòi `party_type` → fallback
  `erpnext_doc_list` + thêm param
  ⑤ inventory trả cả kho → lọc theo vật tư hỏi (word-prefix dài nhất, 2 passes)
- **An toàn tiền củng cố bằng chính batch test**: hỏi khách không tồn tại / fragment 1 từ khớp
  19 khách → trả null + lý do, KHÔNG chọn hộ khách nào (b07 từng trả nhầm 457.875đ của khách khác)
- **Test cuối: 40/40 node --test · 58/58 Python (money corpus nguyên vẹn)**

### Phase 3 — Flutter chat MVP ✅ (`result7–8.txt`, commit `590b1b2` + CI fix `119edd4`/`c3d74c3`)

- `apps/mobile` (Flutter 3.47.2 / Dart 3.13.2, Riverpod + dio, GoRouter 1 route): màn hình chat,
  lịch sử `chat_history_v1` (SharedPreferences), empty state, SnackBar lỗi giữ text,
  footer hiện `COPILOT_BASE_URL` đang nói với server nào
- HTTP `/ask` wrapper (`mcp-erpnext/src/http-ask.mjs`) — app không gọi MCP trực tiếp
- GH Actions `android-debug-apk`: analyze --fatal-infos → test → build APK debug (dart-define
  `COPILOT_BASE_URL`/auth từ repo Variables/Secret — artifact cài được lên máy thật) → artifact
  `erpn-chat-debug-apk`; **run 1 FAILURE** (gitignore `*.g.dart` không lên CI) → **run #2 + #3
  SUCCESS sau khi thêm step build_runner + dart-define** (`result10.txt`, `result11.txt`)
- Flutter analyze 0 issue · 13/13 test; bug thật nổi bật: ChatBubble không bao giờ render
  answer (bắt bằng debug test in toàn bộ Text trong tree)

### Hạ tầng dự án ✅

- Git: branch `change/flutter-chat-mvp`, remote `origin = github.com/hoangsoft90/erpn_mobile1`
  (setup trong phiên result9 từ `.env` GH_REPO_URL/GH_TOKEN); commits `33f9dc0` → `0ac8e61`
  → `590b1b2` → `119edd4`; `.env` git-ignored, secret scan trước mỗi commit
  (result9 đã redact key lộ khỏi file evidence trước khi commit)
- 2 project skills (`.agents/skills/`, local-only — user chốt 2026-09-16: KHÔNG vào repo):
  `erpnext-mcp-connect` + `erpn-verify-first`
  + `erpn-dsh-setup` (result15 — cài/chạy dsh + cơ chế cordis patch, thay công thức result6)
- Tài liệu phiên mới: `.project/` (kiến thức tĩnh) + memory files; `.project/openspec.md`
  là pointer — **1 nguồn sự thật duy nhất**: checklist.md (trạng thái) + next.md (roadmap)
  + result*.txt (bằng chứng)

---

## Sắp tới

### NEXT6 — Session isolation (Prompt-2, CHƯA BẮT ĐẦU) — ⏳ **chờ user**

Audit đã xong (`.plan/next6-audit1.md`, gap G1–G11). Trình tự Prompt-2:
1. Tạo `openspec/changes/next6-session-isolation/` (tên **KHÔNG** bắt đầu bằng số) — proposal/tasks/specs — **TRƯỚC** khi chạm source.
2. Sửa theo gap: store key theo principal · lock per-conversation · scope `sessionContext` · `begin()` chặn replay khác `user_id` · proposal bind principal (chọn hướng) · `Retry-After` trên 429 · dùng `DSH_MAX_SESSIONS` · Flutter id persit + clear · log `/ask` có `conversation_id`.
3. Test + review + `result*.txt`.

### M1/M2 của `ed79f77` — ⏳ **chờ user quyết** (vùng SỐ TIỀN)

- Refresh/retry trong `daily_summary_screen.dart` (`:265` + `_BlockError.onRetry`) reload HÔM NAY thay vì ngày đang xem khi xem "Hôm qua". Cần user quyết sửa hay giữ.

### Push — ⏳ **chờ user gõ "push"**

- 2 commit `17d6f9b` + `ed79f77` (chưa từng qua CI). Sau push: CI APK.

### P9-G — ĐÓNG backlog P9 — ✅ ĐÃ ĐÓNG 2026-09-23, **CHỜ DUYỆT COMMIT** — `.plan/result-p9-done.md`

- **§2 p9_guide đối chiếu xong**: 11/14 nghiệp vụ cửa hàng có đường chat (7 READ + 8 WRITE active trong contract).
- **Bỏ qua có chủ ý (không phải quên)**: P9-F `sales_return` (optional, prompt ghi "chỉ chạy khi user yêu cầu và SI ổn" — user KHÔNG ra lệnh) · trả hàng NCC (chưa từng có phiên) · Stock Reconciliation (không tool trong package pin; P9-E chọn Stock Entry vì verify-đọc-lại được) · JE tay (cấm) · `sales.summary` READ stub (đủ đường read khác).
- **Bảng cấm đo lại còn nguyên**: delete · cancel submitted · JE · MCP thô cho DSH (xem result-p9-done.md §bảng-cấm).
- **Còn treo sau khi đóng P9**: P9-C-followup (nháp chưa trừ nợ — user chốt "để lại") · device smoke (human) · archive OpenSpec `flutter-chat-mvp` (sau device smoke).

### P9-D (`sales_invoice.create`) — ✅ ĐÃ LÀM 2026-09-23, **CHỜ DUYỆT COMMIT**

- **Deliverable**: `.plan/result-p9-D.md`. Hoá đơn bán **NHÁP theo đơn bán đã submit** (WRITE #7), cùng Safety Gateway + idempotency + verify như SO/QT/PO/DN/PR.
- **Đo được ở §0**: 3 lệnh `xuất/lập hóa đơn …` trước đó rơi vào nhóm ĐỌC `sales` (`invoice.lookup`) — mệnh lệnh bị trả lời bằng danh sách hoá đơn; `xuất hoá đơn` (chữ `oá`) = `UNKNOWN_INTENT`.
- **Chưa làm (cố ý)**: hoá đơn **không theo đơn** (tự chọn hàng + giá) · **submit** từ chat (không có đường nào) · chạy **ERPNext thật** (chỉ khi user ghi rõ "cho phép ERPNext thật").
- **Việc cần trước khi dùng thật**: ~~migration `custom_ai_action_id`~~ ✅ **XONG 2026-09-23** — user duyệt, script `add-correlation-field.mjs` (derive từ contract) tạo field trên **Sales Invoice + Delivery Note + Purchase Receipt** (Data, unique=1, search_index=1; verify: đọc lại sau tạo + dry-run lần 2 "mọi doctype đã có" + probe READ-ONLY đúng 2 call executor → HTTP 200 ⇒ hết `SI_CORRELATION_FIELD_MISSING`; 0 Error Log).
- ⚠️ Vùng **SỐ TIỀN** ⇒ AI không tự ký duyệt; chờ user duyệt commit.

### P9-C-followup (nhỏ, CHƯA LÀM) — nháp chi/thu chưa trừ vào nợ khi đề xuất lại (user chốt "để lại, làm sau" 2026-09-23)

> ⚠️ **Đổi tên 2026-09-23**: mục này trước đây ghi là "P9-D", nhưng **P9-D trong `.plan/next1/p9_prompts.md`** là `sales_invoice.create`
> (đã làm xong cùng ngày). Giữ hai thứ cùng tên "P9-D" sẽ làm phiên sau đọc sai việc ⇒ mục này nay là **P9-C-followup**.

- **Hiện tượng**: `outstanding_amount` của ERPNext tính từ **GL (đã submit)** ⇒ một Payment Entry **NHÁP** không làm giảm nợ,
  nên hỏi lại "trả NCC Hà Tiên 2 triệu" lần 2 vẫn thấy đủ nợ và đề xuất tiếp phần đã có nháp.
- **Vì sao chưa sửa**: đây là hành vi **có từ trước ở đường THU**; sửa là đổi ngữ nghĩa tiền của **cả hai hướng** ⇒ cần user quyết (đã quyết: làm sau).
- **Hướng làm khi tới lượt**: `openDraftCover` như P9-A1 (`delivery-write.mjs`) — đọc Payment Entry nháp theo `party` + `references.allocation` trong ngày,
  trừ phần đã chiếm khi dựng đề xuất **và** khi drift-check ở executor; phải chạy cho **cả hai** hướng (thu/chi) với cùng một bộ test.
- **Lưới an toàn đang giữ (không phải không có gì)**: mỗi `/execute` **đọc lại nợ thật + kẹp trần** · `detectDrift` ⇒ `PROPOSAL_STALE` nếu dữ liệu đổi · ERPNext vẫn validate lúc submit.
- ⚠️ **Không tự mở lại** nếu chưa có yêu cầu của user — vùng SỐ TIỀN.

### ĐÃ DUYỆT — XONG trong phiên result31 (2026-09-16) · review vòng 2 kèm 2 fix — ✅ COMMIT `bda54cf` ĐÃ PUSH

0. ✅ **Review vòng 2 (result31 §11) — ĐÃ COMMIT `bda54cf`**: **F1** anchor `startsWith` vẫn nuốt câu ĐỌC lịch sử (`'thanh toán gần nhất của chị Lan...'` → `'payment gần nhất...'` → routed payment_write SAI — probe `answerQuestion()` thật) ⇒ fix `notIf` deny-list (bao nhiêu/mấy/gần nhất/mới nhất/?) → câu hỏi rơi về nhóm payment ĐỌC; +1 test round 2, falsify đạt (gỡ gate → FAIL đúng assertion). **F2** `store.cancel()` ngoài try/catch — race với `/execute` đồng thời ⇒ throw uncaught ⇒ **Node ≥15 crash cả process** (bằng chứng cơ chế: async handler throw → exit 1; suite không bắt được vì child-process cách ly) ⇒ bọc try/catch → 409. **F3** reason dùng `rawText`. Suite sau review: **Node 119/119 · Python 60/60 · Flutter 29/29 · analyze 0**.

1. ✅ **Gộp 1 commit `eea0411`** (thay cho tách 3 — user quyết) + push: 37 files, +3794/−124 (Stage B + fix money/identity + Phase 9 safety + docs result24-30).
2. ✅ **Nối `buildPaymentProposal()` vào `routeIntent()`**: nhóm `payment_write` ĐẦU ROUTES, anchor `startsWith` đầu câu (synonym mapper biến "thu tiền" → "payment" đầu câu; nếu so substring sẽ nuốt câu đọc chứa "đã/chưa thanh toán") → "thu tiền cho chị Lan 500 ngàn" qua pipeline thật = proposal `create_payment_entry`/HIGH, amount từ NLP, invoice nợ cũ nhất; thiếu tiền ⇒ đề xuất THU HẾT nợ (vẫn HIGH, không ghi ngầm). Sửa chữ cũ "Phase 2 chỉ đọc" (grep 0 hit). E2E + widget test với JSON server trả về verbatim — nút [Xác nhận] hiện thật trên Flutter. Falsify: gỡ anchor → 15/16 FAIL; phá confirmable → widget FAIL; khôi phục xanh.
3. ✅ **Route `/execute/cancel`** (giải zombie PENDING result29 §10-F2): `store.cancel()` chỉ từ PENDING; COMPLETED ⇒ 409 + result; PENDING ⇒ `reconcilePaymentEntry()` trước — 0 chứng từ mới CANCELLED, thấy chứng từ ⇒ 409 + `erpnext_doc` (kèm test retry /execute cùng id → replay). 503 khi ERPNext chết lúc đối soát. Falsify: disable nhánh chặn → 13/14 FAIL đúng chỗ; khôi phục 14/14.
4. ✅ **Xoá 2 PE demo `ACC-PAY-2026-00114/00115`**: đọc source tìm tool thật (`erpnext_doc_delete` — draft OK, không cần cancel vì docstatus 0); gọi qua JSON-RPC thô MỘT LẦN theo lệnh user (đường xoá KHÔNG được mở vào code sản phẩm); verify độc lập: cả 2 GONE + `ACC-SINV-2026-00047` outstanding 457.875 Unpaid — GIỐNG HẾT trước xoá.
5. ✅ **faq.md** đầu-file + §3.2/§3.3/§9/§8 cập nhật khớp hành vi mới (nút [Xác nhận] chỉ hiện khi RA LỆNH ghi).
6. ✅ **Commit `bda54cf` ĐÃ PUSH** (2026-09-16): 18 files +978/−66 (14 file + result31.txt + 2 handoff); secret scan CLEAN; `.env`/`idempotency-store`/rác không stage.

### 🆕 Review code toàn bộ + 3 lỗi thật UI/an toàn (result40 → result42)

- **Review ~7.5k dòng** (Dart client · Node skill layer/router · Python bridge), tìm bằng probe chạy thật:
  - **F1 (crash)** `proposal_card._confirm()` cập nhật UI sau `await` ở 4 nhánh không kiểm `mounted`
    ⇒ `setState() called after dispose()` khi rời màn hình/xoá lịch sử lúc lệnh ghi đang bay → **ĐÃ SỬA** (4 guard).
  - **F3 (fail-OPEN ở đường an toàn)** `problems[]` không phải list ⇒ ném TypeError ⇒ banner KHÔNG hiện và
    **nút [Xác nhận] vẫn còn trên đề xuất đã bị từ chối**; cùng cast ở model còn xoá sạch lịch sử chat → **ĐÃ SỬA** (parse tolerant).
  - Cả 2 đã **falsify** (gỡ fix → test đỏ, khôi phục → xanh) + 4 test hồi quy (**Flutter 34 → 38**).
  - **F2 (UI nói ngược sự thật)** `ListView.builder` dispose card ngoài viewport ⇒ thẻ ĐÃ GHI bị dựng lại sạch,
    nút [Xác nhận] quay lại (probe P2: `success=1/button=0` → `success=0/button=1`) — user chọn **(b)
    `AutomaticKeepAliveClientMixin`** ⇒ **ĐÃ SỬA** (`wantKeepAlive` theo state cục bộ, không ghim mọi card).
  - **✅ CẢ 3 FIX ĐÃ COMMIT `4546997` (đã push cùng đợt `c401b0f`)** (`result41.txt` + `result42.txt`): 4 file Dart, 272+/8−;
    Flutter **39/39** (+5 test hồi quy F1×2 · F3 · F2).
- **Hạn chế của option (b)**: kết quả ghi nằm trong RAM ⇒ mất khi tắt app (option (a) mới persist — phải đổi schema).
  An toàn tiền KHÔNG phụ thuộc hiển thị: `command_id` được ghim trong history (`ChatTurn` round-trip test) nên lần bấm
  sau restart vẫn là **replay phía server**, không ghi phiếu thứ hai.
- **Saga/REVERSAL (phase-09 §7)**: ⏸️ **chờ duyệt** — KHÔNG code.

### Hạ tầng dev + 2 tính năng client (result43, 2026-09-17) ✅ ĐÃ COMMIT `c401b0f` + `f28869a` (đã push, APK CI XANH)

- **A) Xác minh hạ tầng sau khi tunnel đổi URL** (chỉ config, không code): `.env` đã đúng
  ngrok mới — verify bằng đọc thật `erpnext_customer_list` (3 khách) · `mac-custom` config
  khớp, tunnel sống (502→200) · `erpn8788.loca.lt` = tunnel Gateway (port 8788).
  ⚠️ tunnel erpn8788 hiện TẮT (tình trạng môi trường, không phải lỗi config).
- **B) Giới hạn lịch sử chat** `maxChatItems` (mặc định **20**, sàn 5, sửa được): cắt turn
  CŨ NHẤT khi vượt cap, **TRỪ turn có proposal đang treo** — luật nằm ở
  `ChatHistoryService.trimTurns` (pure) áp cho cả state lẫn storage; **falsify bắt buộc đạt**.
- **C) Màn hình Settings** (route `/settings` + icon ⚙️): đổi Gateway URL / auth user /
  auth password / max chat items — `CopilotApiClient` đọc settings MỖI request nên **áp dụng
  ngay, không cần build lại APK**; settings rỗng ⇒ vẫn dùng `--dart-define` (APK cũ không đổi).
- 🔎 **Review vòng sau tìm 3 vấn đề thật**: `attachRejection` từng cắt luôn card VỪA bị từ chối
  (banner lý do biến mất — test chứng minh `6→5` trước khi sửa) → đã bỏ trim ở đường đó;
  doc comment provider bị dán lệch (analyzer không báo) → đã sửa; **hở test ở đường nối mới**
  (route `/settings` + ⚙️ không test nào chạm vì harness cũ đi vòng qua nó) → đã thêm
  `test/settings_navigation_test.dart` chạy qua `appRouter` THẬT.
- **Suite: Python 60 · Node 120 · Router 19 · Flutter 62 (39→62) · analyze 0**.
- **✅ ĐÃ COMMIT `c401b0f` + PUSH + BUILD APK XANH** (user duyệt 2026-09-17): GH Actions run
  `35173021349` SUCCESS 5m0s → artifact `erpn-chat-debug-apk` (~80 MB, hạn 2026-12-16).
  ⚠️ Repo chưa set GitHub Variables ⇒ APK endpoint/auth rỗng → **dùng màn Settings trong app**
  để nhập `https://erpn8788.loca.lt` + auth (không cần build lại).
- **Hạn chế đã ghi rõ**: `/execute` đọc `dioProvider` trực tiếp nên chỉ theo URL mới SAU khi có
  ≥1 lần `/ask` (fail-CLOSED, không ghi sai); card đã ghi vẫn "pending" trong model nên không
  bao giờ bị cắt (an toàn > gọn); password lưu SharedPreferences thường (app-private, CHƯA mã hoá).

### Bước kỹ thuật tiếp theo (KHÔNG Phase 4/8/11)

- **MVP kỹ thuật Phase 7 + Phase 9 an toàn: ĐÃ XONG + ĐÃ COMMIT** (bda54cf + 31d485c).
  Mọi nhánh của luồng "hỏi nợ → thu tiền → xác nhận → ghi nháp → banner từ chối nếu lệch/hết hạn"
  đều có code + test; không còn khoảng trống kỹ thuật nào trong scope hiện tại.
- **✅ Đợt UI STALE + F4 (result32–34) ĐÃ COMMIT `31d485c` + PUSH** (user duyệt
  2026-09-16): 15 files +1006/−22 — 4 Dart + 4 docs + result32/33/34 + 3 handoff +
  runbook demo. Suite sau commit: **Python 60/60 · Node 119/119 · Flutter 34/34 ·
  analyze 0**.
- **KHÔNG mở Phase 4 (STT — chặn audio) / 8 (jobs/TTS) / 11 (write skills mới)**.
- Việc tiếp theo: người thật (APK thiết bị thật · SUBMIT phiếu thu · thu audio 150 câu ·
  dán GitHub Settings · rotate key) — hoặc **saga code khi user duyệt §7** (phase-09,
  REVERSING/REVERSED, 5 test mock). Runbook demo 1 trang: `docs/demo-payment-draft.md`.

### Đã xong trong phiên docs-sync (2026-09-16)

- openspec tasks.md: 5.9 → [x] (`6054458`) + mục §6 Phase 6–9 pointer — validate OK.
- **`LESSONS_LEARNED.md` (mới)**: chỉ mục 6 nhóm lỗi lặp + top bài học, nguồn đầy đủ = skill `erpn-verify-first`.
- handoff_20260916-0725.md · result30.txt.

### Đang chạy (không cần quyết thêm)

1. ~~GH Actions run #2~~ ✅ **XONG — run #2 + #3 đều SUCCESS** (`result10.txt`, `result11.txt`):
   run #3 (`c3d74c3`) build APK với dart-define `COPILOT_BASE_URL`/auth từ repo
   Variables/Secret. **Còn lại là việc user:** ① dán 3 giá trị GitHub Settings (token
   chỉ-đọc) ② cài APK thiết bị thật — endpoint lâu dài user chốt 2026-09-16 HOÃN
   (Cloud Shell = dev, Mac/ngrok/tunnel = demo tạm; VPS thật SAU khi app xong),
   dùng nguyên trạng tunnel khi dev ③ cài APK thiết bị thật
2. **Mandatory Sign-off Phase 5** — ✅ ĐÃ KÝ 2026-09-15 (bảng 4/4 điền theo quyết định:
   KHÔNG scrub, KHÔNG 2-tier; free tier chấp nhận — `SIGNOFF-phase5-pii.md`). LLM Router
   bản đơn giản đã code (`scripts/llm-router.mjs` + config JSON + audit JSONL, 7/7 test,
   E2E smoke qua mock-llm — result14)
3. **LLM Router nối upstream thật** — ✅ result15 (2026-09-15): endpoint chính thức điền xong
   (zen `opencode.ai/zen/v1` · gemini `…/v1beta/openai`); 2 bug router tự bắt khi chạy thật
   (https transport + field `store` Gemini từ chối → `stripFields` per-upstream) +
   `LLM_ROUTER_DEBUG=1`; **Gemini verify generate thật 200** qua router · **Zen bị chặn
   billing** (CreditsError: No payment method — glm-5.3-flash PAID, big-pickle chỉ chạy
   trong OpenCode client); cơ chế dsh thật = **cordis patch row override** (công thức
   settings.yaml của result6 lỗi thời) → skill mới `erpn-dsh-setup`; **E2E dsh→router→Gemini
   flaky do free tier 20 req/phút** (1 session dsh tốn 2–3 calls — 429 quota + 503 high
   demand, nguyên văn trong result15 §6). Còn lại Phase 5: user quyết định upstream
   (Zen nạp payment / bỏ; Gemini free hay paid)

### Theo phase

| Phase | Nội dung | Write? | Điều kiện tiên quyết |
|---|---|---|---|
| 4 | Voice input/STT (hybrid): 🎤 → STT → user xem lại/sửa text → Gửi | Không | ⚠️ **Chặn bởi audio thật 3 miền** (100–200 câu, chờ người thật thu) |
| 5 | AI Gateway core: auth, LLM Router, audit (scrub ĐÃ BỎ theo sign-off 2026-09-15) | **ĐANG LÀM** — upstream hàng ngày = **mac-custom** (LLM tự host trên Mac qua `llm9000.loca.lt`, KHÔNG quota — result20); gemini-openai giữ lại CHỈ để verify tương thích provider thật (thought_signature, `E2E_LLM_MODEL=real-gemini`); zen billing-blocked để sau. E2E mac-custom có bằng chứng hợp lệ = **result22** (4×200, `attempts=['mac-custom']`; claim audit của result20 đã bị đính chính — xem result22 §9B); bug credit-note **đã fix + commit `6054458` + verify thật 457.875đ/171.800đ** (result21); E2E đầy đủ qua `mac-custom` **đã XANH** (result22) | Còn lại: verify thought_signature live khi thuận tiện (chờ quota reset) |
| 6 | Entity resolution + Action Proposal card (xác nhận tiếng Việt + Risk Level) | Không | Exit criteria Phase 5 |
| 7 | **`create_payment_entry` + idempotency** | **Có** | **Giai đoạn A XONG + ĐÃ COMMIT `8ebfc0e` (result23) · Stage B + review + fix history + chaos ĐÃ COMMIT `eea0411` (result25-27)**: proposal HIGH dừng ở xác nhận + idempotency store + `/execute` MOCK + nút Flutter. ✅ Fix `command_id` ổn định theo proposal — đã xong + test (`result24.txt`). ✅ **Giai đoạn B ĐÃ CHẠY (user duyệt, ERPNext demo, quy trình như production — `result25.txt`)**: ghi thật `ACC-PAY-2026-00114` 10.000đ + verify độc lập + replay; phát hiện & fix BUG THẬT crash-recovery ghi phiếu thứ hai. ✅ **Review sau Stage B (`result26.txt`) — 5 lỗi thật đã sửa + falsify**: lỗi post-write bị đánh FAILED (đẩy sang command_id mới = ghi phiếu 2) · `amount_vnd: 0`/NaN bị thăng cấp thành thu TOÀN BỘ nợ · chọn đại mode ⇒ sai tài khoản · `<= 0` để lọt NaN · docs/bảng skill. Node 86 → **91/91** · Python 58/58 · Flutter 25/25 · analyze 0. ✅ **Vá lỗ hổng khoá idempotency khi KHÔI PHỤC HISTORY + 2 chaos test (`result27.txt`)**: `toJson/fromJson` nay ghim `command_id` ⇒ khoá sống theo card qua cả app restart (trước đó restore = UUID mới = ghi phiếu thứ hai); chaos test “**ERPNext ghi xong rồi mất response**” → retry reconcile về đúng document đó (đếm ledger thật = 1) + test “ERPNext chết lúc đối soát → 503, không ghi”. Node **93/93** · Python 58/58 · Flutter **27/27** · analyze 0. ✅ **`faq.md` + 2 bug thật đã vá (`result28.txt`)**: tên khách trùng từ-chỉ-số từng làm sai số tiền (`bác Hai 500 ngàn` → 2.500.000đ; `chị Bảy 300 ngàn` → 7.300.000đ) · danh xưng "chị" từng khớp sai khách (site có khách tên `Chị Tư — thầu nhỏ`) — cả hai đã fix + test + falsify. ⚠️ Khoảng trống đã phát hiện: `buildPaymentProposal()` chỉ được test gọi ⇒ nút [Xác nhận] không bao giờ hiện — **ĐÃ NỐI trong result31** (nhóm `payment_write` + anchor `startsWith`; E2E + widget test JSON verbatim). Node 97/97 · Python 60/60 · Flutter 27/27 tại thời điểm đó. ✅ **Skeleton Phase 9** (plan-only, `.plan/phases/phase-09-…md`) — đã grep xác nhận proposal chưa có `created_at`/snapshot và store chưa có TTL; expiry/stale/khoá `(customer, invoice)`/“không xoá document” là việc mới. ⏳ Chờ user: quyết SUBMIT phiếu (nháp nên công nợ chưa đổi) · 2 phiếu nháp demo ĐÃ XOÁ trong result31 (`erpnext_doc_delete`, verify hóa đơn gốc không đổi) · commit `eea0411` ĐÃ PUSH |
| 8 | Background jobs + push notification + TTS readback | Có | Phase 7 + Phase 9 |
| 9 | Proposal state machine (expiry, re-validation, saga/compensation) | Có (đổi hành vi) | **PHẦN AN TOÀN XONG + ĐÃ COMMIT `eea0411`**: ① TTL 10 phút (`proposal-freshness.mjs` `assertFresh`) → 409 `PROPOSAL_EXPIRED` trước `store.begin()` ② re-validate `detectDrift()` so snapshot với dữ liệu sống → 409 `PROPOSAL_STALE` + problems, KHÔNG ghi ③ intentKey `(customer\|invoice)` chặn ý định trùng đang PENDING (đính chính result29 §10-F1) ④ `created_at` ghim vào proposal + Dart (sống qua khôi phục history) ⑤ 409 intent-in-flight trả `clash_command_id` ⑥ **route `/execute/cancel` ĐÃ CÓ (result31)** — đường thoát zombie PENDING. **Còn thiếu (nâng cao)**: saga/undo-compensation; Flutter hiển thị lý do `PROPOSAL_STALE` chi tiết trên card |
| 10 | Multi-user, RBAC, on-behalf-of ERPNext credential | Có | **Trigger #1 tách khỏi dsh** |
| 11 | Mở rộng write skills (sales order, inventory, purchase) | Có | Phase 10 |
| 12 | Multi-tenant readiness | Có | Chỉ nếu có ý định SaaS |
| 13 | Production hardening + beta pilot (chaos test, success rate) | Có | |
| — | **Phase 15 — Monetization (pro qua ads, reset mỗi ngày) thực thi Ở GIỮA 13 và 14** | — | 4 câu chờ user: ad provider · múi giờ "hết ngày" · danh sách pro · IAP bỏ ad |
| 14 | Store submission + PII/NĐ13 sign-off thủ công | — | Phase 9 + PII scrubbing phải pass audit THỦ CÔNG |

### Chờ người thật (không phải việc agent)

- **Rotate key ERPNext** — Hoàng làm trực tiếp trên server (trạng thái: key cũ vẫn hợp lệ,
  result9 §1). Sau khi rotate: update `.env` qua SSH + probe lại + xóa giá trị cũ khỏi mọi file
- **Thu audio thật 3 miền** — mở khóa Phase 4
- **Cài APK + test tại điểm bán** — cần người thật
- **LLM upstream thật** — 2 quyết định user (result15): Zen nạp payment method hay bỏ upstream;
- **Fix bug credit-note — ĐÃ ÁP DỤNG + COMMIT `6054458` (result21)**: `outstanding_amount > 0` →
  `!== 0` trong `mcp-erpnext/src/skills/customer.mjs` (helper dùng chung cho cả `getCustomerBalance`
  và sales) + `sales.mjs`; mock thêm credit note SINV-0004 để có test hồi quy; nhãn "hóa đơn chưa trả"
  → "**chứng từ** chưa thanh toán" + nhánh "hiện dư X" khi outstanding âm. Verify THẬT bằng probe
  gọi thẳng `answerQuestion` với ERPNext thật (không LLM): **457.875đ/1 ✓** và **171.800đ/4 ✓**
- **Giữ `lt` sống trên máy Mac khi cần E2E** — tunnel `llm9000.loca.lt` chỉ hoạt động khi `lt`
  đang chạy; E2E đầy đủ qua mac-custom **đã XANH** (4/4 request 200 · `messages` 2→5→7→9 ⇒ có turn replay — result22 §4),
  nhưng phải bật lại `lt` mỗi lần chạy và dựng lại dsh nếu `/tmp` đã bị dọn;
  Gemini giữ free tier (không nâng paid). Mock giữ làm contract test; dsh trỏ router qua cordis patch
  (skill `erpn-dsh-setup`)

### Việc còn lại của Phase 5 (gateway)

- **Verify `thought_signature` LIVE** — chạy theo `docs/phase5-thought-signature-runbook.md`
  (1 session duy nhất sau mốc reset 07:00 UTC; không probe trước). Đã thất bại 4 lần liên
  tiếp vì quota, không phải logic; bằng chứng hiện có là hermetic (router 19/19).
  ⚠️ `GEMINI_API_KEY` dùng chung ⇒ "ngay sau reset" không đảm bảo có quota.

### Nợ kỹ thuật Phase 1 (khi có dữ liệu quyết định)

- `bạc` = mệnh giá nào (`ch-003`) · viết tắt `m` = triệu? (`ch-004`) · cờ `approximate`
  ("khoảng/hơn 10 triệu") · số âm/hoàn tiền · tiếng lóng miền Trung · phân biệt câu hỏi/lệnh (Phase 6)
- Số trần cuối câu (`"2 triệu 500"`) và 4 số dạng năm (`"trả 2000"`) — **từ chối có chủ đích**
  (fail-safe); viết `2000 đ` hoặc `hai nghìn`

---

## Gate quan trọng nhất (không được bỏ qua)

- **Trước Phase 7** (write đầu tiên chạm tiền): Phase 1–6 đạt exit criteria đầy đủ — điểm mà nếu
  bỏ qua, mất niềm tin người dùng vĩnh viễn, không phase sau nào cứu được.
- **Trước Phase 14** (publish): Phase 9 + PII scrubbing Phase 5 phải **pass audit thủ công**,
  không chỉ unit test — nghĩa vụ pháp lý (Nghị định 13/2023).

## Nguyên tắc xuyên suốt (áp dụng MỌI phase)

1. **Read trước Write** — phase write chỉ bắt đầu khi phase read-only tương ứng đạt ≥90% success
   rate **đo thật trên server thật** (chuẩn tham chiếu: result9 đo 18/18 bằng batch script).
2. **Không tin external reference chưa verify** — tự `npm view` / mở link / curl thật trước khi code.
3. **Tái dùng trước khi xây mới** — check OmniRoute/9Router + TAXPRO trước mỗi phase liên quan runtime/router/NLP.
4. **An toàn > tốc độ** — có thể cắt scope nghiệp vụ, KHÔNG cắt Compliance (PII/NĐ13),
   Idempotency, Proposal Confirmation.
5. **Exit criteria đo được** — không chuyển phase bằng cảm tính; unit xanh ≠ chạy thật.

## Notes

- **Tool đang hỏng trong env:** AgentMemory (down) · MCP cocoindex/codebase-memory (không expose) ·
  OCR (không chạy được) · Simplenote (không có) → Code Review thủ công, không tự cài.
- **Vùng tiền/số/phân quyền: AI KHÔNG tự ký duyệt/không tự commit** — chờ user review.
- **Cầu nối Python ↔ Flutter/dsh = HTTP service nội bộ (localhost)** (chốt 2026-09-13) —
  1 nguồn logic duy nhất, không port sang Dart.
- Mỗi phase lớn: cập nhật `resultNN.txt` + `checklist.md` + `features.md` + `next.md` + `handoff_<ts>.md`.
- `.plan/` bị gitignore → file kết quả phase KHÔNG commit; `result*.txt` / docs root thì có.
