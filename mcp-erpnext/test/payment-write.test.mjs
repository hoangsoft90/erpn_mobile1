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
  shopDay,
  classifySubmitError,
  readPostingDate,
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
    // P9-D: the builder now also reads the party's OPEN DRAFT Payment Entries.
    // No drafts here — these tests are about the amount/posting-date rules, and
    // the cover maths itself is pinned in test/p9-pay.test.mjs.
    listOpenDraftPaymentEntries: async () => ({ data: { doctype: "Payment Entry", data: [] } }),
    getPaymentEntryDoc: async () => {
      throw new Error("no draft is expected in this fixture");
    },
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
    // P9-D: the builder reads the party's open DRAFT Payment Entries too.
    listOpenDraftPaymentEntries: async () => ({ data: { doctype: "Payment Entry", data: [] } }),
    getPaymentEntryDoc: async () => {
      throw new Error("no draft is expected in this fixture");
    },
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
  // P9-C: the message says "đối tác" (khách hàng hay nhà cung cấp) because the
  // same capability now records BOTH directions — the refusal is unchanged in
  // kind (nothing is built), only the wording grew to cover both masters.
  await assert.rejects(
    buildPaymentProposal(fakePaymentSkills(), { customer: null, ambiguous: false, candidates: [] }, {}),
    /không xác định được đối tác/,
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

function mockMcp({ verifyDrift = null, failSubmit = null, stayDraftAfterSubmit = false } = {}) {
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
    // the ONE sanctioned write method (mirrors client.mjs callWriteTool gate).
    // F7-2: exactly ONE more shape than Phase 7 — a SUBMIT of the same Payment
    // Entry doctype (the gate in client.mjs was widened the same way).
    async callWriteTool(tool, args) {
      const createOk = tool === "erpnext_doc_create" && args?.doctype === "Payment Entry";
      const submitOk = tool === "erpnext_doc_submit" && args?.doctype === "Payment Entry";
      if (!createOk && !submitOk) {
        throw new Error(`WRITE_REFUSED: ${tool}/${args?.doctype}`);
      }
      calls.push({ tool, args });
      if (submitOk) {
        if (failSubmit) throw new Error(failSubmit);
        const pe = payments.find((p) => p.name === args.name);
        if (!pe) throw new Error(`Payment Entry ${args.name} not found`);
        if (stayDraftAfterSubmit) {
          // The call REPORTED success but the document is still a draft — the
          // exact shape the executor must never trust (P5-2 §4.2, "unverified").
          return wrap({ data: pe, message: `Payment Entry ${pe.name} submitted successfully` }, tool);
        }
        pe.docstatus = 1;
        return wrap({ data: pe, message: `Payment Entry ${pe.name} submitted successfully` }, tool);
      }
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

// ---- F7-2 (user decision 2026-09-18): conditional submit after the draft ----

test("F7-2 OFF: the default proposal stays draft-only (no submit tool call, note unchanged)", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
    assert.equal(proposal.params.submit_now, false, "the snapshot must freeze the default OFF");
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    const res = await executePaymentProposal(mcp, proposal, cid, s);
    assert.ok(!mcp.calls.some((c) => c.tool === "erpnext_doc_submit"), "no submit when the switch is off");
    assert.equal(res.submit_requested, undefined);
    assert.equal(res.docstatus, 0);
    assert.match(res.note, /NHÁP/);
    assert.equal(s.status(cid).status, "COMPLETED", "draft-only completes normally");
  } finally { cleanup(); }
});

test("F7-2 ON: draft is created AND submitted — docstatus 1 verified by reading back", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {
      amount_vnd: 10_000,
      submit_now: true,
    });
    assert.equal(proposal.params.submit_now, true);
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    const res = await executePaymentProposal(mcp, proposal, cid, s);
    assert.equal(mcp.payments.length, 1, "exactly one Payment Entry");
    assert.equal(mcp.payments[0].docstatus, 1, "the stored document is SUBMITTED");
    assert.equal(res.submit_ok, true);
    assert.equal(res.docstatus, 1);
    assert.match(res.note, /ĐÃ SUBMIT|công nợ/);
    assert.equal(s.status(cid).status, "COMPLETED");
  } finally { cleanup(); }
});

