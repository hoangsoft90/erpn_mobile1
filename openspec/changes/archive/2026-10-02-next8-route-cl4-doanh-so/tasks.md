# next8 / Route CL-4 — tasks

> Created before code — one cluster = one change.

## 0. Measured facts

- `doanh thu hôm nay` → `sales/sales.summary` (trigger `doanh thu`).
- `doanh số hôm nay` → `sales/invoice.lookup` (no `doanh số` trigger).

## 1. Code

- [x] `capabilities.json#capabilities[sales.summary].triggers`: add `doanh số`, `doanh so`.
- [x] `invoice.lookup` triggers unchanged.

## 2. Corpus delta

- [x] `gate.locked_failures` drops C1-133, C1-143; totals shrink.

## 3. Regression

- [x] `doanh thu`/`báo cáo doanh thu` cases still `sales.summary`.
- [x] `hóa đơn chưa trả` cases still `invoice.lookup`.
- [x] Full `npm test`: only the 2 baseline dsh-env failures.
