# next8 / Route CL-5 — tasks

> Created before code — one cluster = one change.

## 0. Measured facts

- `routeIntent("Lịch sử thu của Nguyễn Thị Lan")` → `null` (UNKNOWN_INTENT; audit C2-097).
- `routeIntent("Lịch sử thu của «CUSTOMER_A»")` → `customer/customer.lookup` (the alias
  token contains the substring `customer` — a fixture artefact, not the real path).
- The `payment` group already carries `lịch sử chi`.

## 1. Code

- [x] `capabilities.json#routing[payment]`: add `lịch sử thu` keyword (phrase, not bare `thu`).

## 2. Corpus delta

- [x] `gate.locked_failures` drops C2-097, C1-106, C1-115; totals shrink.

## 3. Regression

- [x] `phiếu thu` / `đã trả` / `đã thanh toán` history questions still `payment.history`.
- [x] Full `npm test`: only the 2 baseline dsh-env failures.

## 4. Falsify

- [x] Covered by the CL-5 corpus gate (no separate mutation needed).
