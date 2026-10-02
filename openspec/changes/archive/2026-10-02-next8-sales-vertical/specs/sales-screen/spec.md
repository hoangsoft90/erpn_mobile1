## ADDED Requirements

### Requirement: The sales screen collects the four blocks and owns no money authority

The screen MUST present four blocks — customer, goods (item/uom/quantity/price/line discount),
discount (order level, visibly separate from the line level) and collect/total — and MUST send
only the form values plus the handoff it was opened with. It MUST NOT compute the totals it
displays as authority, and MUST NOT parse money itself (the server parses Vietnamese amounts).

#### Scenario: the seller edits the totals

- **WHEN** the seller changes a quantity or discount
- **THEN** the screen re-requests the numbers from the server and shows what the server returns

#### Scenario: the screen is opened without a handoff

- **WHEN** the route is opened with no `handoffId`
- **THEN** the screen refuses in Vietnamese instead of inventing a handoff or an empty sale

### Requirement: Changing customer or warehouse discards the other party's data

Changing the customer or the warehouse MUST reset the lines and the money already typed, so two
customers' data can never be mixed in one draft. Stale responses MUST be discarded (epoch guard),
and the state MUST live in a Riverpod controller, not in widget state.

#### Scenario: the seller switches customer mid-entry

- **WHEN** the customer is changed after lines were entered
- **THEN** the lines and the collection are cleared before the new customer is used

#### Scenario: a slow answer arrives after the input changed

- **WHEN** a response for an earlier input arrives after the input was changed
- **THEN** it is ignored and does not overwrite the current draft
