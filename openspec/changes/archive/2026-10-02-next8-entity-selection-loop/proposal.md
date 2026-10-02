## Why

`plan_final_v3.md` §0 documents a measured bug: after a supplier question returns a picker, tapping
a candidate card re-sends the ORIGINAL sentence (`chat_controller.dart` `pickEntity`) and the
backend throws the picked id away for every party that is not a customer
(`copilot-server.mjs` L1270: `if (opts.pickedEntityId && partyKind === "customer")`). The supplier
branch (route group `supplier`, L1104) re-runs `resolveEntityByText` on the same text, matches the
same two suppliers, and returns the same `AMBIGUOUS_SUPPLIER` picker — an infinite loop.

D0 evidence (`.plan/next8/D0-result.md`, probe verbatim, mock ERPNext):

```text
S1 answerQuestion("nhà cung cấp tiên")  → AMBIGUOUS_SUPPLIER + 2 candidates
S2 answerQuestion("nhà cung cấp tiên", {pickedEntityId:"SUP-HATIEN"}) → IDENTICAL to S1
control (customer): same protocol with entity_id=CUST-00001 → id consumed, no loop
```

H6 as stated (`set("supplier")` refused by TTL map) is REJECTED as the loop mechanism — there is no
`set("supplier")` anywhere — but CONFIRMED as a gap the fix needs: `CONTEXT_TTL_MS` holds only
`{customer, invoice}` and `set()` returns `{ok:false, code:"CONTEXT_KIND_UNKNOWN"}` without
throwing; no call site checks `.ok`.

What must NOT be lost: the id the client sends is a HINT, never authority — the server must
re-validate it against the list it just read (the existing customer-path contract,
`pickFromCandidates` + `pickFromCandidatesByText`), and AI mode must stay read-only server-side
(no `submit_now` widening, picker never executes).

## What Changes

- **Supplier branch consumes the picked id** (`copilot-server.mjs` supplier route group): when
  `opts.pickedEntityId` is present, re-validate it against the SAME supplier list the branch just
  read (`pickFromCandidatesByText` with `ENTITY_ACCESSORS.supplier`). A valid id resolves exactly
  one supplier and returns the ordinary detail answer + `read_supplier` proposal; an invalid id is
  refused with a stderr line and the ambiguous/no-match refusal stands (same shape as the customer
  path's `entity pick refused`).
- **Session context gains the `supplier` and `item` kinds** (`session-context.mjs`
  `CONTEXT_TTL_MS`): without them a resume-flow cannot ever be recorded (H6 gap). Every
  `sessionContext.set(...)` call site checks `.ok` and logs a stderr warning on failure instead of
  failing silently. No new session subsystem; keys stay `principal + conversation_id`.
- **AI-mode handoff carries the pick id when the app has one:** the Flutter AI path sends
  `entity_id` alongside `{message, conversation_id}` **only when the user just tapped a picker
  card**, and the `/dsh/ask` handoff branch passes it to `answerQuestionLogged` as
  `pickedEntityId`. `submit_now` stays unread (A0 boundary unchanged); the picker still never
  executes anything.
- **Shared, not supplier-specific:** the resume contract is the same for every entity kind backed by
  a picker (customer already works; supplier/item now consume ids the same way).

## Capabilities

### Modified Specifications

- **`entity-selection`** (new spec file in this change; no spec exists under `openspec/specs/` yet):
  a picker choice MUST terminate the loop — selection is resumed by id, never re-classified into a
  fresh search.

## Impact

- Code: `mcp-erpnext/src/copilot-server.mjs` (supplier branch only), `src/session-context.mjs`
  (+2 TTL kinds), `src/http-ask.mjs` (handoff passes `pickedEntityId`),
  `apps/mobile/lib/features/chat/data/copilot_api_client.dart` (`dshAsk` optional `entityId`),
  `apps/mobile/lib/features/chat/application/chat_controller.dart` (pass the id through in AI mode).
- Not touched: resolver matching, LLM classifier, session architecture, next6 isolation, the
  in-child DSH write gate, picker self-execution.
- Tests: `p2-context-uncertainty` (kind addition), a new supplier-pick E2E (the S1→S2 probe as a
  pinned regression), AI-mode handoff id E2E, falsify (drop the supplier id consumption → the loop
  test must go RED).
