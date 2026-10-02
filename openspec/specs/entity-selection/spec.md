# entity-selection Specification

## Purpose
Khả năng `entity-selection`: chọn/khẳng định một thực thể (khách, NCC, item…) khi tên mơ hồ hoặc khi client gửi lại một `entity_id`. Trọng tâm là từ chối ĐÚNG BẢN CHẤT — id lệch loại (`ENTITY_PICK_WRONG_KIND`) khác với id đã cũ (stale) — để vòng chọn không lặp vô hạn và không gán nhầm đối tác. Spec này còn được các change `next8-entity-selection-loop`/`d3`/`d4` và `next9-turn-entity-isolation` bồi đắp.

## Requirements

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

### Requirement: A picker selection resumes by id and never re-searches

When the user picks a candidate from an entity picker, the server MUST resume the interrupted
request using the picked entity id (re-validated server-side), and MUST NOT re-run intent
classification and entity search on the original sentence for that party in a way that re-offers
the same picker. The invariant: after a selection for entity kind K, the next response about the
same question MUST NOT be another picker for kind K.

#### Scenario: supplier selection terminates the loop

- **WHEN** a supplier question returned `AMBIGUOUS_SUPPLIER` with candidates
  `[{id: "SUP-HATIEN", …}, {id: "SUP-HATIEN-2", …}]`, and the client re-sends the SAME sentence with
  `entity_id: "SUP-HATIEN"`
- **THEN** the response resolves that supplier (detail answer + `read_supplier` read proposal) and
  carries NO candidates — it MUST NOT equal the previous ambiguous response

#### Scenario: an id that is not in the list just read is a hint, never authority

- **WHEN** the client sends `entity_id: "SUP-99999"` (not present in the supplier list the server
  just read from ERPNext)
- **THEN** the refusal stands with the same error_code/candidates the ambiguous state produced, and
  the server logs the refused id server-side

> next8/D2 refinement: the STALE reading below replaces this scenario's "same error_code" — the
> entity may have been DELETED between the picker and the tap, so the refusal now says THAT
> (`ENTITY_PICK_STALE` + its own copy) instead of repeating the ambiguous picker verbatim.

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

### Requirement: AI mode passes the pick id without widening its input surface

The AI route (`/dsh/ask`) handoff MAY carry a picked entity id to the deterministic pipeline when
the client just completed a picker interaction. The route's other input rules are unchanged:
`submit_now` MUST NOT be accepted, and the AI runtime MUST NOT be started for the question.

#### Scenario: a picker tap inside AI mode reaches the pipeline

- **WHEN** the app re-sends the question on the AI route with the picked id after a handoff picker
- **THEN** the handoff call includes `pickedEntityId`, and the pipeline answer is the same detail /
  proposal the ordinary chat route would produce

### Requirement: A pending picker can be bailed out by a bare exit word (D2)

While a picker is pending, a BARE exit word — `hủy`/`huỷ`, `thoát`, `bỏ qua` (accent/case-insensitive
after folding, no other words) — is an ACTION on the conversation: the server MUST clear the pending
selection for that principal+conversation and answer `PICKER_BAILOUT` with its own Vietnamese copy,
no candidates and no proposal. The word MUST NOT be re-classified into the old intent (measured: a
bare `hủy` routed `document_delete` and answered `FORBIDDEN_IN_AI_PATH` — a deletion refusal for a
word that only wants to leave a menu) and MUST NOT re-run the old entity search. A sentence that
merely CONTAINS the word (`"hủy đơn A"`) keeps its normal routing.

#### Scenario: bare "hủy" after an ambiguous supplier question abandons the wait

- **WHEN** a supplier question returned `AMBIGUOUS_SUPPLIER` with candidates, and the next message is
  the bare word `hủy` (or `thoát` / `bỏ qua`)
- **THEN** the response is `PICKER_BAILOUT` with `candidates: []`, `proposal: null` and its own copy —
  never `AMBIGUOUS_SUPPLIER` again, never `FORBIDDEN_IN_AI_PATH`

