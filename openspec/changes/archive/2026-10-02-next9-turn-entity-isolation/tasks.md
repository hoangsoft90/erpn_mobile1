# next9 / Turn entity isolation — tasks

## 1. Root cause (đo, không đoán)

- [x] Probe `scripts/debug-next9-probe.mjs` (mock ERP + NLP thật, 3 mode) —
      tái hiện Symptom A: sentence resolve `CUST-M001` nhưng WRITE bind
      `CUST-00001`; mode `reset`/`fresh` sạch ⇒ cross-turn contamination.
- [x] Đo reachability: `"thu tiền 500000"` (không tên) ⇒ `MISSING_ENTITY`, có
      hay không có context ⇒ tính năng "khách đã nhớ" không bao giờ cứu được gì.
- [x] Đo scope: `/ask` KHÔNG gửi `conversation_id` ⇒ scope `<user>\0default`,
      restart app không xoá được (giải thích Symptom C là state server-side).

## 2. TDD đỏ

- [x] `test/next9-turn-isolation.test.mjs` (Test A–F): A/F **đỏ đúng lý do**
      (bound `CUST-00001` thay vì khách vừa tạo), C sửa lại cho đúng reality
      (refusal + picker, không auto-select).

## 3. Implement (minimal)

- [x] `copilot-server.mjs`: xoá khối thay `customerId/customerName` bằng
      `sessionContext.writeEligible("customer")`; ghi lý do ngay tại chỗ.
- [x] `chat_screen.dart` + `ChatTurn.key`: list key theo turn (không theo index).
- [x] Không đụng: resolver, contract, DSH handoff, executor, idempotency,
      TTL/bailout/bound-10 của next8.

## 4. Xanh + no-regression

- [x] Test mới **5/5 xanh** sau khi đỏ đúng lý do.
- [x] Targeted 9 suite (p2-context, next6-session-isolation, next8 ×4,
      copilot, m1-customer-create, correlation-field) — **100/100**.
- [x] Node FULL: **930 tests / 928 pass / 2 fail** = đúng cặp baseline env
      (`dshGatewayHealth` + `verifyDshRuntime`, máy không có binary dsh).
- [ ] Flutter test/widget: **CHẶN** — toolchain local hỏng (pub-cache thiếu
      `stack_trace-1.12.2`, `dio-5.11.1`; `flutter test` báo 2142 lỗi compile
      ngay trong source của Flutter). Cần `flutter pub get` (ngoài repo) rồi
      chạy `test/next9_turn_isolation_test.dart`. **Chưa verify ⇒ không báo PASS.**

## 6. Siết regression theo prompt-1 (§4–§9)

- [x] Test A–C, E, F, H: assert bằng **ID**, không bằng text (`customer_id` /
      `proposal.entity.id` / HTTP status).
- [x] Test E viết lại đúng nghĩa: request #1 (có context) → `resetSessionContext()`
      → request #2, so `binding #1 == binding #2 == Lê Lợi.id` (`__resetSessionContext`
      KHÔNG truyền scope = drop toàn bộ, đúng như plan yêu cầu).
- [x] Test F mở rộng đúng chuỗi của prompt: Lan → Lê Lợi → Lan → Lê Lợi →
      khách không tồn tại (NO_MATCH) → Lan.
- [x] Test D (file riêng, process riêng — mock đọc state file lúc import):
      fixture 2 khách **cùng tên** qua `customers_created` ⇒ đo được
      `entity.state=AMBIGUOUS_MATCH`, `error_code=AMBIGUOUS_ENTITY`,
      `proposal=null`, candidates chứa **cả hai id** — không tự chọn.
- [x] Test G: context khách → yêu cầu NCC (bind `SUP-MINH-PHAT`, fixture inject
      qua `suppliers_created`); context NCC → WRITE khách (bind `CUST-00001`).
      Seed được assert qua chính store (`entries` map) để test không rỗng nghĩa.
- [x] Probe đo trước khi pin: `scripts/probe-next9-fixtures.mjs`.

## 7. Execute-bound entity (§10 + prompt-2 §1)

