## ADDED Requirements

### Requirement: The Mode of Payment is chosen by the method's channel, not by its name

Resolving a money method MUST select a Mode of Payment whose ERPNext `type`
matches the request's channel: a bank intent resolves a `Bank`-typed Mode of
Payment and a cash intent a `Cash`-typed one. The requested LABEL remains the
source of the channel; it MUST NOT be used to pick a `type` that contradicts it.
The money ACCOUNT is still chosen by lock §6.2 from the channel's
`account_type` — a bank channel resolves the company's bank default and NEVER a
cash ledger such as `1110` — and a wrong-typed account still BLOCKs instead of
substituting.

#### Scenario: a bank intent cannot land on a cash method

- **WHEN** a collection is requested with a bank channel
- **THEN** the resolved `mode_of_payment` is a `Bank`-typed Mode of Payment and
  `paid_to` is the company's bank account

#### Scenario: a cash intent cannot land on a bank method

- **WHEN** a collection is requested with a cash channel
- **THEN** the resolved `mode_of_payment` is a `Cash`-typed Mode of Payment and
  `paid_to` is the company's cash account

### Requirement: A label that contradicts its own type is surfaced, never silently renamed

When a Mode of Payment whose name matches the requested label exists but its
`type` contradicts the request's channel, the result MUST say so in Vietnamese,
naming the mismatch, instead of silently substituting a differently-named method.
Where the contradiction would place the money in the wrong `account_type`, the
write MUST be refused with the existing refusal vocabulary. No new silent
substitution is introduced, and `mode_substituted_from` is reported only when the
written `mode_of_payment` genuinely differs from the requested one.

#### Scenario: the shop's "Chuyển khoản" method is declared as cash

- **WHEN** a bank collection is requested and the site's MoP named "Chuyển khoản"
  carries `type = Cash`
- **THEN** the receipt is not silently labelled with a mismatching method, and
  the result names the conflict in Vietnamese so an operator can correct the
  site's method type

### Requirement: The method actually written is shown on the draft result

The client MUST display the Mode of Payment that ERPNext actually stores on the
draft receipt, and MUST repeat the Vietnamese conflict warning verbatim when the
server reports one. Showing neither would leave the seller believing the shop's own
method name was used when another method of the same channel was written instead —
the warning the API already produces is not an answer by itself.

#### Scenario: a channel token resolves to a differently-named method

- **WHEN** a bank collection writes a draft whose `mode_of_payment` is
  `Wire Transfer`
- **THEN** the draft line names `phương thức ghi: "Wire Transfer"`

#### Scenario: the site's method name contradicted its type

- **WHEN** the server returns `mode_warning` saying the site's "Chuyển khoản"
  method is declared cash
- **THEN** that warning text is shown on the draft line, never swallowed

#### Scenario: no submit step reported

- **WHEN** the server sends no `mode_of_payment` at all
- **THEN** the draft line claims no method instead of inventing one

### Requirement: A method whose NAME reads like the other channel is surfaced too

The Mode of Payment is chosen by the method's `type` and that choice MUST NOT
change because of a naming oddity. But when the CHOSEN method's name reads like
the channel OPPOSITE to the one it is being used for — the mirror of the
"Chuyển khoản is declared Cash" case — the result MUST still say so in
Vietnamese, naming the method, the `type` ERPNext declares for it and the form
the receipt is actually written under. A conflict already reported MUST NOT be
replaced by this weaker, second one. A chosen method whose name matches the form
it is used for stays silent.

#### Scenario: a bank receipt lands on a method named "Cash"

- **WHEN** a bank collection selects a `Bank`-typed Mode of Payment whose name is
  "Cash"
- **THEN** `paid_to` is still the company's bank account, the choice is not
  changed, and the result warns that the method's NAME reads like cash while
  ERPNext types it Bank

#### Scenario: the mirror case, a cash receipt on a bank-named method

- **WHEN** a cash collection selects a `Cash`-typed Mode of Payment whose name
  reads like a transfer
- **THEN** `paid_to` is still the company's cash account and the warning names
  the bank-like name

#### Scenario: a matching name adds nothing

- **WHEN** a bank collection selects the site's `Wire Transfer` (`type = Bank`)
- **THEN** no warning is produced at all
