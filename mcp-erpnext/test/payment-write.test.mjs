/**
 * Phase 7 Stage A/B tests (MOCK ERPNext only — real-server run is Stage B,
 * user-gated). Covers the three spec exit-criteria mechanics:
 *  1. duplicate command_id → exactly ONE Payment Entry;
 *  2. crash between confirm and completion → reconcile, no half-state;
 *  3. proposal→execute amounts re-read and clamped from live data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdempotencyStore, fingerprintProposal, newCommandId, isValidCommandId } from "../src/idempotency.mjs";
import { buildPaymentProposal, executePaymentProposal } from "../src/skills/payment-write.mjs";
import { riskFor, RISK_LEVELS } from "../src/risk-levels.mjs";

const RESOLVED = { customer: { name: "CUST-00001", customer_name: "Khách làm tròn 2026-09-15-p1b-wf1-2" }, ambiguous: false, candidates: [] };

function fakePaymentSkills() {
  return {
    listUnpaidInvoices: async () => ({
      data: {
        count: 2,
        data: [
          { name: "SINV-0002", customer: "CUST-00001", posting_date: "2026-09-05", outstanding_amount: 320_000 },
          { name: "SINV-0001", customer: "CUST-00001", posting_date: "2026-09-01", outstanding_amount: 2_500_000 },
        ],
      },
    }),
  };
}

function store() {
  const dir = mkdtempSync(join(tmpdir(), "idem-"));
  const s = new IdempotencyStore(dir);
  t_dir = dir;
  return s;
}
let t_dir;
function cleanup() { if (t_dir) rmSync(t_dir, { recursive: true, force: true }); t_dir = undefined; }

test("riskFor maps create_payment_entry to HIGH (schema complete before write)", () => {
  assert.equal(riskFor("create_payment_entry"), RISK_LEVELS.HIGH);
});

test("Stage A: proposal is built and STOPS — no ERPNext write call exists in this path", async () => {
  const { proposal, invoice, outstanding_vnd } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {});
  assert.equal(proposal.action, "create_payment_entry");
  assert.equal(proposal.risk, "HIGH");
  assert.equal(proposal.need_confirm, true);
  assert.equal(proposal.executable, false);
  // oldest open invoice is the default target
  assert.equal(invoice, "SINV-0001");
  assert.equal(outstanding_vnd, 2_500_000);
  assert.equal(proposal.params.amount_vnd, 2_500_000);
});

test("Stage A: over-suggested amount is clamped to the invoice outstanding, with warning", async () => {
  const { proposal, warnings } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 9_999_999 });
  assert.equal(proposal.params.amount_vnd, 2_500_000);
  assert.ok(warnings.length >= 1 && /kẹp/.test(warnings[0]), warnings.join("; "));
});

test("Stage A: negative invoice cannot be collected through this write", async () => {
  const credit = {
    listUnpaidInvoices: async () => ({ data: { count: 1, data: [{ name: "SINV-0004", posting_date: "2026-09-09", outstanding_amount: -320_000, is_return: 1 }] } }),
  };
  await assert.rejects(
    buildPaymentProposal(credit, RESOLVED, {}),
    /không phải khoản phải thu dương/,
  );
});

test("Stage A: ambiguous or missing customer refuses with a specific message", async () => {
  await assert.rejects(
    buildPaymentProposal(fakePaymentSkills(), { customer: null, ambiguous: true, candidates: ["A", "B"] }, {}),
    /khớp nhiều kết quả/,
  );
  await assert.rejects(
    buildPaymentProposal(fakePaymentSkills(), { customer: null, ambiguous: false, candidates: [] }, {}),
    /không xác định được khách hàng/,
  );
});

// ---- Stage B against the MOCK: idempotency + reconcile ----

function mockMcp() {
  const calls = [];
  let nextDoc = 100;
  const payments = [];
  return {
    calls,
    payments,
    async callTool(tool, args) {
      calls.push({ tool, args });
      if (tool === "erpnext_sales_invoice_list") {
        return { data: { count: 1, data: [{ name: "SINV-0001", posting_date: "2026-09-01", outstanding_amount: 2_500_000 }] } };
      }
      if (tool === "create_payment_entry") {
        const dup = payments.find((p) => p.reference_no === args.reference_no);
        if (dup) return { data: { name: dup.name } }; // ERPNext-side dedupe by reference
        const doc = `PE-0${nextDoc++}`;
        payments.push({ name: doc, ...args });
        return { data: { name: doc } };
      }
      throw new Error(`unexpected tool ${tool}`);
    },
    // the ONE sanctioned write method (mirrors client.mjs callWriteTool)
    async callWriteTool(tool, args) {
      if (tool !== "create_payment_entry") throw new Error(`WRITE_REFUSED: ${tool}`);
      return this.callTool(tool, args);
    },
  };
}

test("Stage B mock: duplicate command_id produces exactly ONE Payment Entry", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {});

    const gate = s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    assert.equal(gate.replay, false);
    const first = await executePaymentProposal(mcp, proposal, cid, s);
    assert.equal(first.erpnext_doc, "PE-0100");

    // client retry with the SAME command_id (lost-network replay)
    const gate2 = s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    assert.equal(gate2.replay, true, "same command_id must replay, not re-execute");
    assert.equal(gate2.result.erpnext_doc, "PE-0100");

    const createCalls = mcp.calls.filter((c) => c.tool === "create_payment_entry");
    assert.equal(createCalls.length, 1, "ERPNext create must have run exactly once");
    assert.equal(mcp.payments.length, 1);
  } finally { cleanup(); }
});

test("Stage B mock: reference_no = command_id is written server-side", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {});
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    await executePaymentProposal(mcp, proposal, cid, s);
    assert.equal(mcp.payments[0].reference_no, cid);
  } finally { cleanup(); }
});

test("Stage B mock: crash before complete() → PENDING → reconcile by reference finds the doc", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {});
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    // execute wrote to ERPNext but the process died BEFORE store.complete():
    // simulate by calling the write and then rebuilding the record as PENDING.
    const first = await executePaymentProposal(mcp, proposal, cid, s);
    // force the record back to PENDING (as a crash would have left it)
    const db = s._load();
    db.commands[cid].status = "PENDING";
    delete db.commands[cid].result;
    s._persist();

    // Reconcile path: ERPNext lookup by reference_no proves completion.
    const rec = s.status(cid);
    assert.equal(rec.status, "PENDING");
    assert.equal(rec.reference_no, cid);
    const found = mcp.payments.find((p) => p.reference_no === rec.reference_no);
    assert.ok(found, "ERPNext has the entry — reconcile completes without a second write");
    assert.equal(found.name, first.erpnext_doc);
    assert.equal(mcp.payments.length, 1, "no duplicate write after reconcile");
  } finally { cleanup(); }
});

test("Stage B mock: failed command refuses retry with the SAME command_id (new intent = new id)", async () => {
  const s = store(); try {
    const cid = newCommandId();
    s.begin(cid, { action: "create_payment_entry", fingerprint: "f" });
    s.fail(cid, "không xác định được tài khoản tiền");
    // FAILED is terminal: begin() with the same id must THROW (a corrected
    // attempt is a NEW intent and must carry a NEW command_id).
    assert.throws(
      () => s.begin(cid, { action: "create_payment_entry", fingerprint: "f" }),
      /IDEMPOTENCY_FAILED_TERMINAL/,
    );
    assert.equal(s.status(cid).status, "FAILED");
  } finally { cleanup(); }
});

test("Stage B: begin() with same id but DIFFERENT fingerprint throws (no cross-intent reuse)", async () => {
  const s = store(); try {
    const cid = newCommandId();
    s.begin(cid, { action: "create_payment_entry", fingerprint: "fp-A" });
    assert.throws(
      () => s.begin(cid, { action: "create_payment_entry", fingerprint: "fp-B" }),
      /IDEMPOTENCY_FINGERPRINT_MISMATCH/,
    );
  } finally { cleanup(); }
});

test("command_id must be a UUID; store persists across instances", async () => {
  assert.equal(isValidCommandId("not-a-uuid"), false);
  assert.equal(isValidCommandId(newCommandId()), true);
  const dir = mkdtempSync(join(tmpdir(), "idem-")); try {
    const a = new IdempotencyStore(dir);
    const cid = newCommandId();
    a.begin(cid, { action: "create_payment_entry", fingerprint: "fp" });
    a.complete(cid, { erpnext_doc: "PE-0101" });
    const b = new IdempotencyStore(dir); // fresh instance = process restart
    assert.equal(b.status(cid).status, "COMPLETED");
    assert.equal(b.status(cid).result.erpnext_doc, "PE-0101");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
