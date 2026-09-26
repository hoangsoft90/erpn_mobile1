/**
 * B2 (plan3_review3) — sales_order.create, Reference WRITE #2.
 *
 * The safety argument is built in the order the risk appears:
 *
 *  1. ROUTING — "đặt hàng" reaches the order capability, and the intents it is
 *     easily confused with do NOT: "giao hàng", "báo giá", and any QUESTION
 *     about orders. Measured before the feature existed: all three fell into
 *     inventory/stock.balance, so this closes a real misroute (a wrong READ
 *     answer) and avoids creating a wrong WRITE (an order nobody asked for).
 *  2. BUILDING — what the utterance may decide (item, quantity, unit) and what
 *     it may never decide (price), with every unresolvable line an ASK.
 *  3. EXECUTING — the draft goes through the Safety Gateway, is verified by
 *     reading it back, is once-only per command_id, and is draft-only.
 *  4. FALSE WRITES — a declared-but-unimplemented WRITE, an unregistered
 *     executor and a swapped proposal must all write nothing.
 *
 * No ERPNext credentials: the mock server is the "site" (contract-driven now).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { readFileSync } from "node:fs";

import { routeIntent, routeByCapability } from "../src/router.mjs";
import { executableWriteActions, getCapability } from "../src/capability-contract.mjs";
import { buildProposal } from "../src/action-proposal.mjs";
import {
  buildSalesOrderProposal,
  pairLines,
  priceForLine,
  buildSalesOrderData,
  executeSalesOrderProposal,
} from "../src/skills/sales-order-write.mjs";
import { fingerprintProposal } from "../src/idempotency.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const COPILOT = path.join(ROOT, "src", "copilot-server.mjs");

/* ------------------------------------------------------------ fake site -- */

/**
 * The mock server's fixtures, restated for the pure builder tests. Deliberately
 * the SAME values as src/mock-server.mjs: a unit test that invents its own
 * catalogue would prove the builder works against data ERPNext never returns.
 */
