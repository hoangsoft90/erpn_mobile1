## ADDED Requirements

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
