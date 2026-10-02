# next8 / Route CL-2 — tasks

> Created before code — one cluster = one change.

## 0. Measured facts (do not re-measure)

- 30 locked cases: 15 `Đặt hàng {NCC} 1 bao {ITEM}`, 15 `Đặt mua hàng từ {NCC}` →
  normalized `Đặt purchase từ {NCC}` — all currently `sales_order_write`.
- Existing contracts to protect: `đặt hàng cho Nguyễn Thị Lan 10 bao cám heo` →
  `sales_order.create` (b2/b3/b4/p9); `đặt mua cho Hà Tiên 10 bao cám heo` →
  `purchase_order.create` (b4).

## 1. Code

- [x] `capabilities.json`: add a `purchase_order_write` route entry (keywords
      `đặt hàng`,`dat hang`,`đặt purchase`; startsWith; notIf leading with `\bcho\b`)
      BEFORE `sales_order_write`. Existing PO entry unchanged.

## 2. Corpus delta

- [x] `gate.locked_failures` drops CL-2's 30 ids; totals shrink.
- [x] No locked case regresses.

## 3. Regression

- [x] b2/b3/b4/p9 `đặt hàng cho …` and `đặt … cho …` still `sales_order.create`.
- [x] `đặt mua …` still `purchase_order.create`; `purchase từ …` still `purchase_invoice.create`.
- [x] Full `npm test`: only the 2 baseline dsh-env failures.

## 4. Falsify

- [x] F2: drop the `\bcho\b` deny ⇒ `đặt hàng cho <khách>` becomes a purchase and
      the b2/b4 tests + CL-2 direction test go RED; restore byte-identical.
