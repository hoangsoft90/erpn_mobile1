# next8 / Collect screen — the form that finishes a collection, with the server still owning every number

## Why

Phase 1 (commit `a732448`) made a collect sentence stop dead-ending: the answer now
carries a **business handoff** and `POST /collect/propose` can build a proposal
from a ticket plus the form's values. Nothing renders that yet — the ticket is a
id nobody can open. Phase 2 is the screen.

It is also the first time the shop's own money rules meet a real form, and two of
those rules have no data source today (measured, not assumed):

- **The invoice list cannot be searched beyond its first page.** The only read is
  `erpnext_sales_invoice_list` with a fixed field set and `limit: 100`, filtered
  client-side; it has **no company filter**, **no total**, and it **truncates
  silently**. Phase 0 measured **one customer with 179 open invoices** — so today
  the list is already wrong (100 of 179), and every screen built on it inherits
  that. Lock §6.4 says: read every open invoice for the customer **and company**,
  show ≤10 with a **real total**, and never cut silently.
- **There is no way to read the money accounts.** No route, no capability; the
  account logic lives inside the server-side payment builder. A screen that must
  offer "cash or bank" and refuse a wrong-typed account (lock §6.2, UI half) has
  nothing to offer.

The owner approved extending Phase 2 with these two **READ-only** additions and
folding the §6.4 fix into this phase (decisions recorded in
`openspec/changes/next8-collect-contract/tasks.md` §9b). The §6.2 **blocking
validation** stays in Phase 3; this change only stops the UI from inventing an
account.

## What Changes

1. **`CollectScreen` (`features/collect/**`)** — a purpose-built screen with four
   blocks: customer, open invoices (≤10 + search + real total), payment method
   (exactly one) + account (right type only), and a summary with **one** confirm
   action that calls `proposeCollect` and renders the ordinary proposal card.
2. **No automatic allocation, ever.** Ticking an invoice is a user act; the
   default per-invoice amount is the server's live outstanding; the totals are the
   server's arithmetic. The client may compare numbers, never author them.
3. **One invoice read, company-scoped, never silently cut**
   (`skills/sales.mjs#listOpenSalesInvoices` via `erpnext_doc_list` with free
   fields/filters — the same shape `listOpenPurchaseInvoices` already uses), with
   `truncated`/`matched_total` reported instead of a silent page. The chat-driven
   payment path and the drill-down both consume this one implementation, so the
   number a user sees and the number the server validates against cannot drift.
4. **`POST /collect/accounts` (READ)** — the company's money accounts grouped by
   `account_type` (Cash/Bank) plus the company defaults, behind a new READ
   capability. Read-only: it lists what exists, it does not choose.
5. **`/read/list` gains `q`** (search the open-invoice screen) and returns
   `matched_total`, keeping every existing field so the A1 drill-down is
   unchanged in shape.
6. **The chat opens the screen** when an answer carries a collect handoff, and the
   screen refuses to render without one (it never mints a ticket).

## Impact

- Affected specs: `collect-screen` (new), `invoice-reads` (new).
- Affected code: `apps/mobile/lib/features/collect/**` (new),
  `apps/mobile/lib/app/router/app_router.dart`,
  `apps/mobile/lib/features/chat/{data/copilot_api_client.dart,presentation/screens/chat_screen.dart}`,
  `mcp-erpnext/src/{skills/sales.mjs,skills/customer.mjs,skills/accounts.mjs,read-views.mjs,http-ask.mjs,copilot-server.mjs}`,
  `mcp-erpnext/{capabilities.json,src/mock-server.mjs}`.
- Money path: **no write is added.** Every new route/capability in this change is
  READ. `/execute` remains the only door that writes, and the screen reaches it
  only through the confirmed proposal card that already exists.
- Behaviour change to a shared read (§6.4): the open-invoice read becomes
  company-scoped and stops truncating silently, which also changes the chat
  balance/drill-down numbers for a customer whose invoices span two companies.
  Regression tests for the chat path are part of this change.
- Out of scope: the §6.2 blocking validation (Phase 3), lifting the
  multi-invoice 422 (Phase 3/4), Sales/Purchase screens, split-N-PE, and any new
  Dart dependency.