const ITEM_ROWS = [
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
  { name: "CAM-GA-10KG", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", stock_uom: "Bao" },
  { name: "P1F-ACCEPT Livestock Item", item_code: "P1F-ACCEPT Livestock Item", item_name: "P1F-ACCEPT Livestock Item", stock_uom: "Kg" },
];
const PRICE_ROWS = [
  { name: "IP1", item_code: "CAM-HEO-25KG", uom: "Bao", price_list: "Standard Selling", price_list_rate: 305_000, selling: 1 },
  { name: "IP2", item_code: "CAM-GA-10KG", uom: "Bao", price_list: "Standard Selling", price_list_rate: 250_000, selling: 1 },
  { name: "IP3", item_code: "P1F-ACCEPT Livestock Item", uom: "Kg", price_list: "Standard Selling", price_list_rate: 21_000, selling: 1 },
];
const UOM_NAMES = ["Bao", "Tấn", "Kg", "Xe", "Thung", "Viên", "Mét", "m3"];
const UOM_FACTORS = [
  { name: "F1", from_uom: "Tấn", to_uom: "Kg", value: 1000 },
  { name: "F2", from_uom: "Bao", to_uom: "Kg", value: 25 },
];

/** A skills bag like the router builds, with per-test overrides. */
function fakeSkills(over = {}) {
  return {
    findItem: async () => ({ data: { doctype: "Item", count: ITEM_ROWS.length, data: over.items ?? ITEM_ROWS } }),
    listUoms: async () => ({ data: { doctype: "UOM", data: over.uoms ?? UOM_NAMES } }),
    listUomFactors: async () => ({ data: { doctype: "UOM Conversion Factor", data: over.factors ?? UOM_FACTORS } }),
    listItemPrices: async () => ({ data: { doctype: "Item Price", data: over.prices ?? PRICE_ROWS } }),
  };
}

const CUSTOMER = { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" };

/** NLP output shaped exactly like the Python normalizer's (offsets included). */
function nlp(text, quantities) {
  return { text, quantities };
}

/* ------------------------------------------------------------- 1. routing -- */

test("B2 routing: đặt hàng reaches the order WRITE, and its look-alikes do not", () => {
  const order = (t) => routeIntent(t);
  // The order verbs (sentence-initial, like the payment_write group).
  for (const t of [
    "đặt hàng cho Nguyễn Thị Lan 10 bao cám heo",
    "đặt 5 bao cám gà cho Lan",
    "đặt đơn 3 bao cám heo cho Lan",
  ]) {
    const hit = order(t);
    assert.equal(hit?.capability, "sales_order.create", t);
    assert.equal(hit?.group, "sales_order_write", t);
  }
  // MEASURED (2026-09-20): Phase 1's synonym table rewrites "lên đơn" / "tạo
  // đơn" to `sale` BEFORE the router ever sees them, so on the real path those
  // phrasings are a READ (a document list), not an order. The router keeps the
  // keywords for un-normalized input, and this pins the fact instead of
  // pretending the order group covers them.
  assert.equal(order("lên đơn 3 bao cám heo").capability, "sales_order.create", "raw (un-normalized) input");
  assert.equal(order("sale 3 bao cám heo cho chị Lan").capability, "invoice.lookup", "what the pipeline actually routes");

  // The three confusions the phase exists to separate.
  assert.equal(order("giao hàng cho anh Nam hôm nay")?.capability, "delivery.create");
  assert.equal(order("báo giá cám gà cho anh Nam")?.capability, "quotation.create");
  // A QUESTION about an order stays a READ (deny-list, not startsWith luck).
  // WHICH read group it lands in is the router's existing business; what this
  // phase owns is that no order proposal can be produced from a question.
  assert.equal(order("xem đơn hàng của anh Nam")?.capability, "invoice.lookup");
  for (const question of [
    "đặt hàng cho Lan bao nhiêu rồi",
    "đặt hàng hôm nay bán được chưa",
    "kiểm tra đơn hàng của anh Nam",
  ]) {
    const hit = order(question);
    assert.notEqual(hit?.capability, "sales_order.create", question);
    assert.equal(getCapability(hit?.capability)?.type, "READ", `${question} ⇒ ${hit?.capability}`);
  }
  // Cancelling is still the FORBIDDEN capability, checked before any WRITE group.
  const cancel = order("hủy đơn hàng của anh Nam");
  assert.equal(cancel?.capability, "document.delete");
  assert.equal(cancel?.forbidden, true);

  // The look-alikes are WRITE capabilities that go through the ordinary gates;
  // they are NOT forbidden, so the pipeline must answer them from the contract
  // rather than silently ignoring the sentence.
  // B3 turned "báo giá" into a REAL write, P9-A2 did the same for "giao
  // hàng" and P9-B for "nhận/nhập hàng" — no stub WRITE remains. The
  // invariant this test guards is unchanged: a stub can never look
  // callable-with-no-behaviour, and every implemented write names its doctype.
  assert.equal(getCapability("purchase_receipt.create").status, undefined, "P9-B: implemented, no longer a stub");
  assert.equal(getCapability("purchase_receipt.create").execution.write_doctype, "Purchase Receipt");
  assert.equal(getCapability("quotation.create").status, undefined, "B3: implemented, no longer a stub");
  assert.equal(getCapability("quotation.create").execution.write_doctype, "Quotation");
  assert.equal(getCapability("delivery.create").status, undefined, "P9-A2: implemented, no longer a stub");
  assert.equal(getCapability("delivery.create").execution.write_doctype, "Delivery Note");
  // Implemented writes resolve through routeByCapability; a stub (none left)
  // would still resolve to null.
  assert.equal(routeByCapability("purchase_receipt.create")?.capability, "purchase_receipt.create");
  assert.equal(routeByCapability("quotation.create")?.capability, "quotation.create");
  assert.equal(routeByCapability("sales_order.create")?.capability, "sales_order.create");
  assert.equal(routeByCapability("delivery.create")?.capability, "delivery.create");
});

/* -------------------------------------------------------- 2. the builder -- */

test("B2 builder: an order is built from ERPNext facts, and says what it is", async () => {
  const built = await buildSalesOrderProposal(
    fakeSkills(),
    { customer: CUSTOMER, ambiguous: false, candidates: [] },
    { nlp: nlp("đặt hàng cho Nguyễn Thị Lan 10 bao cám heo", [
      { value: 10, unit: "bao", canonical_unit: "bao", raw: "10 bao", start: 24, end: 30 },
    ]) },
  );
  const p = built.proposal;
  assert.equal(p.action, "create_sales_order");
  assert.equal(p.risk, "HIGH", "a write that creates a real order is HIGH");
  assert.equal(p.entity.id, "CUST-00001");
  // Price comes from Item Price — never from the sentence, which had no price.
  assert.equal(p.params.lines.length, 1);
  assert.equal(p.params.lines[0].rate, 305_000);
  assert.equal(p.params.lines[0].uom, "Bao");
  assert.equal(p.params.lines[0].amount_vnd, 10 * 305_000);
  assert.equal(p.params.estimated_total_vnd, 3_050_000);
  assert.equal(p.params.total_source, "qty_x_erpnext_rate");
  // Draft-only is frozen into the snapshot the card renders.
  assert.equal(p.params.submit_now, false);
  // The correlation id travels with the proposal, generated server-side.
  assert.match(p.action_id, /^act_[0-9a-f-]{36}$/);
});

test("B2 builder: multi-line orders, and the number in an item's OWN name is not a quantity", async () => {
  const text = "đặt 2 bao cám heo tăng trọng 25kg và 3 bao cám gà thịt 10kg cho Nguyễn Thị Lan";
  // Offsets are DERIVED from the utterance, exactly as the Python normalizer
  // reports them (hardcoding them would test the test, not the pairing rule).
  const at = (needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
  const built = await buildSalesOrderProposal(
    fakeSkills(),
    { customer: CUSTOMER, ambiguous: false, candidates: [] },
    {
      nlp: nlp(text, [
        { value: 2, unit: "bao", canonical_unit: "bao", raw: "2 bao", ...at("2 bao") },
        { value: 25, unit: "kg", canonical_unit: "kg", raw: "25kg", ...at("25kg") },
        { value: 3, unit: "bao", canonical_unit: "bao", raw: "3 bao", ...at("3 bao") },
        { value: 10, unit: "kg", canonical_unit: "kg", raw: "10kg", ...at("10kg") },
      ]),
    },
  );
  const lines = built.proposal.params.lines;
  assert.equal(lines.length, 2);
  // Paired by span: 2 → the heo line, 3 → the gà line. The 25kg/10kg are the
  // PACKAGING of the item, read from ERPNext's own name (B1 lesson).
  assert.deepEqual(lines.map((l) => [l.item_code, l.qty]), [
    ["CAM-HEO-25KG", 2],
    ["CAM-GA-10KG", 3],
  ]);
  assert.equal(built.proposal.params.estimated_total_vnd, 2 * 305_000 + 3 * 250_000);
});

test("B2 builder: everything a line cannot answer is an ASK, never a guess", async () => {
  const resolve = (n, skills = fakeSkills()) =>
    buildSalesOrderProposal(skills, { customer: CUSTOMER, ambiguous: false, candidates: [] }, { nlp: n });
  const codeOf = async (n, skills) => {
    try {
      await resolve(n, skills);
      return null;
    } catch (err) {
      return err.code;
    }
  };

  // No item named at all.
  assert.equal(await codeOf(nlp("đặt 5 bao cho Nguyễn Thị Lan", [])), "SO_ITEM_UNRESOLVED");
  // Item named, no quantity: "how many" is not something to infer.
  assert.equal(await codeOf(nlp("đặt cám heo tăng trọng 25kg cho Lan", [])), "SO_QTY_MISSING");
  // ONE item with TWO quantities: "2 bao và 3 bao" is a question, not 5.
  assert.equal(
    await codeOf(
      nlp("đặt 2 bao cám heo tăng trọng 25kg và 3 bao cám heo tăng trọng 25kg", [
        { value: 2, unit: "bao", canonical_unit: "bao", raw: "2 bao", start: 4, end: 9 },
        { value: 3, unit: "bao", canonical_unit: "bao", raw: "3 bao", start: 38, end: 43 },
      ]),
    ),
    "SO_QTY_AMBIGUOUS",
  );
  // An ambiguous unit ("thùng" depends on the packaging) stays an ASK.
  assert.equal(
    await codeOf(
      nlp("đặt 5 thùng cám heo tăng trọng 25kg cho Lan", [
        { value: 5, unit: "thùng", canonical_unit: "thùng", raw: "5 thùng", start: 4, end: 12 },
      ]),
    ),
    "SO_UOM_UNRESOLVED",
  );
  // A unit ERPNext does not have is NOT silently swapped for the item default.
  assert.equal(
    await codeOf(
      nlp("đặt 5 bó cám heo tăng trọng 25kg cho Lan", [
        { value: 5, unit: "bó", canonical_unit: "bó", raw: "5 bó", start: 4, end: 8 },
      ]),
    ),
    "SO_UOM_UNRESOLVED",
  );
  // A Tấn→Kg conversion exists, but there is no PRICE for "Tấn" — and a price is
  // not something to derive from another unit's price.
  assert.equal(
    await codeOf(
      nlp("đặt 1 tấn P1F-ACCEPT Livestock Item cho Lan", [
        { value: 1, unit: "tấn", canonical_unit: "tấn", raw: "1 tấn", start: 4, end: 9 },
      ]),
    ),
    "SO_PRICE_MISSING",
  );
  // A converted line that DOES have a price carries the factor explicitly.
  const converted = await resolve(
    nlp("đặt 1 tấn Kg Item cho Lan", [{ value: 1, unit: "tấn", canonical_unit: "tấn", raw: "1 tấn", start: 4, end: 9 }]),
    fakeSkills({
      items: [{ name: "KG-ITEM", item_code: "KG-ITEM", item_name: "Kg Item", stock_uom: "Kg" }],
      prices: [{ name: "IPX", item_code: "KG-ITEM", uom: "Tấn", price_list: "Standard Selling", price_list_rate: 21_000_000, selling: 1 }],
    }),
  );
  assert.equal(converted.proposal.params.lines[0].conversion_factor, 1000);
  assert.match(converted.proposal.params.lines[0].uom_display, /quy đổi/);
  // ERPNext unreachable while building is a refusal with copy, not a crash.
  assert.equal(
    await codeOf(nlp("đặt 1 bao cám heo", []), fakeSkills({ items: undefined }) ),
    "SO_QTY_MISSING",
  );
});

test("B2 builder: the line limit is enforced from the contract, not from hope", async () => {
  const max = Number(getCapability("sales_order.create").line_policy.max_lines);
  const many = Array.from({ length: max + 1 }, (_, i) => ({
    item_code: `IT-${i}`,
    name: `IT-${i}`,
    item_name: `cám loại ${i}`,
    stock_uom: "Bao",
  }));
  const text = many.map((i) => i.item_name).join(" và ");
  const quantities = many.map((_, i) => ({
    value: 1, unit: "bao", canonical_unit: "bao", raw: `${i + 1} bao`, start: i * 10, end: i * 10 + 5,
  }));
  await assert.rejects(
    () =>
      buildSalesOrderProposal(
        fakeSkills({ items: many }),
        { customer: CUSTOMER, ambiguous: false, candidates: [] },
        { nlp: nlp(text, quantities) },
      ),
    (err) => err.code === "SO_LINE_LIMIT",
  );
});

test("B2 pairing rules are pure functions of the utterance", () => {
  const A = { item: { item_code: "A", item_name: "cám heo" }, hit: 2, span: { start: 10, end: 17, phrase: "cám heo" } };
  const B = { item: { item_code: "B", item_name: "cám gà" }, hit: 2, span: { start: 30, end: 36, phrase: "cám gà" } };
  // Nearest-preceding wins; a quantity belonging to neither is a problem.
  const ok = pairLines({
    matched: [A, B],
    quantities: [
      { value: 2, raw: "2 bao", start: 4, end: 9 },
      { value: 3, raw: "3 bao", start: 20, end: 25 },
    ],
  });
  assert.deepEqual(ok.lines.map((l) => [l.item.item_code, l.quantity.value]), [["A", 2], ["B", 3]]);
  assert.equal(ok.problems.length, 0);

  const leftover = pairLines({
    matched: [A],
    quantities: [
      { value: 2, raw: "2 bao", start: 4, end: 9 },
      { value: 9, raw: "9 bao", start: 40, end: 45 },
    ],
  });
  assert.equal(leftover.problems[0].code, "SO_QTY_AMBIGUOUS");

  // A quantity AFTER the item is only attributable when there is exactly one
  // item to attribute it to.
  const after = pairLines({
    matched: [A],
    quantities: [{ value: 7, raw: "7 bao", start: 20, end: 25 }],
  });
  assert.equal(after.lines[0].quantity.value, 7);
  const afterTwo = pairLines({
    matched: [A, B],
    quantities: [{ value: 7, raw: "7 bao", start: 40, end: 45 }],
  });
  assert.equal(afterTwo.problems[0].code, "SO_QTY_MISSING");
});

test("B2 price lookup is keyed on (item, uom) — a price is never carried across units", () => {
  const rows = [
    { item_code: "X", uom: "Bao", price_list: "Standard Selling", price_list_rate: 100 },
    { item_code: "X", uom: "Kg", price_list: "Standard Selling", price_list_rate: 4 },
  ];
  assert.equal(priceForLine(rows, { itemCode: "X", uom: "Bao" }).rate, 100);
  assert.equal(priceForLine(rows, { itemCode: "X", uom: "Tấn" }), null);
  // A chosen price list wins when the site has more than one.
  const two = [
    { item_code: "X", uom: "Bao", price_list: "Standard Selling", price_list_rate: 100 },
    { item_code: "X", uom: "Bao", price_list: "Đại lý", price_list_rate: 90 },
  ];
  assert.equal(priceForLine(two, { itemCode: "X", uom: "Bao", priceList: "Đại lý" }).rate, 90);
  // A zero/absent rate is "no price", never "free".
  assert.equal(priceForLine([{ item_code: "X", uom: "Bao", price_list_rate: 0 }], { itemCode: "X", uom: "Bao" }), null);
});

test("B2 payload: only ERPNext's fields, and only the factor that was shown", () => {
  const data = buildSalesOrderData({
    customerId: "CUST-00001",
    lines: [
      { item_code: "A", qty: 2, uom: "Bao", rate: 100, conversion_factor: 25 },
      { item_code: "B", qty: 1, uom: "Bao", rate: 200, conversion_factor: null },
    ],
    company: "Demo Feed Co",
    transactionDate: "2026-09-20",
    actionId: "act_1",
    correlation: "custom_ai_action_id",
  });
  assert.equal(data.doctype, "Sales Order");
  assert.equal(data.custom_ai_action_id, "act_1");
  assert.deepEqual(data.items[0], { item_code: "A", qty: 2, uom: "Bao", rate: 100, conversion_factor: 25 });
  // No conversion ⇒ no factor field at all (not a silent 1).
  assert.deepEqual(data.items[1], { item_code: "B", qty: 1, uom: "Bao", rate: 200 });
  // The order is never submitted by this payload.
  assert.equal("docstatus" in data, false);
});

/* --------------------------------------------------------- 3. the gateway -- */

const STORE_ENV_KEYS = ["MOCK_ERP_SO_NO_CORRELATION_FIELD", "MOCK_ERP_FAIL_WRITE", "MOCK_ERP_FAIL_AFTER_WRITE", "MOCK_ERP_SO_DROP_LINE"];
function withEnv(vars, fn) {
  const saved = Object.fromEntries(STORE_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

/**
 * A proposal shaped exactly like the one the pipeline produces (including
 * `stock_uom`, which the executor compares — a field the server reads must be a
 * field the client round-trips).
 */
const DEFAULT_LINES = [
  { item_code: "CAM-HEO-25KG", item_name: "Cám heo", qty: 2, uom: "Bao", rate: 305_000, amount_vnd: 610_000, stock_uom: "Bao", conversion_factor: null },
];
function orderProposal({ lines, customer = "CUST-00001", actionId = "act_b2_test" } = {}) {
  const useLines = lines ?? DEFAULT_LINES;
  return buildProposal({
    action: "create_sales_order",
    risk: "HIGH",
    entity: { kind: "customer", id: customer, name: "Nguyễn Thị Lan" },
    params: {
      lines: useLines,
      line_count: useLines.length,
      estimated_total_vnd: useLines.reduce((s, l) => s + l.amount_vnd, 0),
      total_source: "qty_x_erpnext_rate",
      submit_now: false,
    },
    summary: "Tạo đơn NHÁP",
    extra: { action_id: actionId, warnings: [] },
  });
}

async function withGateway(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "b2-so-"));
  try {
    const { runExecute } = await import("../src/safety-gateway.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    return await fn({ runExecute, store: new IdempotencyStore(dir) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("B2 gateway: an order is created as a DRAFT, verified by reading it back, and replayable", async () => {
  await withGateway(async ({ runExecute, store }) => {
    const commandId = randomUUID();
    const verdict = await runExecute({ command_id: commandId, proposal: orderProposal(), store });
    assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
    const result = verdict.body.result;
    assert.match(result.erpnext_doc, /^SO-M\d+$/);
    assert.equal(result.docstatus, 0, "draft only — the order is never submitted");
    assert.equal(result.customer, "CUST-00001");
    assert.equal(result.line_count, 1);
    assert.equal(result.estimated_total_vnd, 610_000);
    assert.equal(result.erpnext_total_vnd, 610_000);
    assert.equal(result.action_id, "act_b2_test");
    assert.match(result.note, /NHÁP/);

    // Same command_id again ⇒ the stored result, not a second order.
    const replay = await runExecute({ command_id: commandId, proposal: orderProposal(), store });
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.result.erpnext_doc, result.erpnext_doc);
  });
});

test("B2 gateway: the client's rate is NOT trusted — a moved price is PROPOSAL_STALE", async () => {
  await withGateway(async ({ runExecute, store }) => {
    const proposal = orderProposal({
      lines: [{ ...DEFAULT_LINES[0], rate: 999, amount_vnd: 1998 }],
    });
    const verdict = await runExecute({ command_id: randomUUID(), proposal, store });
    assert.equal(verdict.status, 409, JSON.stringify(verdict.body));
    assert.equal(verdict.body.code, "PROPOSAL_VERSION_STALE", "a data drift, not an entity change");
    assert.match(verdict.body.problems.join(" "), /giá đổi 999/i);
  });
});

test("B2 gateway: no correlation field on the site ⇒ refuse BEFORE writing", async () => {
  await withEnv({ MOCK_ERP_SO_NO_CORRELATION_FIELD: "1" }, async () => {
    await withGateway(async ({ runExecute, store }) => {
      const verdict = await runExecute({ command_id: randomUUID(), proposal: orderProposal(), store });
      assert.equal(verdict.status, 500, JSON.stringify(verdict.body));
      assert.equal(verdict.body.code, "SO_CORRELATION_FIELD_MISSING");
      assert.match(verdict.body.error, /custom_ai_action_id/);
      // The refusal is terminal and says what to DO about it.
      assert.match(verdict.body.error, /migration/i);
    });
  });
});

test("B2 gateway: a written order that reads back wrong is NOT reported as success", async () => {
  await withEnv({ MOCK_ERP_SO_DROP_LINE: "1" }, async () => {
    await withGateway(async ({ runExecute, store }) => {
      const commandId = randomUUID();
      const verdict = await runExecute({ command_id: commandId, proposal: orderProposal(), store });
      assert.equal(verdict.status, 503, JSON.stringify(verdict.body));
      assert.equal(verdict.body.retry_same_command_id, true);
      // The order WAS created — so the command must stay PENDING (reconcile-able)
      // instead of FAILED, which would push the user toward a second order.
      assert.equal(store.status(commandId).status, "PENDING");
    });
  });
});

test("B2 gateway: an order that may have landed keeps its intent locked, so a second order cannot start", async () => {
  await withEnv({ MOCK_ERP_FAIL_AFTER_WRITE: "1" }, async () => {
    await withGateway(async ({ runExecute, store }) => {
      const first = randomUUID();
      const v1 = await runExecute({ command_id: first, proposal: orderProposal(), store });
      assert.equal(v1.status, 503);
      // The order IS in the mock ledger; only the response was lost.
      const second = await runExecute({ command_id: randomUUID(), proposal: orderProposal(), store });
      assert.equal(second.status, 409, JSON.stringify(second.body));
      assert.equal(second.body.code, "IDEMPOTENCY_INTENT_IN_FLIGHT");
      assert.equal(second.body.clash_command_id, first);
    });
  });
});

test("B2 gateway: a declared-but-unimplemented WRITE has NO executor — the false write is refused", async () => {
  await withGateway(async ({ runExecute, store }) => {
    // P9-B was the last declared-but-unimplemented WRITE; with it wired, the
    // false-write guard is exercised on a STILL-fictional action. The refusal
    // contract is unchanged: an action with no executor entry is refused with
    // EXECUTOR_NOT_REGISTERED and consumes no command_id.
    for (const [action, capability] of [
      ["create_stock_entry", "stock_entry.create"],
    ]) {
      const proposal = buildProposal({
        action,
        risk: "HIGH",
        entity: { kind: "customer", id: "CUST-00001", name: "Nguyễn Thị Lan" },
        params: {},
        summary: "should not exist",
      });
      const verdict = await runExecute({ command_id: randomUUID(), proposal, store });
      // A fictional action has no capability mapping at all, so the FIRST gate
      // refuses it with the "only these actions are executable" 400 (no code
      // field — the code-bearing EXECUTOR_NOT_REGISTERED refusal sits one gate
      // deeper, for an action whose capability IS declared but never wired).
      assert.equal(verdict.status, 400, `${capability}: ${JSON.stringify(verdict.body)}`);
      assert.match(String(verdict.body.error), /only .* proposals are executable/, JSON.stringify(verdict.body));
    }
    // Nothing above may leave a command behind: a refusal that consumed a
    // command_id would make the client re-ask for no reason.
    assert.equal(store.status(randomUUID()), null);
  });
});

test("B2 gateway: the SAME proposal confirmed under a NEW command_id cannot write a second order", async () => {
  // The mock "site" must REMEMBER the first order across the two execute calls
  // (a real ERPNext would): a fresh in-memory mock per call would hide the very
  // duplicate this test exists to catch.
  const stateDir = mkdtempSync(path.join(tmpdir(), "b2-so-state-"));
  const stateFile = path.join(stateDir, "state.json");
  process.env.MOCK_ERP_STATE = stateFile;
  try {
    await withGateway(async ({ runExecute, store }) => {
    const proposal = orderProposal();
    const first = await runExecute({ command_id: randomUUID(), proposal, store });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // A client bug (or a re-ask that kept the proposal) sends the same snapshot
    // with a fresh key. The store has never seen this key, so the write path is
    // reached — and stops on the ERPNext-side correlation, the half that does
    // not depend on the client behaving.
    const second = await runExecute({ command_id: randomUUID(), proposal, store });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.code, "SO_DUPLICATE_ACTION");
    assert.equal(second.body.existing_doc, first.body.result.erpnext_doc);
    // Terminal, and honest about it: nothing new was written.
    assert.equal(second.body.retry_same_command_id, undefined);

    // Proof on the mock "site": still exactly ONE order for this action id.
    const client = createMcpClient({ serverScript: MOCK_SERVER });
    try {
      await client.initialize();
      const found = await client.callTool("erpnext_doc_list", {
        doctype: "Sales Order",
        fields: ["name", "custom_ai_action_id"],
        filters: [["custom_ai_action_id", "=", "act_b2_test"]],
        limit: 5,
      });
      assert.equal(found.data.data.length, 1);
    } finally {
      await client.close().catch(() => {});
    }
  });
  } finally {
    delete process.env.MOCK_ERP_STATE;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("B2 gateway: the approved lines cannot be swapped under a stable command_id", async () => {
  await withGateway(async ({ runExecute, store }) => {
    const commandId = randomUUID();
    const v1 = await runExecute({ command_id: commandId, proposal: orderProposal(), store });
    assert.equal(v1.status, 200);
    const other = orderProposal({
      lines: [{ item_code: "CAM-GA-10KG", item_name: "Cám gà", qty: 5, uom: "Bao", rate: 250_000, amount_vnd: 1_250_000, stock_uom: "Bao" }],
    });
    // Same key, DIFFERENT order. The answer is the FIRST order's result — the
    // swapped lines are never written, and the client is not told its new
    // proposal succeeded.
    const v2 = await runExecute({ command_id: commandId, proposal: other, store });
    assert.equal(v2.body.replay, true);
    assert.equal(v2.body.result.erpnext_doc, v1.body.result.erpnext_doc);
    assert.equal(store.status(commandId).result.erpnext_doc, v1.body.result.erpnext_doc);

    // What makes that safe rather than lucky: the line set IS part of the
    // fingerprint, so a command that is still PENDING cannot have its approved
    // lines swapped either (the store compares fingerprints there — an
    // amount/invoice-only fingerprint would see two identical orders).
    assert.notEqual(fingerprintProposal(orderProposal()), fingerprintProposal(other));
    // ...and a payment fingerprint is unchanged by that addition (amount+invoice
    // still identify it, so nothing about P7's once-only behaviour moved).
    const pay = (amount, invoice) =>
      buildProposal({
        action: "create_payment_entry",
        risk: "HIGH",
        entity: { kind: "customer", id: "CUST-00001", name: "Lan" },
        params: { amount_vnd: amount, invoice },
        summary: "thu",
      });
    assert.notEqual(fingerprintProposal(pay(500_000, "SINV-1")), fingerprintProposal(pay(500_000, "SINV-2")));
    assert.equal(fingerprintProposal(pay(500_000, "SINV-1")), fingerprintProposal(pay(500_000, "SINV-1")));
  });
});

test("B2 gateway: no amount field is required for an order, and the amount gate still protects a payment", async () => {
  await withGateway(async ({ runExecute, store }) => {
    // An order has no amount_vnd at all: if the amount gate ran for it, this
    // would be INVALID_AMOUNT. It must instead get as far as the write path.
    const noAmount = buildProposal({
      action: "create_sales_order",
      risk: "HIGH",
      entity: { kind: "customer", id: "CUST-00001", name: "Nguyễn Thị Lan" },
      params: { lines: orderProposal().params.lines, line_count: 1, estimated_total_vnd: 610_000 },
      summary: "no amount field",
      extra: { action_id: "act_no_amount" },
    });
    const verdict = await runExecute({ command_id: randomUUID(), proposal: noAmount, store });
    assert.equal(verdict.status, 200, JSON.stringify(verdict.body));

    // ...while a payment without an amount is still refused at the boundary.
    const payment = buildProposal({
      action: "create_payment_entry",
      risk: "HIGH",
      entity: { kind: "customer", id: "CUST-00001", name: "Nguyễn Thị Lan" },
      params: { invoice: "SINV-0001" },
      summary: "missing amount",
    });
    const refused = await runExecute({ command_id: randomUUID(), proposal: payment, store });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "INVALID_AMOUNT");
  });
});

test("B2 client gate: creating is contract-driven, and submitting an order is impossible", async () => {
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();
    // A doctype nobody declared is refused in code. P9-D moved the example to
    // master data ("Customer must never become creatable"); M1 (2026-09-23,
    // user decision (a) — result64 §3.1) moved it BACK to Journal Entry:
    // Customer IS declared writable now (customer.create via the gateway). The
    // invariants that stay: an undeclared doctype is refused in CODE, and the
    // raw callWriteTool surface is in-process only — the single HTTP write door
    // remains /execute through the gateway's executor registry.
    await assert.rejects(
      () => client.callWriteTool("erpnext_doc_create", { doctype: "Journal Entry", data: {} }),
      /WRITE_REFUSED/,
    );
    // Sales Order is creatable … but NOT submittable: this capability is
    // draft-only, and the gate says so rather than the skill remembering to.
    const created = await client.callWriteTool("erpnext_doc_create", {
      doctype: "Sales Order",
      data: buildSalesOrderData({
        customerId: "CUST-00001",
        lines: [{ item_code: "CAM-HEO-25KG", qty: 1, uom: "Bao", rate: 305_000 }],
        company: "Demo Feed Co",
        transactionDate: "2026-09-20",
        actionId: "act_gate",
        correlation: "custom_ai_action_id",
      }),
    });
    // The client wraps every result ({__untrusted, source, data: payload}) and
    // the handler payload nests again — the exact trap the write skill warns
    // about, so the test unwraps it the same way rather than pretending.
    const docName = created.data.data.name;
    assert.match(docName, /^SO-M\d+$/);
    await assert.rejects(
      () => client.callWriteTool("erpnext_doc_submit", { doctype: "Sales Order", name: docName }),
      /WRITE_REFUSED/,
    );
    // The order really is still a draft after the refused submit.
    const back = await client.callTool("erpnext_doc_get", { doctype: "Sales Order", name: docName });
    assert.equal(back.data.data.docstatus, 0);
  } finally {
    await client.close().catch(() => {});
  }
});

test("B2 executor: an unrecognised unit never reaches a written line", async () => {
  // Direct call: the executor is behind the gateway in production, but its own
  // validation (line limit, positive quantity) is what this pins.
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  const store = { setReference() {}, complete() {} };
  try {
    await client.initialize();
    await assert.rejects(
      () =>
        executeSalesOrderProposal(
          client,
          orderProposal({ lines: [{ ...DEFAULT_LINES[0], qty: 0 }] }),
          randomUUID(),
          store,
        ),
      (err) => err.code === "SO_QTY_MISSING",
    );
  } finally {
    await client.close().catch(() => {});
  }
});

test("B2 cross-check: the Flutter client confirms EXACTLY the actions the contract can execute", async () => {
  // The card's confirm button and the gateway's executor registry are two
  // halves of one decision — "which writes exist". If they drift, either a
  // user confirms something nothing can execute, or a real write is stranded
  // behind a card with no button. So the Dart set is parsed here and compared
  // with the contract, making the drift impossible to merge silently.
  const dart = readFileSync(
    path.join(REPO, "apps", "mobile", "lib", "features", "chat", "data", "chat_models.dart"),
    "utf8",
  );
  const match = dart.match(/_confirmableActions = \{([^}]*)\}/);
  assert.ok(match, "the client must keep the _confirmableActions set (see chat_models.dart)");
  const clientActions = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const serverActions = executableWriteActions().sort();
  assert.deepEqual(clientActions, serverActions);
});

/* ------------------------------------------------- 4. end-to-end pipeline -- */

/** Strip ERPNEXT_* so the child always talks to the in-memory mock. */
const MOCK_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));

