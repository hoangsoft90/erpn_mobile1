/**
 * P1 units — the parts of "Entity + execution reliability + resilience" that
 * can be proven WITHOUT a live ERPNext:
 *
 *  - entity resolution states + the contract policy (WRITE is exact-only);
 *  - the immutable-snapshot gate vs the TTL gate (different codes, different UX);
 *  - drift classification (data moved vs the entity itself is gone);
 *  - the execution state machine (illegal transitions refused, unknown →
 *    RECONCILING);
 *  - business-level dedup (warn + extra confirm, never a silent block);
 *  - "no amount in the sentence" ⇒ refuse, never collect the whole debt.
 *
 * Money-adjacent, so every rule here has a falsifiable assertion rather than a
 * comment.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENTITY_STATES,
  classifyResolution,
  entityPolicy,
  pickFromCandidates,
  pickerForText,
} from "../src/entity-resolution.mjs";
import { getCapability, __contract, validateContract } from "../src/capability-contract.mjs";
import { assertProposalSnapshot, assertFresh, classifyDriftCode, PROPOSAL_VERSION } from "../src/proposal-freshness.mjs";
import {
  EXECUTION_STATES,
  TERMINAL_STATES,
  UNKNOWN_EXECUTION_STATE,
  assertTransition,
  canTransition,
  mapStoreStatus,
} from "../src/execution-state.mjs";
import { BusinessDedupLedger, annotateBusinessDedup, businessFingerprint, requiresDedupAck } from "../src/business-dedup.mjs";
import { buildPaymentProposal } from "../src/skills/payment-write.mjs";

const LAN = { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" };
const HAI = { name: "CUST-00002", customer_name: "Trần Văn Hai" };

// ───────────────────────────── entity states (§4.1–§4.3) ─────────────────────

test("P1 §4.1: the four resolution states are named, and a fuzzy hit is NOT exact", () => {
  // "chị Lan" only matches "Nguyễn Thị Lan" as a SUBSTRING.
  const fuzzy = classifyResolution(
    { customer: LAN, ambiguous: false, candidates: [] },
    { candidates: ["chị lan", "lan"] },
  );
  assert.equal(fuzzy.state, ENTITY_STATES.FUZZY_SINGLE_MATCH);
  assert.equal(fuzzy.fuzzy, true);

  const exact = classifyResolution(
    { customer: LAN, ambiguous: false, candidates: [] },
    { candidates: ["nguyễn thị lan", "lan"] },
  );
  assert.equal(exact.state, ENTITY_STATES.EXACT_MATCH);
  assert.equal(exact.fuzzy, false);

  const ambiguous = classifyResolution({ customer: HAI, ambiguous: true, candidates: ["Hai", "Hằng"] }, {});
  assert.equal(ambiguous.state, ENTITY_STATES.AMBIGUOUS_MATCH);

  const none = classifyResolution({ customer: null, ambiguous: false, candidates: [] }, {});
  assert.equal(none.state, ENTITY_STATES.NO_MATCH);
  const noneAmbiguous = classifyResolution({ customer: null, ambiguous: true, candidates: ["Hai"] }, {});
  assert.equal(noneAmbiguous.state, ENTITY_STATES.AMBIGUOUS_MATCH);
});

test("P1 §4.3/§8: the CONTRACT forbids auto-selecting a fuzzy customer for a WRITE (and the loader enforces it)", () => {
  const write = getCapability("payment.create");
  const rule = entityPolicy(ENTITY_STATES.FUZZY_SINGLE_MATCH, write, __contract.defaults.entity_policy);
  assert.equal(rule.auto_select, false, "a write must not auto-select a fuzzy match");
  assert.equal(rule.require_picker, true);
  assert.equal(rule.code, "ENTITY_PICK_REQUIRED");

  // A READ may still auto-select (plan2_final §4.3: READ LOW uses policy+threshold).
  const read = getCapability("customer.balance");
  assert.equal(entityPolicy(ENTITY_STATES.FUZZY_SINGLE_MATCH, read, __contract.defaults.entity_policy).auto_select, true);

  // No match: block for a write, clarify (not blocked) for a read.
  assert.equal(entityPolicy(ENTITY_STATES.NO_MATCH, write, __contract.defaults.entity_policy).block, true);
  assert.equal(entityPolicy(ENTITY_STATES.NO_MATCH, read, __contract.defaults.entity_policy).block, false);

  // FAIL-CLOSED: a state the policy does not cover is refused, not allowed.
  assert.equal(entityPolicy("SOMETHING_NEW", write, __contract.defaults.entity_policy).block, true);

  // The loader refuses a contract that relaxes the write rule — the policy
  // cannot be edited away in JSON without breaking startup.
  const relaxed = JSON.parse(JSON.stringify(__contract));
  relaxed.capabilities["payment.create"].entity_policy.FUZZY_SINGLE_MATCH.auto_select = true;
  assert.throws(() => validateContract(relaxed), /Fuzzy|FUZZY_SINGLE_MATCH.*auto_select|forbids auto-selecting/i);

  // ...and one that deletes a state entirely.
  const missing = JSON.parse(JSON.stringify(__contract));
  delete missing.capabilities["payment.create"].entity_policy.AMBIGUOUS_MATCH;
  assert.throws(() => validateContract(missing), /entity_policy is missing state/);
});

test("P1 §4.2/§4.4: the picker offers real customers, and an invented id is refused", () => {
  const list = [LAN, HAI, { name: "CUST-00003", customer_name: "Trang trại Minh Anh" }];
  const offered = pickerForText(list, ["trang trại minh anh", "lan", "anh"]);
  assert.equal(offered[0].id, "CUST-00003", "the longest fragment wins — the real 'Trang trại' customer");
  assert.ok(offered.some((c) => c.id === "CUST-00001"));

  assert.equal(pickFromCandidates(list, "CUST-00002").ok, true);
  assert.equal(pickFromCandidates(list, "CUST-00002").customer.customer_name, "Trần Văn Hai");
  // An id that is not in the list we just read from ERPNext never becomes valid.
  assert.equal(pickFromCandidates(list, "CUST-INVENTED").ok, false);
  assert.equal(pickFromCandidates(list, "").ok, false);
  assert.equal(pickFromCandidates(list, null).ok, false);
});

// ───────────────────────── snapshot vs TTL (§9, §12) ─────────────────────────

test("P1 §9/§12: EXPIRED (time) and VERSION_STALE (snapshot) are DIFFERENT codes with different behaviour", () => {
  const good = { proposal_id: "prp_x", version: PROPOSAL_VERSION, created_at: new Date().toISOString() };
  assert.equal(assertProposalSnapshot(good).ok, true);
  assert.equal(assertFresh(good).ok, true);

  // Missing version / proposal_id ⇒ the executor would read fields this code
  // never validated ⇒ version-stale, NOT expired.
  const noVersion = { ...good, version: undefined };
  assert.equal(assertProposalSnapshot(noVersion).code, "PROPOSAL_VERSION_STALE");
  assert.equal(assertProposalSnapshot({ ...good, proposal_id: "" }).code, "PROPOSAL_VERSION_STALE");
  assert.equal(assertProposalSnapshot({ ...good, version: PROPOSAL_VERSION - 1 }).code, "PROPOSAL_VERSION_STALE");
  // The snapshot check does not care about time, and the TTL check does not care
  // about the snapshot — that is what makes them separable behaviours.
  assert.equal(assertFresh(noVersion).ok, true, "a fresh-but-unversioned proposal is refused by the snapshot gate");
  const old = { ...good, created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() };
  assert.equal(assertProposalSnapshot(old).ok, true);
  assert.equal(assertFresh(old).code, "PROPOSAL_EXPIRED");
});

test("P1 §12: drift is classified — the entity being gone is NOT the same as the data moving", () => {
  assert.equal(
    classifyDriftCode(["nợ lúc tạo đề xuất 1 ≠ nợ hiện tại 2"]),
    "PROPOSAL_VERSION_STALE",
  );
  assert.equal(
    classifyDriftCode(["chứng từ không còn thuộc khách CUST-00001 (nay là CUST-00002)"]),
    "PROPOSAL_ENTITY_CHANGED",
  );
});

// ───────────────────────── state machine (§10.1–§10.2) ───────────────────────

test("P1 §10.1: the state machine refuses illegal transitions (a state machine that allows everything guarantees nothing)", () => {
  assert.equal(canTransition("PROPOSED", "WAITING_CONFIRM"), true);
  assert.equal(canTransition("WAITING_CONFIRM", "CONFIRMED"), true);
  assert.equal(canTransition("CONFIRMED", "EXECUTING"), true);
  assert.equal(canTransition("EXECUTING", "RECONCILING"), true);
  assert.equal(canTransition("RECONCILING", "VERIFIED"), true);

  // The transition that would mean a double write.
  assert.equal(canTransition("VERIFIED", "EXECUTING"), false);
  assert.throws(() => assertTransition("VERIFIED", "EXECUTING"), /EXECUTION_TRANSITION_INVALID/);
  // Nothing follows a terminal state.
  for (const terminal of TERMINAL_STATES) {
    for (const s of Object.keys(EXECUTION_STATES)) {
      assert.equal(canTransition(terminal, s), false, `${terminal} must be final`);
    }
  }
  // A typo'd state is refused rather than silently treated as a fresh one.
  assert.throws(() => assertTransition("DONE", "VERIFIED"), /EXECUTION_STATE_UNKNOWN/);
});

test("P1 §10.2: an unknown execution state becomes RECONCILING, not FAILED", () => {
  assert.equal(UNKNOWN_EXECUTION_STATE, EXECUTION_STATES.RECONCILING);
  // A PENDING command whose document existence is unproven IS the unknown case.
  assert.equal(mapStoreStatus("PENDING", { referenceRegistered: true, verified: false }), EXECUTION_STATES.RECONCILING);
  assert.equal(mapStoreStatus("PENDING", { referenceRegistered: false }), EXECUTION_STATES.EXECUTING);
  assert.equal(mapStoreStatus("COMPLETED"), EXECUTION_STATES.VERIFIED);
  assert.equal(mapStoreStatus("FAILED"), EXECUTION_STATES.FAILED);
  assert.equal(mapStoreStatus("CANCELLED"), EXECUTION_STATES.CANCELLED);
  assert.equal(mapStoreStatus(undefined), EXECUTION_STATES.PROPOSED);
  // ...and RECONCILING may reach VERIFIED, which is the point: the lookup decides.
  assert.equal(canTransition(EXECUTION_STATES.RECONCILING, EXECUTION_STATES.VERIFIED), true);
});

// ───────────────────────── business dedup (§10.5) ────────────────────────────

test("P1 §10.5: same real intent in the window ⇒ warn + extra confirm (a different command_id does NOT hide it)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dedup-"));
  try {
    const ledger = new BusinessDedupLedger(dir);
    const mk = (id) => ({
      proposal_id: `prp_${id}`,
      action: "create_payment_entry",
      entity: { id: "CUST-00001" },
      params: { amount_vnd: 5_000_000, invoice: "SINV-0001", outstanding_vnd: 5_000_000 },
    });
    const now = Date.now();

    // Same customer+amount+capability inside the bucket ⇒ identical fingerprint
    // even though these are two DIFFERENT proposals (different command_ids).
    const fpA = businessFingerprint(mk("a"), { now });
    const fpB = businessFingerprint(mk("b"), { now: now + 60_000 });
    assert.equal(fpA, fpB);

    // A different amount, or the next time bucket, is a different intent.
    const fpOther = businessFingerprint({ ...mk("c"), params: { ...mk("c").params, amount_vnd: 6_000_000 } }, { now });
    assert.notEqual(fpA, fpOther);
    assert.notEqual(fpA, businessFingerprint(mk("d"), { now: now + 16 * 60 * 1000 }));

    // First proposal: nothing to ask about.
    const first = annotateBusinessDedup(mk("a"), ledger, { now });
    assert.equal(first.business_dedup.require_extra_confirm, false);

    // It is recorded (proposed is enough — the intent is visible), then the
    // second one is warned about instead of silently accepted.
    ledger.record({ fingerprint: fpA, phase: "proposed", proposal_id: "prp_a", ts: now });
    const second = annotateBusinessDedup(mk("b"), ledger, { now: now + 120_000 });
    assert.equal(second.business_dedup.require_extra_confirm, true);
    assert.deepEqual(second.business_dedup.duplicate_of, ["prp_a"]);
    assert.equal(requiresDedupAck(second), true);
    assert.equal(requiresDedupAck(first), false);
    assert.match(second.business_dedup.message, /cùng một giao dịch/);

    // Outside the window it is no longer a duplicate (older intents age out).
    const later = annotateBusinessDedup(mk("c"), ledger, { now: now + 20 * 60 * 1000 });
    assert.equal(later.business_dedup.require_extra_confirm, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1 §10.5: a proposal with no amount has no fingerprint (nothing to guard) — never a false duplicate", () => {
  assert.equal(businessFingerprint({ action: "create_payment_entry", entity: { id: "CUST-00001" }, params: {} }), null);
  assert.equal(businessFingerprint({ action: "create_payment_entry", params: { amount_vnd: 1000 } }), null);
});

// ───────────────────────── no guessed amount (§13) ───────────────────────────

test("P1 §13: the interactive write path REFUSES a missing amount instead of collecting the whole debt", async () => {
  // A skills stub that returns one open invoice: this is the shape
  // buildPaymentProposal() reads, so the test exercises the real builder.
  const skills = {
    listUnpaidInvoices: async () => ({
      data: { data: [{ name: "SINV-0001", outstanding_amount: 2_500_000, posting_date: "2026-01-01" }] },
    }),
  };
  const customer = { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" };

  // No requireExplicitAmount (the programmatic caller) keeps the documented
  // full-balance default...
  const full = await buildPaymentProposal(skills, { customer }, {});
  assert.equal(full.proposal.params.amount_vnd, 2_500_000);
  assert.equal(full.proposal.params.amount_source, "full_balance");

  // ...but the interactive path (an utterance whose number the parser missed)
  // must not silently become a full-debt payment.
  await assert.rejects(
    () => buildPaymentProposal(skills, { customer }, { requireExplicitAmount: true }),
    (err) => err.code === "PAYMENT_AMOUNT_MISSING",
  );

  // An explicit amount is still honoured, and recorded as such.
  const explicit = await buildPaymentProposal(skills, { customer }, { amount_vnd: 500_000, requireExplicitAmount: true });
  assert.equal(explicit.proposal.params.amount_vnd, 500_000);
  assert.equal(explicit.proposal.params.amount_source, "explicit");
});
