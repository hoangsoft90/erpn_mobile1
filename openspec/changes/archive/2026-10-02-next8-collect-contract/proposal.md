# next8 / Collect contract — a handoff opens the form, the server owns every number

## Why

A collect sentence (`"thu tiền cho Lan"`) is a business transaction the chat
cannot finish. Today it dead-ends: the answer carries a refusal and the only
thing the user can do is retype a longer sentence. `.plan/next8/plan1_final_v2`
§5–§7 replaces that dead end with two contracts — a **business handoff** (the
server opens a form) and a **transaction draft** (the form's current values) —
so the confirmation flow of Phase 2+ has something to stand on.

The reason this is a contract change and not a UI change: everything it touches
is the money path. The owner locks (`sessions/res1.md` §6.1–6.5, ratified
2026-09-29) fix five rules that must hold *before* any screen exists:

- **§6.1** one collection = **one** payment method (cash + transfer = two
  collections, never one document);
- **§6.2** the account must match the method's account type or be blocked — no
  cross fallback (the old `"Chuyển khoản" → 1110` bug);
- **§6.3** with open invoices the allocation is **explicit**; only 0 open
  invoices allows an on-account receipt; no FIFO/oldest/auto-split;
- **§6.4** open invoices are read per customer+company, all of them, with a real
  total (no silent truncation);
- **§6.5** `payment.create` is the canonical id; `payment.collect` is an
  **alias of the same policy**, not a second wire.

Phase 1 (this change) implements the **data** half of that contract and opens
**no new write surface** — `/execute` stays the only door that writes.

## What Changes

1. **`business-handoff.mjs` (new)** — a server-generated ticket
   (`{type:"business_handoff", handoff_id, capability, screen, question, prefill,
   issued_at}`) with slot states `RESOLVED | AMBIGUOUS | MISSING | NO_MATCH`, a
   TTL-bounded in-process store that enforces **principal + conversation
   ownership**, and a hard rule that **no amount can enter a ticket**.
2. **`transaction-draft.mjs` (new)** — pure primitives and validators shared by
   every transaction screen: VND-integer money, `PaymentMethod` (no `credit`
   member), `InvoiceAllocation`, `TransactionItem`, `TransactionSummary`
   (server-side arithmetic, two discount layers never merged), plus
   `validateAllocations` (§6.3) and `validatePaymentMethods` (§6.1, limit
   parameterised so sales/purchase can raise it later without editing collect).
   **No invoice-selection helper exists anywhere in the module**, and a test
   asserts that against the source.
3. **`POST /collect/propose` (new route, read + build only)** — takes
   `{handoff_id, values:{customer_id, allocations[], payment_methods[],
   claimed_total_vnd?}}`, re-reads the customer's **live** open invoices and
   outstanding amounts, re-validates every form value server-side, and returns
   the **existing** `erpn.proposal/v1` shape (`submit_now:false`). A client's
   total is only ever a claim to compare (`CLIENT_AUTHORITY_REJECTED`).
4. **Capability alias (§6.5)** — `capabilities.json` gains a top-level
   `aliases` block mapping `payment.collect → payment.create`; the contract
   resolves aliases to the canonical record (same frozen object, same executor,
   same policy) and the validator fail-closes on a self-alias, a chain, a
   non-WRITE target or a forbidden target. `isForbidden` treats every alias as
   non-executable under its own name, so no second wire can grow.
5. **Chat wiring** — a routed collect question now answers with a handoff
   instead of a dead end (missing amount, no open invoice, blocked/ambiguous
   entity, and the success path all attach a ticket), under all the existing
   guards (entity resolution, authz, rate limit, uncertainty copy).
6. **Flutter data layer only** — `collect_models.dart` (tolerant parsers), a
   `business_handoff` field on `AskResult`, and `proposeCollect()` on the API
   client. **No screen** — `CollectScreen` is Phase 2.

## Impact

- Affected specs: `transaction-contract` (new spec, all ADDED requirements).
- Affected code: `mcp-erpnext/src/{business-handoff,transaction-draft}.mjs`
  (new), `mcp-erpnext/src/{copilot-server,http-ask}.mjs`,
  `mcp-erpnext/src/capability-contract.mjs`, `mcp-erpnext/capabilities.json`,
  `apps/mobile/lib/features/collect/data/collect_models.dart` (new),
  `apps/mobile/lib/features/chat/data/{chat_models,copilot_api_client}.dart`.
- **Not** touched: `safety-gateway.mjs`, `idempotency.mjs`, the existing write
  executors, and the allocation rules of endpoints already wired. `/execute` is
  unchanged, and no new write route exists — a static tripwire test enforces it.
- Out of scope (recorded, not done): the `CollectScreen` UI (Phase 2), full
  confirm-time validation (§6.2 account-type blocking lives with the confirm
  flow), multi-invoice-in-one-collection (lock §6.1 chose one method per
  collection; a split-into-N-documents flow is a separate money-path change),
  and the `payment.collect` alias being advertised in the UI.
- Money path: this change adds **no** way to write. Every number the flow
  displays after this change is read from ERPNext or computed by the server.
