## Purpose

Promote `sales.summary` from a declared stub to an implemented READ whose filters were PROVEN on
the real site by the C0 gate (`.plan/next7/C0-result.md`), and make the drawer's day-sales block,
the `invoices_today` drill and the chat answer read ONE function — the drift C0 measured cannot
come back.

All requirements are ADDED: no `sales.summary` spec has been archived yet (the C0 change recorded
only its measurement gate), so this is where the capability's behaviour is first written down.

## ADDED Requirements

### Requirement: sales.summary reports the day's NET sales of one company

`sales.summary` MUST answer from submitted Sales Invoices (`docstatus = 1`) of the company the
server RESOLVED, on the shop's calendar day (`Asia/Ho_Chi_Minh`), summing `grand_total` with
returns INCLUDED — a return's `grand_total` is already negative on the site (C0 §2), so it
self-subtracts and MUST NOT be `abs`ed or re-signed. Drafts (`docstatus 0`), cancelled
(`docstatus 2`) and Payment Entries MUST NOT contribute. The answer MUST carry the currency and
the day; a company that the deployment has not pinned MUST be refused (`COMPANY_SCOPE_REQUIRED`)
rather than picked.

#### Scenario: a return lowers the day (C7)

- **WHEN** the day contains a submitted return (`is_return = 1`)
- **THEN** `net_vnd` is lower than the same day's non-return total, and the return is counted as
  one of the day's documents

#### Scenario: only submitted rows count (C8)

- **WHEN** normal, return, cancelled and draft invoices share the day
- **THEN** only the submitted ones (normal + return) contribute to `net_vnd`, and neither the
  cancelled nor the draft document changes the number

#### Scenario: revenue is not money collected

- **WHEN** submitted Payment Entries exist on the same day
- **THEN** they do not contribute to `net_vnd`

### Requirement: One formula — the chat number, the drawer block and the drill cannot disagree

The day-sales read MUST exist once and be shared by the drawer's `sales_invoices` block, the
`invoices_today` drill and `sales.summary`, so `abs(sales.summary.net_vnd − drawer block) == 0`
and the drill's own rows sum to the block above them. The drill MUST NOT drop returns out of that
set (the drift C0 measured on the real site).

#### Scenario: a day with a return

- **WHEN** the day contains a return
- **THEN** the drill lists that return as one of the day's rows (negative amount, labelled as a
  return) and its rows sum to the same total `sales.summary` reports

### Requirement: Empty day vs unreachable ERPNext are different answers

An empty day MUST be reported as a REAL zero (`net_vnd: 0`, `documents: 0`). A failure to read
ERPNext MUST surface as `ERP_UNAVAILABLE` (an error, no number) — never as a fabricated `0`.

#### Scenario: ERPNext is down

- **WHEN** the Sales Invoice read fails
- **THEN** the answer carries `ERP_UNAVAILABLE` and no `net_vnd` value at all

#### Scenario: no invoice on the day

- **WHEN** the day has no submitted invoice
- **THEN** the answer says the revenue is 0 for that day, and it is not an error
