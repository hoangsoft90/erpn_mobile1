# next8 / Collect server validation — the server owns every number and every account

## Why

Phase 2 (commit `433efe8`) shipped the collect screen. The screen is honest — no
auto-allocation, one payment method, live outstanding prefill — but it is still
the **client** that chooses the invoice, the amount and the account, and the
server merely echoes them into a card. Three shapes stay unsupported or
unchecked, all measured in Phase 0/2:

1. **One reference per payment entry.** `buildPaymentEntryData` hardcodes a
   single `references[]` row, and `/collect/propose` refuses more than one
   allocation with `422 COLLECT_MULTI_INVOICE_NOT_READY`. Owner lock §6.1 does
   **not** forbid multiple invoices — Phase 0 proved one submitted PE with
   several references (`phases/phase-00-audit.md` §4). The 422 was a Phase 1
   MVP, and the UI still lets a user tick two invoices and press confirm, so
   today that form ends in a refusal nobody can act on.
2. **The account is never checked against its type (lock §6.2).** The server
   still falls back to "the company's first Cash-type ledger account"
   (`payment-write.mjs#resolvePaymentAccounts`), so a **bank** intent can post
   into a **cash** ledger. The Phase 2 screen only hides the wrong account from
   the picker; nothing stops a crafted request.
3. **Open draft payments are read without a company filter.** ERPNext lowers
   `outstanding_amount` only at SUBMIT, so a live draft is invisible money —
   the code subtracts it, but a draft belonging to **another company** currently
   reduces this company's remainder.

This change makes the server the only author of the numbers: it re-reads
ERPNext (customer, open invoices, live outstanding, account, company), checks
every clause of plan §9/§19/§28, and builds the proposal itself.

## What Changes

1. **A collect proposal is built from explicit allocations** —
   `buildCollectProposal` takes `allocations[]` and the **one** payment method,
   re-reads the live outstanding per invoice, subtracts same-company open
   drafts, and refuses when the allocation total and the payment total disagree.
   The "pick the oldest open invoice" default is **not** reachable from the
   collect path (the chat path keeps its current behaviour until Phase 8/9).
2. **`references[]` becomes a list** in the payment-entry builder:
   one row per allocation, `paid_amount = Σ allocated + unallocated`, and
   `unallocated_amount` written **explicitly** so ERPNext never infers it.
3. **Account resolution follows lock §6.2** — (1) the account the user chose,
   validated to exist, to belong to the company and to match the method's
   `account_type` → (2) the company's own default for that channel →
   (3) **BLOCK**. The "first Cash-type account" fallback is deleted, and a
   cross-channel substitution (Cash ↔ Bank) is impossible.
4. **`/collect/propose` drops the multi-invoice 422** and validates a
   multi-invoice draft instead, so the screen's own form can succeed.
5. **The open-draft read is company-scoped**, and only drafts of the same
   direction and company may reduce an invoice's remainder.
6. **Every refusal carries a code and Vietnamese copy** (plan §28), and an
   unreadable ERPNext fails closed (`ERP_UNAVAILABLE`) instead of answering 0.

## Impact

- Affected specs: `collect-validation`, `payment-accounts`, `payment-references`,
  `invoice-reads` (all new deltas in this change).
- Affected code: `mcp-erpnext/src/skills/payment-write.mjs` (builder, account
  resolution, draft read), `mcp-erpnext/src/skills/sales.mjs` (collect read page),
  `mcp-erpnext/src/copilot-server.mjs` (`proposeCollectFromHandoff`),
  `mcp-erpnext/src/transaction-draft.mjs` (only if a rule must be shared),
  `mcp-erpnext/src/mock-server.mjs` (fixtures the new checks need).
- Money path: this change **alters what the server is willing to propose**. No
  new write route and **no `safety-gateway.mjs` change** (Phase 4 owns execute);
  a multi-reference proposal built here is not yet executable end-to-end.
- Not changed on purpose: the chat-driven payment path keeps its current
  oldest-first default and its warning copy (blast radius ≈ 936 tests), the
  §6.2 rule is enforced **before** a proposal exists, and no client value ever
  becomes authority — client numbers stay inputs to compare.
- Out of scope: executing a multi-reference proposal (Phase 4), Sales/Purchase
  screens, split-N-PE (backlog), and any new Dart dependency.

## Measured facts this change depends on

- The pinned tool `erpnext_doc_list` exposes `limit` but **no offset**
  (`skills/customer-create.mjs` documents the measurement), so "page 2" does not
  exist server-side: paging is done over a complete read, and a read that cannot
  be complete must say so instead of cutting at 100.
- Site accounts: AR `1310`, AP `2110`, cash `1110`, bank `1210`; the Mode of
  Payment rows carry **no** usable account for the company, so the account must
  always come from an explicit account row / company default — never from MoP.
