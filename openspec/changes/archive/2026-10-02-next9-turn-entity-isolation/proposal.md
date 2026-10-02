# next9 / Turn entity isolation — a WRITE never binds a party the sentence did not name

## Why

`.plan/next9/plan-debug.md` reports a production incident with three symptoms:

- **A** — after an earlier sentence about customer *Lan*, `"thu tiền Lê lợi 10000"`
  built a payment for **Lan** (the wrong payer on a money document);
- **B** — that bubble also showed the previous turn's own outcome line;
- **C** — killing the app appeared to "fix" it.

**Measured root cause of A** (`scripts/debug-next9-probe.mjs`, 2026-09-28 —
same-process / reset / fresh modes):

```
Turn 0  "công nợ của Nguyễn Thị Lan"   → context: CUST-00001 (user_selected)
Turn 1  "thêm khách Lê Lợi" → /execute → CUST-M001 created
Turn 2  "thu tiền Lê lợi 10000"
        RESOLVED party : CUST-M001  (Lê Lợi)      ← the resolver was RIGHT
        BOUND party    : CUST-00001 (Nguyễn Thị Lan) ← the WRITE was WRONG
```

The WRITE path replaced the party the sentence had **just resolved** with the
customer remembered in the server-side session context — unconditionally:

```js
const ctx = sessionContext.writeEligible("customer", { scope: contextScopeFor(opts) });
if (ctx.eligible) { customerId = ctx.context.value; customerName = …; }
```

Two measured facts make this strictly harmful and never helpful:

1. **Only EXACT/picked resolutions reach it.** `!partyRow`, the `block` policy
   (NO_MATCH ⇒ block for every customer-party write) and `require_picker`
   (fuzzy/ambiguous) all return *before* the builder — so the code could only
   ever REPLACE a correct party with an older, different one.
2. **Its intended use case is unreachable.** A nameless follow-up
   (`"thu tiền 500000"`) resolves to NO_MATCH and is refused with
   `MISSING_ENTITY` **today, with or without** a remembered customer (measured).
   The "remembered customer" therefore never rescued anything.

**Root cause of B (independent, client-side)** — the chat list is a KEYLESS
`ListView.builder`, while the cards keep their outcome in local State
(`ProposalCard._result`). `ChatHistoryService.trimTurns` drops the oldest turn
once the history passes `maxChatItems` (user-configurable, floor 5), so the list
shifts; Flutter then matches children by INDEX and hands one turn's card element
to another turn, whose bubble renders `"Đã tạo khách hàng: <tên>"`.

**C** is explained by A being in-memory **server-side** state scoped to
`<user>\u0000default` — the classic `/ask` route never sends `conversation_id`,
so the app cannot clear it by restarting; only the gateway process restarting or
the 30-minute TTL ends it. The fix removes the dependency on that entirely.

## What Changes

1. **The WRITE path no longer consumes the remembered customer**
   (`copilot-server.mjs`). Reaching the builder means the sentence's own
   resolution is authoritative (EXACT, or a row the user picked); the invariant
   becomes *asked X ⇒ use X; X not found ⇒ say so*.
2. **The chat list keys its children by the turn** (`chat_screen.dart`,
   `ChatTurn.key` in `chat_models.dart`) so a shifting history can never hand a
   confirmed card's outcome to another turn's bubble.
3. **No new behaviour, no new surface.** Nothing is added to the resolver,
   the contract, the DSH path, or the API. Session-context *recording* is
   untouched (the store, its TTLs and the next6 isolation tests are unchanged).

## Impact

- Affected specs: `entity-selection` (ADDED requirement: a WRITE binds only the
  party the sentence resolved; a remembered entity is never a WRITE's authority).
- Affected specs (chat list, Symptom B): `chat-client` (ADDED requirements: each
  turn has a stable identity; a card's outcome never moves to another turn's
  bubble).
- Affected code: `mcp-erpnext/src/copilot-server.mjs` (delete the substitution),
  `apps/mobile/lib/features/chat/{presentation/screens/chat_screen.dart,data/chat_models.dart}`
  (turn-keyed list).
- Tests: new `mcp-erpnext/test/next9-turn-isolation.test.mjs` (TDD red→green,
  plan-debug Test A–F) + `apps/mobile/test/next9_turn_isolation_test.dart`
  (widget-level mechanism).
- Out of scope (recorded, not fixed): the session-context store now has no
  reader in the pipeline — it is written only. Removing it entirely (and the
  next8 supplier/item TTL work) is a follow-up decision for the user.
- Money path: this change REMOVES a wrong-payer path; no write executor,
  idempotency key or authorization rule is touched.
