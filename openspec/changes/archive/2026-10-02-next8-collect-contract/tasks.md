# next8 / Collect contract — tasks

> Phase 1 của `.plan/next8/phases/phase-01-transaction-contract.md` · owner lock §6.1–6.5 `✅ 2026-09-29`.
> Bằng chứng đầy đủ (lệnh + output) ở `result82.txt` + `.plan/next8/phase1-result.md`.

## 1. Contract (trước code)

- [x] Tạo `openspec/changes/next8-collect-contract/{proposal.md,specs/transaction-contract/spec.md,tasks.md}`
      (tên thư mục **không** bắt đầu bằng số, đúng quy ước).
- [x] Spec delta nêu đủ: handoff server-generated + principal/conversation-bound ·
      prefill không mang số tiền · draft = giá trị hiện tại · proposal server-authoritative ·
      **không** chọn hoá đơn tự động · **1 phương thức/lần thu** (lock §6.1: TM+CK = 2 lần thu;
      split N phiếu vẫn là backlog, KHÔNG thuộc NEXT8).
- [x] `capabilities.json`: `payment.create` giữ nguyên id canonical (10 write đang wire,
      `DSH_WRITE_HANDOFF_CAPABILITIES`, router, test cũ không đổi) + thêm block `aliases`
      `payment.collect → payment.create` (lock §6.5).

## 2. Business Handoff — `src/business-handoff.mjs` (MỚI)

- [x] `buildHandoff()` → `{type, handoff_id, capability, screen, question, prefill, issued_at}`;
      slot state ∈ `RESOLVED|AMBIGUOUS|MISSING|NO_MATCH`; **throw** `HANDOFF_AMOUNT_FORBIDDEN`
      nếu prefill mang `amount_vnd`/`outstanding_vnd`/`amount` (không số tiền nào vào ticket).
- [x] `HandoffStore.read()` enforce ownership principal **và** conversation; id lạ/ngoài chủ sở hữu/
      hết TTL đều trả **cùng** `STALE_HANDOFF` (không dò được id nào còn sống).
- [x] `HandoffStore.put()` trả `{ok:false,code}` chứ KHÔNG throw (bài học next8/D1 — luôn check `.ok`),
      và caller (pipeline) coi `!ok` ⇒ **không phát ticket ra**.
- [x] TTL chỉ giới hạn bộ nhớ hội thoại; **stale = đọc lại ERPNext lúc propose**, không dùng TTL làm an ninh.
- [x] Store **riêng**, không tái dùng `session-context.mjs` — lý do ghi tại header module (context có
      provenance, handoff thì server sinh; trộn hai thứ sẽ làm yếu luật "chỉ entity user chọn mới seed WRITE").
- [x] Wire pipeline (`copilot-server.mjs`) tại **5 điểm**: `!partyRow`, `require_picker`, `block`,
      nhánh thành công (`hasOpenInvoices:true` + `amountGiven` theo số thật), nhánh catch
      `PAYMENT_AMOUNT_MISSING` / `PAYMENT_NO_OPEN_INVOICE` (on-account khi không còn hoá đơn mở).
      Guard cũ (entity resolution, authz, rate limit, uncertainty copy) không đổi.
- [x] `test/next8-collect-handoff.test.mjs` — 9 test: (a) ticket server-generated + screen; (b) id bịa
      bị từ chối như id hết hạn; (c)+(d) ownership principal + conversation; (d2) TTL; (e) slot states;
      (e2) ticket không lưu được ⇒ không phát ra; (f) không số tiền nào vào ticket (**nhất là không field
      nào mang số tiền**); unowned/screenless fail-closed; store refused write không throw.

## 3. Transaction Draft + primitives — `src/transaction-draft.mjs` (MỚI, thuần)

- [x] `paymentMethod` (mode `cash|bank_transfer`, **không** có `credit`), `invoiceAllocation`,
      `transactionItem`, `buildTransactionSummary` (subtotal/line_discount/order_discount/total/
      payment_total/allocated_total/unallocated/outstanding_after — 2 tầng chiết khấu **không gộp**,
      credit là **số**).
- [x] `validateAllocations` (lock §6.3): ≥1 hoá đơn mở ⇒ bắt buộc phân bổ, mỗi dòng `0 < x ≤ outstanding`,
      trùng hoá đơn bị chặn, hoá đơn không thuộc khách ⇒ `NO_MATCH`; 0 hoá đơn mở ⇒ danh sách **phải** rỗng.
- [x] `validatePaymentMethods` (lock §6.1): `maxMethods` là **tham số** (mặc định 1) để sales/purchase
      nâng trần sau này mà không sửa luật collect.