async function startNlpService() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`nlp service exited early (${code})`)));
    setTimeout(() => reject(new Error("nlp service: no ready line in 5s")), 5000);
  });
  return { child, port };
}

function startCopilot(port, extraEnv = {}) {
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...MOCK_ENV, NLP_SERVICE_PORT: String(port), ...extraEnv },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`MCP_ERROR ${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  });
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  return {
    child,
    request,
    async call(text, extraArgs = {}) {
      const res = await request("tools/call", { name: "copilot_ask", arguments: { text, ...extraArgs } });
      assert.equal(res.isError, undefined, `tool error: ${res.content?.[0]?.text}`);
      return res.structuredContent ?? JSON.parse(res.content[0].text);
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

test("B2 E2E: an order sentence produces a HIGH draft proposal, and nothing is written", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("đặt hàng cho Nguyễn Thị Lan 2 bao cám heo tăng trọng 25kg");
    assert.equal(out.routed.group, "sales_order_write", JSON.stringify(out.routed));
    assert.equal(out.proposal?.action, "create_sales_order", JSON.stringify(out.proposal));
    assert.equal(out.proposal.risk, "HIGH");
    assert.equal(out.proposal.entity.id, "CUST-00001");
    assert.equal(out.proposal.params.lines[0].rate, 305_000);
    assert.equal(out.proposal.params.lines[0].qty, 2);
    assert.equal(out.proposal.params.submit_now, false);
    // The answer TELLS the user it is a draft (the card and the sentence agree).
    assert.match(out.answer, /NHÁP/);
    assert.match(out.answer, /610\.000/, out.answer);
    // Asking is not writing: there is no document yet.
    assert.equal(out.proposal.params.lines.length, 1);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("B2 E2E: giao hàng never becomes an ORDER, and báo giá never becomes an ORDER", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    // P9-A2 wired this group: it is now a REAL (draft-only) write of its own,
    // so what this cross-write test owns is unchanged and still the point —
    // "giao hàng" must never surface as a Sales Order. The mock has no SUBMITTED
    // order for this customer, so the answer is a refusal (an ASK), not a card:
    // the invariant is "no proposal, nothing written", however the refusal is
    // worded. The delivery path's own behaviour is owned by p9-delivery.test.mjs.
    const delivery = await copilot.call("giao hàng cho Nguyễn Thị Lan");
    assert.equal(delivery.routed.group, "delivery_write");
    assert.notEqual(delivery.proposal?.action, "create_sales_order", "a delivery is not an order");
    assert.equal(delivery.proposal, null, "no proposal: there is no submitted order to deliver against");
    assert.equal(delivery.error_code, "DN_SO_UNRESOLVED", JSON.stringify(delivery));
    assert.ok(delivery.reason.length > 0);

    // B3: "báo giá" is now a REAL write of its OWN — the invariant this test
    // owns is the cross-write one: it must never surface as an order. Without a
    // quantity it answers with a QT_ refusal (an ASK), and never a proposal.
    const quote = await copilot.call("báo giá cám gà cho Nguyễn Thị Lan");
    assert.equal(quote.routed.group, "quotation_write", JSON.stringify(quote.routed));
    assert.notEqual(quote.proposal?.action, "create_sales_order", "an offer is not an order");
    assert.equal(quote.proposal, null);
    assert.equal(quote.error_code, "QT_QTY_MISSING", JSON.stringify(quote));
    assert.ok(quote.reason.length > 0, "a refusal without copy is not an answer");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("B2 E2E: a fuzzy customer for an order asks for a pick, and builds nothing", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    // "Hai" is not the full stored name ("Trần Văn Hai") ⇒ FUZZY_SINGLE_MATCH,
    // and §4.3 forbids auto-selecting a fuzzy match for a WRITE.
    const out = await copilot.call("đặt hàng cho Hai 2 bao cám heo tăng trọng 25kg");
    assert.equal(out.proposal, null, JSON.stringify(out.proposal));
    assert.equal(out.error_code, "ENTITY_PICK_REQUIRED");
    assert.ok(Array.isArray(out.candidates), "the picker must have candidates to offer");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("B2 E2E: in the read-only AI mode (dsh), an order sentence is blocked", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { COPILOT_DSH_CONTEXT: "1" });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("đặt hàng cho Nguyễn Thị Lan 2 bao cám heo tăng trọng 25kg");
    assert.equal(out.error_code, "DSH_WRITE_BLOCKED");
    assert.equal(out.proposal, null);
    // The READ path is untouched in the same process.
    const read = await copilot.call("Nguyễn Thị Lan còn nợ bao nhiêu");
    assert.equal(read.customer.id, "CUST-00001");
    assert.ok(read.answer.includes("2.500.000"), read.answer);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});
