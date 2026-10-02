## ADDED Requirements

### Requirement: A money-history read uses the ledger of the party's own master

When `/ask` answers a money-history question (`Lịch sử chi tiền của <NCC>`,
`Lịch sử thu của <khách>`), the read MUST pass the party TYPE that matches the
party's master — `Supplier` for a supplier, `Customer` for a customer. It MUST NOT
fall back to `Customer` for a supplier: the real server rejects the mismatch, which
is the audit's HTTP 500. The direction MUST still be derived from which master
holds the party, never from the sentence.

#### Scenario: a supplier history uses the supplier ledger

- **WHEN** the question names a supplier (`Lịch sử chi tiền của <NCC>`)
- **THEN** the read is made with `party_type = Supplier` and never 5xx

#### Scenario: a customer history uses the customer ledger

- **WHEN** the question names a customer (`Lịch sử thu của <khách>`)
- **THEN** the read is made with `party_type = Customer`

#### Scenario: the mock mirrors the real server

- **WHEN** a test calls the mock's payment-entry list with a party_type that does
  not match the party's master
- **THEN** the mock errors (its realserver returns a failure, not an empty list),
  so a regression is observable
