# next8 / Sales vertical — tasks

> Phase 6 của `.plan/next8/phases/phase-06-sales-vertical.md` · Program A · vùng **TIỀN + KHO**
> ⇒ **KHÔNG tự commit**, trình owner duyệt.
> Locks áp dụng: §6.1 (1 phương thức = 1 PE) · §6.2 (tài khoản đúng loại hoặc BLOCK) ·
> §6.4 (đọc đủ dòng). Nguồn phải đọc trước khi code: `plan1_final_v2.md` §6/§7/§12/§13/§15/§24/§30 +
> `phases/phase-00-audit.md` §4.

## 0. Sự thật ĐÃ ĐO trên site (dùng thẳng — xem `.plan/next8/phase6-audit.md`)

- SI reqd: `company, naming_series, customer, posting_date, currency, conversion_rate,
  selling_price_list, price_list_currency, plc_conversion_rate, items, base_net_total,
  grand_total, base_grand_total, debit_to` (phần lớn ERPNext tự tính).
- CK dòng = `items[].discount_amount`/`discount_percentage` (neo `price_list_rate`);
  CK đơn = `additional_discount_percentage`/`discount_amount` + `apply_discount_on`
  (default "Grand Total"); site **ẩn** nhóm CK đơn trên form nhưng field ghi được qua API.
- `paid_amount`/`outstanding_amount` **read_only** · `Sales Invoice Payment` = 0 dòng (POS không dùng).
- PE **không** gạch nợ được SI nháp: `payment_entry.py#validate_reference_documents`
  `if ref_doc.docstatus != 1: throw("… must be submitted")` + `get_valid_reference_doctypes()`
  có `Sales Invoice` cho `party_type = "Customer"`.
- Vòng đời CK thật: `camvlxd_transfer_state` (`pending`/`confirmed`) + `camvlxd_payment_entry`;
  2 pending / 15 confirmed trên 532 SI.
- Giá: `Pricing Rule` bật = 0 · `Selling Settings.selling_price_list = "Standard Selling"` · khách mẫu
  `default_price_list = null` · `Item.standard_rate` = 0 ⇒ giải qua `Item Price`.
- Thuế: `VAT 8% VLXD - MP` (default) · `VAT 10% Kim loại - MP` · `Vietnam Tax - MP` ·
  `Item Tax Template`: `KCT Cám chăn nuôi - MP`… ⇒ chỉ chọn tên, không tự cộng thuế.
- Kho: 11 kho lá · pin `Kho Cám - MP` · `Bin` đọc được (CAM-HEO-25KG @ Kho Cám = 736).
- Company defaults: income `4110 - Doanh thu bán hàng - MP` · cost center `Main - MP` ·
  receivable `1310` · cash `1110` · bank `1210 - ACB 110296868 - MP`.

**Owner chốt 2026-09-30 (trong phiên)**: thu tiền = **(A) PE nháp on-account** (thu ngay, chưa
gạch nợ) · **CÓ** ghi `camvlxd_transfer_state = "pending"` · **cho phép 1 vòng ghi nháp thật**.

**ĐÍNH CHÍNH sau khi chạy THẬT (2026-09-30 — xem `.plan/next8/phase6-result.md` §4):**
`Selling Settings` là **Single** (LIST read = HTTP 500, chỉ `doc_get` đọc được) · `Item Price` giữ
**cả giá mua và giá bán** (phải lọc `selling = 1`, không thì bán bằng giá vốn) ·
`items[].discount_amount` là field **DẪN XUẤT** (`= price_list_rate×qty − rate×qty`) nên CK dòng
phải gửi **cặp** (`price_list_rate` = giá bảng, `rate` = giá NET).

## 1. OpenSpec (trước code lớn)

- [x] `openspec/changes/next8-sales-vertical/{proposal.md,design.md,specs/*,tasks.md}` — tạo **trước** code.
- [x] `openspec validate next8-sales-vertical --strict` = **valid** (chạy lại sau khi thêm 2 requirement
      đính chính ở §0 vào `specs/sales-draft/spec.md` + §10 vào `design.md`).
- [x] `.plan/next8/phase6-audit.md` (6 mục §4 + quyết định đường thu tiền) có bằng chứng thật.

## 2. Server — draft + proposal

