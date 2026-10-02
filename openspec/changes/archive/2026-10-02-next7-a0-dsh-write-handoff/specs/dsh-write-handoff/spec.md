## Purpose

Record how the opt-in AI mode ("Phân tích bằng AI") handles a WRITE question, now that it stops
refusing them. The AI runtime stays read-only and is never asked to write; the sentence is handed to
the deterministic pipeline, which produces the ordinary proposal that still needs its own
`[Xác nhận]`. Nothing here can create a document.

There is no `dsh-write-handoff` spec under `openspec/specs/` yet (no change has been archived), so the
requirements below are ADDED here.

## ADDED Requirements

### Requirement: A WRITE question in AI mode is handed off, not refused

When a question asked on the explicit AI route routes to a HANDOFF-ABLE WRITE capability, the server
MUST answer it through the same deterministic pipeline the ordinary question route uses
(`answerQuestion`), and MUST NOT refuse it with `DSH_WRITE_BLOCKED`. The AI runtime MUST NOT be
started for that question.

The set of handoff-able capabilities MUST be declared explicitly, one capability id at a time. A
capability MUST NOT become handoff-able as a side effect of being write-shaped.

#### Scenario: a complete payment sentence produces a proposal

- **WHEN** the shopkeeper asks "thu tiền chị Lan một triệu" on the AI route, and the customer resolves
  to exactly one id, and the amount is present
- **THEN** the response carries the same proposal the ordinary question route would return, marked as
  a handoff, with the ERP target the answer came from — and no AI runtime was started

#### Scenario: a missing slot is a clarification, not a half-filled card

- **WHEN** the same question names no amount ("thu tiền chị Lan")
- **THEN** the answer is the pipeline's clarification, and no complete proposal is offered

#### Scenario: the set is explicit, not inferred

- **WHEN** a question routes to a WRITE capability that is NOT declared handoff-able
- **THEN** it is NOT handed off — it keeps the behaviour it had before this change

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
