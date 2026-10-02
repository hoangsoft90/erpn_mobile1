# next8 / Collect screen — tasks

> Phase 2 của `.plan/next8/phases/phase-02-collect-screen.md` (+ 2 quyết định owner 2026-09-29:
> mở rộng **READ-only** cho danh sách hoá đơn/tài khoản, và **gộp fix lock §6.4** vào phase này).
> Tạo **TRƯỚC khi code** theo quyết định (1) của owner. Lock §6.1–6.5 là ràng buộc, không nới.
>
> **TRẠNG THÁI 2026-09-29: xong kỹ thuật — chờ owner duyệt commit** (`result83.txt` +
> `.plan/next8/phase2-result.md`). Mục duy nhất còn mở là UI-checkpoint (§6).

## 1. READ-only server (được owner duyệt thêm vào Phase 2)

- [x] `skills/sales.mjs#listOpenSalesInvoices({customerId, company, query, cap})` — đọc bằng
      `erpnext_doc_list` (**field/filter tự do**, giống `listOpenPurchaseInvoices`) thay vì
      `erpnext_sales_invoice_list` (field cố định, `limit 100`, cắt im lặng); lọc `outstanding != 0`
      + `docstatus = 1` và tìm kiếm ở tầng skill; trả `scanned`/`matched`/`truncated` (+`count`
      giữ tên cũ). `truncated` nghĩa là "page đã đầy", **không** phải "chắc chắn còn nữa" —
      hướng an toàn: không bao giờ tự nhận là đã đọc hết. Hằng `cap` để **module-private**
      (guard `router.test.mjs`: module skill chỉ export FUNCTION).
- [x] **Một nguồn logic**: `sales.listUnpaidInvoices` + `customer.listUnpaidInvoices` (bản twin)
      uỷ quyền cho hàm trên (giữ nguyên shape trả về) ⇒ chat balance, drill-down, propose, payment
      builder cùng một phép đọc.
- [x] Test: `test/next8-collect-reads.test.mjs` **18/18** (company scope · docstatus · credit note ·
      truncated · search xuyên trang · legacy = new · account theo type · tripwire read-only).
      Sửa fake của `test/a1-read-drilldown.test.mjs` cho đúng tool/dialect mới — **không** hạ
      assertion nào; `router.test.mjs` giữ nguyên guard (bỏ export thừa thay vì nới guard).
- [x] `getCustomerBalance(mcp, customerId, knownIds, {company})` — truyền company xuống phép đọc.
- [x] `skills/accounts.mjs#listMoneyAccounts({company})` — `erpnext_account_list` + default công ty;
      nhóm theo `account_type` (Cash/Bank), **không** đoán, **không** fallback chéo.
- [x] `capabilities.json`: thêm READ capability cho route tài khoản (không thêm màn hình mới).
- [x] `read-views.mjs`: `readScreen({..., company, query})` → ≤`limit` dòng + `matched_total` +
      `total_documents` + `truncated` + giữ nguyên mọi field cũ (A1 drill-down không đổi shape).
- [x] `http-ask.mjs`: `/read/list` nhận `q`; company resolve **server-side**
      (`resolveCompanyScope`, không tin body) và truyền xuống; thêm `POST /collect/accounts` (READ).
- [x] `copilot-server.mjs`: đường propose dùng **cùng** phép đọc company-scoped (số trên màn = số
      server validate).
- [x] `mock-server.mjs`: fixture SI có `company`/`debit_to`; thêm handler `erpnext_account_list`.

## 2. Flutter — feature `collect`

- [x] `collect/data/collect_repository.dart` — `fetchOpenInvoices({customerId, q})`;
      `fetchAccounts()`; `proposeCollect(...)` (đã có ở Phase 1).
- [x] `collect/application/collect_controller.dart` (`@riverpod` **Notifier** — build sync) — state:
      handoff, customer, invoices(loading|ok|error), allocations{invoiceId: amount}, method, account,
      submitting, result, lastError; **epoch/request token** chống response cũ ghi đè khi đổi khách.
- [x] `collect/presentation/screens/collect_screen.dart` — 4 khối: Khách · Hoá đơn · Phương thức ·
      Tổng; 1 nút **XÁC NHẬN THU** → `proposeCollect` → `ProposalCard` (nháp).
- [x] Widgets: `invoice_allocation_tile.dart` · `payment_method_section.dart` · `collect_summary.dart`
      · `account_picker.dart`.
- [x] `app_router.dart`: route `/collect` (name `collect`), nhận handoff qua `extra`; thiếu ⇒ màn
      refusal tiếng Việt (không tự dựng handoff).
- [x] Chat: answer có handoff collect ⇒ mở màn (guard theo `handoff_id`, chỉ mở 1 lần/câu trả lời).

## 3. Hành vi bắt buộc (lock)

