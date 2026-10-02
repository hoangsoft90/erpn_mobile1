# payment-references Specification

## Purpose
Khả năng `payment-references`: Payment Entry mang MỘT dòng `references[]` cho mỗi phân bổ (anchor doctype, tên hoá đơn, tổng hoá đơn, số phân bổ), với mọi số phân bổ là số LIVE đọc lại. Đường collect KHÔNG tự chọn hoá đơn cho người dùng — cấm FIFO/oldest/tự chia theo số nói.

## Requirements

### Requirement: A payment entry carries one reference row per allocation

The payment-entry builder MUST accept a list of references and emit one
`references[]` row per allocation, each carrying the anchor doctype, the invoice
name, the invoice total and the allocated amount. The document's `paid_amount`
and `received_amount` MUST equal `Σ allocated + unallocated`. `unallocated_amount`
MUST be written explicitly so ERPNext never has to infer the part that is not
tied to a document (plan §9), and `difference_amount` MUST come out zero.

#### Scenario: two invoices in one payment entry

- **WHEN** the builder is given two allocations of a single customer
- **THEN** the document has two reference rows, and `paid_amount` equals the sum
  of both allocations

#### Scenario: an advance has no reference row

- **WHEN** the amount is entirely unallocated (nothing open)
- **THEN** `references` is empty and `unallocated_amount` equals the paid amount

### Requirement: The collect path never picks an invoice itself

The collect proposal MUST require explicit allocations from the draft. The
"default to the oldest open document" behaviour MUST NOT be reachable from the
collect path: with at least one open invoice and no allocation the answer is
`MISSING_REQUIRED_FIELD` with copy telling the user to choose; with no open
invoice the empty allocation list is legal and the whole amount is unallocated.
The chat-driven payment path keeps its existing default until Phase 8/9, and the
code MUST say so where the two paths diverge.

#### Scenario: no allocation while the customer owes

- **WHEN** a collect draft arrives with an empty allocation list while the
  customer has open invoices
- **THEN** the answer is `MISSING_REQUIRED_FIELD` and no invoice is chosen for
  the user, oldest or otherwise

#### Scenario: the chat path is untouched

- **WHEN** the same customer is collected from chat without naming an invoice
- **THEN** the existing oldest-first behaviour and its warnings are unchanged

### Requirement: Every reference amount is the live one

Each reference row's `total_amount` and `outstanding_amount` MUST come from the
same fresh read the allocation was validated against, not from a snapshot
carried by another document. When the live remainder differs from the amount the
proposal was built on, the drift MUST surface as a refusal at confirm time
rather than a silently different write.

#### Scenario: a snapshot is not authority

- **WHEN** a document's stored `outstanding_amount` disagrees with the live one
- **THEN** the live value is used to bound the allocation, and the stored value
  is only reported for the audit trail
