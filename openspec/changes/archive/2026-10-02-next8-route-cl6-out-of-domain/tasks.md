# next8 / Route CL-6 — tasks

> Created BEFORE code (owner rule #1: mở change trước khi sửa router). One cluster = one change.

## 0. Measured facts (do not re-measure)

- `routeIntent("bật đèn phòng khách")` → `customer/customer.balance` (matched `khách`).
- `routeIntent("cửa hàng mở cửa lúc nào")` → `inventory/stock.balance` (matched `hàng`).
- 18/20 C6 sentences already return `null` (no route).

## 1. Code

- [x] `src/capability-contract.mjs#resolveCapability`: add a DENY-only out-of-domain
      guard before the routing loop; a match returns `null`.
- [x] Cue list is small and measured (smart-home / chit-chat), never a route.

## 2. Corpus delta

- [x] `test/fixtures/route-corpus.json#gate.locked_failures` drops C6-225 + C6-237.
- [x] `test/fixtures/route-corpus.snapshot.json`: C6 lockded_fail 2 → 0; totals 79 → 77.
- [x] `node --test test/route-corpus.test.mjs` green (5/5 safety + gate).

## 3. Regression

- [x] Full `npm test`: only the 2 baseline dsh-env failures.
- [x] No ERP sentence in the corpus regresses (gate deep-equals the new fail set).

## 4. Falsify

- [x] F4: replace the guard with a between-word substring match ⇒ CL-6 safety test RED;
      restore byte-identical.
