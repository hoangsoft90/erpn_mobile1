# sales-draft Specification

## Purpose
Khả năng `sales-draft`: **server sở hữu MỌI con số** trên hoá đơn bán nháp — hai tầng chiết khấu (dòng vs đơn) tính riêng và KHÔNG gộp; giá bán đọc từ Single price list (một ca bán KHÔNG bao giờ lấy giá mua); chiết khấu dòng ghi bằng cặp (list rate, net rate); tồn kho chỉ là cảnh báo, không chặn im lặng; và câu bán trong chat mở màn Bán qua ticket do server cấp.

## Requirements

### Requirement: The server owns every number on a sales draft

A sales draft is a request, never an authority: the client sends `handoff_id` + the current form
values (`customer_id`, `warehouse_id`, `items[]`, `order_discount`, `payment_methods[]`) and the
server re-reads ERPNext to resolve the customer, each item's `uom`/price and the company's
accounts before it computes anything. Prices come from ERPNext price lists (`Item Price` for the
resolved `price_list`); when no price exists the server MUST ask instead of assuming zero, and it
MUST NOT fall back to `Item.standard_rate`. The totals the client displays are a preview; the
`grand_total` ERPNext returns after creation is the final number.

#### Scenario: a line price that ERPNext does not know

- **WHEN** a line's item has no `Item Price` for the resolved price list and uom
- **THEN** the proposal asks for the price (`MISSING_REQUIRED_FIELD`/ask), and no zero-priced
  line is ever written

#### Scenario: the client sends a total

- **WHEN** the client sends its own `grand_total`/`subtotal`
- **THEN** those values are ignored and the server's own computation is used

### Requirement: The two discount layers are computed separately and never merged

Line discount and order discount MUST stay two separate computations over two separate fields:
`line_net = qty × unit_price − line_discount` per line, then `subtotal = Σ line_net`, then
`grand_total = subtotal − order_discount`. No function may fold one layer into the other, and the
draft carries them as distinct values. Outstanding credit is a BALANCE
(`credit = grand_total − actual_paid`), never a payment method that "receives" money.

#### Scenario: both layers on one invoice

- **WHEN** a draft has a line discount and an order discount
- **THEN** the line's own net shows only the line discount, the order discount is applied once on
  the subtotal, and the two values are still reported separately in the summary

#### Scenario: credit is not modelled as money received

- **WHEN** the customer pays less than the grand total
- **THEN** the remainder is reported as outstanding credit (a balance) and never as a payment
  method, account or cash movement

### Requirement: Stock is a warning the seller sees, never a silent block

The server MAY read the current stock of each chosen item in the chosen warehouse (`Bin`,
read-only) and report it, but it MUST NOT block the sale, reduce the quantity, substitute a
warehouse or pick a batch/FIFO layer on its own. Blocking on stock would be a hard constraint and
is out of scope until the owner asks for it explicitly.

#### Scenario: an item short of stock

- **WHEN** a line's quantity exceeds what the warehouse shows
- **THEN** the draft still builds and the result states the available quantity as a warning

#### Scenario: no warehouse chosen

- **WHEN** the draft has no warehouse
- **THEN** the server uses the configured default warehouse (`COPILOT_DEFAULT_WAREHOUSE`) and
  reports which one it used, instead of refusing or choosing silently per line

### Requirement: The selling price list is read from the Single document, and a sale never takes a buying price

`Selling Settings` is a **Single** document: on the live site the LIST read answers HTTP 500 and
only the document read works, so the selling price list MUST be resolved through the document read
(after the customer's own default price list). The `Item Price` read for a sale MUST be restricted
to SELLING rows, because the site keeps buying and selling prices in the same table and a sale must
never be priced from the shop's own cost. When no selling price matches the line's item/uom, the
draft MUST ask instead of falling back to whatever row happens to come first.

#### Scenario: the site cannot answer the list read for the price list

- **WHEN** the deployment's `Selling Settings` is only readable as a document
- **THEN** the selling price list is still resolved and used, and it is reported on the proposal

#### Scenario: only a buying price exists for an item

- **WHEN** an item has an `Item Price` row on a buying price list and none on the selling side
- **THEN** the draft asks for the price instead of using the buying rate

### Requirement: A line discount is written as the pair (list rate, net rate)

ERPNext derives a line's `discount_amount` from the two rates it is given
(`discount_amount = price_list_rate × qty − rate × qty`), so a line discount MUST be written as
`price_list_rate` = the resolved list rate together with `rate` = the net rate after that line's
discount; sending a child `discount_amount` directly is not persisted. The read-back MUST verify
both rates and the derived discount, and the order-level discount MUST stay on the parent document
only.

#### Scenario: a line carries a discount

- **WHEN** a line with a line discount is written
- **THEN** the document shows the list rate in `price_list_rate`, the net rate in `rate`, and the
  site's derived `discount_amount` equal to the line discount

#### Scenario: the write does not persist the line discount

- **WHEN** the document read back does not show the line discount that was proposed
- **THEN** the write is reported as unverified instead of being reported as done

### Requirement: A sale sentence in chat opens the sales screen with a ticket

The chat is the ONLY producer of the sales ticket. A sentence routed to `sales.create` MUST answer
with a stored `business_handoff` whose `screen` is `sales` and whose capability is `sales.create`,
with the customer — the one slot a sentence can carry — resolved in the prefill and every other
slot (`items`, `order_discount`, `payment_methods`) left MISSING. Chat MUST NOT propose a freely
composed sale (`proposal: null`): lines, prices and discounts live on the screen, which re-resolves
them against ERPNext at propose time. No number ever enters the ticket. A sales QUESTION ("bán được
bao nhiêu…") MUST keep routing to the read group and emit no ticket.

#### Scenario: a routed sale sentence reaches the sales screen

- **WHEN** a sentence routed to `sales.create` resolves a customer
- **THEN** the answer carries a stored ticket for the sales screen with the customer resolved, the
  other slots MISSING, and `proposal` null

#### Scenario: a sales question does not open the sales screen

- **WHEN** the sentence is a question about sales (amounts, history, status)
- **THEN** no ticket is issued and the read group answers as before

### Requirement: Each propose door serves only its own screen's capability

`/sales/propose` and `/collect/propose` are twins: each MUST refuse a ticket whose own capability
opens a DIFFERENT screen with the same single `STALE_HANDOFF` answer (status 409, no proposal, no
probing which tickets are alive) — the capability travels WITH the ticket, never from the request
body. This keeps a collect ticket from building a sale and a sales ticket from building a
collection against the wrong screen's data.

#### Scenario: a sales ticket is posted to the collect door

- **WHEN** `/collect/propose` receives a ticket whose capability maps to the sales screen
- **THEN** it is refused with `STALE_HANDOFF` and no proposal

#### Scenario: a collect ticket is posted to the sales door

- **WHEN** `/sales/propose` receives a ticket whose capability maps to the collect screen
- **THEN** it is refused with `STALE_HANDOFF` and no proposal
