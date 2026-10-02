# purchase-screen Specification

## Purpose
Khả năng `purchase-screen`: màn Mua gồm bốn khối — nhà cung cấp, hàng hoá (item/uom/số lượng/giá mua), thanh toán & công nợ, và tổng — và KHÔNG sở hữu thẩm quyền tiền: không tự tính tổng, không tự parse số. Đổi NCC hoặc kho thì xoá dữ liệu của đối tác cũ; màn tái dùng widget của Sales thay vì fork.

## Requirements

### Requirement: The purchase screen collects the four blocks and owns no money authority

The screen MUST present four blocks — supplier, goods (item/uom/quantity/buying price), payment and
payable, and total — and MUST send only the form values plus the handoff it was opened with. It MUST
NOT compute the totals it displays as authority, and MUST NOT parse money itself (the server parses
Vietnamese amounts). It MUST show the payable as \"đã trả / còn nợ NCC\" and MUST NOT call the
remaining balance a \"credit method\".

#### Scenario: the owner edits a quantity

- **WHEN** the owner changes a quantity
- **THEN** the screen re-requests the numbers from the server and shows what the server returns

#### Scenario: the screen is opened without a handoff

- **WHEN** the route is opened with no `handoffId`
- **THEN** the screen refuses in Vietnamese instead of inventing a handoff or an empty purchase

### Requirement: Changing supplier or warehouse discards the other party's data

Changing the supplier or the warehouse MUST reset the lines and the money already typed, so two
suppliers' data can never be mixed in one draft. Stale responses MUST be discarded (epoch guard),
and the state MUST live in a Riverpod controller, not in widget state.

#### Scenario: the owner switches supplier mid-entry

- **WHEN** the supplier is changed after lines were entered
- **THEN** the lines and the payment are cleared before the new supplier is used

#### Scenario: a slow answer arrives after the input changed

- **WHEN** a response for an earlier input arrives after the input was changed
- **THEN** it is ignored and does not overwrite the current draft

### Requirement: The screen reuses the sales widgets rather than forking them

The screen MUST reuse the existing `item_line_editor`, `sales_summary`, `PaymentMethodSection`,
`entity_picker` and `proposal_card` widgets, parameterised for the purchase direction where needed,
instead of creating a second copy of any of them. It MUST NOT duplicate the money-parsing or
summary logic in Dart.

#### Scenario: a shared widget is needed

- **WHEN** the purchase screen needs a line editor or a total summary
- **THEN** it renders the shared widget from the sales feature with purchase parameters, not a new
  widget
