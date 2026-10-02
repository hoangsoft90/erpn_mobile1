# payment-accounts Specification

## Purpose
Khả năng `payment-accounts`: giải phương thức thu/chi và tài khoản tiền theo KÊNH (Cash/Bank) của capability (§6.2) — không theo tên phương thức, không fallback chéo. Nó hiển thị cảnh báo khi tên lệch loại, TỪ CHỐI tài khoản sai loại hoặc không thuộc company, và cho người dùng thấy đúng phương thức đã ghi trên phiếu nháp.

## Requirements

### Requirement: The Mode of Payment is chosen by the method's channel, not by its name

Resolving a money method MUST select a Mode of Payment whose ERPNext `type`
matches the request's channel: a bank intent resolves a `Bank`-typed Mode of
Payment and a cash intent a `Cash`-typed one. The requested LABEL remains the
source of the channel; it MUST NOT be used to pick a `type` that contradicts it.
The money ACCOUNT is still chosen by lock §6.2 from the channel's
`account_type` — a bank channel resolves the company's bank default and NEVER a
cash ledger such as `1110` — and a wrong-typed account still BLOCKs instead of
substituting.

#### Scenario: a bank intent cannot land on a cash method

- **WHEN** a collection is requested with a bank channel
- **THEN** the resolved `mode_of_payment` is a `Bank`-typed Mode of Payment and
  `paid_to` is the company's bank account

#### Scenario: a cash intent cannot land on a bank method

- **WHEN** a collection is requested with a cash channel
- **THEN** the resolved `mode_of_payment` is a `Cash`-typed Mode of Payment and
  `paid_to` is the company's cash account

### Requirement: A label that contradicts its own type is surfaced, never silently renamed

When a Mode of Payment whose name matches the requested label exists but its
`type` contradicts the request's channel, the result MUST say so in Vietnamese,
naming the mismatch, instead of silently substituting a differently-named method.
Where the contradiction would place the money in the wrong `account_type`, the
write MUST be refused with the existing refusal vocabulary. No new silent
substitution is introduced, and `mode_substituted_from` is reported only when the
written `mode_of_payment` genuinely differs from the requested one.

#### Scenario: the shop's "Chuyển khoản" method is declared as cash

- **WHEN** a bank collection is requested and the site's MoP named "Chuyển khoản"
  carries `type = Cash`
- **THEN** the receipt is not silently labelled with a mismatching method, and
  the result names the conflict in Vietnamese so an operator can correct the
  site's method type

### Requirement: The method actually written is shown on the draft result

The client MUST display the Mode of Payment that ERPNext actually stores on the
draft receipt, and MUST repeat the Vietnamese conflict warning verbatim when the
server reports one. Showing neither would leave the seller believing the shop's own
method name was used when another method of the same channel was written instead —
the warning the API already produces is not an answer by itself.

#### Scenario: a channel token resolves to a differently-named method

- **WHEN** a bank collection writes a draft whose `mode_of_payment` is
  `Wire Transfer`
- **THEN** the draft line names `phương thức ghi: "Wire Transfer"`

#### Scenario: the site's method name contradicted its type

- **WHEN** the server returns `mode_warning` saying the site's "Chuyển khoản"
  method is declared cash
- **THEN** that warning text is shown on the draft line, never swallowed

#### Scenario: no submit step reported

- **WHEN** the server sends no `mode_of_payment` at all
- **THEN** the draft line claims no method instead of inventing one

### Requirement: A method whose NAME reads like the other channel is surfaced too

The Mode of Payment is chosen by the method's `type` and that choice MUST NOT
change because of a naming oddity. But when the CHOSEN method's name reads like
the channel OPPOSITE to the one it is being used for — the mirror of the
"Chuyển khoản is declared Cash" case — the result MUST still say so in
Vietnamese, naming the method, the `type` ERPNext declares for it and the form
the receipt is actually written under. A conflict already reported MUST NOT be
replaced by this weaker, second one. A chosen method whose name matches the form
it is used for stays silent.

#### Scenario: a bank receipt lands on a method named "Cash"

- **WHEN** a bank collection selects a `Bank`-typed Mode of Payment whose name is
  "Cash"
- **THEN** `paid_to` is still the company's bank account, the choice is not
  changed, and the result warns that the method's NAME reads like cash while
  ERPNext types it Bank

#### Scenario: the mirror case, a cash receipt on a bank-named method

- **WHEN** a cash collection selects a `Cash`-typed Mode of Payment whose name
  reads like a transfer