- [x] **Không tự phân bổ** (không FIFO/oldest/đều nhau); tổng nhập mà chưa tick ⇒ chặn + nhắc.
      (Falsify F1: thêm tự phân bổ ⇒ T9 + T19 + T12 đỏ.)
- [x] Prefill số tiền = `outstanding` **server trả**; validate `0 < x ≤ outstanding` inline.
- [x] ≤10 dòng + ô tìm kiếm + "còn N kết quả"; **không** auto-select dòng nào; key theo invoice id.
- [x] Đổi khách ⇒ xoá danh sách + allocations; bỏ qua response cũ.
      (Falsify F2: bỏ reset ⇒ **T15b** đỏ — xem ghi chú ở §5.)
- [x] 0 hoá đơn mở ⇒ copy *"Thu không gắn hoá đơn (ứng trước / chưa phân bổ)."* và cho submit.
- [x] Phương thức: segmented **Tiền mặt | Chuyển khoản**, đúng 1 giá trị + copy
      *"Mỗi lần thu một hình thức thanh toán."*
- [x] Tài khoản: mặc định theo company; chỉ tài khoản **đúng `account_type`**; sai/không resolve ⇒
      chặn + copy riêng (**không** im lặng về tiền mặt).
- [x] Tổng khối: `Tổng gạch nợ` / `Tổng tiền nhận` + cảnh báo lệch (server quyết định cuối).
- [x] Guard đang-gửi (1 request/lần bấm). (Falsify F3: bỏ guard ⇒ T18 đỏ, 2 request.)

## 4. Test

- [x] Node: test mới cho `listOpenSalesInvoices` (company + không cắt im lặng + tìm kiếm) và
      `listMoneyAccounts`; **regression đường chat** (`customer.balance`, a1 drill-down) sau khi đổi
      phép đọc dùng chung.
- [x] Flutter: `test/collect_screen_test.dart` — **22 ca** (20 ca §5.3 + T15b + T15c).
- [x] `flutter analyze` 0 issue mới; `flutter test` full giữ baseline (3 fail probe untracked).
- [x] `npm test` full: giữ đúng 2 fail baseline env (dsh).

## 5. Falsify

- [x] F1 thêm hàm tự phân bổ oldest ⇒ test "no auto-allocation" + T9 đỏ.
- [x] F2 bỏ reset khi đổi khách ⇒ **T15b** đỏ.
      ⚠️ Ghi nhận: lần chạy đầu **KHÔNG đỏ** vì bộ test **thiếu oracle** cho scenario này (T15 chỉ
      test epoch guard). Đã VIẾT THÊM T15b (tầng controller) trước, rồi mutation mới đỏ đúng. Đây là
      phát hiện của chính bước falsify, không phải guard chết.
- [x] F3 bỏ guard double-tap ⇒ T18 đỏ (`Expected <1>` / `Actual <2>`).
- [x] F4 cho submit khi tổng lệch ⇒ T12 đỏ (`Expected null` / `Actual <Closure>`).
- [x] F5 bỏ lọc company ở phép đọc ⇒ test company-scope đỏ (`actual 4` / `expected 2`).
- [x] Khôi phục byte-identical (sha256 khớp). F6 phát sinh (`ref.mounted` sau reload) ⇒ T15c đỏ.
- [x] (phát sinh) Audit toàn app "ghi state / dùng context sau await": 1 gap thật ở
      `CollectController` đã sửa + T15c; 0 gap ở đường điều hướng.

## 6. Sổ sách

- [x] `result83.txt` + `.plan/next8/phase2-result.md`.
- [x] `working.md`; tick tasks này.
- [ ] UI-checkpoint: ảnh chụp màn hình + owner xác nhận (rule dự án) — **KHÔNG tự commit** vùng tiền.
      ⇒ **CÒN MỞ**: phiên này không có MCP/screenshot. Là mục DoD duy nhất chưa xong.

## 7. Ngoài phạm vi (ghi nhận, không tự nới)

- [ ] Validator **§6.2** (chặn account sai loại ở tầng server trước proposal/execute) — **Phase 3**.
- [ ] Gỡ 422 multi-invoice + cho `allocations[]` nhiều dòng trong 1 PE — **Phase 3/4**.
      ⇒ **ĐO ĐƯỢC trong Phase 2**: UI cho tick nhiều hoá đơn + nút XÁC NHẬN BẬT (test **T9** đang pin),
      nên tick 2 hoá đơn sẽ tới `COLLECT_MULTI_INVOICE_NOT_READY` (422, fail-closed, có lý do tiếng
      Việt). Và kể cả gỡ 422, **builder ghi `references` vẫn hardcode 1 dòng**
      (`payment-write.mjs:366`) ⇒ đây mới là phần việc thật. Cần owner chọn: giữ tới Phase 3/4 hay
      chặn UI ở 1 tick (kèm đổi T9).
- [ ] Split 1 lần thu → N PE (TM+CK) — backlog, không thuộc NEXT8.
- [ ] Sales/Purchase screen — Phase 6/7.
