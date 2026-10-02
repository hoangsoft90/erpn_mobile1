# next8 / DEFECT-1 — tasks

> Created before code. READ-direction fix (no money written).

## 0. Measured facts (do not re-measure)

- `skill` signature: `payment.listPaymentEntries(mcp, partyId, knownIds, partyType='Customer')`.
- Bag: `payment: (mcp, knownIds) => ({ listPaymentEntries: (id, type) => payment.listPaymentEntries(mcp, id, knownIds, type) })`.
- Call site (bug): `skills.listPaymentEntries(partyId, knownIds, "Supplier"|"Customer")` — extra arg.
- Effect (measured with the stricter mock): `party_type=Customer` for every supplier id ⇒ 5× HTTP 500 in the corpus sweep.

## 1. Code

- [x] `copilot-server.mjs`: call `skills.listPaymentEntries(partyId, type)` (2 args).
- [x] `mock-server.mjs`: `erpnext_payment_entry_list` throws on party_type/master mismatch.

## 2. Tests

- [x] `test/route-corpus-pipeline.test.mjs`: sweep 0 5xx; DEFECT-1 pin green.
- [x] Full `npm test`: only the 2 baseline dsh-env failures.

## 3. Falsify

- [x] F3: hard-code `"Customer"` again ⇒ the DEFECT-1 pipeline pin RED; restore byte-identical.