test("F7-2 ON + submit error mid-way: draft stands, command stays PENDING (never COMPLETED, never FAILED)", async () => {
  // PROMPT-4 changed the END state of an unverified submit. BEFORE: the executor
  // completed the command with `submit_ok:false, docstatus:0`. That `docstatus:0`
  // is an ASSUMPTION (the submit call threw — it may have landed), and completing
  // froze it: `begin()` replays a COMPLETED command without re-reading ERPNext,
  // so the app could never correct itself. AFTER: the command stays PENDING and
  // the next attempt reconciles against ERPNext by `reference_no`.
  const s = store(); try {
    const mcp = mockMcp({ failSubmit: "simulated submit failure" });
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {
      amount_vnd: 10_000,
      submit_now: true,
    });
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    await assert.rejects(
      () => executePaymentProposal(mcp, proposal, cid, s),
      (err) => {
        assert.equal(err.code, "PAYMENT_WRITE_UNVERIFIED");
        assert.equal(err.erpnext_doc, "PE-0100", "the refusal names the draft that exists");
        assert.match(err.submit_error, /simulated submit failure/, "ERPNext's own words survive");
        return true;
      },
    );
    // the DRAFT exists — that is the truth about the money
    assert.equal(mcp.payments.length, 1);
    assert.equal(mcp.payments[0].docstatus, 0, "the draft was NOT submitted");
    // NOT COMPLETED (unverified) and NOT FAILED (terminal would break reconcile):
    assert.equal(s.status(cid).status, "PENDING", "an unverified submit must stay reconcile-able");
    assert.equal(s.status(cid).reference_no, cid, "the ERPNext reference is what reconcile searches with");
    // reconcile CAN see the document the draft left behind:
    const rec = await reconcilePaymentEntry(mcp, cid);
    assert.equal(rec.found, true, "reconcile finds the draft by reference_no");
    assert.equal(rec.doc.docstatus, 0);
  } finally { cleanup(); }
});

test("F7-2: execute follows the FROZEN snapshot exactly — params.submit_now is the single source", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
    assert.equal(proposal.params.submit_now, false);
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    // The card UI renders from params.submit_now and /execute executes from
    // the SAME field — there is no second live setting the two could disagree
    // about. (Trust boundary, documented: submit_now is client-authoritative,
    // frozen at /ask time, shown on the card, executed as frozen. The gateway
    // auth is what guards raw HTTP callers, same as command_id itself.)
    const res = await executePaymentProposal(mcp, proposal, cid, s);
    assert.ok(!mcp.calls.some((c) => c.tool === "erpnext_doc_submit"), "snapshot false ⇒ draft only");
    assert.equal(mcp.payments[0].docstatus, 0);
    assert.equal(s.status(cid).status, "COMPLETED");
  } finally { cleanup(); }
});

test("P9-D executor: a crafted FRACTIONAL amount cannot slip past the ceiling the drift compare rounds away", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    // The builder always rounds, so this is a hostile, hand-made proposal — the
    // one input shape `detectDrift` cannot see: its compare is Math.round()ed on
    // both sides, so 2.500.000,4 vs a 2.500.000 snapshot is "equal". The
    // exact-value backstop behind the drift check is what refuses it.
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
    // (params is frozen on the built proposal — the crafted copy is a new object,
    // exactly what a hostile client would POST.)
    const crafted = { ...proposal, params: { ...proposal.params, amount_vnd: 2_500_000.4 } };
    s.begin(cid, { action: crafted.action, fingerprint: fingerprintProposal(crafted) });
    await assert.rejects(
      () => executePaymentProposal(mcp, crafted, cid, s),
      (err) => err.code === "PAYMENT_AMOUNT_EXCEEDS_REMAINDER" && /vượt phần còn lại/.test(err.message),
      "an amount above the live remainder must be refused exactly, not rounded away",
    );
    assert.equal(mcp.payments.length, 0, "nothing was written");
    // The refusal happened BEFORE setReference(): the command is still resumable.
    assert.equal(s.status(cid)?.reference_no, undefined);
  } finally { cleanup(); }
});

