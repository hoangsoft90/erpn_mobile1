## Why

`plan_final.md` §2 draws the AI mode as a UX mode, not a router: a WRITE question asked in
"Phân tích bằng AI" is *supposed* to hand off to the deterministic pipeline
(`answerQuestion()`), produce an ordinary proposal, and get its own `[Xác nhận]` — not be refused.
§3.1 states it as the flow: `POST /dsh/ask → routeIntent → WRITE? → answerQuestion() // cùng /ask`.

What the code does today is the opposite. `dshQuestionGate` refuses a payment question with
`DSH_WRITE_BLOCKED` *before* the runtime is even started (`dsh-gateway.mjs:501-509`), and the route
turns that into `{refused:true}` (`http-ask.mjs:638`). So the shopkeeper in AI mode is told to go
back to the normal chat and re-type the sentence — the copy UI is even built around telling them to.
That is safe but it is not what §2/§3 specify, and it makes the AI mode useless for exactly the
sentences this app exists for (thu tiền / ghi nhận thanh toán).

The safety property that must NOT be lost: in AI mode **nothing may be written without a human
confirm**, and the AI runtime must never gain a write capability. The handoff satisfies that better
than a refusal does, because the proposal it produces is the *same object* `/ask` produces — it
still needs its own `[Xác nhận]`, still travels `/execute` → Safety Gateway, and is still metered
against the same write-proposal rate limit.

## What Changes

- **Layer 1 (the gateway pre-screen) stops refusing payment; it reports a HANDOFF.** A payment-shaped
  question routes to `DSH_WRITE_HANDOFF` instead of `DSH_WRITE_BLOCKED`, and the gateway does **not**
  spawn dsh for it — no runtime cost, no LLM, no `copilot_ask`.
- **The `/dsh/ask` ROUTE performs the handoff** by calling the very same `answerQuestionLogged` the
  `/ask` route calls, so the answer is byte-for-byte what the normal chat would have produced: same
  pipeline, same proposal/proposal-snapshot, same Vietnamese clarification when a slot is missing
  (`thu tiền chị Lan` with no amount ⇒ a clarification, never a half-filled card — §3.3).
- **Rate-limit parity, deliberately:** a handoff charges the `write_proposal` bucket exactly as `/ask`
  does, so AI mode cannot become a cheaper way to obtain a `command_id` than the normal chat.
- **`submit_now` is NOT read from the AI route.** `/dsh/ask`'s body stays `{message, conversation_id}`;
  the handoff passes `submit_now: false`, so anything later confirmed from AI mode creates a DRAFT and
  the card says so. Widening the AI route's input surface to carry a submit policy is not this change's
  business (A2 owns execute/submit binding).
- **Only `payment.create` is handoff-able in A0.** Every other WRITE stays exactly as it is today
  (the in-child gate `blockedInDshContext` still refuses them), so a new WRITE capability can never
  become reachable from AI mode without an explicit edit — the failure mode `dsh-optin.mjs` already
  warns about. A1 widens the set.
- **Defence in depth is retained, not weakened:** the in-child gate (`dsh-optin.mjs`, layer 2) is
  untouched. If a payment question ever reaches the copilot child through dsh's own tool calls, it is
  still refused there. The gateway can only make dsh MORE restricted; the route's handoff means dsh is
  never asked to handle the write at all.

## Capabilities

### New Capabilities

- `dsh-write-handoff` — the AI mode's handling of a WRITE question: hand off to the deterministic
  pipeline, never write from the AI runtime, never lose the confirm step.

### Modified Capabilities

(none — no capability contract / `capabilities.json` change; this is a routing decision)

## Impact

- **Files:** `mcp-erpnext/src/dsh-optin.mjs` (the handoff-able set, next to the WRITE groups) ·
  `src/dsh-gateway.mjs` (`dshQuestionGate` verdict + `dshGatewayAsk` pass-through + one audit outcome) ·
  `src/http-ask.mjs` (`/dsh/ask` handoff branch + the now-stale "never routes to answerQuestion"
  comment) · `test/next7-a0-dsh-write-handoff.test.mjs` (new) · two existing tests in
  `test/dsh-gateway.test.mjs` that pin the old payment refusal.
- **Public shape touched:** a new machine code `DSH_WRITE_HANDOFF` (and a response field marking the
  handoff) — additive; `DSH_WRITE_BLOCKED` keeps its meaning everywhere it still applies.
- **NOT touched:** `/ask` (no dsh branch is added to it — D2 still holds), the in-child
  `blockedInDshContext`, `capabilities.json`, the Safety Gateway, `/execute`, CWD isolation, the DSH
  session store. No new session subsystem. No Flutter change (the card render is A3).
- **Money:** a handoff produces a proposal, never a document. Nothing here can write.
