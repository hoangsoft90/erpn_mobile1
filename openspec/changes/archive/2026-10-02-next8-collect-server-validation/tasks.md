# next8 / Collect server validation — tasks

> Phase 3 của `.plan/next8/phases/phase-03-collect-server-validation.md`.
> Tạo **TRƯỚC khi code** (quyết định owner #1 sau Phase 1). Lock §6.1–6.5 là ràng buộc, không nới.
> Ngoài phạm vi: `safety-gateway.mjs` (Phase 4) · đổi luật 9 write khác · Sales/Purchase ·
> split N PE · thêm dependency Dart.

## 0. Dữ kiện đã ĐO (dùng thẳng, đừng đo lại)

- Tool pin `erpnext_doc_list` có `limit`, **KHÔNG có offset** (`skills/customer-create.mjs` ghi
  phép đo) ⇒ phân trang phải làm trên một lần đọc ĐỦ, không phải "page 2" gửi xuống site.
- Site: AR `1310` · AP `2110` · cash `1110` · bank `1210` · MoP **không** có account dùng được ⇒
  tài khoản luôn đến từ account row / company default.
- `references[].outstanding_amount` là ảnh chụp cũ (cùng hoá đơn 84.000/99.000/110.000 ở 3 phiếu)
  ⇒ luôn dùng số **sống**.

## 1. READ hoá đơn cho Collect (§5.1)

- [x] `listOpenSalesInvoices` nhận thêm `offset` **ở tầng skill** (cắt trên kết quả của một lần đọc
      đủ) và giữ nguyên `cap`/`limit` + `matched`/`scanned`/`truncated` (byte-compat với caller
      Phase 2); thêm `status` vào `fields`.
- [x] Đọc **không cắt im lặng**: đường đọc của màn thu tiền đọc đủ cho customer+company rồi mới phân
      trang; payload luôn nói `matched` + `truncated` (không bao giờ tự nhận "đã hết").
- [x] Test (a) lọc đúng company khi khách nợ 2 công ty; (b) `is_return`/outstanding âm được giữ;
      (c) >10 ⇒ trả 10 + total thật; (d) **179 hoá đơn ⇒ đọc được hết**, `offset` lấy được trang sau
      mà `matched` không đổi.
- [x] Ghi rõ trong code: đường chat/drill-down dùng CÙNG hàm này nên không có chuẩn số thứ hai.

## 2. Draft-cover theo company (§5.2)

- [x] `listOpenDraftPaymentEntries(mcp, partyId, {company})` — thêm `["company","=",company]` khi có
      company; khi không truyền thì giữ nguyên hành vi cũ (đường chat).
- [x] `openDraftCover(reads, partyId, direction, {company})` — chỉ trừ nháp **cùng company** + đúng
      chiều; truyền company vào đúng read.
- [x] Test: nháp của company khác **không** làm giảm phần còn lại; 2 nháp cùng hoá đơn cùng company
      ⇒ cộng dồn đúng; không truyền company ⇒ hành vi cũ.

## 3. Builder (§5.3)

- [x] `buildPaymentEntryData({references:[...], paidFrom, paidTo, mode, unallocated, …})` — 1 dòng
      `references` cho mỗi allocation; `paid_amount = received_amount = Σ allocated + unallocated`;
      `unallocated_amount` ghi **tường minh**.
- [x] `resolvePaymentAccounts` theo lock §6.2: (1) account user chọn (validate tồn tại + company +
      `account_type` khớp phương thức) → (2) company default của đúng kênh → (3) **BLOCK**
      (`PAYMENT_ACCOUNT_UNRESOLVED`/`ACCOUNT_TYPE_MISMATCH`). **Xoá** fallback "Cash-type đầu tiên"
      và **không** dùng MoP làm nguồn tài khoản.
- [x] `buildCollectProposal(...)` — **không** mặc định "hoá đơn cũ nhất": bắt buộc `allocations[]`
      từ draft; ≥1 hoá đơn mở mà rỗng ⇒ `MISSING_REQUIRED_FIELD`; 0 hoá đơn mở ⇒ `[]` +
      `unallocated = paid`. Đường chat giữ nguyên hành vi + ghi rõ chỗ rẽ nhánh trong code.
- [x] Proposal: `entity {kind:"customer", id}` · `params {allocations[], payment_methods[1], total,
      unallocated?, mode, posting_date, submit_now}` · `extra {action_id, warnings, handoff_id}` ·
      `risk HIGH`; validate **chặn >1 method ở server**, không chỉ ở UI.

## 4. Bảng kiểm khi dựng proposal (§5.4) — mỗi dòng 1 test + copy TV

| # | Kiểm | Không đạt ⇒ |
|---|---|---|
| 1 | principal/session + handoff ownership + capability | 403 / `STALE_HANDOFF` |
| 2 | hoá đơn tồn tại, `docstatus=1`, đúng customer + company | `NO_MATCH` / `MISSING_REQUIRED_FIELD` |
| 3 | còn phải thu dương (số sống, trừ nháp cùng company) | `INVOICE_ALREADY_PAID` |
| 4 | `0 < allocated ≤ outstanding sống` từng dòng; không trùng | `INSUFFICIENT_OUTSTANDING` / `INVALID_AMOUNT` |
| 5 | `Σ allocated == Σ methods` (≥1 HĐ mở ⇒ bắt buộc khớp); 0 HĐ ⇒ rỗng + `unallocated` | `MISSING_REQUIRED_FIELD` / `ALLOCATION_TOTAL_MISMATCH` |
| 6 | số phương thức **đúng 1** (lock §6.1) | `PAYMENT_METHOD_COUNT_INVALID` |
| 7 | tài khoản tồn tại, đúng company, `account_type` khớp phương thức | `ACCOUNT_TYPE_MISMATCH` / `COMPANY_SCOPE_REQUIRED` |
| 8 | ERPNext đọc được (fail-closed, không trả 0/bịa) | `ERP_UNAVAILABLE` |

- [x] 8 test tương ứng, mỗi test assert **mã lỗi + một đoạn copy tiếng Việt**.

## 5. Gỡ 422 multi-invoice (§ mục tiêu owner)

- [x] Xoá `COLLECT_MULTI_INVOICE_NOT_READY` ở `proposeCollectFromHandoff`; validate multi-ref theo
      bảng §4 thay vì từ chối theo số lượng hoá đơn.
- [x] Test: draft 2 hoá đơn hợp lệ ⇒ **200 + 2 allocations** trong proposal (trước đây 422);
      draft 2 hoá đơn mà tổng lệch ⇒ `ALLOCATION_TOTAL_MISMATCH`.
- [x] `/execute` multi-ref **KHÔNG** làm ở phase này (Phase 4) — ghi rõ trong result là phần còn thiếu
      để một proposal nhiều `references` chạy được đầu-cuối.

## 6. Falsify (§7)

- [x] F1 bỏ lọc `company` ở read hoá đơn ⇒ test §1(a) + §2 đỏ.
- [x] F2 bỏ kiểm `account_type` ⇒ test §4 #7 đỏ.
- [x] F3 dùng `references[].outstanding_amount` thay số sống ⇒ test §4 #3 đỏ.
- [x] F4 bỏ kiểm tổng khớp ⇒ test §4 #5 đỏ.
- [x] F5 thêm lại fallback "Cash đầu tiên" ⇒ test lock §6.2 (bank phải ra 1210 hoặc bị chặn) đỏ.
- [x] F6 cho on-account khi khách CÒN hoá đơn mở ⇒ test §4 #5 đỏ.
- [x] F7 nhận >1 payment method ⇒ test §4 #6 đỏ.
- [x] Restore byte-identical (sha256 khớp từng file).

## 7. Bằng chứng & sổ sách

- [x] Targeted: `cd mcp-erpnext && COPILOT_MOCK_OK=1 node --test test/next8-collect-*.test.mjs` xanh.
- [x] Full: `npm test` — chỉ còn **2 fail baseline** env dsh; Flutter full giữ baseline **426/3**;
      `flutter analyze` giữ **1 warning baseline** (không đụng Flutter trong phase này ngoài test nếu cần).
- [x] `result87.txt` + `.plan/next8/phase3-result.md` + `working.md` + tick tasks này.
      (Số lệch so với dự kiến `result84`: 84–86 đã bị cổng đóng Phase 2 dùng trước.)
- [x] **KHÔNG tự commit** (vùng tiền) — báo owner chờ duyệt.

## 8. DỪNG hỏi owner khi

- Lock §6.1–6.4 xung đột với contract site thật (vd: `default_bank_account` trống, PE cho phép nhiều
  tài khoản).
- Cần thêm quyền/bảng/cấu hình mới trên ERPNext (không tự tạo DocType).
- Muốn đổi hành vi đường chat cũ hoặc chạm `safety-gateway.mjs`.
