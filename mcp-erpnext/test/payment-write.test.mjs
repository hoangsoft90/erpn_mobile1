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
import {
  buildPaymentProposal,
  executePaymentProposal,
  reconcilePaymentEntry,
  resolvePaymentAccounts,
} from "../src/skills/payment-write.mjs";
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

/**
 * Mini in-memory ERPNext using the REAL handler shapes (verified in the pinned
 * @casys/mcp-erpnext 3.0.4 source): reads via erpnext_doc_get / doc_list, the
 * write via `erpnext_doc_create` with {doctype, data}. The mock mirrors the
 * client envelope ({__untrusted, source, data: payload}) so unwrapping is
 * exercised the same way production does.
 */
const MODES = [
  { name: "Chuyển khoản", enabled: 1, type: "Cash" },
  { name: "Cash", enabled: 1, type: "Cash" },
  { name: "Wire Transfer", enabled: 1, type: "Bank" },
];
const MODE_ACCOUNTS = {
  Cash: "1110 - Cash - DFC",
  "Chuyển khoản": "1120 - Bank - DFC",
  "Wire Transfer": "1120 - Bank - DFC",
};

function mockMcp({ verifyDrift = null } = {}) {
  const calls = [];
  let nextDoc = 100;
  const payments = [];
  const invoice = {
    name: "SINV-0001",
    customer: "CUST-00001",
    company: "Demo Feed Co",
    debit_to: "1310 - Debtors - DFC",
    posting_date: "2026-09-01",
    grand_total: 2_500_000,
    outstanding_amount: 2_500_000,
  };
  const wrap = (payload, tool) => ({ __untrusted: true, source: `erpnext:${tool}`, data: payload });
  return {
    calls,
    payments,
    invoice,
    async callTool(tool, args) {
      calls.push({ tool, args });
      if (tool === "erpnext_sales_invoice_list") {
        return wrap({ doctype: "Sales Invoice", count: 1, data: [{ name: invoice.name, posting_date: invoice.posting_date, grand_total: invoice.grand_total, outstanding_amount: invoice.outstanding_amount }] }, tool);
      }
      if (tool === "erpnext_doc_get") {
        if (args.doctype === "Sales Invoice") return wrap({ data: invoice }, tool);
        if (args.doctype === "Mode of Payment") {
          // Only the STORED document names exist — the Vietnamese label does
          // not (the real site rejected the write with LinkValidationError).
          const account = MODE_ACCOUNTS[args.name];
          if (!account) throw new Error(`Mode of Payment ${args.name} not found`);
          return wrap({ data: { name: args.name, accounts: [{ company: invoice.company, default_account: account }] } }, tool);
        }
        if (args.doctype === "Payment Entry") {
          const pe = payments.find((p) => p.name === args.name);
          if (!pe) throw new Error(`Payment Entry ${args.name} not found`);
          // verifyDrift simulates ERPNext storing something other than intended
          return wrap({ data: verifyDrift ? { ...pe, ...verifyDrift } : pe }, tool);
        }
        throw new Error(`unexpected doctype ${args.doctype}`);
      }
      if (tool === "erpnext_doc_list") {
        const source = args.doctype === "Payment Entry" ? payments : args.doctype === "Mode of Payment" ? MODES : null;
        if (!source) throw new Error(`unexpected doctype ${args.doctype}`);
        const rows = source.filter((row) =>
          (args.filters ?? []).every(([field, , value]) => String(row[field] ?? "") === String(value ?? "")),
        );
        return wrap({ doctype: args.doctype, count: rows.length, data: rows }, tool);
      }
      throw new Error(`unexpected tool ${tool}`);
    },
    // the ONE sanctioned write method (mirrors client.mjs callWriteTool gate)
    async callWriteTool(tool, args) {
      if (tool !== "erpnext_doc_create" || args?.doctype !== "Payment Entry") {
        throw new Error(`WRITE_REFUSED: ${tool}/${args?.doctype}`);
      }
      calls.push({ tool, args });
      const data = args.data;
      const dup = payments.find((p) => p.reference_no === data.reference_no);
      if (dup) return wrap({ data: dup, message: `Payment Entry ${dup.name} created successfully` }, tool);
      const doc = { doctype: "Payment Entry", name: `PE-0${nextDoc++}`, ...data, docstatus: 0 };
      payments.push(doc);
      return wrap({ data: doc, message: `Payment Entry ${doc.name} created successfully` }, tool);
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

    const createCalls = mcp.calls.filter((c) => c.tool === "erpnext_doc_create");
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

    // Reconcile path: the REAL lookup tool (erpnext_doc_list filtered by
    // reference_no) proves completion.
    const rec = s.status(cid);
    assert.equal(rec.status, "PENDING");
    assert.equal(rec.reference_no, cid);
    const listed = await reconcilePaymentEntry(mcp, rec.reference_no);
    assert.equal(listed.found, true, "ERPNext has the entry — reconcile completes without a second write");
    assert.equal(listed.count, 1, "exactly one document carries this reference");
    assert.equal(listed.doc.name, first.erpnext_doc);
    assert.equal(mcp.payments.length, 1, "no duplicate write after reconcile");
  } finally { cleanup(); }
});

