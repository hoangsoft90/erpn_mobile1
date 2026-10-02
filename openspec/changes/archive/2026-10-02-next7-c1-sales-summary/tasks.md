## 1. Skill + one formula (no second copy)

- [x] 1.1 `readDaySalesInvoices(mcp, {date, company})` — THE day read (fields include `is_return`, filter `posting_date =`, submitted + not cancelled, company-scoped). — `mcp-erpnext/src/skills/ops-summary.mjs`.
- [x] 1.2 `getSalesSummary(mcp, {date?, company, erpTarget})` — `net_vnd` (returns INCLUDED, already negative), `currency: "VND"`, `documents`, `returns:{count, amount_vnd}`, `timezone`, `erp_target`; date defaults to the SHOP's day (`vnDay`, Asia/Ho_Chi_Minh). Throws on ERP failure.
- [x] 1.3 Drawer block `salesInvoices()` AND drill `invoices_today` both call `readDaySalesInvoices` — the drift C0 found is impossible by construction.
- [x] 1.4 Drill row for a return: note "Trả hàng (giảm doanh thu)", amount negative (its own value).

## 2. Wiring

- [x] 2.1 `capabilities.json`: `status: "stub"` removed, `skill` set, `errors` = COMPANY_SCOPE_REQUIRED / ERP_UNAVAILABLE, trigger `"báo cáo doanh thu"` added; `drill_screens.invoices_today` comment updated to NET.
- [x] 2.2 `router.mjs`: `getSalesSummary` added to the `sales` factory bag (same group as invoice.lookup).
- [x] 2.3 `copilot-server.mjs`: `sales.summary` answered before the party machinery; company = `authorize()`'s resolved value; `COMPANY_SCOPE_REQUIRED` when unpinned; `ERP_UNAVAILABLE` on read failure; READ proposal `read_sales_summary`.
- [x] 2.4 Answer in Vietnamese: net + currency + date, explicit that revenue ≠ money collected, and the return deduction when there is one.

## 3. Tests (C1–C4, C8 at mock/unit + 1 mock-ERP path)

- [x] 3.1 New `test/next7-sales-summary.test.mjs` — routing (keyword + id + factory bag), contract, NET filter (normal+return+cancelled+draft in ONE day), field-projection guard (`is_return` must be requested), `abs(chat − drawer) == 0`, drill sums to the block, empty day = real 0, ERP down = throw (never 0), company/date required, VN-day default at the 23:59/00:00 boundary (agrees with `vnToday`).
- [x] 3.2 Updated the phase-earlier tripwires to the new semantics with the invariant they really own: `p4-ops-summary` (NET block; a return can never INFLATE), `p44-read-drill` (return is a row of NET, list still sums to the block), `copilot.test.mjs` ("doanh thu" no longer KNOWN_INTENT_UNIMPLEMENTED; company-scope refusal carries copy).
- [x] 3.3 Suite: Node **871 — 871 pass, 0 fail**.

## 4. Evidence

- [x] 4.1 `.plan/next7/C1-result.md` (numbers + files + falsification notes).