// ---- P5-2 (§4.4) posting_date from the snapshot · (§4.2) submit error kind ----

test("P5-2 §4.4: the proposal FREEZES posting_date at propose time (shop day, not host day)", async () => {
  const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {});
  assert.equal(proposal.params.posting_date, shopDay());
  assert.match(proposal.params.posting_date, /^\d{4}-\d{2}-\d{2}$/);
});

test("P5-2 §4.4: 23:59 propose ⇒ the snapshot holds the shop's day, and it is NOT shifted by UTC", async () => {
  // 23:59 on 2026-09-21 in Vietnam is 16:59Z — the OLD expression
  // `new Date().toISOString().slice(0,10)` would still have said 2026-09-21
  // here, so the boundary that matters is the other one: 00:30 VN is 17:30Z on
  // the PREVIOUS day, where the host's UTC day is a day behind the shop's.
  const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {
    amount_vnd: 10_000,
    now: new Date("2026-09-21T16:59:00Z"),
  });
  assert.equal(proposal.params.posting_date, "2026-09-21", "freeze the SHOP's day at propose time");

  const midnight = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {
    amount_vnd: 10_000,
    now: new Date("2026-09-21T17:30:00Z"), // 00:30 VN on 2026-09-22
  });
  assert.equal(midnight.proposal.params.posting_date, "2026-09-22", "00:30 VN belongs to the SHOP's next day");
});

test("P5-2 §4.4: 23:59 propose ⇒ 00:01 execute writes the PROPOSAL's day, not the clock's", async () => {
  // The exact scenario §4.4 exists for (review2 §9): the user approved "thu hôm
  // nay" at 23:59 and the confirm lands at 00:01. Both clocks are injected, so
  // this cannot drift with the real calendar.
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const proposeAt = new Date("2026-09-21T16:59:00Z"); // 23:59 VN on 21/09
    const executeAt = new Date("2026-09-21T17:01:00Z"); // 00:01 VN on 22/09
    assert.equal(shopDay(executeAt), "2026-09-22", "precondition: the shop clock really did roll over");

    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {
      amount_vnd: 10_000,
      now: proposeAt,
    });
    assert.equal(proposal.params.posting_date, "2026-09-21");

    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    await executePaymentProposal(mcp, proposal, cid, s, { now: executeAt });

    assert.equal(mcp.payments[0].posting_date, "2026-09-21", "the APPROVED day must win over the clock");
    assert.equal(mcp.payments[0].reference_date, "2026-09-21", "reference_date follows the same day");
  } finally { cleanup(); }
});

// ── P5-2 SELF-REVIEW (2026-09-22): `params` is client-authoritative, so the
//    posting day is re-validated before anything is registered or written. ──

test("P5-2 review: a posting_date OUTSIDE ±1 day is REFUSED fail-closed (nothing written, nothing registered)", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
    // Exactly what a modified client can put in the /execute request body: a day
    // the user never approved. Before this guard a probe wrote it verbatim.
    const rogue = { ...proposal, params: { ...proposal.params, posting_date: "2026-01-02" } };
    s.begin(cid, { action: rogue.action, fingerprint: fingerprintProposal(rogue) });

    await assert.rejects(
      executePaymentProposal(mcp, rogue, cid, s),
      (err) => err.code === "PAYMENT_POSTING_DATE_INVALID",
    );
    assert.equal(mcp.payments.length, 0, "no Payment Entry may exist after a refused date");
    assert.equal(
      mcp.calls.some((c) => c.tool === "erpnext_doc_create"),
      false,
      "the write tool must never be reached",
    );
    assert.ok(!s.status(cid)?.reference_no, "nothing may be registered with ERPNext (so no reconcile is needed)");
  } finally { cleanup(); }
});

test("P5-2 review: a malformed posting_date is REFUSED, never handed to ERPNext", async () => {
  const s = store(); try {
    for (const junk of ["", "2026-13-01", "2026-02-30", "02-01-2026", 20260102, {}]) {
      const mcp = mockMcp();
      const cid = newCommandId();
      const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
      const broken = { ...proposal, params: { ...proposal.params, posting_date: junk } };
      s.begin(cid, { action: broken.action, fingerprint: fingerprintProposal(broken) });
      await assert.rejects(
        executePaymentProposal(mcp, broken, cid, s),
        (err) => err.code === "PAYMENT_POSTING_DATE_INVALID",
        `junk=${JSON.stringify(junk)} must be refused`,
      );
      assert.equal(mcp.payments.length, 0, `junk=${JSON.stringify(junk)} still wrote a document`);
    }
  } finally { cleanup(); }
});

