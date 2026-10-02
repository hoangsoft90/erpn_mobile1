# purchase-money Specification

## Purpose
Khả năng `purchase-money`: chiều tiền mua hàng là **Pay**, lấy từ CHÍNH SÁCH của capability (phân giải đối tác theo master NCC) — không suy từ tên hiển thị, loại chứng từ hay câu nói. Một phương thức cho mỗi lần trả và tài khoản phải khớp loại; trả vào một hoá đơn nháp được ghi nhận là ỨNG TRƯỚC, không phải tất toán.

## Requirements

### Requirement: The money direction is Pay, and it comes from the capability

For a supplier, `party_type` MUST be `Supplier` and the payment direction MUST be `Pay`, taken from
the payment capability's own direction policy (which resolves the party against the supplier master
list). It MUST NOT be inferred from the party's display name, the document type, or any utterance
string. Money out MUST leave the shop's cash/bank account (`paid_from`) and land on the payable
account, never the other way round.

#### Scenario: a supplier payment

- **WHEN** the owner confirms a purchase with a cash payment
- **THEN** the Payment Entry carries `payment_type = Pay`, `party_type = Supplier`, `paid_from` in
  the cash account and `paid_to` on the payable account

#### Scenario: the direction would be guessed from a name

- **WHEN** the party's name looks like a customer but the capability resolves it as a supplier
- **THEN** the direction is still `Pay` and no code reads the name to decide

### Requirement: One method per payment, and the account must match its type

A supplier payment carries at most ONE payment method; more than one is refused, never split
silently into several documents in one command (owner lock §6.1). The money account MUST be resolved
by the method's channel from the company's own defaults and MUST carry the matching `account_type` —
a bank intent resolves the bank account (`1210`) and never a cash ledger such as `1110`; a wrongly
typed account is refused (BLOCK) instead of substituted (owner lock §6.2). The payable account is
the company's `default_payable_account` (`2110`); when the company declares none, the write is
refused.

#### Scenario: two methods in one command

- **WHEN** a purchase draft asks to pay by cash and by bank transfer in one command
- **THEN** the command is refused with the method-count refusal, and nothing is written

#### Scenario: a bank intent with a cash account offered

- **WHEN** the offered account for a bank transfer is a cash-typed ledger
- **THEN** the payment is refused rather than posting money out of the wrong ledger

#### Scenario: a company with no payable account

- **WHEN** the company has no `default_payable_account` set
- **THEN** creating the Purchase Invoice is refused instead of writing an unknown `credit_to`

### Requirement: Paying against a draft invoice is recorded as an advance, not as a settlement

Because ERPNext refuses to allocate a Payment Entry to a draft Purchase Invoice, a supplier payment
taken before the invoice is submitted MUST be written as an **on-account advance for the supplier**
with no invoice allocation. The result MUST say, in Vietnamese, that the payment is a draft advance
and that the invoice is **not** settled yet; it MUST NOT claim the invoice was paid, and it MUST NOT
write any allocation row pointing at the draft invoice.

#### Scenario: money paid while the invoice is still a draft

- **WHEN** the owner pays part of the total right after the draft invoice is created
- **THEN** the payment is written as an unallocated advance for that supplier and the copy states
  the invoice is not settled yet

#### Scenario: claiming a settlement that did not happen

- **WHEN** any result text is produced for a draft invoice with a payment
- **THEN** it never says the invoice was paid, and no reference row points at the draft invoice
