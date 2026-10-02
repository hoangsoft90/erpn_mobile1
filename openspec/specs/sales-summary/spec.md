# sales-summary Specification

## Purpose
Gate đo đạc bắt buộc TRƯỚC khi code `sales.summary` (plan_final §5.2): mọi filter/field của skill
doanh thu phải được chứng minh trên ERPNext thật, không đoán. Change này KHÔNG thêm capability —
nó chốt BẰNG CHỨNG cho capability `sales.summary` sẽ khai báo ở change C1.

## Requirements

### Requirement: Sales-summary filters and fields are C0-proven, not guessed

Skill `sales.summary` (C1) MUST dùng: field tiền + cách xử lý return + filter docstatus đã đo
trên ERPNext thật ở C0 và ghi trong `.plan/next7/C0-result.md`. CẤM hardcode filter đoán.
Kết luận tối thiểu C0 phải phủ: SI submitted thường / submitted return / cancelled (docstatus=2) /
draft (docstatus=0) trong cùng một ngày lịch `Asia/Ho_Chi_Minh` và một company scope pin.

#### Scenario: return trong ngày không được tính thành doanh thu dương

- **WHEN** ngày đo có SI submitted return (đã đo dấu + field thật ở C0)
- **THEN** công thức net = Σ SI submitted thường − |Σ SI submitted return| (theo dấu đã đo), và
  số này được đối chiếu với block bán của Drawer cùng ngày/company

#### Scenario: PE không bao giờ vào doanh thu

- **WHEN** Payment Entry (kể cả submitted, cùng ngày) tồn tại
- **THEN** KHÔNG nằm trong phép tính doanh thu net (doanh thu ≠ tiền đã thu)

### Requirement: Measurement is evidence-first (C0 gate)

C0 MUST query ERPNext thật (không suy diễn từ fixture), sample phải ghi (name/docstatus/is_return/
amount/posting_date — không secret), và kết luận C1 phải trích được dòng code drawer đối chiếu.
Nếu ngày đo không có return thật: MUST ghi rõ giới hạn bằng chứng thay vì khẳng định công thức
đã được chứng minh trọn vẹn.

#### Scenario: thiếu return trong ngày đo

- **WHEN** cửa sổ đo không có SI return nào submitted
- **THEN** C0-result ghi giới hạn này + đề xuất đo bổ sung; C1 KHÔNG được tuyên bố C7 (return làm
  net giảm đúng) đã PASS chỉ từ fixture

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

### Requirement: The day comes from the sentence when the sentence names one

`sales.summary` MUST read the day from the question it was routed from, deterministically, with no
model in the path. It MUST understand `hôm nay` / `hôm qua` / `hôm kia`, `d/m`, `d/m/yyyy`,
`d-m-yyyy`, `d.m.yyyy`, `yyyy-mm-dd` and `ngày d tháng m [năm yyyy]` — accented and unaccented —
and MUST resolve them against the SHOP's calendar day (`Asia/Ho_Chi_Minh`), the same reading its
own default uses. A question that names NO day MUST keep the previous behaviour: the shop's today.

#### Scenario: a named day is the day that is read

- **WHEN** the shopkeeper asks "doanh thu ngày 15/9" and the 15th of September already happened
  this year
- **THEN** the answer is about `YYYY-09-15`, the payload's `date` is that day, and the number is
  that day's NET sales — not today's

#### Scenario: relative days are real calendar arithmetic

- **WHEN** "hôm qua" is asked on the first day of a month (or of a year)
- **THEN** the day read is the previous calendar day, across the month/year boundary

#### Scenario: no day named is not an error

- **WHEN** the question names no day at all ("doanh thu", "doanh thu bán được bao nhiêu")
- **THEN** the answer is about the shop's today, exactly as before this change

### Requirement: A day that cannot be pinned is REFUSED, never substituted

The capability MUST refuse — with `answer: null`, no figures and a Vietnamese reason — rather than
answer about a day the shopkeeper did not ask for. It MUST refuse a PERIOD (`tuần`, `tháng`, `quý`,
`năm` used as a span, "mấy ngày nay", "3 ngày qua") with `KNOWN_INTENT_UNIMPLEMENTED`, and MUST
refuse an unusable DAY with `DAY_PHRASE_INVALID`: an impossible date (`31/2`, `29/2` in a
non-leap year), a future day, a year-less day still to come this year, a 2-digit year
(`15/9/26`), a day word that pins nothing ("hôm trước", "bữa nọ"), and two different days in one
sentence. Every such refusal MUST carry copy the screen can show.

#### Scenario: the year is asked for instead of guessed

- **WHEN** "doanh thu 30/9" is asked on 27/9 of the same year (a day still to come, no year given)
- **THEN** the answer is a refusal that asks for the year — NOT last year's number and NOT today's

#### Scenario: a period is understood and refused

- **WHEN** "doanh thu tháng này" is asked
- **THEN** the refusal says only single days are supported today, carries no figures, and proposes
  nothing

#### Scenario: money is not a date

- **WHEN** the sentence contains a number followed by a money word ("doanh thu 1/5 triệu")
- **THEN** that number is not read as a date and the question is treated as naming no day

#### Scenario: a person is not a period

- **WHEN** the sentence mentions a person whose name is a period word ("doanh thu của chị Năm")
- **THEN** no period is inferred and the question is treated as naming no day

### Requirement: The answer names the day it read

The answer MUST state the day it read (ISO `YYYY-MM-DD`) and MUST add the relative word
(`hôm qua` / `hôm kia`) when the day read IS the previous day / the day before that, using the same
one clock reading the read used. The proposal MUST carry the day it read so the card cannot name a
different day than the figures.

#### Scenario: a past-day answer cannot read as today's

- **WHEN** the day read is the previous day
- **THEN** the answer contains that ISO day plus "(hôm qua)", and the proposal's `date` is the same
  day