- [x] `validateTransactionDraft`: tổng gạch nợ == tổng tiền nhận; `claimedTotalVnd` chỉ là **claim**
      ⇒ lệch thì `CLIENT_AUTHORITY_REJECTED` (số của client không bao giờ thành kết quả).
- [x] **Cấm** FIFO/oldest/first/newest: không helper nào như vậy tồn tại, và test **TRIPWIRE** quét
      source (sau khi strip comment) để khẳng định điều đó.
- [x] `test/next8-collect-draft.test.mjs` — 7 test: primitive VND int; lock §6.1 một phương thức;
      lock §6.3 bắt buộc/cho phép rỗng; trần từng hoá đơn + trùng; tổng khớp + claim; on-account;
      summary 2 tầng chiết khấu; TRIPWIRE.

## 4. Route `POST /collect/propose` (đọc + dựng đề xuất; **KHÔNG** ghi)

- [x] `http-ask.mjs`: route mới, cùng stack (rate limit bucket `read`, correlation, log event
      `collect_propose`), body `{handoff_id, conversation_id?, values:{customer_id, allocations[],
      payment_methods[], claimed_total_vnd?}}`; thiếu `handoff_id`/`conversation_id` ⇒ 400
      `MISSING_REQUIRED_FIELD`.
- [x] Kiểm ownership ⇒ **409 `STALE_HANDOFF`** (không phân biệt với id bịa/ngoài principal);
      sai authz ⇒ 403; thiếu `customer_id` ⇒ 400.
- [x] Đọc **sống** customer master (validate id — hint không phải thẩm quyền) + `listUnpaidInvoices`
      lọc `outstanding_vnd > 0`; `validateTransactionDraft` chạy trên số vừa đọc.
- [x] Trả **đúng shape proposal hiện có** (`erpn.proposal/v1`, `submit_now:false`) ⇒ card/`/execute`
      không phải đổi. Phân bổ dùng **đúng lựa chọn của user**, không để builder tự chọn oldest.
- [x] Multi-invoice trong 1 lần thu ⇒ **422 `COLLECT_MULTI_INVOICE_NOT_READY`** (lock §6.1 chọn
      phương án "1 lần thu = 1 phiếu"; split N phiếu là change riêng, không tự thêm ở đây).
- [x] `finally { await mcp.close() }` — thiếu nó thì event loop không thoát (đã đo: suite treo ~280s).
- [x] `test/next8-collect-propose.test.mjs` — 7 test E2E: câu collect trả **ticket** thay vì dead-end;
      propose trả proposal chuẩn; id bịa/ngoài principal bị từ chối; server tái kiểm giá trị form
      (2 mode / không alloc / tổng lệch / vượt outstanding / hoá đơn người khác / multi-invoice);
      400 malformed; F3 ticket phải có trong store; **TRIPWIRE không có write**.
- [x] Không thêm route ghi: `/execute` vẫn là cửa ghi duy nhất; tripwire grep `callWriteTool|/execute`
      trên đường collect-propose = **0 hit**.

## 5. §6.5 alias capability

- [x] `capability-contract.mjs`: `resolveCapabilityId`, `listCapabilityAliases`, `getCapability`
      resolve alias về **cùng object frozen** của capability canonical.
- [x] `validateAliases()` fail-closed: slug hợp lệ; key không được là capability thật; target phải tồn tại;
      target là alias ⇒ lỗi "chain"; target phải là **WRITE**; target không được `forbidden_in_ai_path`.
      Được gọi ở **cuối** `validateContract` (sau vòng lặp capability — thứ tự có ý nghĩa cho test chain/shadow).
- [x] `isForbidden(id)`: alias **luôn** `true` ⇒ `assertCapabilityExecutable("payment.collect")` throw
      `FORBIDDEN_IN_AI_PATH` — alias không bao giờ execute dưới tên riêng.
- [x] `test/capability-contract.test.mjs`: thêm test lock §6.5 + 5 case alias validation đỏ đúng lý do
      (shadow / unknown / chain / READ target / forbidden target).

## 6. Flutter — tầng dữ liệu (chưa có UI)

- [x] `apps/mobile/lib/features/collect/data/collect_models.dart` (MỚI): `CollectSlotState`,
      `CollectPrefillSlot`, `BusinessHandoff.tryParse` (fail-closed khi thiếu id / `type` lạ),
      `CollectProposalRequest.toJson()`, `CollectAllocationValue`, `CollectMethodValue`,
      `CollectProposeResult.fromJson`, `CollectSummary` (số của **server**, chỉ hiển thị).
- [x] `chat_models.dart`: `BusinessHandoffRef` (chỉ id/capability/screen, `tryParse` fail-closed)
      + field `businessHandoff` trên `AskResult`.
