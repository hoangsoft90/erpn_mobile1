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

test("Phase 7b: a collect-money COMMAND at sentence start routes to payment_write", () => {
  // The Phase 1 synonym mapper rewrites the verb "thu tiền/trả tiền/thanh
  // toán" to canonical "payment" — a write COMMAND begins its sentence with
  // it. Anchor is the sentence START: substring matching would swallow
  // reading questions like "chưa thanh toán" (→ "...chưa payment").
  assert.equal(routeIntent("payment cho chị Lan 500 ngàn")?.group, "payment_write");
  assert.equal(routeIntent("payment chị Lan 500 ngàn")?.group, "payment_write");
  assert.equal(routeIntent("payment Lan")?.group, "payment_write"); // no amount → full-debt proposal, still a visible HIGH card
});

test("Phase 7b anchor: reading questions containing 'payment' mid-sentence do NOT route to payment_write", () => {
  // Regression for the route swap found while wiring (copilot.test.mjs
  // credit-note E2E started hitting the write group).
  assert.equal(routeIntent("Trần Văn Hai còn bao nhiêu hóa đơn chưa payment")?.group, "sales");
  assert.equal(routeIntent("Trần Văn Hai đã payment bao nhiêu")?.group, "payment");
});

test("Phase 7b anchor round 2: READ-history questions that START with 'payment' do NOT route to payment_write", () => {
  // Review finding 2026-09-16: "thanh toán gần nhất của chị Lan..." (a READ
  // history question) normalizes to a sentence STARTING with "payment" — the
  // sentence-start anchor alone swallowed it into the WRITE group. Question
  // words deny-list the write route; these must reach the READ groups.
  assert.equal(routeIntent("payment gần nhất của chị Lan là bao nhiêu")?.group, "payment");
  assert.equal(routeIntent("payment mới nhất của anh Nam")?.group, "payment");
  assert.equal(routeIntent("payment gần nhất cho chị Lan")?.group, "payment");
  // ...while the collect-money commands still route to the write group.
  assert.equal(routeIntent("payment cho chị Lan 500 ngàn")?.group, "payment_write");
  assert.equal(routeIntent("payment chị Lan 500 ngàn")?.group, "payment_write");
  assert.equal(routeIntent("payment cho Lan")?.group, "payment_write");
});

test("routes customer/receivable intent", () => {
  assert.equal(routeIntent("công nợ của anh Nam là bao nhiêu")?.group, "customer");
  assert.equal(routeIntent("khách hàng còn nợ mấy")?.group, "customer");
});

test("specific groups beat the broad customer group (result9 batch findings)", () => {
  // b08/b09: invoice questions that MENTION a customer must stay sales,
  // the customer group is broad ("khách", "nợ") and checked LAST now.
  assert.equal(routeIntent("hóa đơn chưa trả của Khách làm tròn 2026-09-14")?.group, "sales");
  assert.equal(routeIntent("liệt kê hóa đơn chưa thanh toán của Khách smoke")?.group, "sales");
  // b16: an inventory question with no customer word at all
  assert.equal(routeIntent("thép D16 còn lại trong kho mấy")?.group, "inventory");
  // b12: bare payment-entry question stays payment ("trả" kept intentionally)
  assert.equal(routeIntent("xem phiếu thu của Công trình nhà ông An")?.group, "payment");
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