- [x] `SalesTransactionDraft` theo plan §12 (customer/warehouse/items/order_discount/payment_methods/outstanding).
- [x] Tổng **server tính**: `line_net` → `subtotal` → `grand_total`; **2 tầng CK không gộp** (có test khẳng định + falsify F1).
- [x] `buildSalesProposal` → `erpn.proposal/v1`, risk `HIGH`, mọi số từ server; `payment_methods ≤ 1`.
- [x] Giá: `priceForLine` + price list (khách → Selling Settings); không có giá ⇒ **HỎI**, không mặc định 0.
      **ĐÍNH CHÍNH (đo thật)**: price list đọc từ **Single** `Selling Settings`; Item Price lọc `selling = 1`
      ⇒ **không bao giờ lấy giá mua làm giá bán** (test + falsify F8/F9).
- [x] Thuế: chỉ chọn tên template (+ `item_tax_template` dòng); không tự cộng thuế.
- [x] Kho: `set_warehouse` + kho dòng; thiếu ⇒ dùng `COPILOT_DEFAULT_WAREHOUSE` và **nói rõ** đã dùng kho nào.
- [x] Tồn kho: đọc `Bin` (read-only) ⇒ **chỉ cảnh báo**, không chặn/không hạ số.
- [x] `credit = grand_total − actual_paid` là **số dư**, không phải phương thức (ghi trong spec + test).
- [x] CK dòng ghi ERPNext dưới dạng **cặp** (`price_list_rate`=giá bảng, `rate`=giá NET); verify cả hai
      rate + discount dẫn xuất (test + falsify F10).

## 3. Thu tiền (owner chốt A) + vòng đời §13

- [x] Thu tiền là **lệnh riêng** qua cùng `/execute`, dùng đường advance đã có (1 phương thức = 1 PE).
- [x] **Không** gạch nợ vào SI nháp · **không** ghi `paid_amount` · **không** dùng child `payments`
      (verify: `unallocated_amount = số thu`, `references = []` — đo trên site thật).
- [x] Copy: *"đã ghi phiếu thu NHÁP … (tiền đặt trước, chưa gạch nợ vào hoá đơn nháp này)"*.
- [x] CK: ghi `camvlxd_transfer_state = "pending"` trên SI + copy *"chờ xác nhận tiền về"*;
      TM: **không** set state, không nhắc chuyển khoản.
- [x] **Không** bao giờ nói "đã nhận tiền" chỉ vì đã tạo chứng từ (test pin nguyên văn + falsify F3).
- [x] **§6.3 cho Sales = S1 — owner chốt 2026-09-30**: Collect `payment.create` GIỮ NGUYÊN
      §6.3 (còn HĐ mở ⇒ bắt buộc allocate); đường Sales (`sales.create`) được PE nháp
      **on-account (advance) cùng party** với SI nháp vừa tạo, KHÔNG bắt allocate vào HĐ mở cũ;
      copy "tiền đặt trước / chưa gạch nợ". KHÔNG nới Collect · KHÔNG 1 lệnh N PE · KHÔNG submit.
      Kỹ thuật: executor của Sales tự dựng NỘI BỘ payload advance (dùng lại
      `resolveAdvanceAccounts` + `buildPaymentEntryData` chế độ `references: []`) — luồng mới
      có test riêng, không đi qua luật §6.3 của Collect, không sửa `payment.create`.

## 4. Flutter — SalesScreen

- [x] `features/sales/{data,application,presentation}` theo blueprint; route `/sales` nhận `handoffId`.
- [x] 4 khối: Khách · Hàng hoá · Chiết khấu (dòng ≠ đơn) · Thu/Tổng; tái dùng picker + `ProposalCard`.
- [x] Riverpod controller + epoch; đổi khách/kho ⇒ reset items + tiền (có test).
- [x] Thiếu handoff ⇒ màn từ chối tiếng Việt, **không** tự dựng handoff.
- [x] **Không** parser tiền thứ hai trong Dart.
- [x] Chat auto-mở `/sales` khi `full.screen == "sales"` (+ guard giọng nói có trigger `sales.create`).

## 5. Execute + verify

- [x] `/execute` duy nhất ⇒ SI **nháp** (`docstatus 0`); PE nháp nếu có thu.
- [x] Verify đọc lại: SI (items đủ dòng, 2 tầng CK tách, `grand_total`, `outstanding_amount`,
      company/customer/warehouse, `camvlxd_transfer_state`) + PE (như Phase 4) + correlation ids.
- [x] Idempotency: double confirm ⇒ **1** SI (+1 PE nếu có thu); trùng business key ⇒ `409`.
- [x] Tripwire: không helper tự chọn item/FIFO/kho; executor chỉ đăng ký ở `safety-gateway`.

