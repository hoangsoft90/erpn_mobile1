# next8 / D3 — tasks

## 1. Inventory branch consumes the picked id (shared Rule C)

- [x] DONE 2026-09-28 (D3): probe-verified gap — `item_candidates` is a PRIVATE key (grep
      apps/mobile = 0) and the branch ignored `opts.pickedEntityId` (P2a === P2b, probe file deleted).
- [x] DONE 2026-09-28 (D3): ambiguous-item answer carries the SHARED `candidates` key (limit 10)
      BESIDE the warning answer; `item_candidates` stays (b1 pin green).
- [x] DONE 2026-09-28 (D3): `pickRowFromCandidates(items, id, { idOf: ENTITY_ACCESSORS.item.idOf })`
      against the SAME findItem("") list; ok ⇒ `named = [row]` BEFORE rows/note derivation (order bug
      caught by the test) ⇒ proposal binds the id, warning gone; stale ⇒ `ENTITY_PICK_STALE` + fresh
      chips + `rows: []`. Evidence: next8-d3-shared 3–5 RED before, GREEN after.
- [x] DONE 2026-09-28 (D3): session context `set("item", …)` at the unique-match point + `.ok` checked
      (no-pick attempt logged as honest no-op).

## 2. Supplier READ picker obeys the D2 bound

- [x] DONE 2026-09-28 (D3): verified the branch already runs D2's limit 10 + overflow fields (D2 did
      it); D3 pins it by test (12 injected suppliers ⇒ 10 chips / total 12 / more 2 / hint).
- [x] DONE 2026-09-28 (D3): no client change.

## 3. Verify-and-pin the shared contract (T6/T7/T8 subset — evidence, no code)

- [x] DONE 2026-09-28 (D3): T6-customer pin — `ENTITY_PICK_REQUIRED` + chips → pick → proposal binds
      `CUST-00001` (probe P5).
- [x] DONE 2026-09-28 (D3): T7 pin — READ công nợ with the id answers `customer.id` = picked id.
- [x] DONE 2026-09-28 (D3): T8 verification — proposal binds the id; executor uses `proposal.entity.id`
      (next7 A2 ledger evidence: `mine[0].party === entity.id`); no new execute code.
- [x] DONE 2026-09-28 (D3): T8-supplier pin — `proposal.entity.id === "SUP-HATIEN"` + `supplier.id`.

## 4. Pay-side supplier ambiguous picker — DEFERRED (documented, no code)

- [x] DONE 2026-09-28 (D3): probe P3/P4 recorded — builder refuses before any picker; direction
      question = multi-chain ⇒ BACKLOG per plan §7. Recorded in D3-result §A/§G.

## 5. Tests + falsify + gates

- [x] DONE 2026-09-28 (D3): `test/next8-d3-shared.test.mjs` 7/7 (3 inventory tests RED before the
      fix, GREEN after; 4 pins green immediately). Falsify F1–F4 RED exactly their tests; restore from
      /tmp backup, grep FALSIFY = 0 (no `git checkout`).
- [x] DONE 2026-09-28 (D3): targeted suites 95/95 · Node FULL **905 tests — 903 pass / 2 fail**
      (baseline env pair) · Flutter lib untouched (analyze 1 issue probe; targeted tests 21/21).