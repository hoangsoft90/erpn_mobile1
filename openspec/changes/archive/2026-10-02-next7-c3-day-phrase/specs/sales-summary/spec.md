## Purpose

Write down HOW `sales.summary` learns which day the shopkeeper means. C1 gave the capability a day
argument (and left it at the shop's today); C3 is the reader that fills it from the sentence — with
the fail-closed rule that an unpinnable day is refused instead of answered with another day's money.

The C1 delta (`openspec/changes/next7-c1-sales-summary`) is not archived yet, so no `sales.summary`
spec exists under `openspec/specs/`; the requirement below is therefore ADDED here and applies
alongside C1's.

## ADDED Requirements

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