## 6. Test + falsify

- [x] `test/next8-sales-*.test.mjs` phủ ma trận plan §30 (nhiều item · qty/uom · giá · CK dòng ·
      CK đơn · cash · bank · cash+bank(từ chối) · trả một phần · công nợ còn lại · account theo
      phương thức · sai loại tài khoản · chờ tiền về) — file **20/20**.
- [x] F1 gộp 2 tầng CK · F2 credit như tiền vào · F3 báo "đã nhận tiền" · F4 >1 phương thức ·
      F5 fallback 1110 · F6 client làm thẩm quyền giá · F7 bỏ lọc company/kho ⇒ **đỏ đúng test**.
- [x] F8 (đọc price list bằng LIST) · F9 (bỏ lọc `selling=1`) · F10 (CK dòng bằng `discount_amount`)
      ⇒ **đỏ đúng test** (3 pin mới từ lỗi đo thật).
- [x] Restore byte-identical (`cp` trước + `sha256sum -c` sau) — **10/10 RED · 10/10 restore identical**.

## 7. Regression

- [x] Node: file mới xanh + `npm test` chỉ 2 fail baseline env `dsh` (**1.070 / 1.068 / 2**).
- [x] Flutter: `flutter analyze` 0 warning mới (**1 warning = baseline**) · `flutter test`
      **439 pass / 3 fail** (3 fail = probe untracked).
- [x] Python không đổi.

## 8. Vòng ghi nháp THẬT (owner đã cho phép 2026-09-30)

- [x] 1 vòng: SI nháp (+ PE nháp on-account nếu chọn thu) cho khách/số tiền nhỏ.
      (2 lần đầu **không xanh** và làm lộ 3 lỗi thật ⇒ đã xoá sạch rồi chạy lại; lần 3 xanh.)
- [x] Verify bằng REST: SI `docstatus 0`, items + 2 tầng CK, `grand_total`, `camvlxd_transfer_state`,
      PE `unallocated_amount` = số thu, **0 dòng allocation** vào SI nháp — đủ, xem
      `.plan/next8/phase6-result.md` §7.
- [x] Xoá lại đúng chứng từ của mình + verify 404 + số nền không đổi (SI **534/5** · PE **316/17**;
      phải xoá cascade vì automation của site gắn thêm Audit Issue/PLE/GL/ALLOC).

## 9. Sổ sách & bàn giao

- [x] `result92.txt` (§2) + `.plan/next8/phase6-result.md` + tick file này + `working.md`.
- [ ] `release-roadmap.md` — cập nhật ở bước bàn giao.
- [ ] **KHÔNG tự commit** (vùng tiền + kho) — chờ lệnh owner.

## 10. DỪNG hỏi owner khi

- Muốn **write-off**, **1 lệnh → N PE**, hay **chặn/hạ số theo tồn kho** (hard constraint).
- Site khác plan §12/§13 (vd không có bước "chờ tiền về") ⇒ cập nhật spec, không bịa.
- Phải sửa `safety-gateway.mjs`/`idempotency.mjs`/luật `payment.create` của Collect.

## 11. GAP — XỬ LÝ THEO LỆNH OWNER (2026-09-30)

- [x] **S21 — `/collect/propose` gate capability** (đối xứng S20, lệnh owner "Sửa S21"): thêm gate
      `screenForCapability(capabilityId) !== "collect"` sau kiểm WRITE (`copilot-server.mjs`, hàm
      `proposeCollectFromHandoff`) — trả `409 STALE_HANDOFF` cùng dạng câu trả lời DUY NHẤT như ca
      stale, không lộ ticket nào còn sống. Đối chiếu vs §10: KHÔNG đụng `safety-gateway.mjs`,
      `idempotency.mjs`, luật `payment.create` của Collect — chỉ đóng CỬA propose.
