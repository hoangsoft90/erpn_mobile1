## ADDED Requirements

### Requirement: A pick refusal names a cross-kind id for what it is (M1)

The pick helpers MUST be able to tell a cross-kind id from a stale one: when the
client-sent `entity_id` is NOT in the freshly-read list AND its ERPNext id series
is recognisable (`SUP-`/`CUST-`/`CAM-`) AND the series belongs to a DIFFERENT
entity kind than the branch that offered the chips, the refusal code MUST be
`ENTITY_PICK_WRONG_KIND` (with copy telling the user to pick again from the list),
NOT the stale/invalid reading. This is a REFUSAL REFINEMENT only: an id that IS
in the freshly-read list MUST still resolve regardless of its series (the list is
the authority — hint-not-authority is unchanged), an unrecognisable series keeps
the existing codes, and no additional ERPNext round-trip is added.

#### Scenario: a customer id sent into the supplier branch refuses as WRONG_KIND

- **WHEN** a supplier READ question offers supplier chips and a follow-up turn
  sends `entity_id: "CUST-00001"` (a live customer row, absent from the supplier
  list just read — a cross-kind bounce)
- **THEN** the response is refused with `error_code: "ENTITY_PICK_WRONG_KIND"`
  and a reason naming the kind mismatch — never `ENTITY_PICK_STALE` (the entity
  is not stale, it is the wrong kind), and no entity resolves from that id

#### Scenario: branches that surface refusal codes name the mismatch

- **WHEN** the supplier READ branch or the inventory branch receives a
  cross-kind id
- **THEN** both answer `ENTITY_PICK_WRONG_KIND` with fresh chips standing
  (inventory keeps `rows: []`); the customer path keeps its D0 contract — the
  refined code travels to the server-side log only, and the customer picker is
  re-offered (no new surface there)

#### Scenario: an id in the fresh list always wins regardless of series

- **WHEN** a branch's freshly-read list contains a row whose id does not follow
  its kind's usual series, and the client sends exactly that id
- **THEN** the pick resolves (list-is-authority) — the series check never
  overrides the freshly-read list

#### Scenario: a same-kind absent id keeps the STALE reading

- **WHEN** the client sends `entity_id: "SUP-99999"` (supplier series, absent
  from the supplier list just read)
- **THEN** the refusal stays `ENTITY_PICK_STALE` (unchanged D2 behaviour) — the
  guard only fires when the series names a DIFFERENT kind

#### Scenario: an unrecognisable series keeps the existing reading

- **WHEN** the client sends an absent id with no known series prefix
  (e.g. `"X".repeat(140)`)
- **THEN** the refusal stays exactly as before this change (`ENTITY_PICK_STALE`
  on the picker branches) — the guard does not guess

#### Scenario: the pipeline copy names the mismatch and keeps the fresh picker

- **WHEN** the supplier READ branch or the inventory branch refuses with
  `ENTITY_PICK_WRONG_KIND`
- **THEN** the answer carries the kind-mismatch reason with the FRESH chips
  standing (inventory also keeps `rows: []`), never a wrong entity and never a
  500
