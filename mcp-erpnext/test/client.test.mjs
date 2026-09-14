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
    // "erpnext_doc_get" IS whitelisted but NOT implemented by the mock ->
    // server answers a JSON-RPC error — the client must reject, not hang.
    await assert.rejects(
      () => client.callTool("erpnext_doc_get", { doctype: "X", name: "Y" }),
      /MCP_ERROR -32602/,
    );
  } finally {
    await client.close();
  }
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
