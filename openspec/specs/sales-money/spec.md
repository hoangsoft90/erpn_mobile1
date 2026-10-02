# sales-money Specification

## Purpose
Khả năng `sales-money`: tiền của đường Bán — một phương thức cho mỗi lần thu và tài khoản phải khớp loại; thu vào một hoá đơn nháp được ghi nhận là ỨNG TRƯỚC (không phải tất toán); chuyển khoản là "chờ tiền về", không bao giờ "đã nhận".

## Requirements

### Requirement: One method per collection, and the account must match its type

A sales collection carries at most ONE payment method; more than one is refused, never split
silently into several documents in one command (owner lock §6.1). The money account is resolved by
the method's channel from the company's own defaults and MUST carry the matching `account_type` —
a bank intent resolves the bank account and never a cash ledger such as `1110`; a wrongly typed
account is refused (BLOCK) instead of substituted (owner lock §6.2).

#### Scenario: two methods in one command

- **WHEN** a sales draft asks to collect by cash and by bank transfer in one command
- **THEN** the command is refused with the existing method-count refusal, and nothing is written

#### Scenario: a bank intent with a cash account offered

- **WHEN** the offered account for a bank transfer is a cash-typed ledger
- **THEN** the collection is refused rather than posting money into the wrong ledger

### Requirement: Collecting against a draft invoice is recorded as an advance, not as a settlement

Because ERPNext refuses to allocate a Payment Entry to a draft Sales Invoice (measured: the site's
own `payment_entry.py` throws `… must be submitted` and `Sales Invoice` is a valid reference
doctype for a Customer payment), a sales collection taken before the invoice is submitted MUST be
written as an **on-account advance for the customer** with no invoice allocation. The result MUST
say, in Vietnamese, that the receipt is a draft advance and that the invoice is **not** settled
yet; it MUST NOT claim the invoice was paid, and it MUST NOT write `paid_amount`/`outstanding_amount`
on the invoice (both are read-only) nor use the POS `payments` child table (unused on this site).

#### Scenario: money taken while the invoice is still a draft

- **WHEN** the seller collects part of the total right after the draft invoice is created
- **THEN** the receipt is written as an unallocated advance for that customer and the copy states
  the invoice is not settled yet

#### Scenario: claiming a settlement that did not happen

- **WHEN** any result text is produced for a draft invoice with a collection
- **THEN** it never says the invoice was paid, and no allocation row points at the draft invoice

### Requirement: A bank transfer is "waiting for the money", never "received"

A sale collected by bank transfer MUST be distinguishable from money actually received: the draft
invoice carries the site's own transfer-state field set to `pending`, and the copy says the
transfer is waiting to be confirmed. The app MUST NOT report "đã nhận tiền"/"received" merely
because a document was created.

#### Scenario: a bank transfer sale

- **WHEN** the seller collects by bank transfer
- **THEN** the created invoice carries the transfer state `pending` and the result says the money
  is still waiting to be confirmed

#### Scenario: a cash sale

- **WHEN** the seller collects in cash
- **THEN** no transfer state is set on the invoice and the copy does not mention a pending transfer
