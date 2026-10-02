# invoice-reads Specification

## Purpose
Khả năng `invoice-reads`: đọc phục vụ màn Thu tiền trả MỌI hoá đơn mở của một khách trong company đã phân giải (`docstatus = 1`, `outstanding_amount` khác 0, giữ credit note âm). Phân trang chạy trên một lần đọc trọn vẹn vì site không có "trang hai" — không được cắt im lặng.

## Requirements

### Requirement: The collect read is complete for the customer and company

The read that feeds a collect screen MUST return every open invoice of the
customer **and** the resolved company, filtered to `docstatus = 1` and to a
non-zero `outstanding_amount` (a credit note's negative remainder is kept). It
MUST NOT cut the query at a fixed page size the caller cannot see, and it MUST
report the number it matched so a screen can say "còn N kết quả" from the truth.

#### Scenario: a customer with more invoices than a screen shows

- **WHEN** the customer has 179 open invoices and the screen shows ten
- **THEN** all 179 are read, the payload reports 179 matched, and the screen can
  page through them

#### Scenario: the customer's other company is not in the number

- **WHEN** the same customer owes in two companies and this deployment is pinned
  to one
- **THEN** only that company's invoices are counted in the total

### Requirement: Paging is done over a complete read, because there is no page two

The pinned tool exposes `limit` but no offset (measured, `skills/customer-create.mjs`),
so a paging offset MUST be applied to an already-complete read rather than passed
to the site. A read that cannot be complete MUST say so (`truncated`) with the
matched count instead of presenting a partial page as the whole debt, and a read
whose source fails MUST refuse rather than answer with an empty list.

#### Scenario: an offset selects a later slice of the same complete read

- **WHEN** a caller asks for the second page of the customer's open invoices
- **THEN** the rows come from one complete read of that customer's invoices, and
  the matched total is unchanged by the offset

#### Scenario: an unreadable source is not an empty list

- **WHEN** the invoice source cannot be read
- **THEN** the read refuses with an error code, and no caller may render it as
  "this customer owes nothing"

### Requirement: An open-invoice read is scoped to the customer AND the company

An open-invoice read MUST be filtered by the customer **and** by the resolved
company. The company MUST come from the server's own resolution (principal →
`COPILOT_COMPANY` → request), never from a value the client alone chose, and a
request naming a company the principal may not use MUST be refused. A read that
cannot resolve a company MUST report that instead of returning rows from every
company on the site.

#### Scenario: invoices of another company are not in the list

- **WHEN** the customer has open invoices in two companies and the deployment is
  pinned to one
- **THEN** only that company's invoices appear, and the totals count only those

#### Scenario: a company outside the principal's allow-list is refused

- **WHEN** a request names a company the principal may not operate on
- **THEN** the read is refused as denied, not silently rewritten to another company

### Requirement: An open-invoice read never truncates silently

The read MUST report that it is bounded: the payload MUST carry the number of
rows it matched AND a flag saying the read filled its own page (the site may hold
more than was asked for), so no caller can present a bounded page as the whole
debt. The flag states "this page is full", never "this is everything". A read that
fails MUST refuse rather than answer with an empty list.

#### Scenario: a customer with more invoices than one page

- **WHEN** the customer has more open invoices than the page the read returns
- **THEN** the payload carries the matched count and the bounded flag, and the
  screen shows "còn N kết quả"

#### Scenario: an unreadable invoice source is not an empty list

- **WHEN** the invoice source cannot be read
- **THEN** the read refuses with an error code, and no caller may render it as
  "no debt"

### Requirement: The invoice list is bounded, searchable and has a real total

The list a screen renders MUST show at most the declared page size (10) of open
invoices, MUST offer a search over the customer's open invoices that is not
limited to the first page, MUST show how many remain, and MUST NOT select any row.
Rows MUST be keyed by invoice id so a shifting list cannot attribute one row's
state to another.

#### Scenario: searching finds an invoice beyond the first page

- **WHEN** the customer has more open invoices than one page and the user searches
  for one that is not in the first page
- **THEN** that invoice is found and offered for allocation

#### Scenario: the page size is respected

- **WHEN** the customer has more than 10 open invoices
- **THEN** at most 10 rows render, with the remaining count shown

### Requirement: Money accounts are read per method account type

The money accounts offered for a collection MUST be read from the company and
grouped by the account type the payment method implies (cash ⇒ Cash-typed
accounts, bank transfer ⇒ Bank-typed accounts), together with the company's own
defaults when the site declares them. The read MUST NOT invent an account, MUST
NOT infer one from a label or a mode's name, and MUST report an unresolved
account type instead of substituting another.

#### Scenario: the read groups by account type

- **WHEN** the company declares Cash-typed and Bank-typed accounts
- **THEN** the read returns them under their own types, and the defaults the
  company declares

#### Scenario: an unresolved account type is reported, not guessed

- **WHEN** the company declares no account of the required type
- **THEN** the read reports that the account type is unresolved and offers no
  substitute account

### Requirement: Every route added for the screen is read-only

The endpoints added for this screen MUST be READ: they MUST NOT reference a write
tool, the write gateway, or `/execute`, and a static check over their sources MUST
find no write reference. Reading accounts and invoices MUST NOT be able to change
any document.

#### Scenario: no write reference on the collect read paths

- **WHEN** the sources of the invoice and account reads are scanned for a write
  gateway reference
- **THEN** no match is found
