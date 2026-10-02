# next7 / A0 — tasks

## 1. The handoff-able set (one place, explicit)

- [x] `dsh-optin.mjs`: `DSH_WRITE_HANDOFF_CAPABILITIES = new Set(["payment.create"])` next to the
      derived `WRITE_ROUTE_GROUPS`, with a comment naming A1 as the place it widens. A capability is
      handoff-able ONLY by being listed here — never because a route looks write-shaped.
- [x] `DSH_WRITE_HANDOFF_CODE = "DSH_WRITE_HANDOFF"`.

## 2. Gate reports the handoff instead of refusing (layer 1)

- [x] `dshQuestionGate`: a route whose capability is handoff-able returns
      `{ok:false, code: DSH_WRITE_HANDOFF_CODE, handoff:true, reason, matched}` — the `ok:false` keeps
      "this turn does not run dsh" honest for every existing caller.
- [x] Every OTHER WRITE keeps `DSH_WRITE_BLOCKED`, unchanged.
- [x] `dshGatewayAsk`: the handoff verdict returns `{ok:false, httpStatus:200, handoff:true, …}` and
      **never spawns dsh** (same shape as today's refusal: a normal answer, not a server error).
- [x] One audit line with a DISTINCT outcome so an operator can count handoffs apart from refusals.

## 3. The route performs the handoff

- [x] `http-ask.mjs` `/dsh/ask`: on `outcome.handoff` → `answerQuestionLogged(text, {principal, company,
      env, correlation, submitNow:false})` with a server-side deadline, exactly like `/ask`.
- [x] Charge the `write_proposal` bucket when the result carries one (`proposalBucketFor`) — parity
      with `/ask`, so AI mode is never a cheaper route to a `command_id`.
- [x] Respond `{ok:true, mode:"dsh", handoff:"payment.create", erp_target, result}` — `result` is the
      same object `/ask` returns (proposal included) so A3 can render the existing card.
- [x] `submit_now` is NOT accepted from the AI route's body: a proposal made there is always a DRAFT
      snapshot (documented in code).
- [x] Fix the now-stale comment claiming this route never reaches `answerQuestion`.

## 4. Tests

- [x] A1: `/dsh/ask` "thu tiền [khách 1-match] 1000" (mock ERP) → `ok:true`, `result.proposal`
      non-null, `handoff` marked, `erp_target` present, and dsh was never spawned.
- [x] Slot gap: "thu tiền chị Lan" (no amount) → a clarification, NOT a full proposal (§3.3/A10 shape).
- [x] A3: `/dsh/ask` "cách nuôi lợn" → `DSH_OFF_TOPIC`, unchanged, no handoff.
- [x] READ question → still the dsh path (no handoff).
- [x] A non-payment WRITE is NOT handed off (gate still refuses/blocks) — proves the set is explicit.
- [x] `dshGatewayAsk` handoff writes exactly ONE audit line with the handoff outcome and spawns nothing.
- [x] Rate-limit parity: the handoff charges the write-proposal bucket.
- [x] Update the two existing `dsh-gateway.test.mjs` tests that pin the old payment refusal.

## 5. Falsify

- [x] Mutate the handoff (remove the route branch / widen the set / drop the metering) → the NAMED test
      goes red, restore byte-identical.

## 6. Out of scope (named, not silently dropped)

- [ ] Widening to every WRITE capability, entity picker, and slot/clarification polish — A1.
- [ ] Execute binding, idempotency, session note — A2.
- [ ] Flutter mode-bar copy + the AI card render — A3.
- [ ] `submit_now` on the AI route — A2 (execute/submit policy).
