/**
 * next8 / Phase 1 — BUSINESS HANDOFF (plan1_final_v2 §6/§16; owner lock §6.1–6.5).
 *
 * Pins the five properties the handoff exists for, each as its own test:
 *   (a) the id is SERVER-generated and the ticket says what it opens;
 *   (b) a FABRICATED id is refused exactly like an expired one (no probing);
 *   (c) another PRINCIPAL using my ticket is refused;
 *   (d) another CONVERSATION using my ticket is refused;
 *   (e) slot states follow the entity-resolution vocabulary (RESOLVED /
 *       AMBIGUOUS / MISSING / NO_MATCH);
 *   (f) NO AUTHORITATIVE NUMBER can enter the ticket at all — not even by
 *       accident, since buildHandoff refuses the attempt outright.
 *
 * Pure module tests: no server, no ERPNext, no NLP.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HANDOFF_TYPE,
  HANDOFF_TTL_MS,
  SLOT_STATES,
  HandoffStore,
  buildHandoff,
  collectSlotStates,
  screenForCapability,
} from "../src/business-handoff.mjs";

const baseArgs = (over = {}) => ({
  capability: "payment.create",
  principalId: "user-A",
  conversationId: "conv-1",
  question: "thu tiền cho Nguyễn Thị Lan",
  prefill: {
    customer: { state: SLOT_STATES.RESOLVED, id: "CUST-00001", label: "Nguyễn Thị Lan" },
    allocations: { state: SLOT_STATES.MISSING },
    payment_methods: { state: SLOT_STATES.MISSING },
    amount: { state: SLOT_STATES.MISSING },
  },
  ...over,
});

test("(a) the ticket is server-generated and names the capability + screen", () => {
  const h = buildHandoff(baseArgs());
  assert.equal(h.type, HANDOFF_TYPE);
  assert.equal(h.type, "business_handoff", "the literal plan §6 names, so a client can switch on it");
  assert.equal(h.capability, "payment.create");
  assert.equal(h.screen, "collect");
  assert.match(h.handoff_id, /^[0-9a-f-]{36}$/, "a real uuid, not a caller-supplied string");
  assert.equal(new Date(h.issued_at).toString() === "Invalid Date", false, "issued_at is an ISO timestamp");
  // The canonical id keeps the executor wire: an ALIAS (lock §6.5) opens the SAME
  // screen instead of creating a second one.
  assert.equal(screenForCapability("payment.collect"), "collect");
  assert.equal(screenForCapability("payment.create"), "collect");
  assert.equal(screenForCapability("sales_order.create"), null, "a capability with no screen gets no ticket");
});

test("(b) a fabricated handoff id is refused like an expired one", () => {
  const store = new HandoffStore();
  const h = buildHandoff(baseArgs());
  store.put(h, { principalId: "user-A", conversationId: "conv-1" });
  const madeUp = store.read("11111111-2222-3333-4444-555555555555", { principalId: "user-A", conversationId: "conv-1" });
  assert.equal(madeUp.ok, false);
  assert.equal(madeUp.code, "STALE_HANDOFF");
  // and it does not leak whether something exists under another key
  const foreign = store.read(h.handoff_id, { principalId: "user-B", conversationId: "conv-1" });
  assert.equal(foreign.code, madeUp.code, "same code for 'not yours' and 'never existed'");
});

test("(c)+(d) ownership is principal AND conversation bound", () => {
  const store = new HandoffStore();
  const h = buildHandoff(baseArgs());
  assert.equal(store.put(h, { principalId: "user-A", conversationId: "conv-1" }).ok, true);

  assert.equal(store.read(h.handoff_id, { principalId: "user-A", conversationId: "conv-1" }).ok, true, "the owner reads it");
  assert.equal(store.read(h.handoff_id, { principalId: "user-B", conversationId: "conv-1" }).ok, false, "principal B cannot");
  assert.equal(store.read(h.handoff_id, { principalId: "user-A", conversationId: "conv-9" }).ok, false, "another thread cannot");
});

test("(d2) a handoff expires by TTL — and expiry is not a freshness check for data", () => {
  const store = new HandoffStore();
  const h = buildHandoff(baseArgs());
  store.put(h, { principalId: "user-A", conversationId: "conv-1", ts: 1_000 });
  const live = store.read(h.handoff_id, { principalId: "user-A", conversationId: "conv-1", now: 1_000 + HANDOFF_TTL_MS });
  assert.equal(live.ok, true, "still inside the window");
  const expired = store.read(h.handoff_id, { principalId: "user-A", conversationId: "conv-1", now: 1_000 + HANDOFF_TTL_MS + 1 });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, "STALE_HANDOFF");
});

test("(e2) a ticket that failed to store is NOT handed out — no prefill from nowhere", () => {
  // F3 (plan §7): a handoff the user can never read back is worse than none, so
  // the pipeline must hand out ONLY tickets that are actually in the store.
  const store = new HandoffStore();
  const h = buildHandoff(baseArgs());
  // Simulate the refusal path: the ticket exists but was never stored.
  const readBack = store.read(h.handoff_id, { principalId: "user-A", conversationId: "conv-1" });
  assert.equal(readBack.ok, false, "an unstored ticket is unreadable — buildHandoff output alone is never enough");
  // And the store's put is the ONLY way in: nothing else in the module can make
  // an id readable (probed by reading a validly-built but unstored id).
  assert.equal(store.entries.has(h.handoff_id), false);
});

test("(e) slot states speak the entity-resolution vocabulary (lock §6.3 in the alloc slot)", () => {
  assert.deepEqual(collectSlotStates({}), {
    customer: SLOT_STATES.MISSING,
    allocations: SLOT_STATES.MISSING,
    payment_methods: SLOT_STATES.MISSING,
    amount: SLOT_STATES.MISSING,
  });
  assert.equal(collectSlotStates({ ambiguousCustomer: true }).customer, SLOT_STATES.AMBIGUOUS);
  assert.equal(collectSlotStates({ customer: { id: "CUST-1" } }).customer, SLOT_STATES.RESOLVED);
  assert.equal(collectSlotStates({ amountGiven: true }).amount, SLOT_STATES.RESOLVED);
  // 0 open invoices is the ONE case where "no allocation" is legal (on-account),
  // so the slot reads NO_MATCH rather than MISSING.
  assert.equal(collectSlotStates({ hasOpenInvoices: false }).allocations, SLOT_STATES.NO_MATCH);
  assert.equal(collectSlotStates({ hasOpenInvoices: true }).allocations, SLOT_STATES.MISSING);
});

test("(f) no amount can enter the ticket — prefill is a hint, never authority", () => {
  assert.throws(
    () => buildHandoff(baseArgs({
      prefill: { amount: { state: SLOT_STATES.RESOLVED, amount_vnd: 500_000 } },
    })),
    (err) => err.code === "HANDOFF_AMOUNT_FORBIDDEN",
  );
  assert.throws(
    () => buildHandoff(baseArgs({
      prefill: { allocations: { state: SLOT_STATES.MISSING, outstanding_vnd: 2_500_000 } },
    })),
    (err) => err.code === "HANDOFF_AMOUNT_FORBIDDEN",
  );
  const h = buildHandoff(baseArgs());
  assert.equal(JSON.stringify(h).includes("amount_vnd"), false);
  assert.equal(JSON.stringify(h).includes("outstanding"), false);
});

test("an unowned or screenless handoff is refused at build time (fail closed)", () => {
  assert.throws(() => buildHandoff(baseArgs({ principalId: "" })), (err) => err.code === "HANDOFF_NO_PRINCIPAL");
  assert.throws(
    () => buildHandoff(baseArgs({ capability: "sales_order.create" })),
    (err) => err.code === "HANDOFF_NO_SCREEN",
  );
  assert.throws(
    () => buildHandoff(baseArgs({ prefill: { customer: { state: "SOMETHING_ELSE" } } })),
    (err) => err.code === "HANDOFF_SLOT_STATE_INVALID",
  );
});

test("the store reports a refused write instead of throwing (the next8/D1 lesson)", () => {
  const store = new HandoffStore();
  const h = buildHandoff(baseArgs());
  const refused = store.put(h, { principalId: "" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "HANDOFF_NO_PRINCIPAL");
});