### Requirement: The picker is bounded and names its overflow (D2)

The picker MUST offer at most 10 chips. When an ambiguous name matches MORE rows than the limit, the
response carries `picker_total` (the TRUE match count, counted before the window) and `picker_more`
(how many are not shown), and the reason names the overflow ("Còn X kết quả — gõ tên cụ thể hơn").
With no overflow the fields stay absent (byte-compatible with pre-D2 responses).

#### Scenario: 12 matching suppliers show 10 chips and say what is left

- **WHEN** the master list holds 12 suppliers matching the spoken name
- **THEN** `candidates` holds exactly 10 chips, `picker_total` is 12, `picker_more` is 2, and the
  reason contains "Còn 2 kết quả"

### Requirement: A stale pick is refused with its own reading, never a loop (D2)

When the client sends an `entity_id` that is NOT in the freshly-read list (the entity was deleted or
renamed between the picker and the tap), the response MUST be `ENTITY_PICK_STALE` with Vietnamese copy
telling the user to pick again from the fresh list, and the FRESH picker MUST stand (`candidates`
from the list just read). Never a wrong entity, never an endless re-offer of the dead pick.

#### Scenario: a picked id that vanished from the list

- **WHEN** the client re-sends the ambiguous sentence with `entity_id: "SUP-DELETED"` and the fresh
  supplier list does not contain that id
- **THEN** the response is `ENTITY_PICK_STALE` with the stale copy, the fresh candidates stand, and
  `supplier` stays null

### Requirement: Cards carry the id plus at most one distinguishing master field (D2)

Picker chips and resolved detail answers MAY carry ONE distinguishing master field the ERP already
returned (supplier `tax_id` / MST) — absent-honest when the row has none (no invented values) — and
MUST carry nothing beyond id + that field. A resolved supplier answer names the field when present
(e.g. "MST 0300000002").

#### Scenario: the unique "đại lý" answer surfaces the MST

- **WHEN** the question resolves supplier `SUP-BINH-DUONG` whose master row carries
  `tax_id: "0300000002"`
- **THEN** the answer contains "MST 0300000002" and the `supplier` object carries `tax_id`; rows
  without a tax_id carry NO tax_id key anywhere (chips included)

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

### Requirement: The entity-selection acceptance table is executed, not asserted

Every case T1–T16 of plan_final_v3 §11 MUST map to an EXECUTED test (suite + test
name) or carry an explicit SKIP reason (the entity/path does not exist in the product —
e.g. no Invoice picker). A T-case claimed PASS without a runnable test or a skip
reason does not count toward the FIXED verdict. The H6 answer (CONFIRMED/REJECTED)
must cite executed evidence (suite output), and the no-regression claim for
next6/next7 must cite the suites that pin them.

#### Scenario: the final report's T-table rows point at evidence

- **WHEN** `.plan/next8/next8-final-result.md` is produced (plan §13 A–H)
- **THEN** every T1–T16 row names the suite + test that proves it (or SKIP + reason),
  the H6 row cites the session-context suite output, and the verdict is FIXED only
  when all rows resolve to executed evidence or justified skips

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

### Requirement: A WRITE binds only the party the sentence resolved

A write-producing answer MUST bind the party that THIS sentence resolved. A
remembered entity (session context, previously selected or previously resolved
customer) MUST NOT replace a party the current sentence resolved, and MUST NOT
be substituted when the current sentence resolved no party at all — in that case
the answer is the ordinary not-found refusal. The invariant is:

```
USER ASKED ENTITY X  →  RESOLVE X  →  FOUND X  →  USE X
USER ASKED ENTITY X  →  X NOT FOUND  →  not-found refusal (never another entity)
```

Reaching the WRITE builder means the resolution is EXACT_MATCH or a
user-picked row (a missing party and a fuzzy/ambiguous match are refused before
the builder), so the only reachable effect of a substitution is replacing a
correct, user-stated party with a different one. A remembered entity MUST NOT be
an authority for a WRITE — it is at most a convenience for READS.

