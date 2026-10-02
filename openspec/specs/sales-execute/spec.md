# sales-execute Specification

## Purpose
Khả năng `sales-execute`: một lần ghi Bán thi hành qua cửa `/execute` DUY NHẤT và chỉ tạo NHÁP; ghi xong phải đọc lại để verify; xác nhận lặp lại cùng một lệnh không được tạo hoá đơn thứ hai (idempotent).

## Requirements

### Requirement: A sales write goes through the one existing execute door and only creates a draft

Confirming a sales proposal MUST go through the same safety-gateway `/execute` used by every other
write — the executor is reachable by no other path — and MUST create the Sales Invoice as a
**draft** (`docstatus 0`). Submitting invoices or receipts is a separate, later decision (Phase 9)
and MUST NOT be reachable from this path.

#### Scenario: a confirmed sale

- **WHEN** the seller confirms the sales proposal
- **THEN** exactly one draft Sales Invoice exists afterwards, with `docstatus = 0`, and no submit
  happens anywhere in the flow

#### Scenario: a write attempted outside the door

- **WHEN** the codebase is scanned for a way to create a sales invoice
- **THEN** the only executor registration for the sales capability is the safety-gateway table

### Requirement: What was written is verified by reading it back

After creation the server MUST read the document back and verify the fields that carry meaning:
company, customer, warehouse, every item line (code, uom, quantity, rate, line discount), the two
discount layers kept apart, the totals ERPNext computed (`grand_total`, `outstanding_amount`),
the sales taxes template, and the correlation (`custom_ai_action_id`/`reference_no`) matching the
action and command ids. A mismatch MUST be reported as a written-but-unverified document, never as
success.

#### Scenario: ERPNext computes a different grand total

- **WHEN** the totals read back differ from the computed proposal (e.g. site taxes)
- **THEN** the result reports the document as written but unverified, naming the difference

### Requirement: Repeating the same confirmation cannot create a second invoice

Confirming the same command twice MUST yield one invoice: the second confirmation replays the
stored result instead of writing again, and a repeated business key MUST be refused with the
existing duplicate-action refusal.

#### Scenario: double confirmation

- **WHEN** the same command is confirmed twice
- **THEN** exactly one Sales Invoice exists and the second answer is the replayed first result
