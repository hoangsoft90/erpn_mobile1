/**
 * End-to-end tests for createMcpClient <-> mock MCP server correlation.
 * Spawns the REAL mock server process (node src/mock-server.mjs) and speaks
 * JSON-RPC over its stdio — no ERPNext credentials needed (user decision
 * 2026-09-13). Run: `node --test` (from mcp-erpnext/).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createMcpClient } from "../src/client.mjs";
import { auditAgainstAdvertisedTools } from "../src/readonly-guard.mjs";

test("initialize handshake + tools/list round-trip", async () => {
  const client = createMcpClient();
  try {
    const tools = await client.listTools();
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length >= 5);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  } finally {
    await client.close();
  }
});

test("callTool correlates response by id and unwraps structuredContent", async () => {
  const client = createMcpClient();
  try {
    const res = await client.callTool("erpnext_customer_list", { limit: 10 });
    assert.equal(res.__untrusted, true);
    assert.equal(res.source, "erpnext:erpnext_customer_list");
    assert.equal(res.data.doctype, "Customer");
    assert.equal(res.data.count, 2);
    assert.equal(res.data.data[0].customer_name, "Nguyễn Thị Lan");
  } finally {
    await client.close();
  }
});

test("concurrent calls are correlated correctly (ids never cross)", async () => {
  const client = createMcpClient();
  try {
    const [customerList, stock, invoices] = await Promise.all([
      client.callTool("erpnext_customer_list", {}),
      client.callTool("erpnext_stock_balance", { item_code: "CAM-HEO-25KG" }),
      client.callTool("erpnext_sales_invoice_list", {}),
    ]);
    assert.equal(customerList.data.doctype, "Customer");
    assert.equal(stock.data.doctype, "Bin");
    assert.equal(stock.data.data[0].item_code, "CAM-HEO-25KG");
    assert.equal(invoices.data.doctype, "Sales Invoice");
  } finally {
    await client.close();
  }
});

test("tool-reported error (isError) surfaces as TOOL_ERROR", async () => {
  const client = createMcpClient();
  try {
    // CUST-99999 exists in no fixture — but the guard requires known ids, so
    // exercise the raw tool error path via an unknown-but-whitelisted call:
    await assert.rejects(
      () => client.callTool("erpnext_customer_get", { name: "CUST-00000" }),
      /TOOL_ERROR/,
    );
  } finally {
    await client.close();
  }
});

test("JSON-RPC error (unknown tool name on the server) surfaces as MCP_ERROR", async () => {
  const client = createMcpClient();
  try {
    // "erpnext_ar_aging" IS whitelisted but NOT implemented by the mock ->
    // server answers a JSON-RPC error — the client must reject, not hang.
    await assert.rejects(
      () => client.callTool("erpnext_ar_aging", {}),
      /MCP_ERROR -32602/,
    );
  } finally {
    await client.close();
  }
});

test("close() is IDEMPOTENT: a child that already exited must not hang the caller", async () => {
  // Every HTTP route calls close() in its `finally`, so a close() that waits on
  // an `exit` event which already fired turns into a handler that never returns
  // (one leaked socket + child per failed request). Measured 2026-09-21: with a
  // client whose child never came up, `close()` never settled at all.
  const client = createMcpClient();
  await client.initialize();
  await client.close();
  const verdict = await Promise.race([
    client.close().then(() => "closed", (err) => `error: ${err.message}`),
    new Promise((resolve) => setTimeout(() => resolve("HANG"), 3000)),
  ]);
  assert.equal(verdict, "closed", "a second close() (child already exited) must return, not hang");
});

test("guard audit: mock server advertises readOnlyHint for every whitelisted tool it serves", async () => {
  const client = createMcpClient();
  try {
    const tools = await client.listTools();
    const blocked = auditAgainstAdvertisedTools(tools.filter((t) => !t.name.startsWith("erpnext_doc_")));
    assert.deepEqual(blocked, []);
  } finally {
    await client.close();
  }
});

// ---- F7-2: the fail-closed write gate allows exactly ONE more shape ----

test("F7-2 gate: erpnext_doc_submit on Payment Entry reaches the mock (docstatus 0 -> 1)", async () => {
  const client = createMcpClient();
  try {
    // create a draft through the sanctioned gate...
    await client.callWriteTool("erpnext_doc_create", {
      doctype: "Payment Entry",
      data: {
        company: "Demo Feed Co",
        payment_type: "Receive",
        party_type: "Customer",
        party: "CUST-00001",
        paid_amount: 10_000,
        received_amount: 10_000,
        reference_no: "F7-2-GATE-TEST",
        mode_of_payment: "Cash",
        paid_to: "1110 - Cash - DFC",
        paid_from: "1120 - Bank - DFC",
      },
    });
    // ...then submit it through the ONE extra shape the gate now allows.
    const listed = await client.callTool("erpnext_doc_list", {
      doctype: "Payment Entry",
      filters: [["reference_no", "=", "F7-2-GATE-TEST"]],
    });
    const pe = listed.data.data[0];
    assert.equal(pe.docstatus, 0, "created as draft first");
    const sub = await client.callWriteTool("erpnext_doc_submit", {
      doctype: "Payment Entry",
      name: pe.name,
    });
    assert.ok(sub.data, "submit returns the document");
    const after = await client.callTool("erpnext_doc_get", {
      doctype: "Payment Entry",
      name: pe.name,
    });
    assert.equal(Number(after.data.data.docstatus), 1, "the draft is now SUBMITTED");
  } finally {
    await client.close();
  }
});

test("F7-2 gate: a submit of a NON-Payment-Entry doctype is still REFUSED (fail-closed)", async () => {
  const client = createMcpClient();
  try {
    await assert.rejects(
      client.callWriteTool("erpnext_doc_submit", { doctype: "Sales Invoice", name: "SINV-0001" }),
      /WRITE_REFUSED/,
      "the gate must not widen to other doctypes",
    );
  } finally {
    await client.close();
  }
});