test("Stage B: reconcile uses erpnext_doc_list (the dedicated payment list cannot filter by reference_no)", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    mcp.calls.length = 0;
    const rec = await reconcilePaymentEntry(mcp, cid);
    assert.equal(rec.found, false, "nothing written yet");
    const call = mcp.calls.at(-1);
    assert.equal(call.tool, "erpnext_doc_list");
    assert.equal(call.args.doctype, "Payment Entry");
    assert.deepEqual(call.args.filters, [["reference_no", "=", cid]]);
  } finally { cleanup(); }
});

test("Stage B: reconcile flags DUPLICATES instead of pretending one write happened", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    mcp.payments.push(
      { name: "PE-0900", reference_no: cid, party: "CUST-00001", paid_amount: 10_000, docstatus: 0 },
      { name: "PE-0901", reference_no: cid, party: "CUST-00001", paid_amount: 10_000, docstatus: 0 },
    );
    const rec = await reconcilePaymentEntry(mcp, cid);
    assert.equal(rec.found, true);
    assert.equal(rec.count, 2);
    assert.equal(rec.duplicates, true, "two documents on one command_id must be surfaced, not hidden");
  } finally { cleanup(); }
});

test("Stage B: the written payload is the REAL Payment Entry shape (accounts read live, allocation attached)", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    await executePaymentProposal(mcp, proposal, cid, s);

    const written = mcp.payments[0];
    assert.equal(written.payment_type, "Receive");
    assert.equal(written.party_type, "Customer");
    assert.equal(written.party, "CUST-00001");
    assert.equal(written.paid_amount, 10_000);
    assert.equal(written.received_amount, 10_000);
    assert.equal(written.reference_no, cid);
    assert.equal(written.company, "Demo Feed Co", "company read from the invoice, not invented");
    assert.equal(written.paid_from, "1310 - Debtors - DFC", "paid_from = the invoice debit_to");
    assert.equal(written.paid_to, "1110 - Cash - DFC", "paid_to from the mode of payment");
    assert.deepEqual(written.references, [
      {
        reference_doctype: "Sales Invoice",
        reference_name: "SINV-0001",
        total_amount: 2_500_000,
        outstanding_amount: 2_500_000,
        allocated_amount: 10_000,
      },
    ]);
    assert.equal(written.docstatus, 0, "draft — submitting is a separate, human decision");
  } finally { cleanup(); }
});

test("Stage B: the mode-of-payment NAME is resolved from ERPNext, not assumed from the label", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    // The proposal asks for "Tiền mặt" (the shopkeeper's words). No such Mode
    // of Payment exists — exactly the real LinkValidationError on 2026-09-16.
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {
      amount_vnd: 10_000,
      mode: "Tiền mặt",
    });
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    const res = await executePaymentProposal(mcp, proposal, cid, s);

    // The label "Tiền mặt" resolves to a real Cash-type mode document.
    const used = mcp.payments[0].mode_of_payment;
    assert.ok(used === "Cash" || used === "Chuyển khoản", `stored document name used, got ${used}`);
    assert.equal(res.mode_substituted_from, "Tiền mặt", "the substitution is reported back");
  } finally { cleanup(); }
});

test("Stage B: an existing mode name is passed through unchanged (no needless substitution)", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {
      amount_vnd: 10_000,
      mode: "Cash",
    });
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    const res = await executePaymentProposal(mcp, proposal, cid, s);
    assert.equal(mcp.payments[0].mode_of_payment, "Cash");
    assert.equal(res.mode_substituted_from, undefined, "an exact match must not be flagged");
  } finally { cleanup(); }
});

