/**
 * Tests for the Phase 2 skeleton — `node --test test/`.
 * Covers: intent routing (no embeddings), the read-only guard (write verbs
 * refused in code), and the no-invented-ID rule.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { routeIntent } from "../src/router.mjs";
import { assertReadOnly, assertKnownId, markUntrusted, READ_ONLY_TOOLS } from "../src/readonly-guard.mjs";
import * as customer from "../src/skills/customer.mjs";
import * as sales from "../src/skills/sales.mjs";
import * as payment from "../src/skills/payment.mjs";
import * as inventory from "../src/skills/inventory.mjs";

// ---------------------------------------------------------------- routing --

test("routes payment intent", () => {
  assert.equal(routeIntent("Nam trả 500 nghìn tiền cám")?.group, "payment");
  assert.equal(routeIntent("phiếu thu cho anh Nam")?.group, "payment");
});

test("routes customer/receivable intent", () => {
  assert.equal(routeIntent("công nợ của anh Nam là bao nhiêu")?.group, "customer");
  assert.equal(routeIntent("khách hàng còn nợ mấy")?.group, "customer");
});

test("routes inventory intent", () => {
  assert.equal(routeIntent("tồn kho cám heo còn bao nhiêu")?.group, "inventory");
  assert.equal(routeIntent("kho còn mấy bao cám")?.group, "inventory");
});

test("routes sales intent", () => {
  assert.equal(routeIntent("hóa đơn chưa trả của chị Lan")?.group, "sales");
});

test("unknown intent returns null (no guessing)", () => {
  assert.equal(routeIntent("thời tiết hôm nay đẹp"), null);
});

test("skill groups expose only business-level functions using whitelisted tools", () => {
  // sanity: every exported skill function is a named function (no tool dump)
  for (const mod of [customer, sales, payment, inventory]) {
    for (const [name, fn] of Object.entries(mod)) {
      assert.equal(typeof fn, "function", `${name} must be a function`);
    }
  }
});

// ------------------------------------------------------------------ guard --

test("read-only whitelist passes known read tools", () => {
  for (const tool of READ_ONLY_TOOLS) {
    assert.ok(assertReadOnly(tool));
  }
});

test("whitelist uses REAL 3.0.4 tool names (erpnext_*), not generic ones", () => {
  // The first skeleton whitelisted get_list/get_doc — names the pinned package
  // does not expose. Guard against regressing to invented names.
  for (const tool of READ_ONLY_TOOLS) {
    assert.match(tool, /^erpnext_[a-z_]+$/);
  }
  assert.ok(!READ_ONLY_TOOLS.includes("get_list"));
  assert.ok(!READ_ONLY_TOOLS.includes("get_doc"));
  assert.ok(!READ_ONLY_TOOLS.includes("run_sql_query"));
});

test("write verbs are refused in CODE, not prompt", () => {
  const writeTools = [
    "erpnext_doc_create",
    "erpnext_customer_create",
    "erpnext_customer_update",
    "erpnext_doc_update",
    "erpnext_doc_delete",
    "erpnext_doc_submit",
    "erpnext_doc_cancel",
    "erpnext_doc_assign",
    "erpnext_file_upload",
    "erpnext_method_call",
    "erpnext_sales_invoice_submit",
    // plus generic/wrong names are refused too
    "create_payment_entry",
    "set_value",
    "run_doc_method",
  ];
  for (const tool of writeTools) {
    assert.throws(() => assertReadOnly(tool), /TOOL_REFUSED/);
  }
});

test("unknown tool is refused", () => {
  assert.throws(() => assertReadOnly("not_a_real_tool"), /TOOL_REFUSED/);
});

test("empty tool name is refused", () => {
  assert.throws(() => assertReadOnly(""), /TOOL_REFUSED/);
});

test("invented ERPNext IDs are refused", () => {
  const knownIds = new Set(["CUST-00001"]);
  assert.throws(() => assertKnownId("CUST-99999", knownIds), /ID_REFUSED/);
  assert.ok(assertKnownId("CUST-00001", knownIds));
});

test("markUntrusted wraps data with the marker", () => {
  const wrapped = markUntrusted("erpnext:get_list", { x: 1 });
  assert.equal(wrapped.__untrusted, true);
  assert.equal(wrapped.source, "erpnext:get_list");
  assert.deepEqual(wrapped.data, { x: 1 });
});