- [x] **S22 — đường vào màn Bán từ chat**: (1) nhóm định tuyến WRITE `sales_write` thêm vào
      `capabilities.json` (keyword `bán hàng/bán cho/lập hoá đơn bán` + notIf câu hỏi, đứng TRƯỚC
      nhóm đọc `sales` — đo thật: câu mệnh lệnh từng bị nhóm đọc giành mất);
      (2) `salesHandoffFor()` trong `copilot-server.mjs` (twin của `collectHandoffFor`): trả ticket
      `sales.create`/screen `sales` với customer đã resolve, còn lại MISSING, KHÔNG BAO GIỜ có số;
      (3) chat KHÔNG đề xuất bán tự do (`proposal: null` — câu nói không mang dòng hàng); gắn vào
      3 đường guard + nhánh builder riêng; (4) Flutter: `chat_screen.dart` **đã có sẵn** route
      `business_handoff` screen `sales` → `/sales` (xác nhận đọc code, không sửa client).
      **BÀI HỌC ĐO ĐƯỢC**: NLP synonym map viết lại "bán hàng" → "sale" TRƯỚC router ⇒ câu đó rơi
      nhóm đọc (cùng lớp lỗi đã ghi ở `sales_order_write` cho "tạo đơn"/"lên đơn"); gốc này đã
      được ĐÓNG riêng ở bullet dưới.
- [x] **S22follow-up — sửa NLP synonym (lệnh owner 2026-10-01)**: bỏ `"bán hàng"` khỏi
      `SYNONYM_GROUPS["sale"]` (`src/vietnamese_nlp/synonyms.py`) — giữ `chốt đơn`/`tạo đơn`/
      `lên đơn`/`bán lẻ`/`sales order`/`sale`. Phrase sống qua `normalize()` nên `sales_write` khớp
      ⇒ `"bán hàng cho <khách>"` mở màn Bán. Khoá: `dialect_cases.json` syn-015 `expected_intents: []`
      (+note) · `test_synonyms.py` +2 test · `next8-s21-s22-capability-gate.test.mjs` dùng câu THẬT
      `"bán hàng cho Nguyễn Thị Lan"` **4/4**. Verify 2 chiều: command → ticket `screen=sales`;
      `"bán được bao nhiêu hôm nay"` → KHÔNG ticket. Falsify **F13** (re-add synonym ⇒ ĐỎ):
      **RED 13/13 · restore byte-identical 13/13**. Python **65 OK**; Node full **1074/1072/2**;
      Flutter **439/3** + analyze 1 warning (đều baseline). Trade-off ghi rõ: câu bắt đầu "bán hàng"
      thiếu từ khoá hỏi trong `notIf` (vd "bán hàng tháng này") nay MỞ màn Bán (màn chỉ mở, ghi vẫn
      qua `/execute`).
- [x] **Verify S21+S22**: test mới `mcp-erpnext/test/next8-s21-s22-capability-gate.test.mjs` **4/4**
      (ticket sales từ chat + câu hỏi không mở màn + sales-ticket → collect door bị chặn + collect
      ticket → sales door bị chặn); falsify F11/F12 thêm vào `_falsify_phase6.mjs` — **RED 12/12,
      restore byte-identical 12/12**; Node full **1074/1072/2** (2 fail dsh-env baseline); Flutter
      **439/3** (baseline `_probe_review_test.dart`) + analyze 1 warning (baseline); openspec
      validate --strict **valid**.
- [x] **Vòng thật qua CHUỖI CHAT (site `frontend`, owner đã duyệt 1 vòng nháp)**: `/ask "bán cho
      Nguyễn Văn Toàn"` → ticket `screen=sales` (KHÔNG còn cần `PROBE_FORCE_HANDOFF`) →
      `/sales/propose` → `/execute` **200 replay=false** — SI nháp `ACC-SINV-2026-01294`
      (grand_total 250.000 = 300.000 − 20.000 dòng − 50.000 đơn; `price_list_rate` 320.000/rate
      300.000/derived discount 20.000; `apply_discount_on="Grand Total"`; `update_stock` 0;
      `debit_to` 1310; `camvlxd_transfer_state=pending` + amount 100.000; taxes 2 dòng rate 0;
      warehouse `Kho Cám - MP`; income `4110 - Doanh thu bán hàng - MP`) + PE nháp
      `ACC-PAY-2026-00777` (100.000, Wire Transfer → `1210 - ACB 110296868 - MP`, `references=[]`,
      `<command_id>:advance`). Dọn cascade (2 doc + 1 Audit Issue đi kèm) → đọc-lại **404** cả hai,
      **0** ref thừa theo `custom_ai_action_id`/`reference_no`, baseline khớp **SI 534/5 · PE 316/17**.
      Ghi chú đo: tên chứng từ bị TÁI SỬ DỤNG sau xoá (SI 01294/PE 00777 trùng vòng trước) — đối
      chiếu bằng action_id mới (`act_a3d40001…`), KHÔNG dùng tên.
- [ ] **Rác cũ không của phiên này**: PE nháp `ACC-PAY-2026-00775` (Phase 5b) vẫn còn trên site.
