# next8 / Collect — full customer master + bank MoP channel (Phase 5b)

## Why

Phase 5 measured two defects in the Collect MONEY path on the real site
(`result89.txt` §6, `.plan/next8/phase5-result.md`, `.plan/next8/phases/phase-05b-collect-propose-fixes.md`).
Both are in the path that decides whether a collection can be written at all,
and which ledger it lands in:

- **F-P5-1 (MEDIUM) — a customer outside the first 100 rows cannot be collected
  from.** `findCustomer` reads `erpnext_customer_list` with `{ limit: 100 }`
  (`mcp-erpnext/src/skills/customer.mjs:32`) and `proposeCollectFromHandoff`
  resolves the picked id with `rows.find(...)` over that same capped list
  (`mcp-erpnext/src/copilot-server.mjs:2470`). The site has **134 Customers**
  (measured 2026-09-30), so ~34 of them — e.g. `Anh Ba — xây nhà` with two open
  invoices — always return `404 NO_MATCH` from `/collect/propose`. The failure is
  invisible on a small demo site and permanent on a real one. Same class as the
  M1 lesson that already forced `limit: 0` in `customer-create.mjs:150`.
- **F-P5-2 (MEDIUM) — a `bank_transfer` intent writes `mode_of_payment = "Cash"`.**
  `resolveAccountPlan` picks the Mode of Payment **name** by
  `exact(label) → /cash/i(name) → type === "cash"` and has **no bank branch**
  (`mcp-erpnext/src/skills/payment-write.mjs:579`, the `chosen` line). The money
  account is correct — the channel that selects the account reads the request
  LABEL (`channelOfMode`), so `paid_to` is the company's Bank default — but the
  MoP label is wrong. Proven on the real draft `ACC-PAY-2026-00775`:
  request `bank_transfer`, `paid_to = "1210 - ACB 110296868 - MP"` (correct),
  `mode_of_payment = "Cash"` (wrong). Every report grouped by MoP files a bank
  receipt under cash.
- **F-P5-3 (site data, NOT fixed by this change)** — the site declares MoP
  `"Chuyển khoản"` with `type = Cash` (measured 2026-09-30: `Bank Draft|Bank`,
  `Cash|Cash`, `Cheque|Bank`, `Chuyển khoản|Cash`, `Credit Card|Bank`,
  `Wire Transfer|Bank`). A label match and the MoP `type` disagree. Fixing site
  data is the owner's job; the product must not resolve the conflict silently.

Owner decision (2026-09-30, `result89.txt` §9): for F-P5-2 take **option C** —
pick a genuinely bank-typed MoP AND say out loud, in Vietnamese, when a
label-matching MoP has a contradictory `type`, instead of silently renaming the
shop's method. Measured site data supports C (the `"Chuyển khoản"` MoP really is
`type = Cash`), so option B ("let the MoP `type` decide the channel") is rejected:
it would route money a user called "chuyển khoản" into the cash ledger `1110`.

## What Changes

1. **F-P5-1 — read the full customer master on the propose path.**
   `findCustomer` stops capping at 100 (`limit: 0` = no limit, the verified M1
   behaviour of the pinned `@casys/mcp-erpnext@3.0.4`) and keeps the read's
   existing shape. The chosen id is STILL re-validated against the
   freshly-read master at propose time — the list is a **HINT, not AUTHORITY**
   (§7) and this change does not relax that rule. Nothing else about how a
   customer is picked or trusted changes.
2. **F-P5-2 — pick the Mode of Payment by CHANNEL, not by name.**
   `resolveAccountPlan` keeps the request's label as the source of the channel
   (`channelOfMode`, unchanged) and then chooses the MoP whose `type` matches
   that channel, deterministically. A bank intent can no longer land on a
   `Cash`-typed MoP.
3. **Decision C — say it out loud, never silently rename.**
   When a MoP whose name matches the requested label exists but its `type`
   contradicts the channel, the result carries a Vietnamese warning naming the
   mismatch (e.g. MoP "Chuyển khoản" is declared tiền mặt). Where the mismatch
   would put money in the wrong `account_type`, the write is refused with the
   existing refusal vocabulary — no new silent substitution is introduced.
4. **Tests pin both measured cases and both are falsified.**
   A customer beyond row 100 resolves `/collect/propose`; a bank intent yields a
   bank-channel MoP. Falsify: restore `limit: 100`, or drop the bank branch ⇒ the
   matching test goes red; restore byte-identical (md5).

## Impact

- Affected code: `mcp-erpnext/src/skills/customer.mjs` (`findCustomer` read
  limit), `mcp-erpnext/src/skills/payment-write.mjs` (`resolveAccountPlan`
  MoP selection), and `mcp-erpnext/src/mock-server.mjs` only if a fixture is
  needed to mirror ERPNext (>100 customers / a label-vs-type-mismatched MoP).
- Affected spec areas: the Collect customer-resolution read and the §6.2
  channel→account rule. Lock §6.1 (one method), §6.2 (right `account_type` or
  BLOCK), §6.3 (on-account only with 0 open invoices) and §6.4 (company-scoped)
  are **unchanged**; F-P5-2 changes only how the MoP NAME is chosen, never how
  the money ACCOUNT is chosen.
- Money path: no new write route, no submit, no change to `idempotency.mjs`, the
  safety-gateway order, or the refusal-code catalogue (no new code unless a case
  demands it).
- Out of scope: Sales/Purchase screens (Phase 6), editing the shop's ERPNext data
  (including the `type` of MoP "Chuyển khoản" — that is the owner's action),
  pagination/offset reads for other tools, and widening `limit` anywhere not
  required by these two fixes.

## Constraints this change must not break

- **HINT-NOT-AUTHORITY stays.** The customer id the client sends is never trusted
  as authority: it is looked up in the master read at propose time and the master
  is re-checked when the record is used (F-P5-1 widens the READ, not the trust).
- **§6.2 stays "right `account_type` or BLOCK".** A bank intent must resolve the
  company's Bank default (e.g. `1210`), and must NEVER fall back to a cash
  ledger such as `1110`; a wrong-typed account still refuses, never substitutes.
- **`payment.create` stays the single canonical write capability** (alias
  `payment.collect` unchanged); `/execute` stays the one door to a Payment Entry.
- **One method per transaction stays enforced** (§6.1) — one entry, not N.
- **Money still comes only from ERPNext reads**, never computed by the model.
