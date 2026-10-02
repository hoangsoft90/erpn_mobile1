## Why

A0 proved the handoff shape with one capability: a payment sentence on the AI route is answered by
the deterministic pipeline (`answerQuestion`), produces the ordinary proposal, and never starts the
runtime. But `DSH_WRITE_HANDOFF_CAPABILITIES` still names only `payment.create`, so every OTHER
wired write (order, quotation, purchase order, delivery, receipt, invoice, return, stock write-off,
customer create) is still refused with `DSH_WRITE_BLOCKED` — the shopkeeper in AI mode is still
told to go back to the normal chat and retype, for sentences the app exists for.

`plan_final.md` §2 draws AI mode as a UX mode, not a per-capability router, and §3.2–§3.3 fix what
every handed-off write must respect: 0 match ⇒ no proposal, >1 match ⇒ a picker, missing
amount/item/qty ⇒ a clarification, 1 match + complete slots ⇒ a proposal carrying the resolved id.
All of that already exists in the pipeline — the guards (`entityPolicy`/`require_picker`),
the `MISSING_ENTITY`/`AMBIGUOUS_ENTITY` refusals, the `PAYMENT_AMOUNT_MISSING`-class slot
refusals and every builder are the SAME code `/ask` runs. The work is the routing decision plus
the proof that those behaviours survive the handoff unchanged.

## What Changes

- **The handoff-able set names every WIRED write capability.** Ten capability ids join
  `payment.create`: the nine document writes plus `customer.create`. `document.delete` is FORBIDDEN
  (`forbidden: true` in the contract) and therefore can NEVER be handed off — the refusal it gets
  is the pipeline's own forbidden refusal, not a new rule. A FUTURE write capability is still
  blocked-by-default: joining the handoff requires naming the id here, which is the one edit
  A1's reviewer should look for.
- **Every handed-off write runs the SAME pipeline code with the SAME guards** — nothing about
  entity resolution, slot refusals or proposal building changes. The A0 route branch is reused
  verbatim: same `write_proposal` metering, same `submit_now:false` DRAFT freeze, same 120s
  deadline, same `handoff: <capability id>` response field (now able to carry any of the eleven
  ids), same `runtime: null`.
- **The in-child gate is untouched.** `blockedInDshContext` keeps refusing every WRITE group for a
  question the runtime drives through its own tool calls — the handoff widens the GATEWAY's
  one-way forwarding only. A question that reaches dsh is still refused with `DSH_WRITE_BLOCKED`
  there (pinned by an existing p5 test).
- **Tests prove the §3.2–§3.3 behaviours THROUGH the AI route**, asserting handoff parity against
  `/ask` rather than re-copying expectations: A5 (duplicate name ⇒ `ENTITY_PICK_REQUIRED` +
  candidates, no proposal), A6 (no party named ⇒ `MISSING_ENTITY`, no proposal), A7 (one match +
  complete slots ⇒ proposal carrying the resolved id, now for a non-payment write too), A10
  (missing amount ⇒ `PAYMENT_AMOUNT_MISSING`, no proposal), plus an explicit-write-set mutation
  guard: any capability not in the set keeps `DSH_WRITE_BLOCKED`.

## Capabilities

### New Capabilities

(none — this widens the routing decision A0 recorded, it does not create a new contract)

### Modified Capabilities

- `dsh-write-handoff` — the handoff-able set grows from `{payment.create}` to every wired write
  capability; the AI runtime's own read-only gate is unchanged; every route-level safeguard
  (metering, deadline, DRAFT freeze) applies to every handed-off capability.

## Impact

- **Files:** `mcp-erpnext/src/dsh-optin.mjs` (the set + its comment) ·
  `test/next7-a0-dsh-write-handoff.test.mjs` (A5/A6/A7/A10 through the AI route) ·
  `test/dsh-gateway.test.mjs` (the non-handoff WRITE example now hands off; the explicit-set guard
  gets `document.delete`) · `scripts/falsify/next7-a0-handoff.mjs` (mutation anchors for the wider
  set) · `test/p5-dsh-optin.test.mjs` (in-child gate still refused — should pass UNCHANGED).
- **NOT touched:** `copilot-server.mjs` (all guards/builders), `/ask`, `/execute`, the Safety
  Gateway, `capabilities.json`, CWD isolation, the session store, Flutter. No new input surface:
  the AI route's body stays `{message, conversation_id}`.
- **Money:** same as A0 — a handoff produces a proposal, never a document. Payment keeps
  `requireExplicitAmount: true`, so "auto full-balance when the amount is missing" stays
  impossible on every route (policy-locked full-balance does not exist on any chat path yet).
