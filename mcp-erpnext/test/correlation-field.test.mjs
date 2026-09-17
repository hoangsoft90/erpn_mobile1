/**
 * P0 §10.4 — ERPNext correlation field `custom_ai_action_id`.
 *
 * The business-level lookup key. `reference_no` = command_id (technical
 * idempotency); `custom_ai_action_id` = action_id (the logical action). Both are
 * written; reconcile can search by either, so a lost response can never be
 * resolved by guessing from (customer + amount + date).
 *
 * Properties under test:
 *  1. buildPaymentEntryData() puts the action id in the contract's field.
 *  2. the created document carries it (mock == real shape once migrated).
 *  3. reconcile finds a document by action id even with a different reference.
 *  4. a site WITHOUT the field must not break the write or the verification —
 *     the absence is REPORTED (correlation_field_missing), never guessed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
delete process.env.COPILOT_GLOBAL_READ_ONLY;

const { createMcpClient, MOCK_SERVER } = await import("../src/client.mjs");
const {
  buildPaymentEntryData,
  correlationField,
  reconcilePaymentEntry,
  verifyWrittenPayment,
  newActionId,
} = await import("../src/skills/payment-write.mjs");

const FIELD = correlationField();

test("buildPaymentEntryData writes the contract's correlation field", () => {
  assert.equal(FIELD, "custom_ai_action_id");
  const data = buildPaymentEntryData({
    customerId: "CUST-00001",
    paid: 100_000,
    commandId: "cmd-x",
    actionId: "act-x",
    invoice: "SINV-0001",
    invoiceTotal: 1_000_000,
    invoiceOutstanding: 1_000_000,
    company: "Demo Feed Co",
    paidFrom: "1310 - Debtors - DFC",
    paidTo: "1110 - Cash - DFC",
    postingDate: "2026-09-17",
  });
  assert.equal(data[FIELD], "act-x");
  assert.equal(data.reference_no, "cmd-x");
});

test("the created document carries the action id, and reconcile finds it by field", async () => {
  const mcp = createMcpClient({ serverScript: MOCK_SERVER });
  await mcp.initialize();
  try {
    const actionId = newActionId();
    const reference = `ref-${randomUUID()}`;
    const created = await mcp.callWriteTool("erpnext_doc_create", {
      doctype: "Payment Entry",
      data: {
        payment_type: "Receive",
        party_type: "Customer",
        party: "CUST-00001",
        paid_amount: 50_000,
        received_amount: 50_000,
        paid_from: "1310 - Debtors - DFC",
        paid_to: "1110 - Cash - DFC",
        company: "Demo Feed Co",
        reference_no: reference,
        [FIELD]: actionId,
      },
    });
    const docName = created.data?.data?.name ?? created.data?.name;
    assert.ok(docName, "the mock returned a document name");

    // by reference (the technical key)
    const byRef = await reconcilePaymentEntry(mcp, reference);
    assert.equal(byRef.found, true);
    assert.equal(byRef.doc.name, docName);

    // by ACTION ID with a reference that matches nothing — this is the P0 §10.4
    // lookup that must never be guessed from customer+amount+date.
    const byAction = await reconcilePaymentEntry(mcp, "no-such-reference", { actionId });
    assert.equal(byAction.found, true);
    assert.equal(byAction.doc.name, docName);
    assert.equal(byAction.doc[FIELD], actionId);
    assert.equal(byAction.duplicates, false, "the same document must not count twice");

    // and the verification agrees with the stored action id
    const verified = await verifyWrittenPayment(mcp, docName, {
      commandId: reference,
      paid: 50_000,
      customerId: "CUST-00001",
      actionId,
    });
    assert.equal(verified.name, docName);

    // a MISMATCHED action id is a verification failure, not a silent pass
    await assert.rejects(
      () =>
        verifyWrittenPayment(mcp, docName, {
          commandId: reference,
          paid: 50_000,
          customerId: "CUST-00001",
          actionId: "act-wrong",
        }),
      (err) => err.code === "PAYMENT_WRITE_UNVERIFIED",
    );
  } finally {
    await mcp.close();
  }
});

test("a site WITHOUT the Custom Field: write and verify still succeed; the absence is reported", async () => {
  const mcp = createMcpClient({ serverScript: MOCK_SERVER });
  await mcp.initialize();
  try {
    const reference = `ref-${randomUUID()}`;
    // Simulates an un-migrated site: the create call does not carry the key at
    // all, and ERPNext drops it instead of erroring.
    const created = await mcp.callWriteTool("erpnext_doc_create", {
      doctype: "Payment Entry",
      data: {
        party: "CUST-00001",
        paid_amount: 20_000,
        received_amount: 20_000,
        paid_from: "1310 - Debtors - DFC",
        paid_to: "1110 - Cash - DFC",
        company: "Demo Feed Co",
        reference_no: reference,
      },
    });
    const doc = created.data?.data ?? created.data;
    assert.equal(Object.prototype.hasOwnProperty.call(doc, FIELD), false, "the field is genuinely absent");

    // Verification must NOT fail a good write because a migration is pending.
    const verified = await verifyWrittenPayment(mcp, doc.name, {
      commandId: reference,
      paid: 20_000,
      customerId: "CUST-00001",
      actionId: "act-whatever",
    });
    assert.equal(verified.name, doc.name);

    // The reference lookup still works — the primary key is intact.
    const rec = await reconcilePaymentEntry(mcp, reference, { actionId: "act-whatever" });
    assert.equal(rec.found, true);
    assert.equal(rec.doc.name, doc.name);
  } finally {
    await mcp.close();
  }
});

test("/execute E2E: the stored Payment Entry carries the proposal's action_id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corr-e2e-"));
  const stateFile = join(dir, "mock-erp.json");
  process.env.MOCK_ERP_STATE = stateFile;
  let server = null;
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const { buildProposal } = await import("../src/action-proposal.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    // Built the way the pipeline builds it — action_id generated server-side and
    // carried inside the immutable proposal.
    const proposal = buildProposal({
      action: "create_payment_entry",
      risk: "HIGH",
      entity: { kind: "customer", id: "CUST-00001", name: "Khách mock" },
      params: { amount_vnd: 2_500_000, invoice: "SINV-0001", outstanding_vnd: 2_500_000, mode: "Tiền mặt" },
      extra: { action_id: newActionId() },
    });
    const cid = randomUUID();
    const r = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal }),
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.result.action_id, proposal.action_id);
    assert.equal(body.result.reference_no, cid);
    assert.equal(body.result.correlation_field_missing, undefined, "the mock HAS the field");

    const rows = JSON.parse(readFileSync(stateFile, "utf8")).payments ?? [];
    const written = rows.find((p) => p.name === body.result.erpnext_doc);
    assert.ok(written, "the document is in the ledger");
    assert.equal(written[FIELD], proposal.action_id, "the correlation field really landed on the document");
  } finally {
    delete process.env.MOCK_ERP_STATE;
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
