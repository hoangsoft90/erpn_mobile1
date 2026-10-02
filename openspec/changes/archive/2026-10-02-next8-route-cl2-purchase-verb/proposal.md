# next8 / Route CL-2 — buying from an NCC reaches the purchase order

## Why

`res1.md` §3 (CL-2, **purchase_order.create 0/30**): `Đặt hàng [NCC] …` and the
Phase-1-normalized `Đặt purchase từ [NCC] …` both fell into **`sales_order_write`**
— a purchase sentence turned into a SALES order (wrong direction). The audit calls
this a business hazard if the SO is ever confirmed. The two look-alikes share the
word `đặt hàng`, so the direction has to be read from a signal, not the verb alone.

## What Changes

1. A dedicated `purchase_order_write` route entry matches `đặt hàng` / `dat hang` /
   `đặt purchase` (sentence-initial) and DENIES the sales tell-tale `cho`
   (`\bcho\b`, word-boundary so `chọn`/`chờ` cannot match) plus the usual question
   words. So:
   - `Đặt hàng <NCC> <qty> <item>` and `Đặt purchase từ <NCC> …` → `purchase_order.create`
     (a draft Purchase-Order PROPOSAL).
   - `đặt hàng cho <khách> …` is DENIED here and keeps resolving to
     `sales_order_write` (`sales_order.create`) — the existing b2/b3/b4/p9 contracts
     stay green.
2. The existing `purchase_order_write` entry (which owns `đặt mua`, `mua `, …) is
   untouched, so `đặt mua cho Hà Tiên …` still resolves to a purchase order.

## Why `cho` and not the party name

Routing is text-only (no entity resolution in `routeIntent`). `cho` ("for someone")
is the buying/selling tell-tale the corpus exposes: every locked sale has `cho`,
every locked purchase names the NCC directly. The party is still re-resolved
server-side against the SUPPLIER master for `purchase_order_write`
(`copilot-server.mjs` partyKind), so a name that is not a supplier is REFUSED —
never turned into a purchase order.

## Out of scope

- No change to purchase builders, prices, or `/execute`.
