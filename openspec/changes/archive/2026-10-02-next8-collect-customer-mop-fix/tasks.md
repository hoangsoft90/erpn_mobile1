# next8 / Collect — full customer master + bank MoP channel — tasks

> Phase 5b of `.plan/next8/phases/phase-05b-collect-propose-fixes.md`.
> Created **BEFORE code** (owner rule #1). Locks §6.1–6.4 are constraints, not
> things to widen. Out of scope: Sales/Purchase (Phase 6), a second write route,
> editing the shop's ERPNext data, `idempotency.mjs`, the safety-gateway order,
> split N Payment Entries.

## 0. Measured facts (use directly — do not re-measure)

- Site has **134 Customers** but `erpnext_customer_list` returns the first 100 ⇒
  ~34 customers unreachable by `/collect/propose` today (F-P5-1).
- Real draft `ACC-PAY-2026-00775`: request `bank_transfer` ⇒
  `paid_to = "1210 - ACB 110296868 - MP"` (correct) but
  `mode_of_payment = "Cash"` (wrong), `mode_substituted_from = "bank_transfer"`.
- Site MoP types (2026-09-30): `Bank Draft|Bank`, `Cash|Cash`, `Cheque|Bank`,
  **`Chuyển khoản|Cash`**, `Credit Card|Bank`, `Wire Transfer|Bank` (all enabled).
- `customer-create.mjs:150` already uses `{ limit: 0 }` for the same tool — the
  precedent for the fix (M1 lesson).
- Owner chose F-P5-2 **option C** (channel-aware MoP + explicit Vietnamese warning
  / refuse on label-vs-type mismatch), recorded in `result89.txt` §9.

## 1. OpenSpec (before code)

- [x] This change validates: `npx --no-install openspec validate next8-collect-customer-mop-fix --strict`.
      → **valid** (needed `specs/` deltas added for `--strict`).

## 2. F-P5-1 — full customer master on the propose path

- [x] `src/skills/customer.mjs#findCustomer`: read `erpnext_customer_list` with
      `limit: 0` (no silent 100-cap); read shape and `registerIds` unchanged.
- [x] Confirmed the read still works for the other callers of `findCustomer("")`
      (chat balance, drill-down, proposal builder, collect screen) — collect
      cluster + full suite green.
- [x] The picked id is STILL re-validated against the freshly-read master at
      propose time (HINT-NOT-AUTHORITY unchanged; a new test pins that an invented
      id resolves to nothing).
- [x] Test: a customer beyond the first 100 rows resolves (self-contained stub
      mirroring real `limit` semantics + 134 rows).

## 3. F-P5-2 — pick the Mode of Payment by channel

- [x] `src/skills/payment-write.mjs#resolveAccountPlan`: the request label stays
      the channel source (`channelOfMode`, unchanged); the MoP is chosen so its
      `type` matches the channel (`bank_transfer` ⇒ `Bank`; `cash` ⇒ `Cash`),
      deterministically (transfer-ish name first for bank, then alphabetical).
- [x] Decision C: a label-matching MoP with a contradicting `type` is NOT used;
      a real same-channel method is chosen and a Vietnamese `mode_warning` names
      the conflict. No new silent substitution.
- [x] Lock §6.2 preserved: bank ⇒ company Bank default (`1210`), NEVER a cash
      ledger such as `1110`; wrong-typed account still BLOCKs.
- [x] `mode_substituted_from` semantics stay truthful (set only when the written
      MoP really differs from the requested one) — existing test still green.
- [x] Mock fixture mirrors the site's label/type conflict: already present in
      `src/mock-server.mjs` (`{ name: "Chuyển khoản", enabled: 1, type: "Cash" }`) —
      no mock change needed.

## 4. Tests & falsify

- [x] `test/next8-collect-05b-fixes.test.mjs` pins both measured cases + the
      decision-C warning + FINDING 2 (3 mirror cases) + FINDING 3 (2 memo cases)
      (**12/12**).
- [x] Falsify F-P5-1: `limit: 100` ⇒ the two ">100 rows" tests are RED.
- [x] Falsify F-P5-2: `requestedType = null` (no channel branch) ⇒ the bank-MoP
      and decision-C tests are RED.
- [x] Falsify FINDING 2: the mirror branch disabled (`false && …`) ⇒ its 2
      positive tests RED.
- [x] Falsify FINDING 3: the memo write disabled ⇒ the "share one read" test RED.
- [x] Restore byte-identical (md5 `c9acfa86…` customer.mjs · `49c37245…` payment-write.mjs).

## 5. Regression

- [x] `COPILOT_MOCK_OK=1 node --test test/next8-collect-*.test.mjs test/payment-write.test.mjs` + the next8/next9/gateway cluster → **237/237**.
- [x] Full `npm test`: **1050 / 1048 / 2** — only the 2 baseline env failures
      (missing `dsh` binary). TRAP: leaving the NLP bridge on 8787 while running
      the suite adds a 3rd failure (`issue3-erp-target.test.mjs` `/ask` 500 vs 200);
      kill the bridge first, then the file is 4/4.
- [x] Flutter full **426 pass / 3 fail** (untracked `_probe_review_test.dart`) and
      `flutter analyze` **1 warning** (untracked probe) — baseline unchanged, no
      Dart touched.
- [x] Python: `PYTHONPATH=src python3 -m unittest discover -s tests` → **63 OK**.

## 6. Real round (only if the site proves a case the mock cannot)

- [x] **DONE (2026-09-30)** — owner authorised exactly one real draft round
      ("1 vòng ghi NHÁP thật để chứng minh MoP bank (rồi xoá đúng phiếu đó bằng
      aki/bench)"). Ran `/ask → /collect/propose → /execute` once for customer
      `lan`, invoice `ACC-SINV-2026-01285`, 50.000, `bank_transfer`:
      `docstatus 0`, **`mode_of_payment = "Wire Transfer"` (type Bank)**,
      `paid_to = "1210 - ACB 110296868 - MP"`, `mode_substituted_from = bank_transfer`.
      Old code wrote `"Cash"` for the same request ⇒ F-P5-2 proven on the real site.
      The draft was then deleted with `bench --site frontend … force=1`; verified
      PE **404**, outstanding 84.000/320.000, GL 1310 `lan` 8 rows / net 404.000,
      5 stale `Payment Allocation` rows untouched. Evidence: `result91.txt` §1–§3.
      Note: the site REUSED the deleted name for the new draft (F-P5-4 re-confirmed)
      ⇒ reconcile by `reference_no`/action id, never by document name.

## 6b. FINDING 1 (code review, owner asked): the written method must be visible

- [x] Decision: **display, do not refuse** (a refusal would block the shop's most
      common bank collection while the money account is already correct; the draft
      is not submitted, so the note reaches the human in time). Rationale in
      `result91.txt` §4.
- [x] `proposal_card.dart` shows `mode_of_payment` on the draft result line and
      repeats `mode_warning` verbatim when present; nothing is invented when an
      older server sends neither.
- [x] 3 tests added (real-site shape `Wire Transfer`, the conflict warning, the
      no-method case); falsify (drop the note) ⇒ the 2 positive tests RED, restore
      ⇒ file 44/44.
- [x] Spec delta gained the matching requirement ("The method actually written is
      shown on the draft result"); `validate --strict` = valid.

## 6c. FINDING 2 (code review nit): the mirror label/type conflict stayed silent

- [x] `payment-write.mjs#resolveAccountPlan`: right after `accountType` is decided,
      the CHOSEN method's name is read for a channel (`channelOfMode(modeName)`);
      when it reads like the channel OPPOSITE to the one the method is being used
      for, `mode_warning` now says so (name + declared type + the form actually
      used). The choice and the money account are untouched (§6.2 intact) — only
      the silence is removed.
- [x] A conflict already reported (`modeWarning` from the label case) is never
      overwritten by this weaker one; a name matching the form used stays silent
      (the real site's `Wire Transfer|Bank` for a bank intent ⇒ no warning).
- [x] Spec delta added (`payment-accounts`: "A method whose NAME reads like the
      other channel is surfaced too", 3 scenarios); `validate --strict` = valid.
- [x] **ĐO THẬT (chỉ đọc) nhánh gương trên site** — `scripts/_probe_05b_mirror_readonly.mjs`
      (KHÔNG `/execute`, KHÔNG ghi): ma trận 6 nhãn cho thấy nhánh gương KHÔNG bật được
      bằng dữ liệu MoP hiện tại (`bank_transfer`→`Wire Transfer`, `cash`→`Cash`, đều khớp
      tên/kênh); đồng thời đo được cảnh báo NHÁNH NHÃN chạy thật với nhãn "Chuyển khoản"
      (`result91.txt` §5c).
- [x] Owner quyết **DỪNG — nhận bằng chứng đo thật**: KHÔNG sửa master data của shop,
      KHÔNG ghi thêm phiếu nháp nào (2026-09-30, trong phiên).

## 6d. FINDING 3 (code review nit): `findCustomer` re-read the whole master on every call

- [x] The whole-master read is now memoised PER REQUEST (`customer.mjs`
      `masterReadCache`, a `WeakMap` keyed by the caller's `knownIds` registry,
      which each request creates for itself) so one request reads ERPNext once and
      the next request still reads fresh — HINT-NOT-AUTHORITY untouched, ids are
      still registered and still re-validated by each caller.
- [x] Spec delta added (`customer-resolution`: "One request reads the customer
      master at most once", 2 scenarios); `validate --strict` = valid.

## 7. Evidence & books

- [x] `result90.txt` + `result91.txt` (real round + FINDING 1) + `.plan/next8/phase05b-result.md`.
- [x] `working.md` entry (34); this file ticked; `release-roadmap.md` updated
      (Phase 5 row + a new 5b row).
- [x] Commit made on the owner's explicit written instruction (money zone); one
      commit, explicit staging, no `.env` / `.plan` / secrets.

## 8. STOP and ask the owner when

- A money rule other than these two is found to rely on "customer list ≤100".
- A real write is needed without a written approval in the session.
- The site's MoP data makes option C impossible to implement without a new
  refusal code or new UI copy that is not already catalogued.