#### Scenario: a remembered customer never replaces the customer the sentence named

- **WHEN** an earlier sentence resolves customer A (exactly, within the TTL), and
  the next sentence names customer B (also exact) in a write intent
- **THEN** the response's `customer`/proposal entity is B — no part of the answer
  names A, and no proposal is bound to A

#### Scenario: naming the remembered customer is unchanged

- **WHEN** the sentence names the remembered customer itself
- **THEN** the proposal is built for that customer exactly as before

#### Scenario: an absent customer is refused, not substituted

- **WHEN** a write sentence names a customer that does not exist in ERPNext,
  while a DIFFERENT customer is remembered
- **THEN** the answer carries no proposal and no bound party (a picker or a
  not-found refusal) — the remembered customer is never used

#### Scenario: a nameless write sentence is refused as before

- **WHEN** a write sentence names nobody (e.g. `"thu tiền 500000"`)
- **THEN** the answer is the ordinary not-found refusal, whether or not a
  customer is remembered (the remember-feature never rescued this sentence)

#### Scenario: clearing the remembered state changes nothing

- **WHEN** the same write sentence is asked with and without the in-memory
  session context
- **THEN** both answers resolve and bind the same party

### Requirement: An explicitly named entity always wins over remembered state

The invariant, stated once and pinned by its own test: a sentence that names an
entity MUST be answered about THAT entity's id. Remembered state (session
context) MUST NOT take precedence over an explicit name, and MUST NOT be the
reason a different id is bound.

#### Scenario: the named party is the bound party

- **WHEN** customer A is remembered and the sentence names customer B
- **THEN** the resolved id and the bound id are both B's id (asserted by id,
  never by display text alone)

### Requirement: An ambiguous match is never auto-picked or substituted

When the resolver reports more than one candidate for the named entity, the
answer MUST NOT select any of them: not the first, not the latest, not the
nearest, not the one carrying a debt, and not the one held in session context.
The response MUST be the ambiguity refusal, with the candidate list when the
contract provides one, and no proposal.

#### Scenario: two customers share a name

- **WHEN** two customers exist under the same name (or the resolver returns
  several candidates) and the sentence names that entity — with and without a
  DIFFERENT customer in session context
- **THEN** the entity resolution state is the ambiguous state, `proposal` is
  null, no party is bound, and every ambiguous id is offered as a candidate
  instead of being chosen

### Requirement: Remembered state never crosses entity types

Context recorded for one entity kind MUST NOT be consumed as, or overwrite, an
entity of another kind: a remembered customer MUST NOT be used to answer a
supplier/purchase request, and a remembered supplier MUST NOT be used to answer
a customer/sales request. Each request resolves against the master list of its
own kind.

#### Scenario: customer context while asking about a supplier

- **WHEN** a customer is remembered and the request resolves a supplier
- **THEN** the supplier id is bound (or the request is refused for its own
  reason) and the remembered customer is neither bound nor mentioned as the
  party

#### Scenario: supplier context while writing a customer document

- **WHEN** a supplier is remembered and a customer document sentence names a
  customer explicitly
- **THEN** the customer id is bound and the remembered supplier is not

### Requirement: The executed document binds the proposal's entity id

Execution MUST use the entity id the proposal was built with. Re-resolving the
proposal's display name at execute time is forbidden, because a name can resolve
to a different row later; a proposal without a resolved entity id MUST be
refused rather than executed.

#### Scenario: the executed party is the proposed party

- **WHEN** a proposal binds customer X and the user confirms it
- **THEN** the payload sent to ERPNext carries X's id (the display name is never
  the binding value)

#### Scenario: remembered state changing between ask and confirm cannot move the execute

- **WHEN** a proposal was built for X, and AFTERWARDS the remembered session
  state changes to a different entity Y (a new sentence resolved Y, or the store
  was cleared and re-seeded with Y), and the user then confirms the OLD proposal
- **THEN** the executed document is bound to X's id — Y is neither used nor
  mentioned, because execution reads the proposal, never the remembered state
