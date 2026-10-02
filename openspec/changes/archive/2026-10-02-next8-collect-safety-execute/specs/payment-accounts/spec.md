## ADDED Requirements

### Requirement: The account is re-derived at execute time, never read from the proposal

The executor MUST resolve the money account itself, from ERPNext, using the
direction, the customer's company and the method's channel — (1) the account the
proposal picked, validated to exist as a leaf of that company and to match the
channel's `account_type`; (2) the company's default for that channel;
(3) **BLOCK**. The account name carried in the proposal is an input to CHECK,
never an instruction to obey, and a wrong-typed account MUST NOT be substituted
by a fallback.

#### Scenario: a crafted proposal names the wrong ledger

- **WHEN** a cash collection arrives carrying the company's bank account
- **THEN** the answer is `ACCOUNT_TYPE_MISMATCH` and nothing is written

#### Scenario: the company declares no account for the channel

- **WHEN** neither the proposal nor the company default yields an account of the
  required type
- **THEN** the answer is `PAYMENT_ACCOUNT_UNRESOLVED` and nothing is written

### Requirement: One payment entry moves money on exactly one money account

The written document MUST carry one money account per side, taken from the
resolved account, with the receivable ledger on the other side for a collection.
A Mode of Payment MUST NOT be used as the source of an account.

#### Scenario: the sides are assigned from the direction

- **WHEN** a collection is written
- **THEN** `paid_from` is the invoice's receivable ledger and `paid_to` is the
  resolved money account, and the reverse holds for a pay-out
