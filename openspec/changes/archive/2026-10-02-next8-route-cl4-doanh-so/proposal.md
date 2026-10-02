# next8 / Route CL-4 — `doanh số` means the day's sales summary

## Why

`res1.md` §1: `sales.summary` passes for `doanh thu` / `báo cáo doanh thu` (a
trigger on `sales.summary`) but `doanh số hôm nay` falls to
`sales/invoice.lookup`. In the shop's speech "doanh số" and "doanh thu" both mean
**today's sales figure**, so the same question must reach the same capability.

## Decision table (the two words share one target)

| Question shape | Capability |
|---|---|
| `doanh thu …`, `báo cáo doanh thu …` | `sales.summary` |
| `doanh số …`, `báo cáo doanh số …` | `sales.summary` |
| `hoá đơn chưa trả …`, `invoice …` | `invoice.lookup` |
| `bán được bao nhiêu …` | `sales.summary` |

`doanh số` is a phrase trigger on `sales.summary`; it does not change
`invoice.lookup` (document lists are asked with `hoá đơn`/`invoice`).

## What Changes

1. Add `doanh số` (+ diacritic-free `doanh so`) to `sales.summary`'s triggers.

## Out of scope

- No change to the `sales.summary` computation, no date logic, no new capability.
