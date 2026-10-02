## Purpose

Record that the entity-selection contract (plan_final_v3 §0/§3) is SHARED by every
entity kind that offers a picker — the id a user picks is consumed by the branch
that offered the chips, never dropped — and that the D2 bound (≤10 chips) applies
to every picker. D1/D2 fixed the supplier READ loop and that picker's safety; D3
covers the remaining picker-backed kinds and pins the WRITE binding end to end.

## ADDED Requirements

### Requirement: The picked id is consumed by every branch that offers chips (D3)

When a branch answers with picker candidates (the shared `candidates` key), that
branch MUST consume `pickedEntityId` on the next turn: the id is validated against
the SAME master list the branch just read (hint-not-authority, D1's law), a valid
id narrows the answer to that entity (proposal/entity binding carries the id), and
an id the list does not hold is refused `ENTITY_PICK_STALE` with the fresh chips
standing (D2 reading). A branch that shows chips but ignores the pick re-creates
the D1 supplier loop for that kind — forbidden.

#### Scenario: an ambiguous item pick narrows the inventory answer to that item

- **WHEN** `tồn kho cám` answers AMBIGUOUS with item chips, and the client re-sends
  the same sentence with `entity_id: "CAM-GA-10KG"`
- **THEN** the answer's rows are ONLY that item's rows, the proposal binds
  `entity.id = "CAM-GA-10KG"`, and the ambiguity warning is gone

#### Scenario: a stale item pick is refused with the fresh list standing

- **WHEN** the client sends `entity_id: "CAM-GONE"` (not in the item list just read)
- **THEN** the response is `ENTITY_PICK_STALE` with its Vietnamese copy and fresh
  chips — never a wrong item, never an error 500

### Requirement: Every picker obeys the D2 bound (D3)

Every branch that offers picker chips MUST use `limit ≤ 10` and, on overflow, MUST
carry `picker_total`/`picker_more` and the "Còn X kết quả — gõ tên cụ thể hơn"
hint — the D2 rule is not supplier-specific. A private candidate key (like B1's
`item_candidates`) does not replace the shared `candidates` key.

#### Scenario: the supplier READ picker shows at most 10 chips

- **WHEN** a supplier READ question matches more than 10 supplier rows
- **THEN** `candidates` holds exactly 10 chips and `picker_more` names the rest

### Requirement: The WRITE proposal binds the picked id end to end (D3 — verification)

After a selection on a WRITE route, the proposal's `entity.id` MUST BE the picked
id (Rule C — bind exact ID) and the `/execute` path MUST use ONLY that id
(`proposal.entity.id`), never a name re-resolution. The supplier party MUST travel
under the key its kind names (`supplier.id`).

#### Scenario: a customer picker pick on a payment WRITE binds the id

- **WHEN** a fuzzy customer name answered `ENTITY_PICK_REQUIRED` with chips, and
  the same sentence returns with `entity_id: "CUST-00001"`
- **THEN** the proposal's `entity.id` is `CUST-00001` and the executor's ledger row
  carries that party (pinned by the next7 A2 evidence — no name re-resolution)

### Requirement: A branch without a picker does not invent one (D3 — boundary)

A route whose contract cannot resume a WRITE from a picked id alone (the pay-side
supplier ambiguity, which would require a direction question) MUST NOT be given a
picker by D3 — that is a documented backlog limitation (plan §7 multi-chain),
recorded in the phase result, not improvised.

#### Scenario: the pay-side supplier ambiguity stays a documented limitation

- **WHEN** a pay-side question carries a supplier ambiguity whose WRITE cannot
  resume from a picked id alone (it would need a direction question)
- **THEN** D3 MUST NOT offer that branch a picker — the limitation stays recorded
  in the phase result instead of being improvised into new behaviour
