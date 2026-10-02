## ADDED Requirements

### Requirement: A money account is resolved in one order, and never guessed

Resolving the account money moves into or out of MUST follow exactly this order:
(1) the account the user chose, when it exists, belongs to the resolved company
and its `account_type` matches the chosen method; (2) otherwise the company's own
default for that channel (`default_cash_account` for cash,
`default_bank_account` for bank transfer) when that default is a leaf of the
matching type; (3) otherwise **BLOCK** with `PAYMENT_ACCOUNT_UNRESOLVED`. The
Mode of Payment rows MUST NOT be used as an account source, because a site's
mode rows carry no usable account for the company (measured on the shop's own
site: cash `1110`, bank `1210`).

#### Scenario: the user's account wins when it is valid

- **WHEN** the request names a bank account of the resolved company and the
  method is a bank transfer
- **THEN** that account is used, and no default is consulted

#### Scenario: no account can be resolved

- **WHEN** neither the chosen account nor a matching company default exists
- **THEN** the answer is `PAYMENT_ACCOUNT_UNRESOLVED` with Vietnamese copy, and
  no proposal is built

### Requirement: A wrong-typed account is refused, never substituted

An account whose `account_type` does not match the method MUST be refused with
`ACCOUNT_TYPE_MISMATCH`. The server MUST NOT substitute an account of the other
channel: a bank intent MUST NOT silently post into the cash ledger, and a cash
intent MUST NOT post into the bank ledger. In particular the "company's first
Cash-type ledger account" fallback MUST NOT exist as a way to satisfy a
bank-transfer intent.

#### Scenario: bank intent against a cash account

- **WHEN** the request names the cash ledger while the method is a bank transfer
- **THEN** the answer is `ACCOUNT_TYPE_MISMATCH` naming both, and nothing is
  proposed — the request is not quietly rewritten to a valid cash collection

#### Scenario: cash intent with no explicit account

- **WHEN** the method is cash and no account was chosen
- **THEN** only the company's cash default may be used; a Cash-type account that
  is merely the first one found is not acceptable

### Requirement: The account must belong to the resolved company

An account of another company MUST be refused, and a request that names a
company the principal may not operate on MUST be refused as denied. When no
company can be resolved for a money document, the answer MUST be
`COMPANY_SCOPE_REQUIRED` rather than an account chosen from every company on the
site.

#### Scenario: an account from another company

- **WHEN** the chosen account belongs to a different company than the invoice's
- **THEN** the answer is `ACCOUNT_TYPE_MISMATCH` / `COMPANY_SCOPE_REQUIRED` with
  copy that says which company was expected, and nothing is proposed

#### Scenario: the same rule applies to the invoice's own ledger account

- **WHEN** the anchor invoice's receivable/payable account is read
- **THEN** it comes from the document itself and is used as-is, so the party
  ledger can never be replaced by a same-typed account of another company