- **THEN** `paid_to` is still the company's cash account and the warning names
  the bank-like name

#### Scenario: a matching name adds nothing

- **WHEN** a bank collection selects the site's `Wire Transfer` (`type = Bank`)
- **THEN** no warning is produced at all

### Requirement: A money account is resolved in one order, and never guessed

Resolving the account money moves into or out of MUST follow exactly this order:
(1) the account the user chose, when it exists, belongs to the resolved company
and its `account_type` matches the chosen method; (2) otherwise the company's own
default for that channel (`default_cash_account` for cash,
`default_bank_account` for bank transfer) when that default is a leaf of the
matching type; (3) otherwise **BLOCK** with `PAYMENT_ACCOUNT_UNRESOLVED`. The
Mode of Payment rows MUST NOT be used as an account source, because a site's
mode rows carry no usable account for the company (measured on the shop's own
site: cash `1110`, bank `1210`).

#### Scenario: the user's account wins when it is valid

- **WHEN** the request names a bank account of the resolved company and the
  method is a bank transfer
- **THEN** that account is used, and no default is consulted

#### Scenario: no account can be resolved

- **WHEN** neither the chosen account nor a matching company default exists
- **THEN** the answer is `PAYMENT_ACCOUNT_UNRESOLVED` with Vietnamese copy, and
  no proposal is built

### Requirement: A wrong-typed account is refused, never substituted

An account whose `account_type` does not match the method MUST be refused with
`ACCOUNT_TYPE_MISMATCH`. The server MUST NOT substitute an account of the other
channel: a bank intent MUST NOT silently post into the cash ledger, and a cash
intent MUST NOT post into the bank ledger. In particular the "company's first
Cash-type ledger account" fallback MUST NOT exist as a way to satisfy a
bank-transfer intent.

#### Scenario: bank intent against a cash account

- **WHEN** the request names the cash ledger while the method is a bank transfer
- **THEN** the answer is `ACCOUNT_TYPE_MISMATCH` naming both, and nothing is
  proposed — the request is not quietly rewritten to a valid cash collection

#### Scenario: cash intent with no explicit account

- **WHEN** the method is cash and no account was chosen
- **THEN** only the company's cash default may be used; a Cash-type account that
  is merely the first one found is not acceptable

### Requirement: The account must belong to the resolved company

An account of another company MUST be refused, and a request that names a
company the principal may not operate on MUST be refused as denied. When no
company can be resolved for a money document, the answer MUST be
`COMPANY_SCOPE_REQUIRED` rather than an account chosen from every company on the
site.

#### Scenario: an account from another company

- **WHEN** the chosen account belongs to a different company than the invoice's
- **THEN** the answer is `ACCOUNT_TYPE_MISMATCH` / `COMPANY_SCOPE_REQUIRED` with
  copy that says which company was expected, and nothing is proposed

#### Scenario: the same rule applies to the invoice's own ledger account

- **WHEN** the anchor invoice's receivable/payable account is read
- **THEN** it comes from the document itself and is used as-is, so the party
  ledger can never be replaced by a same-typed account of another company

### Requirement: The account is re-derived at execute time, never read from the proposal

The executor MUST resolve the money account itself, from ERPNext, using the
direction, the customer's company and the method's channel — (1) the account the
proposal picked, validated to exist as a leaf of that company and to match the
channel's `account_type`; (2) the company's default for that channel;
(3) **BLOCK**. The account name carried in the proposal is an input to CHECK,
never an instruction to obey, and a wrong-typed account MUST NOT be substituted
by a fallback.

#### Scenario: a crafted proposal names the wrong ledger

- **WHEN** a cash collection arrives carrying the company's bank account
- **THEN** the answer is `ACCOUNT_TYPE_MISMATCH` and nothing is written

#### Scenario: the company declares no account for the channel

- **WHEN** neither the proposal nor the company default yields an account of the
  required type
- **THEN** the answer is `PAYMENT_ACCOUNT_UNRESOLVED` and nothing is written

### Requirement: One payment entry moves money on exactly one money account

The written document MUST carry one money account per side, taken from the
resolved account, with the receivable ledger on the other side for a collection.
A Mode of Payment MUST NOT be used as the source of an account.

#### Scenario: the sides are assigned from the direction

- **WHEN** a collection is written
- **THEN** `paid_from` is the invoice's receivable ledger and `paid_to` is the
  resolved money account, and the reverse holds for a pay-out
