# next8 / Route CL-3 — tasks

> Created before code — one cluster = one change. Opens a money-write route:
> owner signs off before commit (money zone).

## 0. Measured facts (do not re-measure)

- 35 locked cases: `Bán {KH} 1 bao {ITEM}` → `sales/invoice.lookup` (20) and
  `Bán cho {KH} …` → `sales_write/sales.create` (15 in C1 + 2 in C5).
- Expected (corpus + `res1.md` §1): `sales_order_write/sales_order.create`, `expected_proposal: true`.
- `bán hàng cho Nguyễn Thị Lan` MUST stay `sales_write`/`sales.create`
  (`test/next8-s21-s22-capability-gate.test.mjs`).

## 1. Code

- [x] `capabilities.json#routing[sales_order_write]`: add `bán ` keyword, add
      `bán hàng|ban hang` to `notIf`.
- [x] No other group touched.

## 2. Corpus delta

- [x] `gate.locked_failures` drops CL-3's 35 ids; totals shrink.
- [x] SAFETY test: no locked READ case promoted to a WRITE group.

## 3. Regression

- [x] `next8-s21-s22-capability-gate.test.mjs` (S22) green — `bán hàng cho` still opens the sales screen.
- [x] b2/b4/p9 `đặt hàng cho …` still `sales_order.create`; questions still READ.
- [x] Full `npm test`: only the 2 baseline dsh-env failures.

## 4. Falsify

- [x] F1: route EVERY `bán` (drop the notIf / startsWith anchor) ⇒ the "no blind
      WRITE" corpus safety test + the missing-slot case go RED; restore byte-identical.