- [x] Trace: `safety-gateway.mjs` dựng payload từ `proposal.entity.id`
      (`customer: proposal.entity.id`, `supplier: proposal.entity.id`, …) và
      **refuse 400** khi `!proposal?.entity?.id` — executor KHÔNG re-resolve
      display name ⇒ không có NEXT9 BLOCKER, chỉ thêm assertion.
- [x] Verify-first prompt-2 §1: grep toàn bộ `src/` — sau fix, sessionContext
      chỉ còn 3 điểm `.set()` (copilot-server L1198/L1374/L1616), **0 điểm đọc**
      (`writeEligible`/`get` chỉ trong session-context.mjs + test seam) ⇒
      execute path không thể tiêu thụ context.
- [x] Regression `test/next9-execute-binding.test.mjs` (prompt-2 §1): proposal
      Lê Lợi → context đổi sang Lan (set lại qua câu hỏi đọc) → execute proposal
      CŨ ⇒ executed customer_id == CUST-M001, != CUST-00001; + biến thể reset
      context + biến thể Lan trước rồi execute cũ — **3/3 PASS**.
- [x] Falsify: inject `writeEligible` override vào execute path ⇒ test đỏ đúng
      (executed = Lan), khôi phục source md5 khớp.

## 8. Flutter (§11–§15)

- [x] `ChatTurn.key`: stable/immutable/unique/không phụ thuộc index — test mới
      trong `next9_turn_isolation_test.dart` (same-ts khác câu, toJson→fromJson
      giữ key, trim giữ nguyên key người sống sót).
- [x] `ProposalCard` state đã phân loại: `_result/_submitOk/_error/_rejectionCode`
      = ephemeral, giữ alive qua scroll bằng `AutomaticKeepAliveClientMixin`
      (`wantKeepAlive`); rejection persist model-level (`attachRejection`);
      `_result` không persist — giới hạn có chủ ý từ trước (option b), GHI NHẬN
      không sửa (ngoài scope).
- [x] `flutter pub get` khôi phục toolchain (pub-cache thiếu
      `stack_trace-1.12.2`, `dio-5.11.1`) — không nâng dependency nào.
- [x] UI regression test: history shift (trim) + confirm qua mock /execute —
      pass; **falsify**: comment key ⇒ đỏ đúng leak ("Lê Lợi outcome leaked")
      ⇒ Symptom B PROVEN, không còn hypothesis.
- [x] Flutter FULL suite: 391/394 — 3 fail thuộc `_probe_review_test.dart`
      (untracked, probe review cũ bị xoá ở 6bb4d76, không thuộc next9, fail
     RenderFlex-overflow khi recycler nhét card 850px vào viewport 600 — đã tồn
      tại trước next9).

## 10. prompt-2 — FINAL CLOSE GATE

- [x] §1 Execute binding: verify-first (0 điểm đọc context trong pipeline);
      `test/next9-execute-binding.test.mjs` **3/3 PASS** (context đổi sau
      proposal / reset / memory-before + replay + business-dedup);
      falsify inject override vào `executePaymentProposal` ⇒ **2/3 đỏ đúng**,
      khôi phục md5 khớp ⇒ xanh lại. **Không sửa production code.**
- [x] §2 Flutter: pub get + `flutter test test/next9_turn_isolation_test.dart`
      **2/2 PASS** (exit 0); analyze file next9 sạch.
- [x] §3 FULL regression: Node **936/934/2** (2 fail baseline env dsh) ·
      Flutter **391/394** (3 fail probe pre-existing — chứng minh bằng
      stash-run không next9 vẫn fail) · next9 cụm **11/11**.
- [x] §5 `.plan/next9/debug-result.md` §J: từng PASS/FAIL + blocker +
      **NEXT9 VERDICT: PASS** (còn §16 device check là việc vận hành).
- [ ] §16 Manual device reproduction (Case 1–3) — cần máy thật; việc vận hành
      duy nhất còn lại (không phải blocker tự động).

## 5. Sổ sách

- [x] `.plan/next9/debug-result.md` (theo §19 A–G của plan-debug).
- [x] `working.md` mục mới; tick tasks.md đủ.
- [ ] Trình user duyệt — **KHÔNG tự commit** (chạm đường tiền: payment party).
