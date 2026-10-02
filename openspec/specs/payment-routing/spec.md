# payment-routing Specification

## Purpose
Khả năng `payment-routing`: một câu lệnh thu đặt đối tác trước kèm số tiền — `<Tên> trả <số tiền>` — phải vào nhóm `payment_write` (`payment.create`) đúng như dạng verb-first (`Thu tiền …`, `Trả tiền …`). Việc rewrite chỉ fire khi KHÔNG có mệnh đề `đã trả` và không có route `startsWith` nào khác đã chiếm đầu câu.

## Requirements

### Requirement: A party-first collect command reaches the collect path

A collect COMMAND whose verb follows the party and names an amount — `<Tên> trả
<số tiền>` — MUST resolve to the `payment_write` group (`payment.create`), exactly
like the verb-first forms (`Thu tiền …`, `Trả tiền …`). The rewrite MUST NOT fire
for a question about money already paid, which carries no amount after the verb
(`<Tên> đã trả bao nhiêu`, `<Tên> trả những khoản nào`); those MUST keep resolving
to `payment.history`. The money DIRECTION and every amount are still derived
server-side from data, never from the sentence.

#### Scenario: a party-first collect command routes to payment.create

- **WHEN** the sentence is `<Tên> trả <số tiền>` (e.g. `«CUSTOMER_A» trả 50 nghìn`)
- **THEN** the router resolves `payment_write` / `payment.create`

#### Scenario: a history question is not rewritten

- **WHEN** the sentence is `<Tên> đã trả bao nhiêu?` or `<Tên> trả những khoản nào`
- **THEN** the router still resolves `payment` / `payment.history`

#### Scenario: a bare `Thu <party> <amount>` collect command reaches the collect path

- **WHEN** the sentence opens with the bare collect verb `Thu` followed by a party
  and an amount (`Thu «CUSTOMER_A» 50 nghìn`), which the NLP does NOT canonicalize
- **THEN** the router resolves `payment_write` / `payment.create`, instead of being
  pulled into the `customer` group by the party token
- **AND** the NLP-owned dual forms (`thu tiền`, `thu nợ`, `thu hết`) are left raw
  (Phase 1 rewrites them), and `thu nhập` / `thuế` are never treated as a collect

#### Scenario: a later, subordinate "trả <amount>" is not a collect command

- **WHEN** the sentence mentions a paid amount in a subordinate clause, or already
  opens with another command — e.g. `xuất hóa đơn cho đơn đã trả 500 nghìn`,
  `xem đơn đã trả 200 nghìn`, or `khách trả 500 nghìn`
- **THEN** the rewrite MUST NOT fire: the sentence keeps the route its own leading
  keyword (or the participial `đã trả` history read) already earns. A collect
  command requires the verb to OPEN the command, not merely occur somewhere in it
  (measured regression: prepending `payment` to a bare `trả <digit>` hijacked an
  invoice command into a payment write).

#### Scenario: the sentence never decides the direction

- **WHEN** a party-first collect command resolves
- **THEN** no amount or direction is taken from the sentence; the existing
  `payment.create.direction_policy` derives pay/receive from the master list
