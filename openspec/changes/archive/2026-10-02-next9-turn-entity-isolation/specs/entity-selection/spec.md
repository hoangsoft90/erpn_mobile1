## ADDED Requirements

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