test("P5-2 review: null/undefined is the OLD-CARD case (falls back), while \"\" is a refusal", () => {
  // The two must not be conflated: an absent field means "card predates the
  // field" (keep working), an empty string means "a bug or a tampered body".
  const now = new Date("2026-09-22T03:00:00Z"); // 10:00 VN on 22/09
  assert.equal(readPostingDate({ params: { posting_date: null } }, now), "2026-09-22");
  assert.equal(readPostingDate({ params: {} }, now), "2026-09-22");
  assert.throws(() => readPostingDate({ params: { posting_date: "" } }, now), (e) => e.code === "PAYMENT_POSTING_DATE_INVALID");
});

test("P5-2 review: the ±1 window keeps the honest midnight cases and rejects only further", () => {
  const now = new Date("2026-09-22T03:00:00Z"); // 10:00 VN on 22/09
  assert.equal(readPostingDate({ params: { posting_date: "2026-09-22" } }, now), "2026-09-22");
  assert.equal(readPostingDate({ params: { posting_date: "2026-09-21" } }, now), "2026-09-21", "yesterday: the midnight case");
  assert.equal(readPostingDate({ params: { posting_date: "2026-09-23" } }, now), "2026-09-23", "tomorrow: a device clock a day ahead");
  for (const far of ["2026-09-20", "2026-09-24", "2026-01-02"]) {
    assert.throws(
      () => readPostingDate({ params: { posting_date: far } }, now),
      (e) => e.code === "PAYMENT_POSTING_DATE_INVALID",
      `${far} is outside the window and must be refused`,
    );
  }
});

test("P5-2 §4.4: a card built BEFORE this change (no params.posting_date) still executes", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
    // Cards already stored in the chat history predate `posting_date`; the P5-2
    // CẤM is that they must keep working. Rebuild one exactly as it was stored.
    const stored = { ...proposal, params: { ...proposal.params } };
    delete stored.params.posting_date;
    s.begin(cid, { action: stored.action, fingerprint: fingerprintProposal(stored) });
    const res = await executePaymentProposal(mcp, stored, cid, s);

    assert.equal(res.submit_ok, undefined);
    assert.equal(mcp.payments[0].posting_date, shopDay(), "absent snapshot ⇒ today at the shop, never a crash");
  } finally { cleanup(); }
});

test("P5-2 §4.4: shopDay agrees with vnToday at the VN/UTC boundary (one day boundary, two call sites)", async () => {
  // The only reason shopDay exists as a second expression is the import cycle
  // described in its doc comment; this test is what keeps the two from drifting.
  const { vnToday } = await import("../src/http-ask.mjs");
  for (const iso of [
    "2026-09-21T16:59:00Z", // 23:59 VN
    "2026-09-21T17:00:00Z", // 00:00 VN next day
    "2026-01-05T03:00:00Z",
    "2026-12-31T17:30:00Z", // across a year boundary
  ]) {
    const d = new Date(iso);
    assert.equal(shopDay(d), vnToday(d), `shopDay and vnToday disagree at ${iso}`);
  }
});

