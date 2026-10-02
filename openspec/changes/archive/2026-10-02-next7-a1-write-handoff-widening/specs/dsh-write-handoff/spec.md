## Purpose

Record how the opt-in AI mode ("Phân tích bằng AI") handles a WRITE question, now that it stops
refusing them. The AI runtime stays read-only and is never asked to write; the sentence is handed to
the deterministic pipeline, which produces the ordinary proposal that still needs its own
`[Xác nhận]`. Nothing here can create a document.

This change widens the A0 delta: the handoff-able set grows from `{payment.create}` to every WIRED
write capability. The requirements below modify the two requirements A0 added.

## MODIFIED Requirements

### Requirement: A WRITE question in AI mode is handed off, not refused

When a question asked on the explicit AI route routes to a HANDOFF-ABLE WRITE capability, the server
MUST answer it through the same deterministic pipeline the ordinary question route uses
(`answerQuestion`), and MUST NOT refuse it with `DSH_WRITE_BLOCKED`. The AI runtime MUST NOT be
started for that question.

The set of handoff-able capabilities MUST be declared explicitly, one capability id at a time, and
MUST contain only capabilities the deterministic pipeline can actually answer (a wired
`answerQuestion` branch). A capability MUST NOT become handoff-able as a side effect of being
write-shaped. A capability the contract marks FORBIDDEN (`document.delete`) MUST never appear in
the set.

The handed-off answer MUST respect the pipeline's own entity and slot rules for EVERY handed-off
capability, not only payments: when the sentence names no party, the answer is the pipeline's
`MISSING_ENTITY` refusal; when the name matches several candidates, the answer carries the picker's
candidate list and no proposal; when a required slot (amount/item/qty) is missing, the answer is
the pipeline's clarification; only a resolved id with complete slots may produce a proposal.

#### Scenario: a complete non-payment sentence produces a proposal

- **WHEN** the shopkeeper asks "đặt hàng cho Nguyễn Thị Lan 2 bao cám heo" on the AI route, and the
  customer resolves to exactly one id, and the item/qty slots are present
- **THEN** the response carries the same order proposal the ordinary question route would return,
  marked as a handoff, with `entity.id` naming the resolved customer — and no AI runtime was started

#### Scenario: a complete payment sentence produces a proposal

- **WHEN** the shopkeeper asks "thu tiền chị Lan một triệu" on the AI route, and the customer resolves
  to exactly one id, and the amount is present
- **THEN** the response carries the same proposal the ordinary question route would return, marked as
  a handoff, with the ERP target the answer came from — and no AI runtime was started

#### Scenario: a missing slot is a clarification, not a half-filled card

- **WHEN** the same question names no amount ("thu tiền chị Lan")
- **THEN** the answer is the pipeline's clarification, and no complete proposal is offered

#### Scenario: a name that matches several candidates is a picker, not a proposal

- **WHEN** a handed-off write sentence names a party the master list resolves to several rows
- **THEN** the answer carries the pipeline's picker code (`ENTITY_PICK_REQUIRED`) and its candidate
  list, and no proposal is offered

#### Scenario: a sentence that names no party is a refusal, not a proposal

- **WHEN** a handed-off write sentence names no customer or supplier at all
- **THEN** the answer is the pipeline's `MISSING_ENTITY` refusal, and no proposal is offered

#### Scenario: the set is explicit, not inferred

- **WHEN** a question routes to a WRITE capability that is NOT declared handoff-able — including
  every capability the contract marks FORBIDDEN
- **THEN** it is NOT handed off — a forbidden capability keeps the pipeline's forbidden refusal,
  and no response on the AI route carries a `handoff` field for it

### Requirement: The handoff keeps every route-level safeguard the ordinary route has

A handoff MUST be metered exactly as the ordinary question route meters it: the read bucket before any
pipeline work, and the write-proposal bucket when the result carries a proposal. It MUST be bounded by
a server-side deadline. A handoff MUST NOT become a cheaper way to obtain a proposal than asking the
same thing on the ordinary route.

#### Scenario: proposal metering

- **WHEN** a handoff produces a proposal and the caller's write-proposal budget is exhausted
- **THEN** the handoff is rate-limited like any other proposal, and no proposal id reaches the client

#### Scenario: nothing is submitted by the handoff's own doing

- **WHEN** a handoff produces a payment proposal
- **THEN** the proposal's submit policy is the safe default (a DRAFT), because the AI route's request
  body carries no submit policy — the AI route's input surface is not widened to add one

### Requirement: The AI runtime never gains a write path

The handoff MUST NOT give the AI runtime any ability to write. The in-runtime refusal for WRITE
questions MUST remain in force, so a WRITE question that somehow reaches the runtime through its own
tool calls is still refused there. The handoff chooses a different path for the question; it never
loosens the runtime's own gate.

#### Scenario: a write question that reaches the runtime is still refused

- **WHEN** the AI runtime drives a WRITE question through its own tool call
- **THEN** it is refused with `DSH_WRITE_BLOCKED` exactly as before this change, and no proposal is
  produced there

#### Scenario: the ordinary route gains no AI branch

- **WHEN** the ordinary question route answers any question
- **THEN** it still never starts the AI runtime — the handoff is one-way
