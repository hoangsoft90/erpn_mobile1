## ADDED Requirements

### Requirement: A picked id is length-capped at every HTTP boundary

The `entity_id` a client sends back MUST pass the SAME length cap at EVERY
route that accepts it: an `entity_id` longer than `MAX_ENTITY_ID_LENGTH`
(140) characters is refused with HTTP 400 and code `DSH_GATEWAY_BAD_REQUEST`
before the pipeline runs. Both routes share the one constant — the two
standards MUST NOT drift again. A shorter id keeps every existing behaviour
(hint-not-authority re-validation against the freshly-read list is unchanged),
and an over-long id MUST NOT reach the pipeline (refusal reasons and stderr
logs embed the id, so the boundary cap bounds every echo).

#### Scenario: /ask refuses an over-long entity_id like /dsh/ask does

- **WHEN** `/ask` receives a body with `entity_id` of 141+ characters
- **THEN** the response is HTTP 400 with `ok:false` and code
  `DSH_GATEWAY_BAD_REQUEST` — identical to `/dsh/ask`'s refusal — and no
  pipeline answer is produced

#### Scenario: a 140-char id behaves exactly as before on both routes

- **WHEN** a client sends an `entity_id` of exactly 140 characters that the
  freshly-read list does not hold
- **THEN** both routes answer 200 with `ENTITY_PICK_STALE` (the id passed the
  boundary and is refused by re-validation, not by the cap) — no behaviour
  change for in-contract ids

## MODIFIED Requirements

### Requirement: Session context can remember every picker-backed entity kind

The session context TTL map MUST include a kind for every entity kind a picker
can offer (at least `customer`, `invoice`, `supplier`, `item`), and every `set()`
call site that attempts an entry which COULD be stored MUST check the returned
`ok` and log a warning when the write was refused (`CONTEXT_KIND_UNKNOWN` /
invalid provenance) — a silent drop is forbidden. A call site MUST NOT attempt
an entry that can never be stored (an id that is not a non-empty string):
attempting it produces a guaranteed refusal whose log line is noise, not
visibility. Context keys stay scoped by `principal + conversation_id`.

#### Scenario: a supplier context entry survives follow-up reads

- **WHEN** `set("supplier", {id: "SUP-HATIEN", provenance: "user_selected"})` is called within a
  scoped session
- **THEN** the entry is stored (ok:true) and `get("supplier")` returns it inside the TTL, expired
  entries still behave like a first mention

#### Scenario: a failed context write is visible, not silent

- **WHEN** a call site calls `set()` with a kind missing from the TTL map
- **THEN** the returned `{ok:false, code:"CONTEXT_KIND_UNKNOWN"}` is checked and logged, and the
  pipeline's answer is not silently assumed to have remembered the entity

#### Scenario: the inventory branch does not attempt a null-id context write

- **WHEN** an ambiguous-item question answers with picker chips (no pick yet)
- **THEN** the branch makes NO `set("item", …)` call until a pick has produced a
  real id, and the answer produces no `session context write refused` stderr
  line
