# next8 / Route CL-3 — `Bán [KH] <qty> <item>` reaches the sales-order write

## Why

The worst cluster in the audit (`res1.md` §1: **sales_order.create 0/35**): every
`Bán [KH] N bao [item]` / `Bán cho [KH] …` sentence matched the BROAD READ group
`sales` (keyword `bán`) and was answered with a document list
(`invoice.lookup`) — a WRITE command answered as a READ. Phase 6 built the sales
vertical, but the item-bearing order sentence was never routed to it.

## What Changes

1. `sales_order_write` gains the sentence-initial keyword `bán ` (trailing space so
   `bánh` cannot match) and the deny-words `bán hàng` / `ban hang`.
   - `Bán [KH] <qty> <item>` and `Bán cho [KH] <qty> <item>` → `sales_order.create`
     (a draft Sales Order PROPOSAL built from the sentence's lines, confirmed by the
     user — never a blind write).
   - `bán hàng cho <khách>` is DENIED here and still falls to `sales_write` /
     `sales.create` — **Phase 6's free-sale screen is preserved**, and its S22 test
     stays green.
   - Questions (`bán được bao nhiêu`, `bán … chưa?`) are denied and keep landing on
     the READ `sales` group.
2. Missing slots do NOT write: with no customer (or no item) the pipeline refuses
   (`MISSING_ENTITY` / builder refusal) — the safety invariants of next10 §4 hold.

## Behaviour change to flag for the owner

`Bán cho <khách>` with a full line (`… 1 bao <item>`) now opens an **order
proposal** instead of the Phase 6 free-sale screen (which owns lines/prices). This
is what the frozen corpus (`expected_proposal: true`, group `sales_order_write`) and
`res1.md` §3 ask for. `bán hàng cho <khách>` (the canonical free sale) is unchanged.

## Out of scope

- No change to `sales-write.mjs`, prices, discounts, or `/execute`.
- No widening of the `sales`/`sales_write` READ/verb sets.