test("P5-2 §4.2: classifySubmitError names the refusal, in the shape the real client produces", async () => {
  // Messages shaped like the pinned 3.0.4 client's own
  // `[FrappeClient] <METHOD> <path> failed: <msg> (HTTP <status>)` — the mock
  // must not invent a friendlier wording than the site actually emits.
  const cases = [
    ["[FrappeClient] POST /api/method/frappe.client.submit failed: frappe.exceptions.PermissionError: Not permitted (HTTP 403)", "permission"],
    ["[FrappeClient] POST /api/method/frappe.client.submit failed: frappe.exceptions.ValidationError: Accounting period 2026-09 is closed, cannot submit (Period Closing Voucher PCV-0001) (HTTP 417)", "period_locked"],
    ["[FrappeClient] POST /api/method/frappe.client.submit failed: frappe.exceptions.ValidationError: Workflow state 'Chờ duyệt' does not allow transition to Submitted (HTTP 417)", "workflow"],
    ["[FrappeClient] POST /api/method/frappe.client.submit failed: frappe.exceptions.TimestampMismatchError: Document has been modified (HTTP 417)", "other"],
    ["", "other"],
    [null, "other"],
    [{ message: "not a string" }, "other"],
  ];
  for (const [message, kind] of cases) {
    assert.equal(classifySubmitError(message), kind, `${kind} <= ${JSON.stringify(message)}`);
  }
});

test("P5-2 §4.2: submit_error_kind is reported beside the VERBATIM submit_error, draft still stands", async () => {
  const cases = [
    ["[FrappeClient] POST /api/method/frappe.client.submit failed: frappe.exceptions.PermissionError: Not permitted (HTTP 403)", "permission"],
    ["[FrappeClient] POST /api/method/frappe.client.submit failed: frappe.exceptions.ValidationError: Accounting period 2026-09 is closed (Period Closing Voucher PCV-0001) (HTTP 417)", "period_locked"],
    ["[FrappeClient] POST /api/method/frappe.client.submit failed: frappe.exceptions.ValidationError: Workflow state does not allow transition to Submitted (HTTP 417)", "workflow"],
    ["[FrappeClient] POST /api/method/frappe.client.submit failed: frappe.exceptions.TimestampMismatchError: Document has been modified (HTTP 417)", "other"],
  ];
  for (const [message, kind] of cases) {
    const s = store(); try {
      const mcp = mockMcp({ failSubmit: message });
      const cid = newCommandId();
      const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {
        amount_vnd: 10_000,
        submit_now: true,
      });
      s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
      await assert.rejects(
        () => executePaymentProposal(mcp, proposal, cid, s),
        (err) => {
          assert.equal(err.code, "PAYMENT_WRITE_UNVERIFIED", `code for: ${message}`);
          assert.equal(err.submit_error_kind, kind, `kind for: ${message}`);
          assert.equal(err.submit_error, message, "ERPNext's own words must survive untouched");
          return true;
        },
      );
      assert.equal(mcp.payments[0].docstatus, 0, "the draft stands whatever the refusal was");
      assert.equal(s.status(cid).status, "PENDING", "unverified submit: never COMPLETED, never FAILED");
    } finally { cleanup(); }
  }
});

