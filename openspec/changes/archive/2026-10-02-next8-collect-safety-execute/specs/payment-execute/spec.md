## ADDED Requirements

### Requirement: Execution uses the proposal's ids and never re-resolves a name

`/execute` MUST write the document from the ids frozen in the proposal: the
customer id, the invoice ids in `params.allocations[]`, and the `command_id` /
`action_id` already stamped on it. The executor MUST NOT re-resolve a party, an
invoice or an account from a human-typed string, and MUST NOT fall back to
picking an invoice the user did not choose.

#### Scenario: the allocations are the user's

- **WHEN** a proposal arrives carrying two invoice ids in `params.allocations[]`
- **THEN** the written document has exactly those two reference rows, in that
  order, with no additional invoice discovered by the executor

#### Scenario: a foreign proposal cannot be re-pointed by a name

- **WHEN** a caller sends a proposal whose entity id does not belong to the
  invoice ids in it
- **THEN** the run is refused before any write, and nothing is created

### Requirement: Every allocation is re-bounded by a live read at execute time

Before writing, the executor MUST re-read each allocated invoice's live
outstanding (minus open drafts of the same company and direction) and MUST refuse
when the live number no longer covers the allocation. The snapshot inside the
proposal is not authority; it is audit data.

#### Scenario: the debt shrank after the card was built

- **WHEN** the live remainder is smaller than the allocated amount
- **THEN** the answer is `INSUFFICIENT_OUTSTANDING` (or `PROPOSAL_STALE`) with
  Vietnamese copy, and no document is created

#### Scenario: the invoice was paid in the meantime

- **WHEN** an allocated invoice has no live remainder left
- **THEN** the answer is `INVOICE_ALREADY_PAID` and no document is created

### Requirement: An entry's amount is the server's own sum

The written document MUST set `paid_amount` and `received_amount` to
`Σ allocated_amount + unallocated_amount`, and MUST write `unallocated_amount`
explicitly so ERPNext never infers the part not tied to a document
(`difference_amount` = 0). A caller-supplied total MUST NOT be able to move the
document's amount.

#### Scenario: partially allocated

- **WHEN** two invoices are allocated 300.000 and 200.000 and the payment is
  500.000
- **THEN** the document's `paid_amount` is 500.000 and `unallocated_amount` is 0

### Requirement: On-account is a shape, not a fallback

With an empty allocation list the entry MUST be written with no reference row and
`unallocated_amount` equal to the paid amount, and this shape MUST be legal
**only** when the customer has nothing open (lock §6.3). With at least one open
invoice the empty list MUST be refused.

#### Scenario: nothing open, money taken as an advance

- **WHEN** the customer has no open invoice and the payment is 1.000.000
- **THEN** the document has zero reference rows and `unallocated_amount` 1.000.000

#### Scenario: open invoice, nothing allocated

- **WHEN** the customer still has an open invoice and the allocation list is empty
- **THEN** the answer is a refusal with copy telling the user to choose an
  invoice, and nothing is written

### Requirement: Exactly one payment method per entry

A collection MUST be written as exactly ONE payment entry with exactly ONE
payment method (lock §6.1). A payload offering more than one method MUST be
refused before any write; splitting one collection into several entries is not
part of this capability.

#### Scenario: two methods in one confirmation

- **WHEN** a confirmation carries two payment methods
- **THEN** the answer is a refusal with its own code and Vietnamese copy, and no
  document is created

### Requirement: Verification reads the document back before reporting success

Success MUST be reported only after reading the written document back and
comparing every mapped field: `docstatus` (draft), `payment_type`, `party_type`,
`party`, `company`, `paid_from`, `paid_to`, `paid_amount`, `received_amount`,
`unallocated_amount`, the reference row count and each row's `allocated_amount`,
`reference_no`, and the correlation field equal to the proposal's action id. A
write response is not evidence.

#### Scenario: one field drifts

- **WHEN** the read-back shows any mapped field differing from what was sent
- **THEN** the answer is `PAYMENT_WRITE_UNVERIFIED`, the command is not reported
  as completed, and the case is reconcilable

#### Scenario: the correlation travels

- **WHEN** the document is read back after a successful write
- **THEN** its `reference_no` equals the command id and its correlation field
  equals the proposal's action id

### Requirement: One command id, one document

A repeated confirmation of the same `command_id` MUST replay the existing result
and MUST NOT create a second document; `reconcilePaymentEntry` MUST be able to
find the document by the command id alone. The idempotency store, the drift
fingerprint and the queue's actor attribution MUST keep their current contract.

#### Scenario: the user presses confirm twice

- **WHEN** the same command id is executed twice
- **THEN** the second answer reports a replay, and exactly one document exists

#### Scenario: the reply was lost

- **WHEN** a retry arrives for a command whose first attempt is unverified
- **THEN** the retry reconciles against ERPNext and reports the document's real
  `docstatus` without writing again

### Requirement: An unreachable ERPNext stays retryable

When ERPNext cannot be read or written mid-execute, the answer MUST be a
retryable failure that tells the caller to reuse the same command id, and the
command MUST be queued for the operator. No document may be reported as created
without a successful read-back.

#### Scenario: ERPNext goes down between the write and the read-back

- **WHEN** the create call cannot be confirmed
- **THEN** the caller is told to retry the same command id, the command stays
  reconcile-able, and the job appears in the queue with its original actor

### Requirement: The card says what will be written

The confirmation card's Vietnamese copy MUST name every invoice being settled,
the total, whether part of the money is left unallocated (on-account), any live
draft already covering one of the invoices, and that the entry is written as a
**NHÁP** (draft).

#### Scenario: a partially covered invoice

- **WHEN** one of the allocated invoices is already partly covered by an open draft
- **THEN** the card names that draft and states that the remaining amount is what
  will be allocated

#### Scenario: several invoices in one receipt

- **WHEN** the proposal settles two invoices
- **THEN** the card lists both invoice names and the total amount, not just the first

### Requirement: /execute remains the only write door

No module other than the safety gateway may call a Payment Entry write tool.
A static check over the skill and script sources MUST keep failing if a second
call path appears.

#### Scenario: a new call path appears

- **WHEN** any module outside the gateway calls the create/submit tool for
  Payment Entry
- **THEN** the static tripwire test fails
