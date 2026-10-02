## ADDED Requirements

### Requirement: The main document of \"nhập hàng\" is a draft Purchase Invoice

A purchase started from the app MUST be written as a **Purchase Invoice** in `docstatus 0` (draft),
carrying `update_stock = 1` so one draft is both the supplier payable and the goods receipt — this
is the document the site's own purchases use (measured: 65 Purchase Invoices, of which 45 submitted,
with `credit_to = 2110` and `naming_series ACC-PINV-.YYYY.-`). Purchase Receipt and Purchase Order
are NOT used for this flow and their existing capabilities are not widened.

#### Scenario: a done purchase

- **WHEN** the owner confirms a purchase draft
- **THEN** exactly one Purchase Invoice draft is created, with `update_stock = 1`, and never a
  Purchase Receipt or Purchase Order for the same command

#### Scenario: a purchase receipt for a supplier is asked for

- **WHEN** any code path would create a Purchase Receipt for this flow
- **THEN** it does not exist — the receipt path is a separate capability and is never entered here

### Requirement: The purchase price is the BUYING price, never the selling price

Every line's unit price MUST come from ERPNext's `Item Price` on the **buying** side
(`buying = 1`) for the item's UOM, resolved through a price list taken from the supplier's own
default else the SINGLE `Buying Settings.buying_price_list`. The site keeps both sides on the same
`Item Price` table (measured: CAM-HEO-25KG is 295.000 Standard Buying vs 320.000 Standard Selling),
so a purchase priced without the buying filter would be priced at the shop's selling price. A line
with no buying price MUST be refused, never written with a zero or an invented rate, and
`Item.standard_rate` MUST NOT be used.

#### Scenario: a line the site has a buying price for

- **WHEN** the item has a Standard Buying price for the chosen UOM
- **THEN** the line is proposed at that buying rate

#### Scenario: a line with only a selling price

- **WHEN** the item has a Standard Selling price but no buying price for the UOM
- **THEN** the command is refused (no price for the purchase) and nothing is written

### Requirement: Only two payment modes exist — pay in full against a live invoice, or pay in advance

A supplier payment MUST be either (a) settling the **full** outstanding of a live Purchase Invoice
read at execute time, or (b) an **advance** with no invoice reference (`references = []`). This
phase ships mode (b) only; mode (a) is deferred to a later audited change. **Partial allocation by
supplier invoice is out of scope**: no oldest-first, no FIFO, no automatic invoice picking.

#### Scenario: paying in advance with a purchase

- **WHEN** the owner pays part of the total at purchase time
- **THEN** a separate Payment Entry advance with `references = []` and `unallocated_amount` equal to
  the amount paid is created, and the copy states the invoice is not settled yet

#### Scenario: a partial allocation by invoice is attempted

- **WHEN** any code path would split a payment across supplier invoices or pick an invoice by age
- **THEN** it does not exist — the only allocation the design knows is all-or-nothing on a live
  invoice, which is not part of this phase

### Requirement: Payable is a balance, not a payment mode

The amount owed to the supplier MUST be computed as `purchase_total − actual_paid` and treated as a
**balance**. It MUST NOT be modelled as a payment channel, a boolean, or an amount posted to an
account on its own.

#### Scenario: a purchase with no payment

- **WHEN** the owner records a purchase and pays nothing
- **THEN** the payable equals the whole purchase total and no payment document is written

#### Scenario: a partially paid purchase

- **WHEN** the owner pays part of the total
- **THEN** the payable equals `purchase_total − amount_paid`, as a number
