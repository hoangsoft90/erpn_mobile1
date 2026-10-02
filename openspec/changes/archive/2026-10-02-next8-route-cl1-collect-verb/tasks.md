# next8 / Route CL-1 — tasks

> Created before code — one cluster = one change. Money zone: this change only
> redirects the ROUTE; no amount or account is affected. Owner signs off before commit.

## 0. Measured facts (do not re-measure)

- `routeIntent("«CUSTOMER_A» trả 50 nghìn")` → `payment/payment.history` (matched `trả`).
- `routeIntent("«CUSTOMER_B» đã trả bao nhiêu?")` → `payment/payment.history` (correct, must stay).
- `routeIntent("Thu tiền X 50 nghìn")` (normalized `payment X 50 nghìn`) → `payment_write/payment.create` (already correct).

## 1. Code

- [x] `src/capability-contract.mjs#resolveCapability`: rewrite the shape
      `<prefix> trả <digit>` onto the canonical verb (guard: not already starting
      with `payment`). Question shapes carry no digit after `trả` and are untouched.
- [x] No change to `payment-create` logic, amounts, accounts, `/execute`.
- [x] **Self-review fix (2026-10-01)**: the first cut prepended `payment` to ANY
      `trả <digit>` anywhere, so `xuất hóa đơn cho đơn đã trả 500 nghìn` (an invoice
      command) and `xem đơn đã trả 200 nghìn` (a history read) were hijacked into
      `payment_write`. Narrowed: the rewrite now also requires that (a) the
      participial `đã trả` / `da tra` clause is absent, and (b) no other `startsWith`
      command route already claims the sentence start. Probes + corpus re-verified
      (167/167 locked, strict 7/7, sweep 280/280 HTTP 200, Node 1105/1102/2).

## 2. Corpus delta

- [x] `gate.locked_failures` drops CL-1's 7 ids (C2-001..006, C2-148); totals shrink.
- [x] Gate + snapshot green; no locked READ promoted to WRITE (safety test).

## 3. Regression

- [x] Full `npm test`: only the 2 baseline dsh-env failures.
- [x] The CL-5 history questions still route to `payment.history`.

## 4. Falsify

- [x] F5: make an ambiguous/party-less collect propose a write ⇒ corpus §4 safety RED;
      restore byte-identical.