test("Stage B: an invalid amount is refused and NEVER promoted to the full debt", async () => {
  // Defense in depth for the review finding of 2026-09-16: the executor used to
  // compute `Number(amount) || liveOutstanding`, so a proposal carrying 0/NaN
  // was silently turned into a payment for the WHOLE outstanding amount.
  for (const bad of [0, -5, null, "không rõ"]) {
    const s = store();
    const mcp = mockMcp();
    const cid = newCommandId();
    try {
      const built = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
      // The proposal is deep-frozen by Phase 6 (by design) — build the bad
      // variant by spreading, exactly as a tampering client would.
      const proposal = { ...built.proposal, params: { ...built.proposal.params, amount_vnd: bad } };
      s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
      await assert.rejects(
        executePaymentProposal(mcp, proposal, cid, s),
        (err) => err.code === "PAYMENT_AMOUNT_INVALID",
        `amount_vnd=${JSON.stringify(bad)} must be refused`,
      );
      assert.equal(mcp.payments.length, 0, "nothing may be written for an invalid amount");
      assert.equal(s.status(cid).reference_no, undefined, "no ERPNext reference registered");
    } finally { cleanup(); }
  }
});

test("Stage B: a site with no matching cash mode is REFUSED, never silently posted to another account", async () => {
  // Regression for the review finding of 2026-09-16: the selector used to end
  // with `?? modes[0]?.name`, so "thu tiền mặt" on a site without a cash-like
  // mode would post the collection into whatever mode happened to be first
  // (e.g. a bank transfer account) — a silent wrong-ledger write.
  const mcp = {
    calls: [],
    async callTool(name, args) {
      this.calls.push(name);
      if (name === "erpnext_doc_get" && args.doctype === "Sales Invoice") {
        return { data: { company: "MP", debit_to: "1310-Debtors-MP", outstanding_amount: 2_500_000 } };
      }
      if (name === "erpnext_doc_list" && args.doctype === "Mode of Payment") {
        return { data: [{ name: "Chuyển khoản", enabled: 1, type: "Bank" }, { name: "Ví điện tử", enabled: 1, type: "Bank" }] };
      }
      throw new Error(`unexpected call ${name}`);
    },
  };
  await assert.rejects(
    resolvePaymentAccounts(mcp, { invoice: "SINV-0001", mode: "Tiền mặt" }),
    (err) => err.code === "PAYMENT_MODE_UNRESOLVED" && /sai tài khoản/.test(err.message),
  );
});

test("Stage B: a non-numeric outstanding amount is refused (NaN must not reach the payload)", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
    // A malformed invoice row: outstanding is not a number. "abc" passes the
    // "has debt" filter (NaN !== 0) and MUST be caught by the receivable check;
    // "" reads as zero and is caught earlier as "no longer open".
    for (const [bad, code] of [
      ["abc", "PAYMENT_INVOICE_NOT_RECEIVABLE"],
      ["", "PAYMENT_INVOICE_ALREADY_SETTLED"],
    ]) {
      mcp.invoice.outstanding_amount = bad;
      await assert.rejects(
        executePaymentProposal(mcp, proposal, cid, s),
        (err) => err.code === code,
        `outstanding_amount=${JSON.stringify(bad)} must not reach the payload`,
      );
    }
    assert.equal(mcp.payments.length, 0, "nothing may be written with a malformed outstanding");
  } finally { cleanup(); }
});

test("Stage B: the write is verified by reading the document BACK (write response is not evidence)", async () => {
  const s = store(); try {
    const mcp = mockMcp({ verifyDrift: { paid_amount: 999_999 } });
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    await assert.rejects(
      executePaymentProposal(mcp, proposal, cid, s),
      (err) => err.code === "PAYMENT_WRITE_UNVERIFIED" && /sai lệch/.test(err.message),
    );
    // and the command must NOT be reported as completed
    assert.notEqual(s.status(cid).status, "COMPLETED");
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

test("store: begin() on a resumed command KEEPS reference_no (regression: losing it caused a second real payment)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idem-")); try {
    const a = new IdempotencyStore(dir);
    const cid = newCommandId();
    const first = a.begin(cid, { action: "create_payment_entry", fingerprint: "fp" });
    assert.equal(first.resumed, false, "a brand-new command is not a resume");
    a.setReference(cid, cid);

    // crash: the record stays PENDING with its ERPNext reference
    const b = new IdempotencyStore(dir);
    const again = b.begin(cid, { action: "create_payment_entry", fingerprint: "fp" });
    assert.equal(again.resumed, true, "the caller must reconcile before writing");
    assert.equal(
      b.status(cid).reference_no,
      cid,
      "reference_no is the only handle reconcile has — it must survive the resume",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
