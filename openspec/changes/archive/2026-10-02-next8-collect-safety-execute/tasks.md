# next8 / Collect safety execute — tasks

> Phase 4 của `.plan/next8/phases/phase-04-collect-safety-execute.md`.
> Tạo **TRƯỚC khi code** (owner rule #1). Lock §6.1–6.5 là ràng buộc, không nới.
> Ngoài phạm vi: route ghi thứ hai · đổi `idempotency.mjs` · auto-submit · Sales/Purchase ·
> split N PE (lock §6.1 ⇒ change riêng) · đổi thứ tự gate của Safety Gateway.

## 0. Dữ kiện đã ĐO (dùng thẳng, đừng đo lại)

- `custom_ai_action_id` đã có trên Payment Entry ⇒ correlation chạy thật.
- Bất biến: `difference_amount = 0`; 1 PE = 1 tài khoản tiền.
- `erpnext_doc_list` cho Payment Entry: `filters` + `limit`, **không** offset.
- Site thật còn 17 phiếu nháp (16 của MP) ⇒ draft-cover phải lọc company (Phase 3 đã làm).
- `allocated_amount > outstanding` ⇒ ERPNext trả 417 ⇒ phải chặn TRƯỚC khi gọi.

## 1. Executor nhiều reference (§5)

- [x] `executePaymentProposal` đọc `proposal.params.allocations[]` + `payment_methods[0]`;
      **bỏ** chốt `PAYMENT_MULTI_REFERENCE_NOT_READY`.
- [x] Mỗi hoá đơn: đọc lại `outstanding` SỐNG (trừ nháp cùng company + đúng chiều); lệch ⇒
      `PROPOSAL_STALE` / `INSUFFICIENT_OUTSTANDING` / `INVOICE_ALREADY_PAID`; **không** gọi write.
      (Doc-level: `erpnext_doc_get` từng allocation — list read không có `company`/`docstatus`;
      unreadable ⇒ `PAYMENT_ERP_UNAVAILABLE`; hết nợ ⇒ `PAYMENT_INVOICE_ALREADY_SETTLED`;
      docstatus≠1 / âm / is_return ⇒ `PAYMENT_INVOICE_NOT_RECEIVABLE`.)
- [x] Dựng `references[]` (1 dòng/allocation, thứ tự tất định theo `posting_date`/`due_date`) +
      `paid_amount = received_amount = Σ allocated + unallocated`; `unallocated_amount` tường minh.
- [x] Tài khoản **re-derive server-side** theo §6.2 (`resolvePaymentAccounts`), validate
      `account_type` khớp phương thức; sai loại ⇒ BLOCK, không fallback (kể cả khi proposal ghi tên khác).
- [x] Test: 2 hoá đơn phân bổ một phần ⇒ payload đúng từng dòng · vượt trần ⇒ refuse ·
      hoá đơn hết nợ sau khi dựng proposal ⇒ refuse · crafted proposal (account bank cho ý định cash) ⇒ BLOCK.

## 2. On-account (lock §6.3 — đã cho phép)

- [x] `allocations = []` + khách **0 hoá đơn mở** ⇒ `references = []`,
      `unallocated_amount = paid_amount` (không để ERPNext tự suy).
- [x] Khách **còn** hoá đơn mở + `allocations = []` ⇒ **từ chối** (`MISSING_REQUIRED_FIELD`).
- [x] Test: 0 hoá đơn mở ⇒ 1 phiếu không reference, `unallocated == paid` ·
      còn hoá đơn mở ⇒ từ chối, 0 write.

## 3. Verify (§5)

- [x] `verifyWrittenPayment` đọc lại đủ: `docstatus` (0) · `payment_type` · `party_type` · `party` ·
      `company` · `paid_from`/`paid_to` · `paid_amount`/`received_amount` · `unallocated_amount` ·
      `references[]` (số dòng + từng `allocated_amount`) · `reference_no` = `command_id` ·
      correlation field = `action_id`.
- [x] Test: lệch từng nhóm field ⇒ `PAYMENT_WRITE_UNVERIFIED` (không báo thành công giả);
      thiếu/lệch 1 dòng reference ⇒ fail.

## 4. Idempotency / double-confirm / chaos (không đổi hợp đồng)

- [x] Double confirm cùng `command_id` ⇒ `replay:true` + **1** chứng từ.
- [x] `reconcilePaymentEntry` tìm được bằng `reference_no = command_id`.
- [x] ERP down giữa execute ⇒ 503 + `retry_same_command_id` ⇒ JobQueue; retry cùng id ⇒ không tạo phiếu thứ hai;
      job replay mang actor gốc.
- [x] **KHÔNG** sửa `idempotency.mjs`.

## 5. Card copy (tiếng Việt) + tripwire

- [x] Copy nêu: danh sách hoá đơn · tổng · on-account (nếu có) · cảnh báo nháp đang phủ · vẫn ghi rõ **NHÁP**.
      (`_paymentMoneyTail` trên `ProposalCard`: "gạch nợ SINV-A xđ, SINV-B yđ", "chưa gạch nợ Nđ";
      dòng draft "Đã ghi phiếu thu NHÁP … (submit là bước riêng trên ERPNext)"; cảnh báo nháp
      đang phủ vẫn từ `warnings` của buildCollectProposal.)
- [x] Tripwire tĩnh: quét `src/` + `scripts/` khẳng định vẫn **chỉ** `safety-gateway` chạm write tool của Payment Entry.
      (`next8-collect-execute.test.mjs` — walk src/+scripts/, `executePaymentProposal` chỉ được import/gọi bởi `safety-gateway.mjs`.)

## 6. Falsify (§7)

- [x] F1 bỏ đọc lại outstanding ở execute ⇒ test vượt trần đỏ.
- [x] F2 dùng tài khoản từ proposal thay vì re-derive ⇒ test account đỏ.
- [x] F3 bỏ `unallocated_amount` tường minh ⇒ test on-account đỏ.
- [x] F4 cho execute re-resolve party theo tên ⇒ test execute binding đỏ.
- [x] F5 bỏ verify 1 field ⇒ test verify đỏ.
- [x] F6 nhận `payment_methods` > 1 ⇒ test lock §6.1 đỏ.
- [x] F7 MoP / fallback ngân quỹ cash cho ý định bank ⇒ test lock §6.2 đỏ.
- [x] F8 cho on-account dù khách còn hoá đơn mở ⇒ test lock §6.3 đỏ.
- [x] Restore byte-identical (md5 khớp từng file).

## 7. Bằng chứng & sổ sách

- [x] Targeted: E2E mock propose → confirm → ledger đúng số dòng + allocation; chaos/idempotency.
- [x] Full `npm test`: **chỉ 2 fail baseline** env dsh; Flutter full giữ baseline; analyze giữ 1 warning.
- [x] `resultNN.txt` + `.plan/next8/phase4-result.md` + `working.md` + tick tasks này.
- [ ] **KHÔNG tự commit** (vùng tiền) — trình owner duyệt.

## 8. DỪNG hỏi owner khi

- Muốn ghi THẬT lên site ERPNext (Phase 5 mới có quy trình).
- Muốn đổi gate/idempotency/Safety Gateway, hoặc gộp nhiều phương thức / nhiều phiếu trong 1 lệnh.