test("P5-2 §4.2: a submit that REPORTS success but leaves docstatus 0 is unverified, kind = other, stays PENDING", async () => {
  const s = store(); try {
    const mcp = mockMcp({ stayDraftAfterSubmit: true });
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, {
      amount_vnd: 10_000,
      submit_now: true,
    });
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    await assert.rejects(
      () => executePaymentProposal(mcp, proposal, cid, s),
      (err) => {
        assert.equal(err.code, "PAYMENT_WRITE_UNVERIFIED", "a submit we could not verify is NOT a success");
        assert.equal(err.submit_error_kind, "other", "our own read-back message, not an ERPNext refusal");
        assert.match(err.submit_error, /docstatus đọc lại/);
        return true;
      },
    );
    assert.equal(mcp.payments[0].docstatus, 0, "the draft stands");
    assert.equal(s.status(cid).status, "PENDING", "the requested end state (docstatus 1) was not achieved");
  } finally { cleanup(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT-4 — Payment Entry WRITE safety & idempotency (.plan/next6-prompt4.md)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A mock "site" whose SUBMIT lands (docstatus → 1) but whose RESPONSE is lost
 * — the one case where the executor cannot assume "not submitted".
 */
function clientWithLostSubmit(mcp) {
  return {
    initialize: async () => {},
    close: async () => {},
    callTool: (tool, args) => mcp.callTool(tool, args),
    callWriteTool: async (tool, args) => {
      if (tool === "erpnext_doc_submit") {
        const pe = mcp.payments.find((p) => p.name === args.name);
        pe.docstatus = 1; // ERPNext APPLIED the submit...
        throw new Error("[FrappeClient] POST /api/method/frappe.client.submit failed: socket hang up (no response)"); // ...the reply never arrived
      }
      return mcp.callWriteTool(tool, args);
    },
  };
}

test("P4 gateway: a LOST submit response that actually LANDED is never completed as a draft; retry reconciles to docstatus 1 with NO second Payment Entry", async () => {
  const { runExecute } = await import("../src/safety-gateway.mjs");
  const s = store(); try {
    const mcp = mockMcp();
    const client = clientWithLostSubmit(mcp);
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000, submit_now: true });

    // 1. The write is UNKNOWN to the caller (submit landed, reply lost).
    const v1 = await runExecute({ command_id: cid, proposal, store: s, createClient: () => client, dedup_ack: true });
    assert.equal(v1.status, 503, JSON.stringify(v1.body));
    assert.equal(v1.body.retry_same_command_id, true, "the caller must retry the SAME id, not a new one");
    assert.equal(s.status(cid).status, "PENDING", "an unverified submit must stay reconcile-able");
    assert.equal(mcp.payments.length, 1, "exactly one draft exists so far");
    assert.equal(mcp.payments[0].docstatus, 1, "ERPNext really DID submit it");

    // 2. The client retries the SAME command_id: the gateway reconciles against
    //    ERPNext and reports the TRUE docstatus — no assumption, no new write.
    const v2 = await runExecute({ command_id: cid, proposal, store: s, createClient: () => client, dedup_ack: true });
    assert.equal(v2.status, 200, JSON.stringify(v2.body));
    assert.equal(v2.body.replay, true);
    assert.equal(v2.body.reconciled, true, "the retry reconciled instead of re-writing");
    assert.equal(v2.body.result.docstatus, 1, "the reply now reports ERPNext's REAL docstatus");
    assert.equal(v2.body.result.submit_ok, true, "a reconciled submit is truthfully reported as submitted");
    assert.equal(mcp.payments.length, 1, "NO second Payment Entry — the retry never creates");
  } finally { cleanup(); }
});

test("P4 gateway: a submit that cleanly REFUSED is not assumed either — retry reconciles and reports the draft truthfully", async () => {
  const { runExecute } = await import("../src/safety-gateway.mjs");
  const s = store(); try {
    const mcp = mockMcp({ failSubmit: "[FrappeClient] POST frappe.client.submit failed: frappe.exceptions.ValidationError: Accounting period 2026-09 is closed (Period Closing Voucher PCV-0001) (HTTP 417)" });
    const client = { initialize: async () => {}, close: async () => {}, callTool: (t, a) => mcp.callTool(t, a), callWriteTool: (t, a) => mcp.callWriteTool(t, a) };
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000, submit_now: true });

    const v1 = await runExecute({ command_id: cid, proposal, store: s, createClient: () => client, dedup_ack: true });
    assert.equal(v1.status, 503, JSON.stringify(v1.body));
    assert.equal(s.status(cid).status, "PENDING");

    const v2 = await runExecute({ command_id: cid, proposal, store: s, createClient: () => client, dedup_ack: true });
    assert.equal(v2.status, 200, JSON.stringify(v2.body));
    assert.equal(v2.body.reconciled, true);
    assert.equal(v2.body.result.docstatus, 0, "the draft is the truth — ERPNext never submitted it");
    assert.equal(v2.body.result.submit_ok, false, "an unsubmitted draft must never be reported as submitted");
    assert.equal(mcp.payments.length, 1, "NO duplicate");
  } finally { cleanup(); }
});

test("P4 item 7: a live draft already covering the invoice makes a NEW command refuse BEFORE creating", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    // A live DRAFT the shop left open, covering the whole invoice.
    mcp.payments.push({
      name: "PE-DRAFT-OPEN",
      reference_no: "some-other-command",
      party: "CUST-00001",
      payment_type: "Receive",
      party_type: "Customer",
      paid_amount: 2_500_000,
      docstatus: 0,
      references: [{ reference_doctype: "Sales Invoice", reference_name: "SINV-0001", allocated_amount: 2_500_000 }],
    });
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });
    s.begin(cid, { action: proposal.action, fingerprint: fingerprintProposal(proposal) });
    await assert.rejects(
      () => executePaymentProposal(mcp, proposal, cid, s),
      (err) => err.code === "PROPOSAL_STALE" && /lệch/.test(err.message),
      "before creating, the executor re-reads live state and refuses when a draft already covers the debt",
    );
    assert.equal(mcp.payments.length, 1, "nothing new was created");
  } finally { cleanup(); }
});

