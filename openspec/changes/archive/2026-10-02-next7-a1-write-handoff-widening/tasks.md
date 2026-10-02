# next7 / A1 — tasks

## 1. Widen the handoff-able set (one place, explicit)

- [x] `dsh-optin.mjs`: `DSH_WRITE_HANDOFF_CAPABILITIES` = every wired write capability id —
      `payment.create`, `sales_order.create`, `quotation.create`, `purchase_order.create`,
      `delivery.create`, `purchase_receipt.create`, `sales_invoice.create`, `sales_return.create`,
      `stock.adjustment`, `customer.create` (+ the A0 `payment.create`), each with a one-line
      "why it is safe" and a note that `document.delete` is FORBIDDEN and stays outside by contract.
- [x] The comment names what a FUTURE write must do: be wired into `answerQuestion` first, then be
      added here explicitly — never inherit the handoff from being write-shaped.

## 2. Route-side: no code change expected

- [x] Confirm the A0 route branch needs no edit for the wider set (it reads `outcome.handoff` and
      meters whatever proposal the pipeline returns) — assert this in the A1 result, not by editing.

## 3. Tests (through `/dsh/ask`, parity-asserted against `/ask`)

- [x] A5: `MOCK_ERP_DUPLICATE_CUSTOMER="Nguyễn Thị Lan"` + payment sentence → `handoff` marked,
      `error_code: ENTITY_PICK_REQUIRED`, `candidates.length ≥ 2`, `proposal: null`.
- [x] A6: WRITE sentence naming no party ("tạo đơn bán 3 bao cám heo") → `handoff` marked,
      `error_code: MISSING_ENTITY`, `proposal: null`.
- [x] A7: non-payment write with 1 match + complete slots ("đặt hàng cho Nguyễn Thị Lan 2 bao cám
      heo") → `ok:true`, `proposal.entity.id === "CUST-00001"`, `submit_now === false`,
      `runtime: null`.
- [x] A10: payment without an amount → `PAYMENT_AMOUNT_MISSING`, `proposal: null` (already pinned
      in A0 — keep green).
- [x] Explicit-set guard: `document.delete` shape ("xóa hóa đơn ACC-SINV-0001") is NOT handed off —
      no `handoff` field anywhere in the response.
- [x] `test/dsh-gateway.test.mjs`: the "non-handoff WRITE" example switches from "đặt hàng…" to a
      `document.delete` sentence; the reason assertion relaxes from the refusal copy to the code +
      "no handoff" (the forbidden copy belongs to the pipeline, not the gateway).
- [x] `test/p5-dsh-optin.test.mjs` passes UNCHANGED (in-child gate untouched).

## 4. Falsify

- [x] `scripts/falsify/next7-a0-handoff.mjs`: M1 (empty set) and M3 (every capability incl.
      forbidden) anchors verified against the new code; add M6 — one wired write id removed from
      the set (e.g. `sales_order.create`) → its A7 test goes RED. Restore byte-identical.

## 5. Out of scope (named)

- [ ] Flutter picker/card render for the newly handed-off writes — A3.
- [ ] Execute binding/idempotency — A2 (unchanged from A0).
- [ ] New WRITE capabilities without an `answerQuestion` branch — none exist today; the explicit
      set is the guard for any future one.
