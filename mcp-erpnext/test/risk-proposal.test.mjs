/**
 * Phase 6 tests — Risk Level schema + Action Proposal object.
 *
 * Safety properties under test:
 *  1. The four levels exist, are frozen, and riskFor() classifies its verbs.
 *  2. buildProposal() refuses incomplete proposals (no action/entity/risk).
 *  3. assertProposalAllowed() blocks anything above READ from executing —
 *     Phase 6 stops at display; the Phase 7 confirmation flow flips this.
 *  4. Proposals freeze: callers cannot mutate risk after the fact.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  RISK_LEVELS,
  RISK_ORDER,
  RISK_DISPLAY,
  riskFor,
  isExecutable,
  assertProposalAllowed,
} from "../src/risk-levels.mjs";
import { buildProposal, readProposal } from "../src/action-proposal.mjs";

test("exactly the four spec levels exist, frozen", () => {
  assert.deepEqual(RISK_ORDER, ["READ", "LOW", "HIGH", "CRITICAL"]);
  for (const level of RISK_ORDER) {
    assert.equal(Object.isFrozen(RISK_LEVELS), true);
    assert.ok(RISK_DISPLAY[level].label.length > 0, `${level} has a display label`);
  }
  // needConfirm ladder: READ never, LOW/HIGH single, CRITICAL double.
  assert.equal(RISK_DISPLAY.READ.needConfirm, false);
  assert.equal(RISK_DISPLAY.LOW.needConfirm, true);
  assert.equal(RISK_DISPLAY.HIGH.needConfirm, true);
  assert.equal(RISK_DISPLAY.CRITICAL.needDoubleConfirm, true);
});

test("riskFor classifies write verbs HIGH/CRITICAL and reads stay READ", () => {
  assert.equal(riskFor("read_balance"), RISK_LEVELS.READ);
  assert.equal(riskFor("read_stock_balance"), RISK_LEVELS.READ);
  assert.equal(riskFor("read_payment_history"), RISK_LEVELS.READ);
  // Phase 7 verbs already mapped — the schema is complete before the write exists.
  assert.equal(riskFor("create_payment_entry"), RISK_LEVELS.HIGH);
  assert.equal(riskFor("create_sales_invoice"), RISK_LEVELS.HIGH);
  assert.equal(riskFor("submit_sales_invoice"), RISK_LEVELS.HIGH);
  assert.equal(riskFor("cancel_sales_invoice"), RISK_LEVELS.CRITICAL);
  assert.equal(riskFor("delete_payment_entry"), RISK_LEVELS.CRITICAL);
});

test("buildProposal produces the frozen v1 schema with derived risk", () => {
  const p = buildProposal({
    action: "read_balance",
    entity: { kind: "customer", id: "CUST-00001", name: "Nguyễn Thị Lan" },
    params: { outstanding_vnd: 2500000, open_documents: 1 },
    summary: "Xem công nợ: Nguyễn Thị Lan",
  });
  assert.equal(p.schema, "erpn.proposal/v1");
  assert.equal(p.action, "read_balance");
  assert.equal(p.risk, "READ");
  assert.equal(p.need_confirm, false);
  assert.equal(p.executable, true);
  assert.equal(p.entity.id, "CUST-00001");
  assert.equal(p.params.outstanding_vnd, 2500000);
  assert.equal(Object.isFrozen(p), true, "proposal is frozen after build");
});

test("readProposal is always READ level regardless of action wording", () => {
  const p = readProposal({ action: "whatever", entity: { id: null, name: null } });
  assert.equal(p.risk, "READ");
  assert.equal(p.need_confirm, false);
});

test("buildProposal refuses incomplete or invalid input", () => {
  assert.throws(() => buildProposal({ entity: { id: "X" } }), /PROPOSAL_INVALID: action/);
  assert.throws(() => buildProposal({ action: "read_balance" }), /PROPOSAL_INVALID: entity/);
  assert.throws(
    () =>
      buildProposal({
        action: "read_balance",
        risk: "EXTREME",
        entity: { id: "X", name: "Y" },
      }),
    /PROPOSAL_INVALID: unknown risk/,
  );
});

test("assertProposalAllowed blocks every level above READ (Phase 6 = display only)", () => {
  assert.equal(assertProposalAllowed("READ"), true);
  for (const level of ["LOW", "HIGH", "CRITICAL"]) {
    assert.throws(
      () => assertProposalAllowed(level, { phase: "6" }),
      /EXECUTION_BLOCKED: risk .* requires the Phase 7 confirmation flow/,
      `${level} must not execute in Phase 6`,
    );
  }
  assert.throws(() => assertProposalAllowed("WHATEVER"), /RISK_LEVEL_INVALID/);
});

test("isExecutable mirrors needConfirm === false", () => {
  assert.equal(isExecutable("READ"), true);
  assert.equal(isExecutable("LOW"), false);
  assert.equal(isExecutable("HIGH"), false);
  assert.equal(isExecutable("CRITICAL"), false);
});

// ---- Review 2026-09-16 regressions ----

test("riskFor fails CLOSED on unknown/typo write verbs (never silent READ)", () => {
  // genuinely unmapped verbs (incl. typos) must THROW, not classify as READ
  for (const bad of ["resubmit", "creat_payment_entry", "", null, "finalize", "import_rows", "sync_stock"] ) {
    assert.throws(
      () => riskFor(bad),
      /RISK_UNKNOWN/,
      `"${bad}" must throw, not classify as READ`,
    );
  }
  // new HIGH verbs added in review are recognized
  assert.equal(riskFor("apply_credit_note"), RISK_LEVELS.HIGH);
  assert.equal(riskFor("post_gl_entry"), RISK_LEVELS.HIGH);
  assert.equal(riskFor("allocate_payment"), RISK_LEVELS.HIGH);
});

test("buildProposal is deeply frozen — extras cannot weaken control fields", () => {
  const p = buildProposal({
    action: "read_balance",
    entity: { id: "C1", name: "X" },
    params: { outstanding_vnd: 1000 },
    extra: { need_confirm: false, risk: "LOW", source: "test" },
  });
  assert.equal(p.need_confirm, false); // READ already false — pinned
  assert.equal(p.risk, "READ", "extra must not override risk");
  assert.throws(() => {
    "use strict";
    p.entity.id = "HACKED";
  }, TypeError, "nested entity must be frozen");
  assert.throws(() => {
    "use strict";
    p.params.outstanding_vnd = 1;
  }, TypeError, "params must be frozen");
  assert.throws(() => {
    "use strict";
    p.risk = "LOW";
  }, TypeError, "risk must be frozen");
});
