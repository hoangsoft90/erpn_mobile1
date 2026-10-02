## ADDED Requirements

### Requirement: A "bán" sentence with a line becomes a sales-order proposal, not a read

A sentence that opens with the sell verb `bán` and names a party plus a line
(customer, quantity, item) MUST resolve to the `sales_order_write` group
(`sales_order.create`) and produce a draft Sales-Order PROPOSAL — never the READ
`sales` group. The routed-order path MUST take every id and every price from a
READ, and MUST refuse when a required slot (customer, item) is missing rather than
write a blind order. The canonical free-sale phrase `bán hàng cho <khách>` MUST
still open the Phase 6 sales screen (`sales_write` / `sales.create`), and a
QUESTION about what was sold MUST still resolve to a READ group.

#### Scenario: a sell command with a line routes to the order write

- **WHEN** the sentence is `Bán <khách> <qty> <item>` or `Bán cho <khách> <qty> <item>`
- **THEN** the router resolves `sales_order_write` / `sales_order.create`

#### Scenario: the free-sale screen is untouched

- **WHEN** the sentence is `bán hàng cho <khách>`
- **THEN** the router resolves `sales_write` / `sales.create` (the sales screen)

#### Scenario: a question is not a command

- **WHEN** the sentence is `bán được bao nhiêu hôm nay`
- **THEN** the router does NOT resolve a WRITE group

#### Scenario: a missing slot never writes

- **WHEN** a `bán` sentence has no resolvable customer (or no item)
- **THEN** no proposal is built (the pipeline refuses); nothing is written
