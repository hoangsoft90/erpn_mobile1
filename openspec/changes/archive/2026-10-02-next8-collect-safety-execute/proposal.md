# next8 / Collect safety execute — confirming a multi-invoice collection

## Why

Phase 3 (commit `c763107`) made the server the author of the collect proposal:
`/collect/propose` now returns a card carrying `allocations[]` (several invoices),
explicit `unallocated_vnd`, and an account resolved by lock §6.2. The proposal is
**built** but not **executable**: `executePaymentProposal` still refuses anything
with more than one allocation (`PAYMENT_MULTI_REFERENCE_NOT_READY`), and
`buildPaymentEntryData` is only reachable there through the single-invoice
shorthand. So today a seller can tick two invoices, get a correct card, press
confirm — and the money path stops.

Phase 4 is the other half of the same feature: `/execute` must write ONE draft
Payment Entry with several reference rows, from the ids frozen in the proposal,
after re-reading the live numbers. The safety contract that already exists
(idempotency on `command_id`, drift ⇒ `PROPOSAL_STALE`, the single write door,
reconcile, job queue) MUST NOT change shape — this change widens *what can be
executed*, not *how execution is guarded*.

## What Changes

1. **`executePaymentProposal` accepts a multi-reference proposal.** It reads
   `params.allocations[]` (ids, never names) and `params.payment_methods[0]`,
   re-reads each invoice's live outstanding (minus same-company drafts), and
   refuses when the live remainder no longer covers the allocation:
   `PROPOSAL_STALE` / `INSUFFICIENT_OUTSTANDING` / `INVOICE_ALREADY_PAID`.
2. **The written document carries one reference row per allocation**, with
   `paid_amount = received_amount = Σ allocated + unallocated` and
   `unallocated_amount` written explicitly, so `difference_amount` is zero.
3. **On-account is a real shape** (lock §6.3): with nothing open the proposal has
   `allocations: []` and the entry is written with **no** reference row and
   `unallocated_amount = paid_amount`. With an invoice still open, an empty
   allocation list stays refused.
4. **The account is re-derived server-side** at execute time and validated
   against the method's channel (lock §6.2) — a proposal field is never trusted
   as authority, and a wrong-typed account blocks instead of falling back.
5. **Verification reads back every mapped field**, including the reference rows:
   `docstatus`, `payment_type`, `party_type`, `party`, `company`, `paid_from`,
   `paid_to`, `paid_amount`, `received_amount`, `unallocated_amount`, the
   reference row count and each `allocated_amount`, plus
   `reference_no = command_id` and `custom_ai_action_id = action_id`.
6. **Exactly one payment method stays enforced** (lock §6.1): a payload with more
   than one method is refused before any write.
7. **The card copy says what will happen in Vietnamese** — every invoice name,
   the total, whether part of the money is on-account, any live draft that
   already covers an invoice, and that the document is written as a **NHÁP**.

## Impact

- Affected specs: `payment-execute` (new), `payment-accounts` (execute-time
  re-derive). `payment-references` (Phase 3) already fixes the document shape;
  this change is what puts it on the wire.
- Affected code: `mcp-erpnext/src/skills/payment-write.mjs`
  (`executePaymentProposal`, `verifyWrittenPayment`, the proposal→document
  mapping), and — only if the executor table requires it —
  `mcp-erpnext/src/safety-gateway.mjs`'s `WRITE_EXECUTORS` entry. The gate order,
  the idempotency store, the reconcile path and the job queue are **not** changed.
- Money path: this is the first change that can write a multi-reference Payment
  Entry. Every other write rule (the other nine capabilities) is untouched.
- Out of scope: a second write route, N-payment-entries-per-order (lock §6.1
  keeps one method ⇒ one entry, split-N-PE is a separate change), Sales/Purchase
  screens, auto-submit, and any change to `idempotency.mjs`.

## Constraints this change must not break

- `/execute` stays the ONE door that can reach a Payment Entry write.
- Idempotency stays keyed on `command_id` + `reference_no` + the correlation
  field; a second confirm of the same command MUST replay, never double-post.
- An ERPNext outage mid-execute stays retryable (503 + `retry_same_command_id`
  + job queue), and a retry MUST NOT create a second document.
- Numbers on the document come from a LIVE read at execute time; the proposal's
  numbers are a snapshot with an `action_id` for audit only.