test("P4: reconcile is keyed on reference_no + the action id — NEVER on customer+amount", async () => {
  const s = store(); try {
    const mcp = mockMcp();
    mcp.calls.length = 0;
    await reconcilePaymentEntry(mcp, "cmd-ref-1", { actionId: "act_x" });
    const filters = mcp.calls.filter((c) => c.tool === "erpnext_doc_list").map((c) => c.args.filters);
    assert.deepEqual(filters[0], [["reference_no", "=", "cmd-ref-1"]], "the primary key is the command reference");
    assert.deepEqual(filters[1], [["custom_ai_action_id", "=", "act_x"]], "the correlation field is the action id");
    for (const f of filters) {
      for (const [field] of f) {
        assert.ok(!/party|customer|paid_amount/.test(field), `${field} must not be part of the reconcile key`);
      }
    }
  } finally { cleanup(); }
});

test("P4: idempotency intent is NOT customer+amount — the same customer/amount on a DIFFERENT invoice is a different action", () => {
  const s = store(); try {
    const meta = (fp, intentKey) => ({ action: "create_payment_entry", fingerprint: fp, intentKey });
    const a = newCommandId();
    const b = newCommandId();
    s.begin(a, meta("fp-a", "CUST-00001|SINV-0001"));
    s.begin(b, meta("fp-b", "CUST-00001|SINV-0002"));
    assert.equal(s.status(b).status, "PENDING", "a different invoice is a different intent, not a duplicate");
    // The SAME intent IS blocked (a second command_id for the same debt is a
    // legitimate intent at the proposal level, but executing both settles it twice).
    assert.throws(
      () => s.begin(newCommandId(), meta("fp-c", "CUST-00001|SINV-0001")),
      /IDEMPOTENCY_INTENT_IN_FLIGHT/,
    );
  } finally { cleanup(); }
});

test("P4: a payment command_id/proposal owned by A cannot be used by B", async () => {
  const { runExecute } = await import("../src/safety-gateway.mjs");
  const s = store(); try {
    const mcp = mockMcp();
    const client = { initialize: async () => {}, close: async () => {}, callTool: (t, a) => mcp.callTool(t, a), callWriteTool: (t, a) => mcp.callWriteTool(t, a) };
    const pA = { user_id: "A", permissions: ["Accounts User"], mode: "single_tenant" };
    const pB = { user_id: "B", permissions: ["Accounts User"], mode: "single_tenant" };
    const cid = newCommandId();
    const { proposal } = await buildPaymentProposal(fakePaymentSkills(), RESOLVED, { amount_vnd: 10_000 });

    // A executes it (draft).
    const v1 = await runExecute({ command_id: cid, proposal, store: s, createClient: () => client, dedup_ack: true, principal: pA });
    assert.equal(v1.status, 200, JSON.stringify(v1.body));

    // B replays A's command_id → refused by NAME, and must NOT receive A's result.
    const v2 = await runExecute({ command_id: cid, proposal, store: s, createClient: () => client, dedup_ack: true, principal: pB });
    assert.equal(v2.status, 409, JSON.stringify(v2.body));
    assert.equal(v2.body.code, "COMMAND_ID_FOREIGN");
    assert.equal(v2.body.result, undefined, "B must never see A's result");

    // B confirms A's stamped proposal under a FRESH id → refused at the proposal gate.
    const stamped = { ...proposal, principal_user_id: "A" };
    const v3 = await runExecute({ command_id: newCommandId(), proposal: stamped, store: s, createClient: () => client, dedup_ack: true, principal: pB });
    assert.equal(v3.status, 403, JSON.stringify(v3.body));
    assert.equal(v3.body.code, "PROPOSAL_PRINCIPAL_MISMATCH");
  } finally { cleanup(); }
});
