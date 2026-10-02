# next8 / Route CL-1 — a party-first collect command reaches payment.create

## Why

The audit (`res1.md` §1, `corpus.json`) locks 7 sentences of the shape
`<Tên> trả <số tiền>` (e.g. `«CUSTOMER_A» trả 50 nghìn`). They are collect
COMMANDS — the owner's own words in `phase-08 §5.5` — but they route to the READ
`payment` group (`payment.history`), because the collect verb sits AFTER the party
and every `payment_write` keyword is sentence-initial. The sibling forms
`Thu tiền X 50 nghìn` / `Trả tiền X …` already reach `payment.create` (NLP rewrites
their verb to the canonical `payment`); only the party-first shape is missed.

## What Changes

1. `resolveCapability` gains ONE targeted rewrite: when the text carries a party,
   the verb `trả`, then a spoken AMOUNT (`\d`), it is rewritten onto the canonical
   verb (`payment <…>`), so the existing `payment_write` route decides — with its
   own question deny-list (`bao nhiêu`, `mấy`, `chưa`, `?`). A question about money
   already paid (`X đã trả bao nhiêu`, `X trả những khoản nào`) has **no amount after
   the verb** and is never rewritten, so it still lands on `payment.history`.
2. The direction is still derived server-side from which master list holds the
   party (`payment.create.direction_policy`) — this change only fixes WHICH GROUP
   the sentence reaches; it does not touch the money direction or any amount.

## Out of scope

- No change to `payment.write` logic, amounts, accounts, or `/execute`.
- No widening of the `payment` READ group.
