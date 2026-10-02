## ADDED Requirements

### Requirement: A buying sentence reaches the purchase order, not the sales order

A sentence that orders FROM a supplier — `đặt hàng <NCC> <qty> <item>` or the
normalized `đặt purchase từ <NCC> …` — MUST resolve to the `purchase_order_write`
group (`purchase_order.create`) and produce a draft Purchase-Order PROPOSAL. It MUST
NOT resolve to `sales_order_write`. Conversely, a sale-shaped sentence that uses
`cho` (`đặt hàng cho <khách> …`) MUST keep resolving to `sales_order_write`. The
party MUST still be re-resolved server-side against the SUPPLIER master for a
purchase route, so a name that is not a supplier is refused, never written.

#### Scenario: ordering from an NCC reaches the purchase order

- **WHEN** the sentence is `đặt hàng <NCC> <qty> <item>`
- **THEN** the router resolves `purchase_order_write` / `purchase_order.create`

#### Scenario: the normalized buying verb is recognized

- **WHEN** the sentence is `đặt purchase từ <NCC> <qty> <item>`
- **THEN** the router resolves `purchase_order_write` / `purchase_order.create`

#### Scenario: a sale-shaped order is not stolen

- **WHEN** the sentence is `đặt hàng cho <khách> <qty> <item>`
- **THEN** the router resolves `sales_order_write` / `sales_order.create`

#### Scenario: a question is not a command

- **WHEN** the sentence is `đặt hàng <NCC> bao nhiêu tiền`
- **THEN** the router does NOT resolve a purchase-order write
