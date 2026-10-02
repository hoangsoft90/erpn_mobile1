# purchase-execute Specification

## Purpose
Khả năng `purchase-execute`: một xác nhận mua hàng thi hành qua cửa ghi DUY NHẤT `/execute`, tạo tối đa một Purchase Invoice nháp (cộng một Payment Entry ứng trước khi đề xuất có phương thức). Ghi phải IDEMPOTENT (xác nhận hai lần ⇒ một chứng từ) và mọi lần ghi được VERIFY bằng đọc lại — lệch dữ liệu thì từ chối.

## Requirements

### Requirement: One confirmation writes one purchase through the single execute door

A confirmed purchase MUST be executed through the one shared `/execute` endpoint, creating at most
one Purchase Invoice draft (plus, when the proposal carries a payment method, one advance Payment
Entry). The write MUST be idempotent: a double confirmation results in one document, and a repeated
action key is refused rather than written twice. There MUST be no second write path.

#### Scenario: confirm twice

- **WHEN** the same confirmation is submitted twice
- **THEN** exactly one Purchase Invoice draft exists for that action id

#### Scenario: an interrupted attempt

- **WHEN** the write response is lost, the client is unavailable, or the result is unknown
- **THEN** the attempt stays reconcilable by action id, and a retry reconciles instead of writing a
  second document

### Requirement: The write is verified by reading back, and drift is refused

After writing, the skill MUST read the document back and confirm the supplier, `docstatus = 0`,
`update_stock = 1`, `credit_to`, the line count and each line's quantity and rates. When the buying
price, the total, or the entity has moved since the proposal was built, the write MUST be refused
as stale rather than re-priced or silently written. A write whose read-back does not match MUST
surface as an unverified refusal, never as success.

#### Scenario: the buying price changed after the proposal

- **WHEN** the buying price for a line differs at execute time from the proposal
- **THEN** the command is refused as stale and nothing is written

#### Scenario: read-back mismatches

- **WHEN** the read-back shows a different supplier, a submitted invoice, or a moved line rate
- **THEN** the result is an unverified refusal with the differences, not a success
