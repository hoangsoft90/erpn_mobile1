## Purpose

Record the rule that a candidate-picker selection is an ACTION that resumes the interrupted request
by entity id — never a fresh search. This spec exists because the current pipeline only consumes a
picked id on the customer path (`copilot-server.mjs` L1270); the supplier path re-classifies the
same sentence and re-offers the same picker (the measured loop). No spec exists under
`openspec/specs/` yet (no change has been archived), so the requirements below are ADDED here.

## ADDED Requirements

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

The session context TTL map MUST include a kind for every entity kind a picker can offer (at least
`customer`, `invoice`, `supplier`, `item`), and every `set()` call site MUST check the returned
`ok` and log a warning when a write was refused (`CONTEXT_KIND_UNKNOWN` / invalid provenance) — a
silent drop is forbidden. Context keys stay scoped by `principal + conversation_id`.

#### Scenario: a supplier context entry survives follow-up reads

- **WHEN** `set("supplier", {id: "SUP-HATIEN", provenance: "user_selected"})` is called within a
  scoped session
- **THEN** the entry is stored (ok:true) and `get("supplier")` returns it inside the TTL, expired
  entries still behave like a first mention

#### Scenario: a failed context write is visible, not silent

- **WHEN** a call site calls `set()` with a kind missing from the TTL map
- **THEN** the returned `{ok:false, code:"CONTEXT_KIND_UNKNOWN"}` is checked and logged, and the
  pipeline's answer is not silently assumed to have remembered the entity

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
