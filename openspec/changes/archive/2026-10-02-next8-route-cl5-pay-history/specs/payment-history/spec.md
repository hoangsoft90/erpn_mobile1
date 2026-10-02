## ADDED Requirements

### Requirement: "Lịch sử thu" is a payment-history question

`Lịch sử thu của <Tên>` MUST resolve to the `payment` READ group
(`payment.history`) — money IN — exactly like its siblings `phiếu thu` and
`đã trả bao nhiêu`. The recognized phrase MUST be the two-word `lịch sử thu`, not
the bare verb `thu`, so unrelated sentences are untouched. The read MUST work for
both a customer and a supplier name.

#### Scenario: a customer's money-in history routes

- **WHEN** the sentence is `Lịch sử thu của <khách>`
- **THEN** the router resolves `payment` / `payment.history`

#### Scenario: a supplier's money-out history still routes

- **WHEN** the sentence is `Lịch sử chi tiền của <NCC>`
- **THEN** the router still resolves `payment` / `payment.history`
