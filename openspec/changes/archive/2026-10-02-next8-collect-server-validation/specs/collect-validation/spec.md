## ADDED Requirements

### Requirement: A collect proposal is built from a fresh read of the books

The server MUST re-read, on every `POST /collect/propose`, the customer, the
customer's open invoices **for the resolved company**, each invoice's live
`outstanding_amount`, the money account and the company. No client-supplied
amount, account or outstanding value may be used as authority: client values are
only inputs the server compares against its own read. When ERPNext cannot be
read, the proposal MUST fail closed with `ERP_UNAVAILABLE` — never answer with a
zero, an empty list or a proposal built from a cached number.

#### Scenario: the live outstanding is what the allocation is checked against

- **WHEN** a proposal is requested for an invoice whose submitted payments
  already reduced its outstanding
- **THEN** the allocation is checked and clamped against the live outstanding,
  not against the `outstanding_amount` snapshot carried by an older document

#### Scenario: an unreadable ledger is a refusal, not a zero

- **WHEN** the invoice read fails
- **THEN** the answer is `ERP_UNAVAILABLE` with Vietnamese copy and no proposal

### Requirement: The ticket, the party and the invoice must all still be valid

The proposal MUST verify, in this order, that (1) the ticket exists, belongs to
this principal and this conversation and is usable, (2) the capability is a
WRITE the principal is authorized for, (3) the customer id is present and exists
in the current master, and (4) every allocated invoice exists, is submitted
(`docstatus = 1`) and belongs to **that customer and that company**. Each
failure MUST return its own code and Vietnamese copy:
`STALE_HANDOFF` (409), authorization code (403), `MISSING_REQUIRED_FIELD` (400),
`NO_MATCH` for an unknown customer or an invoice that is not this customer's.

#### Scenario: an invoice of another customer is not allocatable

- **WHEN** an allocation names an invoice that belongs to a different customer
- **THEN** the proposal is refused as `NO_MATCH` and nothing is proposed

#### Scenario: a foreign or expired ticket leaks nothing

- **WHEN** the ticket is expired, or belongs to another principal or conversation
- **THEN** the answer is the same `STALE_HANDOFF` for all three cases

### Requirement: Allocation amounts are bounded by what is still owed

For every allocated invoice the server MUST require `0 < allocated ≤ live
outstanding`, and MUST reject the same invoice appearing twice. An invoice whose
live remainder is already zero after subtracting same-company open drafts MUST
be refused as already settled. Codes: `INVALID_AMOUNT`,
`INSUFFICIENT_OUTSTANDING`, `DUPLICATE_ALLOCATION`, `INVOICE_ALREADY_PAID`.

#### Scenario: allocating more than the remainder

- **WHEN** an allocation for an invoice exceeds its live remainder
- **THEN** the answer is `INSUFFICIENT_OUTSTANDING` naming the invoice and the
  remaining number

#### Scenario: a fully drafted invoice is not collectable twice

- **WHEN** the invoice's remainder is already covered by open draft payments of
  the same company and direction
- **THEN** the answer is `INVOICE_ALREADY_PAID` / draft-covered copy, and the
  user is told which drafts to submit or cancel

### Requirement: The allocation total and the payment total must agree

The server MUST verify that `Σ allocations == Σ payment_methods` whenever the
customer has open invoices, and that the draft carries **exactly one** payment
method (owner lock §6.1). With zero open invoices the only legal shape is an
empty allocation list plus `unallocated = paid` (an advance on the receivable
account). A client-claimed total MUST only be compared, never adopted; a
mismatch is refused with `ALLOCATION_TOTAL_MISMATCH`, a missing or extra method
with `PAYMENT_METHOD_COUNT_INVALID`, and a claimed total that disagrees with the
server's own arithmetic with `CLIENT_AUTHORITY_REJECTED`.

#### Scenario: two invoices, one payment method

- **WHEN** the draft allocates to two open invoices and names exactly one method
  whose amount equals the allocations' total
- **THEN** the server accepts the draft, and the proposal carries both
  allocations and that one method

#### Scenario: an advance with nothing open

- **WHEN** the customer has no open invoice and the draft carries an empty
  allocation list with an amount
- **THEN** the whole amount is `unallocated` and the proposal is legal

#### Scenario: a second payment method is refused server-side

- **WHEN** the draft carries two payment methods
- **THEN** the answer is `PAYMENT_METHOD_COUNT_INVALID` with the copy explaining
  that two channels mean two collections — even if a client skipped the UI

### Requirement: A multi-invoice collect is valid when the draft is valid

`POST /collect/propose` MUST NOT refuse a draft merely for allocating to more
than one invoice. The number of allocations is bounded by the draft's own
validity (each allocation in range, no duplicates, totals agreeing); the single
method limit of lock §6.1 remains. The proposal MUST then carry one
`params.allocations[]` entry per allocated invoice, with ids only.

#### Scenario: the screen's own two-invoice form succeeds

- **WHEN** a user ticks two open invoices, enters the matching total and picks
  one method
- **THEN** a proposal is returned (not a 422) carrying both allocations

#### Scenario: many allocations cannot smuggle a wrong sum

- **WHEN** three invoices are allocated but the method total matches only two
- **THEN** the answer is `ALLOCATION_TOTAL_MISMATCH` and no proposal is returned

### Requirement: The proposal carries ids, the one method and the server's summary

The returned proposal MUST be `erpn.proposal/v1` with `risk: HIGH`, an `entity`
naming the customer **by id**, `params` carrying `allocations[]` (ids),
`payment_methods` (exactly one, with the resolved account id), `total`,
`unallocated` when non-zero, `mode`, `posting_date` and `submit_now`, and `extra`
carrying `action_id`, `warnings` and `handoff_id`. The response MUST also carry
the server's own summary, so the screen can display a total it did not compute.

#### Scenario: the client cannot author the summary

- **WHEN** the proposal is returned
- **THEN** the totals come from the server's arithmetic, and `action_id` was
  generated server-side at build time

#### Scenario: the frozen day travels with the proposal

- **WHEN** the proposal is built
- **THEN** `posting_date` is part of the proposal, so a late confirm cannot
  silently move the receipt to the next day
