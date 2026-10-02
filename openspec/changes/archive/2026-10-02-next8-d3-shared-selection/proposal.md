# next8 / D3 — Shared entities + WRITE regression (plan_final_v3 §0/§3/§8)

## Why

D1 fixed the supplier picker loop and D2 made that picker safe, but a probe
(measured 2026-09-28, throwaway run, file deleted) shows the selection contract
is still PER-BRANCH, not shared — plan_final_v3 §0 says it must be shared:

- **Customer** (the original picker): fuzzy-single WRITE → `ENTITY_PICK_REQUIRED`
  with chips → pick re-sends the id → proposal binds `CUST-00001`. FULL Rule C. ✔
- **Supplier READ** (`route.group === "supplier"`): D1 wired the id in — pinned
  by next8-entity-pick.test.mjs 4/4. ✔
- **Inventory** (`route.group === "inventory"`): offers chips under a PRIVATE
  `item_candidates` key (B1) that no client renders, and IGNORES
  `opts.pickedEntityId` entirely — a tap cannot exist and an id does nothing.
  ✘ same-loop class as the D1 supplier bug.
- **Pay-side supplier WRITE**: an ambiguous supplier name never OFFERS a picker —
  the builder refuses `PAYMENT_DIRECTION_CONFLICT`/unresolved before any picker
  path, so a shop cannot pick which "Hà Tiên" to pay. ✘ (measured: id dropped.)
- **Heading WRITE picker (require_picker branch, L1608)**: `pickerForText(...,
  limit: 5)` — the D2 hard limit of 10 does not apply to the WRITE picker, and
  no overflow fields. ✘ D2 rule applies to every picker.

## What Changes

1. **Inventory consumes the picked id (shared Rule C)** — the ambiguity branch
   offers `candidates` (chips, the SHARED key) beside the warning answer;
   `opts.pickedEntityId` re-validates against `ENTITY_ACCESSORS.item` on the
   SAME `findItem("")` list (hint-not-authority, D1's law) and narrows `named`
   to that one row; a stale/crafted id answers `ENTITY_PICK_STALE` (D2 code).
   `item_candidates` stays (B1 pin) — the shared `candidates` is additive.
2. **Supplier READ limit 5 → 10 + overflow fields** — D2's bound applies to the
   supplier picker too (`pickerForRowsByText(..., limit: 10)` +
   `countPickerMatches` + `picker_total/picker_more` + hint on overflow).
3. **Customer/Stale contract verification (T6/T8 subset)** — pins, no new code:
   customer fuzzy-single pick → proposal binds the id (measured ✔);
   supplier pick on a supplier-WRITE route resolves that row (P1: the resolved
   supplier comes straight from the text resolver's exact hit, so Rule C's
   "no name re-resolution" is asserted by the proposal binding, no change);
   execute-side uses only `proposal.entity.id` (P9-C/next7-A2 — no code).
4. **Pay-side supplier ambiguous picker — DEFERRED** (multi-chain direction
   question, backlog per plan §7): pinned as a documented limitation, not code.

## Impact

- Affected specs: `entity-selection` (ADDED requirement + scenario).
- Affected code: `copilot-server.mjs` (inventory branch + supplier READ picker
  limit), `entity-resolution.mjs` (no change — helpers exist).
- Tests: new `test/next8-d3-shared.test.mjs` (T6/T7/T8 subset + inventory pick
  + overflow) with falsify battery; no Flutter change (client renders `candidates`
  already; inventory now emits into it).