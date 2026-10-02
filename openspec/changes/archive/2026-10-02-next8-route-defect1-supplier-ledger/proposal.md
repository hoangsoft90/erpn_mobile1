# next8 / DEFECT-1 — a supplier money-history read must use the SUPPLIER ledger

## Why

The audit measured HTTP 500 on `Lịch sử chi tiền của <NCC>` (C2-124..127). The
history read hard-coded `party_type=Customer` for a supplier ledger. A previous
commit (16c17fa) threaded a direction-aware `party_type` through
`copilot-server` — but the `/ask` call site passed THREE arguments into the
`payment` router bag's TWO-argument shim
(`listPaymentEntries: (id, type) => payment.listPaymentEntries(mcp, id, knownIds, type)`),
so the real type was swallowed: the skill always received `"Customer"`. The mock
ignored `party_type`, so no test could see it; the real server enforces it (500).

## What Changes

1. `copilot-server.mjs` (payment-history branch): call the bag with its declared
   shape — `skills.listPaymentEntries(partyId, isPayHistory ? "Supplier" : "Customer")`.
   The type now reaches `payment.listPaymentEntries` and a supplier read uses the
   SUPPLIER ledger.
2. `src/mock-server.mjs#erpnext_payment_entry_list`: mirror the real server's
   requirement — `party_type` MUST match the party's master (membership in the
   supplier/customer masters), else the tool errors (⇒ 5xx), never a silent empty
   list. This is what makes the direction observable to tests.

## Out of scope

- No change to the write path, amounts, or `/execute`. This is a READ direction.
- No change to `payment.listPaymentEntries`'s own signature.