- [x] `copilot_api_client.dart`: `proposeCollect()` → `POST /collect/propose` (parse refusal ở body,
      không throw).
- [x] `test/next8_collect_data_test.dart` — 16 test parse (handoff/ref/request/result/on-account).
- [x] **Chưa** làm `CollectScreen` (Phase 2), **chưa** gọi `/execute` từ app.

## 7. Test & bằng chứng

- [x] Node targeted 4 suite: **39/39 pass**.
- [x] Node full `npm test`: **966 tests / 964 pass / 2 fail** — đúng 2 fail baseline env
      (`dshGatewayHealth`, `verifyDshRuntime`: máy không có binary dsh).
- [x] Flutter targeted `test/next8_collect_data_test.dart`: **16/16 pass**.
- [x] Flutter full `flutter test`: **404 pass / 3 fail** — 3 fail thuộc `_probe_review_test.dart`
      (untracked, baseline có trước next8; fail RenderFlex-overflow trong chính file probe đó).
- [x] `flutter analyze`: **0 issue mới** (1 warning còn lại nằm trong `_probe_b0_voice_autosend.dart`
      untracked — xem `.plan/next8/phase1-result.md` §5 để biết lý do **không** sửa).
- [x] Tripwire tĩnh: **0 hit** write reference trên đường collect-propose.

## 8. Falsify (`scripts/falsify/next8-phase1-handoff.mjs`)

- [x] F1 bỏ ownership ⇒ **RED x3** · F2 id do client sinh ⇒ **RED x13** ·
      F3 bỏ put-or-nothing ⇒ **RED x1** · F4 propose chạm write gateway ⇒ **RED x1** ·
      F5 alias resolver hỏng ⇒ **RED x7** · F6 self-alias ⇒ **RED x7**.
- [x] `restore byte-identical: true` (sha256 trước == sau cho cả 3 file bị đột biến).

## 9. Sổ sách

- [x] `result82.txt` (bằng chứng lệnh + output thật).
- [x] `.plan/next8/phase1-result.md` (tổng hợp §1–§7 theo phase-01 §9 DoD).
- [x] `working.md` mục mới.
- [x] Trình user duyệt — **OWNER ĐÃ DUYỆT 2026-09-29**, commit vùng tiền (message rõ, không force-push) — xem §9b.

## 9b. OWNER DUYỆT + 3 QUYẾT ĐỊNH (2026-09-29) — ghi nhận, KHÔNG hỏi lại

- [x] **Phase 1 ĐƯỢC DUYỆT** — được commit (commit vùng tiền, message rõ, không force-push).
- [x] **(1) OpenSpec tạo sau code**: chấp nhận **lần này**; từ phase sau phải tạo
      `openspec/changes/<tên>/` **TRƯỚC** khi code.
- [x] **(2) Lock §6.2** (account đúng `account_type` hoặc BLOCK, không fallback chéo): **KHÔNG** làm ở
      Phase 2 UI — làm ở **Phase 3** (server validation trước proposal/execute).
- [x] **(3) `COLLECT_MULTI_INVOICE_NOT_READY` (422 khi >1 hoá đơn) chỉ là MVP tạm của Phase 1**.
      Lock §6.1 = **1 phương thức tiền / 1 PE** (TM **hoặc** CK), **KHÔNG** cấm multi-invoice;
      Phase 0 đã chứng minh 1 PE nhiều `references` là có thật trên site.
      ⇒ **Phase 3/4 sẽ GỠ 422** và cho `allocations[]` **nhiều dòng trong 1 PE + đúng 1 mode**.
      **Không** implement split N PE (TM + CK) — vẫn là backlog.

## 10. Chưa làm (ghi nhận, không tự nới scope)

- [ ] `CollectScreen` (UI) + confirm → `/execute` = **Phase 2** (`.plan/next8/phases/phase-02-collect-screen.md`).
- [ ] Lock §6.2 (account đúng `account_type` hoặc BLOCK) — **Phase 3** theo quyết định (2) ở §9b;
      Phase 1 **không** thêm validator này và spec delta **không** claim nó.
- [ ] Gỡ `COLLECT_MULTI_INVOICE_NOT_READY` + cho `allocations[]` nhiều dòng trong 1 PE — **Phase 3/4**
      theo quyết định (3) ở §9b (đây là thay đổi đường tiền cấp phiếu ⇒ phải sửa spec delta tương ứng).
- [ ] Split 1 lần thu → N phiếu (TM + CK thành 2 PE) = **backlog**, không thuộc NEXT8.
- [ ] Sales/Purchase draft (Phase 6/7) — primitives đã để `maxMethods` nâng trần mà không sửa collect.
