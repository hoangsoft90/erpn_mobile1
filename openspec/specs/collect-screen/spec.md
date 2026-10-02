# collect-screen Specification

## Purpose
Khả năng `collect-screen`: màn Thu tiền chỉ mở từ handoff do server cấp, KHÔNG tự chọn hoá đơn và KHÔNG tự đặt số tiền; một phương thức cho mỗi lần thu, tài khoản phải khớp loại phương thức, và chỉ một hành động xác nhận với tối đa một request đang chạy.

## Requirements

### Requirement: The collect screen opens only from a server-issued handoff

The collect screen MUST be opened from a `business_handoff` the server issued for
a collect capability, carried as route data. Without one the screen MUST refuse to
render a form and say so — it MUST NOT build a ticket, invent a customer, or fall
back to an empty form that could be mistaken for "nothing owed". A handoff the
server refuses (expired, foreign, already used) MUST end in a re-handoff prompt,
never in a submission of the old values.

#### Scenario: a routed collect sentence opens the form

- **WHEN** a chat answer carries a collect handoff
- **THEN** the screen opens with the customer and the slot states the ticket
  carried, and no invoice is selected

#### Scenario: no ticket, no form

- **WHEN** the route is reached without a handoff (a deep link, a stale route)
- **THEN** the screen shows a Vietnamese refusal telling the user to ask again in
  chat, and offers no way to submit

#### Scenario: a stale ticket cannot be submitted

- **WHEN** the confirm action is refused as stale
- **THEN** the screen shows the re-handoff copy, keeps no submission in flight,
  and does not resend the old values

### Requirement: The screen never chooses an invoice

The screen MUST NOT select, tick, pre-allocate or split an invoice on the user's
behalf: not the oldest, not the first, not the newest, not the nearest, not by
amount. Every allocated invoice MUST be one the user ticked, and the per-invoice
amount MUST start from the live outstanding the server returned and stay editable
within `0 < amount <= outstanding`.

#### Scenario: nothing is pre-selected

- **WHEN** the form opens for a customer with open invoices
- **THEN** every invoice row is unticked and the allocation total is zero

#### Scenario: a single total is not divided among invoices

- **WHEN** the user enters an amount without ticking any invoice while invoices
  are open
- **THEN** submission is blocked with a message asking them to tick the invoices
  to settle — the amount is never spread across rows

#### Scenario: an out-of-range amount is refused inline

- **WHEN** a row amount is zero, negative, or above that invoice's outstanding
- **THEN** the row shows a Vietnamese error and submission is blocked

#### Scenario: an amount above every invoice, with none open

- **WHEN** the customer has no open invoices and the user enters an amount
- **THEN** the form states the receipt is an advance with no invoice attached and
  allows the single confirm action

### Requirement: One payment method per collection

The screen MUST offer exactly one payment method per collection — cash **or**
bank transfer, never both, and with no control that adds a second one. The copy
"Mỗi lần thu một hình thức thanh toán." MUST be shown with the control. A user
wanting both MUST be told to collect twice.

#### Scenario: the method control holds one value

- **WHEN** the user switches between cash and bank transfer
- **THEN** exactly one method is selected, and no second method can be added

#### Scenario: the copy is present

- **WHEN** the method block is rendered
- **THEN** it carries "Mỗi lần thu một hình thức thanh toán."

### Requirement: A money account must match the payment method's type

The account offered MUST belong to the resolved company and match the selected
method's account type (cash method ⇒ a Cash account; bank transfer ⇒ a Bank
account). A default MUST come from the company's own defaults when the server
provides them. When no account of the required type resolves, submission MUST be
blocked with its own Vietnamese message — the screen MUST NOT fall back to a
different account type, and MUST NOT send an account the user did not choose in
place of one that could not be resolved.

#### Scenario: the account list follows the method

- **WHEN** the method is cash
- **THEN** only Cash-typed accounts of the company are offered

#### Scenario: a wrong-typed account is refused, not silently replaced

- **WHEN** the selected account does not match the method's account type
- **THEN** the screen blocks submission with its own message and does not
  substitute the company's default account

### Requirement: The screen never authors the amount

Amounts displayed as authoritative MUST come from the server: the per-invoice
outstanding and the summary totals. Client-side arithmetic MUST only ever be used
to compare against the server's numbers, never to decide what is written, and
submission MUST be blocked while the allocation total disagrees with the payment
total.

#### Scenario: a disagreeing total cannot be submitted

- **WHEN** the sum of the ticked allocations differs from the payment amount
- **THEN** the summary shows the disagreement and the confirm action is blocked

#### Scenario: the confirm action shows the server's own summary

- **WHEN** the confirm action succeeds
- **THEN** the rendered numbers are the ones the propose response carried, and the
  ordinary proposal card is shown for the final confirmation

### Requirement: Changing the customer clears what the old customer left

Selecting a different customer MUST clear the previously loaded invoices and every
allocation, and MUST discard a slower response for the previous customer so it
cannot repopulate the form. A customer with no open invoices MUST switch the form
to the advance copy rather than showing an empty list as if nothing were owed.

#### Scenario: the old list and allocations are gone

- **WHEN** the customer changes after invoices were ticked
- **THEN** the invoice list reloads for the new customer and every allocation is
  cleared

#### Scenario: a late response from the previous customer is ignored

- **WHEN** the previous customer's read resolves after the customer changed
- **THEN** the form does not adopt those rows

### Requirement: One confirm action, at most one request in flight

The screen MUST have a single confirm action. While a submission is in flight the
action MUST be disabled so a second tap sends nothing, and a refusal or an
unexpected error MUST leave the form usable with the server's Vietnamese reason
shown verbatim.

#### Scenario: a double tap sends one request

- **WHEN** the confirm action is tapped twice in a row
- **THEN** exactly one request is sent

#### Scenario: a refusal leaves the form usable

- **WHEN** the server refuses the submission (for example a stale ticket or a
  mismatched allocation)
- **THEN** the form shows the refusal reason, re-enables the action, and keeps the
  user's values
