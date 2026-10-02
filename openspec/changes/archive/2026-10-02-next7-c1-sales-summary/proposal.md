## Why

`sales.summary` (\"Báo cáo doanh thu hôm nay\") shipped as a READ **stub**: `skill: null`,
`status: \"stub\"`, so the pipeline answered `KNOWN_INTENT_UNIMPLEMENTED` for a question the
keyword router already understood. C0 (`openspec/changes/next7-c0-si-measurement`, PASS
2026-09-27) measured the REAL site and locked the formula; C0's own proposal says the capability
"will be delta'd in change C1, AFTER this gate PASSES". This is that change.

C0 also found a LIVE DRIFT that C1 must fix in the same pass: the drawer's `sales_invoices`
aggregate never asked for `is_return`, so the real tool did not return the field, so its
`!is_return` guard was dead code and the block summed **NET** — while the `invoices_today`
drill DID ask for the field and dropped returns. On any day with a return the list under the
number disagreed with the number (measured: 408.885.620 vs 397.505.620 on 2026-09-17).

## What Changes

- **New behaviour — `sales.summary` is implemented:**
  - `getSalesSummary(mcp, {date?, company, erpTarget})` in
    `mcp-erpnext/src/skills/ops-summary.mjs`; the day defaults to the SHOP's calendar day
    (`Asia/Ho_Chi_Minh`).
  - `net_vnd` = Σ submitted Sales Invoices of ONE company on the day, **returns INCLUDED**
    (their `grand_total` is already NEGATIVE on the site — C0 §2), drafts (`docstatus 0`),
    cancelled (`docstatus 2`) and Payment Entries excluded.
  - The skill also reports `currency`, `documents`, the return subset, and the ERP target.
- **One formula, no drift:** the day-invoice read is extracted to `readDaySalesInvoices()` and
  used by the drawer block, the `invoices_today` drill AND the new skill — so
  `abs(sales.summary − drawer block) == 0` holds by construction (plan_final §5.3).
- **Drift fix (authorised by the C0 chốt):** the drill no longer filters returns out; a return
  now appears as one of the day's rows, labelled "Trả hàng (giảm doanh thu)".
- **Contract:** `sales.summary` loses `status: \"stub\"`, gains
  `skill: \"skills/ops-summary.mjs#getSalesSummary\"`, and its `errors[]` becomes
  `COMPANY_SCOPE_REQUIRED` / `ERP_UNAVAILABLE`. Keyword `\"báo cáo doanh thu\"` added.
- **Pipeline:** `answerQuestion()` answers the capability BEFORE the party machinery (a revenue
  question names no customer — routed through those guards it would die as `MISSING_ENTITY`) and
  uses the company `authorize()` resolved, never a client string. An unpinned deployment is
  refused with `COMPANY_SCOPE_REQUIRED` (C0 §6.4: pin from env, never auto-pick). An ERP failure
  becomes `ERP_UNAVAILABLE` — never a fabricated 0 (§5.4). An empty day is a REAL zero.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `sales.summary` — promoted from declared-stub to implemented READ (also fixes the
  aggregate↔drill drift on days with a return).

## Impact

- **Files:** `mcp-erpnext/src/skills/ops-summary.mjs` (+`vnDay`, `readDaySalesInvoices`,
  `getSalesSummary`) · `src/router.mjs` (sales factory) · `src/copilot-server.mjs` (branch +
  resolved company) · `capabilities.json` · tests (`next7-sales-summary.test.mjs` new;
  `p4-ops-summary`, `p44-read-drill`, `copilot` tripwires updated to the NET semantics).
- **Behaviour change to state out loud:** the drawer's `sales_invoices` amount now EXCLUDES
  nothing that the real site already included — it becomes explicitly NET. Mock/fixture runs
  change (they used to drop the return row); the real site's number does NOT move, because C0
  measured that it was already NET. `returns: null` (no separate breakdown) is unchanged.
- **NOT touched:** Payment Entries are never revenue · no write path, no `/execute`, no DSH
  change, no voice, no Flutter code (the client already renders whatever the server sends).
- Suite after the change: **Node 871 — 871 pass, 0 fail**.
