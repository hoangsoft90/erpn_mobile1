/**
 * B4 (plan3_review3 §52/§510) — purchase_order.create, WRITE #4.
 *
 * What this file proves, in the order the risk appears:
 *
 *  1. THE MISROUTE IS CLOSED. Measured on the real path 2026-09-20, before this
 *     phase existed: "đặt mua 500 bao cám heo từ Hà Tiên" AND "đặt nhà cung cấp
 *     Hà Tiên 500 bao cám heo" both routed to `sales_order.create` — a shop that
 *     also sells to a name it buys from would have raised a SALES order for its
 *     own supplier. The purchase group now owns those sentences, and the
 *     confusables (giao hàng / báo giá / nhận-nhập hàng) did NOT move into it.
 *  2. THE PARTY IS A SUPPLIER. The route decides which master list is read, not
 *     whichever list happens to contain the name.
 *  3. THE PRICE IS THE BUYING PRICE. The selling table is not read on this path
 *     at all: a purchase booked at the price we sell at is a real accounting
 *     error, and the site declares both sides (295.000 buying vs 305.000 selling
 *     for the same item — verified live).
 *  4. EXECUTING — draft only, verified by reading back, once-only per
 *     command_id, and refusals (never a silent re-price) when the site moved.
 *  5. FALSE WRITES + REGRESSION — the receipt stub cannot execute, the write gate
 *     still refuses an undeclared doctype, and payment/SO/QT still work through
 *     the SAME gateway.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { routeIntent } from "../src/router.mjs";
import {
  assertCapabilityExecutable,
  executableWriteActions,
  getCapability,
} from "../src/capability-contract.mjs";
import { buildProposal } from "../src/action-proposal.mjs";
import {
  buildPurchaseOrderData,
  buildPurchaseOrderProposal,
  executePurchaseOrderProposal,
} from "../src/skills/purchase-order-write.mjs";
import { buildSalesOrderProposal } from "../src/skills/sales-order-write.mjs";
import { buildPaymentProposal } from "../src/skills/payment-write.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";

/* --------------------------------------------------------------- fixtures -- */

/** Same values as src/mock-server.mjs on purpose — a test catalogue of its own
 *  would prove the builder works against data ERPNext never returns. */
const ITEM_ROWS = [
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
  { name: "CAM-GA-10KG", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", stock_uom: "Bao" },
];
/** The SELLING side — present in the fixtures on purpose, so a builder that read
 *  the wrong side would still find a price and only the RATE assertion (below)
 *  would betray it. */
const SELLING_PRICES = [
  { name: "IP1", item_code: "CAM-HEO-25KG", uom: "Bao", price_list: "Standard Selling", price_list_rate: 305_000, selling: 1 },
  { name: "IP2", item_code: "CAM-GA-10KG", uom: "Bao", price_list: "Standard Selling", price_list_rate: 250_000, selling: 1 },
];
const BUYING_PRICES = [
  { name: "IPB1", item_code: "CAM-HEO-25KG", uom: "Bao", price_list: "Standard Buying", price_list_rate: 295_000, buying: 1 },
  { name: "IPB2", item_code: "CAM-GA-10KG", uom: "Bao", price_list: "Standard Buying", price_list_rate: 240_000, buying: 1 },
];
const UOM_NAMES = ["Bao", "Tấn", "Kg", "Xe", "Thung", "Viên", "Mét", "m3"];
const UOM_FACTORS = [
  { name: "F1", from_uom: "Tấn", to_uom: "Kg", value: 1000 },
  { name: "F2", from_uom: "Bao", to_uom: "Kg", value: 25 },
];

function fakeSkills(over = {}) {
  const sides = [];
  return {
    findItem: async () => ({ data: { doctype: "Item", count: (over.items ?? ITEM_ROWS).length, data: over.items ?? ITEM_ROWS } }),
    listUoms: async () => ({ data: { doctype: "UOM", data: over.uoms ?? UOM_NAMES } }),
    listUomFactors: async () => ({ data: { doctype: "UOM Conversion Factor", data: over.factors ?? UOM_FACTORS } }),
    // Records EVERY side the builder asks for, AND resolves like the REAL mock
    // does: a query is answered from the rows that match the FILTER, so a
    // builder that asks for the wrong side (or drops the filter) gets the
    // selling rows and fails the rate assertions — a stub that always returned
    // the buying table would make the price-side guard unfalsifiable.
    listItemPrices: async ({ side } = {}) => {
      sides.push(side ?? null);
      const pool = [...(over.buying ?? BUYING_PRICES), ...(over.selling ?? SELLING_PRICES)];
      const rows = (side ?? null) === null ? pool : pool.filter((r) => Number(r[side] ?? 0) === 1);
      return { data: { doctype: "Item Price", data: rows } };
    },
    // A2 (measured 2026-09-24): a PURCHASE LINE of a stock item needs a
    // warehouse, and the only acceptable source is ERPNext's own `Item Default`.
    // `warehouse: null` models the real site as measured (no default declared),
    // `warehouseOptions` models a site that declares two (⇒ a question, not a
    // pick). Both must REFUSE, never let the purchase path choose a warehouse.
    getItemWarehouseHints: async (code) => ({
      item_code: code,
      is_stock_item: over.isStockItem ?? true,
      warehouse: over.warehouse === undefined ? "Stores - DFC" : over.warehouse,
      options: over.warehouseOptions ?? [],
      ambiguous: (over.warehouseOptions ?? []).length > 1,
    }),
    __sides: sides,
  };
}

const SUPPLIER = { name: "SUP-HATIEN", supplier_name: "Hà Tiên" };
const nlp = (text, quantities) => ({ text, quantities });

/* --------------------------------------------- 1. the misroute is closed -- */

test("B4 routing: đặt mua / mua / đặt nhà cung cấp reach the PURCHASE path (measured closed misroute)", () => {
  // Every sentence here routed to sales_order_write before B4 (measured on the
  // real path); the last two are the dangerous ones — they name a supplier and
  // still became a sales order.
  for (const t of [
    "đặt mua 500 bao cám heo từ Hà Tiên",
    "đặt mua cho Hà Tiên 10 bao cám heo",
    "mua 20 bao cám gà từ Hà Tiên",
    "mua 15 bao cám heo",
    "đặt nhà cung cấp Hà Tiên 5 bao cám heo",
    "đặt ncc Hà Tiên 3 bao cám heo",
  ]) {
    const hit = routeIntent(t);
    assert.equal(hit?.capability, "purchase_order.create", t);
    assert.equal(hit?.group, "purchase_order_write", t);
  }
  // The sales path is UNTOUCHED: an order is still an order.
  assert.equal(routeIntent("đặt hàng cho Nguyễn Thị Lan 10 bao cám heo")?.capability, "sales_order.create");
  assert.equal(routeIntent("đặt 12 bao cám heo cho Bùi Thị Mai")?.capability, "sales_order.create");
  assert.equal(routeIntent("báo giá cho Nguyễn Thị Lan 10 bao cám heo")?.capability, "quotation.create");
  // ...and the other members of the purchase family are their OWN stub, not a PO.
  for (const t of ["nhận hàng từ Hà Tiên 20 bao cám heo"]) {
    assert.equal(routeIntent(t)?.capability, "purchase_receipt.create", t);
  }
  // Phase 1 collapses "nhập hàng"/"nhập kho"/"mua hàng" into one token, so they
  // land in the receipt stub — they must NOT become a purchase ORDER (see
  // B4-result §gap: PR vs Stock Entry is not distinguishable after normalize).
  assert.equal(routeIntent("purchase từ Hà Tiên 10 bao cám heo")?.capability, "purchase_receipt.create");
  assert.equal(routeIntent("purchase 5 bao cám heo")?.capability, "purchase_receipt.create");
});

test("B4 routing: a QUESTION or a PAST-TENSE mention never opens a purchase order", () => {
  for (const t of [
    "đã mua 5 bao cám heo tháng trước",
    "đặt mua 500 bao cám heo từ Hà Tiên bao nhiêu tiền",
    "mua 20 bao cám gà từ Hà Tiên bao nhiêu",
    "hôm qua tôi mua 5 bao cám heo",
  ]) {
    assert.notEqual(routeIntent(t)?.capability, "purchase_order.create", `"${t}" must not create a document`);
  }
  // The deny-list is only honoured because the group is sentence-initial: a
  // non-startsWith group would silently ignore its own notIf (measured — the
  // first B4 golden run failed exactly this way on the receipt group).
  const groups = getCapability("purchase_order.create");
  assert.equal(groups.route_group, "purchase_order_write");
  const contract = JSON.parse(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "capabilities.json"), "utf8"),
  );
  for (const group of ["purchase_order_write", "purchase_receipt_write"]) {
    const raw = contract.routing.find((g) => g.group === group);
    assert.equal(raw.startsWith, true, `${group} must be startsWith or its notIf is dead code`);
    assert.ok(raw.notIf, `${group} must carry a question deny-list`);
  }
});

/* ------------------------------------------------------------ 2. contract -- */

test("B4 contract: the purchase order is a draft-only WRITE on the BUYING side", () => {
  const po = getCapability("purchase_order.create");
  assert.equal(po.type, "WRITE");
  assert.equal(po.risk.level, "HIGH");
  assert.equal(po.risk.requires_confirmation, true);
  assert.equal(po.execution.idempotent, true);
  assert.equal(po.execution.write_doctype, "Purchase Order");
  assert.equal(po.execution.correlation_field, "custom_ai_action_id");
  assert.equal(po.execution.allow_submit, false);
  assert.equal(po.execution.draft_only, true);
  assert.equal(po.amount_policy, null, "no single amount to gate — the risk is per line");
  assert.equal(po.line_policy.rate_source, "erpnext");
  assert.equal(po.line_policy.price_side, "buying", "a purchase order is never priced from the selling table");
  assert.equal(po.entities.required.includes("supplier"), true, "the required party is a supplier");
  // The taxonomy is the purchase path's OWN: a copy-paste from SO/QT is visible.
  for (const code of po.errors) {
    assert.ok(
      code.startsWith("PO_") || (!code.startsWith("SO_") && !code.startsWith("QT_")),
      `${code} is a foreign-prefixed code declared on the purchase path`,
    );
  }
  assertCapabilityExecutable("purchase_order.create");

  // The receipt is a REAL write since P9-B (same draft-only discipline as the
  // purchase order it mirrors) — and the false-write invariant this file owns
  // moves to a STILL-fictional capability so it keeps guarding something.
  const receipt = getCapability("purchase_receipt.create");
  assert.equal(receipt.type, "WRITE");
  assert.equal(receipt.status, undefined, "P9-B: implemented, no longer a stub");
  assert.equal(receipt.execution.write_doctype, "Purchase Receipt");
  assert.equal(receipt.execution.allow_submit, false);
  assertCapabilityExecutable("purchase_receipt.create");
  assert.equal(executableWriteActions().includes("create_purchase_receipt"), true);
  // A capability not in the contract at all fails closed with NOT_FOUND.
  assert.throws(() => assertCapabilityExecutable("stock_entry.create"), (e) => e.code === "CAPABILITY_NOT_FOUND");
});

/* ------------------------------------------------------------- 3. building -- */

test("B4 builder: quantities from the utterance, BUYING prices from ERPNext (never the selling ones)", async () => {
  const skills = fakeSkills();
  const built = await buildPurchaseOrderProposal(
    skills,
    { supplier: SUPPLIER, ambiguous: false, candidates: [] },
    {
      nlp: nlp("đặt mua 2 bao cám heo tăng trọng 25kg và 3 bao cám gà thịt 10kg từ Hà Tiên", [
        { value: 2, canonical_unit: "Bao", raw: "2 bao", start: 0, end: 5 },
        { value: 3, canonical_unit: "Bao", raw: "3 bao", start: 0, end: 5 },
      ]),
    },
  );
  assert.equal(built.proposal.action, "create_purchase_order");
  assert.equal(built.proposal.risk, "HIGH");
  assert.equal(built.proposal.entity.kind, "supplier");
  assert.equal(built.proposal.entity.id, "SUP-HATIEN");
  assert.equal(built.proposal.params.submit_now, false, "a purchase order is never auto-submitted");
  assert.equal(built.proposal.params.price_side, "buying");

  const heo = built.lines.find((l) => l.item_code === "CAM-HEO-25KG");
  const ga = built.lines.find((l) => l.item_code === "CAM-GA-10KG");
  // THE assertion this phase exists for: 295.000/240.000 are the BUYING rates;
  // a builder that read the selling table would report 305.000/250.000 here.
  assert.equal(heo.rate, 295_000);
  assert.equal(ga.rate, 240_000);
  assert.equal(heo.price_list, "Standard Buying");
  assert.equal(built.proposal.params.estimated_total_vnd, 2 * 295_000 + 3 * 240_000);
  assert.equal(built.proposal.params.total_source, "qty_x_erpnext_buying_rate");
  // ...and it never even looked at the selling side.
  assert.deepEqual(skills.__sides, ["buying"]);
});

test("B4 builder: a missing BUYING price is an ASK even when a selling price exists", async () => {
  // The selling table HAS a price for this item. Falling back to it would book
  // the purchase at the price we sell at, so the path must refuse instead.
  const skills = fakeSkills({ buying: [] });
  await assert.rejects(
    () =>
      buildPurchaseOrderProposal(
        skills,
        { supplier: SUPPLIER, ambiguous: false, candidates: [] },
        { nlp: nlp("đặt mua 2 bao cám heo tăng trọng 25kg từ Hà Tiên", [{ value: 2, canonical_unit: "Bao", raw: "2 bao", start: 0, end: 5 }]) },
      ),
    (err) => err.code === "PO_PRICE_MISSING",
  );
  assert.deepEqual(skills.__sides, ["buying"], "the selling table must not be consulted as a fallback");
});

test("A2/P9-E builder: a STOCK line takes its warehouse from ERPNext's Item Default — and REFUSES when the site declared none", async () => {
  const allowed = { supplier: SUPPLIER, ambiguous: false, candidates: [] };
  const args = {
    nlp: nlp("đặt mua 2 bao cám heo tăng trọng 25kg từ Hà Tiên", [
      { value: 2, canonical_unit: "Bao", raw: "2 bao", start: 0, end: 5 },
    ]),
  };

  // 1. The site DID declare one ⇒ it travels on the line and reaches the payload
  //    ERPNext validates.
  const ok = await buildPurchaseOrderProposal(fakeSkills(), allowed, args);
  assert.equal(ok.lines[0].warehouse, "Stores - DFC");
  const data = buildPurchaseOrderData({
    supplierId: "SUP-HATIEN",
    lines: ok.lines,
    company: "Demo Feed Co",
    transactionDate: "2026-09-24",
    actionId: "AI-1",
    correlation: "custom_ai_action_id",
  });
  assert.equal(data.items[0].warehouse, "Stores - DFC", "the warehouse must reach the document");

  // 2. The site declared NONE — the REAL site as measured 2026-09-24 (stock items
  //    with empty item_defaults; ERPNext then answers HTTP 417 "Dòng #1: Kho là
  //    bắt buộc đối với mặt hàng tồn kho …"). → REFUSE. Choosing one of the
  //    shop's warehouses decides where stock physically lands: no code may.
  await assert.rejects(
    () => buildPurchaseOrderProposal(fakeSkills({ warehouse: null }), allowed, args),
    (e) =>
      e.code === "PO_WAREHOUSE_UNRESOLVED" &&
      /Item Default|kho mặc định/.test(e.message) &&
      /KHÔNG tự chọn kho/.test(e.message),
  );

  // 3. TWO declared warehouses is a QUESTION, never a coin flip.
  await assert.rejects(
    () =>
      buildPurchaseOrderProposal(
        fakeSkills({ warehouse: null, warehouseOptions: ["Kho Cám - DFC", "Kho VLXD - DFC"] }),
        allowed,
        args,
      ),
    (e) => e.code === "PO_WAREHOUSE_UNRESOLVED" && /NHIỀU kho/.test(e.message),
  );

  // 4. A line ERPNext does not consider stock needs NO warehouse — the refusal
  //    above must not spread to service lines.
  const service = await buildPurchaseOrderProposal(fakeSkills({ isStockItem: false, warehouse: null }), allowed, args);
  assert.equal(service.lines[0].warehouse, null, "a non-stock line needs no warehouse");
  assert.ok(!("warehouse" in buildPurchaseOrderData({
    supplierId: "SUP-HATIEN",
    lines: service.lines,
    company: "Demo Feed Co",
    transactionDate: "2026-09-24",
    actionId: "AI-2",
    correlation: "custom_ai_action_id",
  }).items[0]), "and none is invented for it");
});

test("B4 builder: an unresolvable line is an ASK with a PO_ code, never a guess", async () => {
  const build = (opts, over = {}) =>
    buildPurchaseOrderProposal(fakeSkills(over), { supplier: SUPPLIER, ambiguous: false, candidates: [] }, opts);

  await assert.rejects(
    () => build({ nlp: nlp("đặt mua cám heo tăng trọng 25kg từ Hà Tiên", []) }),
    (err) => err.code === "PO_QTY_MISSING",
  );
  await assert.rejects(
    () => build({ nlp: nlp("đặt mua từ Hà Tiên nhé", []) }),
    (err) => err.code === "PO_ITEM_UNRESOLVED",
  );
  await assert.rejects(
    () => build({ nlp: nlp("đặt mua 2 bao cám heo tăng trọng 25kg từ Hà Tiên", [{ value: 2, canonical_unit: "Bao", raw: "2 bao", start: 0, end: 5 }]) }, { items: [] }),
    (err) => err.code === "PO_ITEM_UNRESOLVED",
  );
  // Unknown supplier ⇒ no document, and the code names the SUPPLIER (not a customer).
  await assert.rejects(
    () => buildPurchaseOrderProposal(fakeSkills(), { supplier: null, ambiguous: true, candidates: ["Hà Tiên", "Hà Tiên 2"] }, { nlp: nlp("đặt mua 2 bao cám heo từ Hà Tiên", []) }),
    (err) => err.code === "PO_SUPPLIER_UNRESOLVED",
  );
});

test("B4 builder: a converted line carries the factor it is billed in — and NO invented chain", async () => {
  const built = await buildPurchaseOrderProposal(
    fakeSkills({
      items: [{ name: "KG-ITEM", item_code: "KG-ITEM", item_name: "Kg Item", stock_uom: "Kg" }],
      buying: [{ name: "IPBX", item_code: "KG-ITEM", uom: "Tấn", price_list: "Standard Buying", price_list_rate: 21_000_000, buying: 1 }],
    }),
    { supplier: SUPPLIER, ambiguous: false, candidates: [] },
    { nlp: nlp("đặt mua 1 tấn Kg Item từ Hà Tiên", [{ value: 1, canonical_unit: "Tấn", raw: "1 tấn", start: 0, end: 6 }]) },
  );
  const line = built.lines[0];
  assert.equal(line.conversion_factor, 1000);
  assert.equal(line.stock_uom, "Kg");
  assert.match(String(line.uom_display), /= ?1000/);
  // A BAO-stocked item is NOT reachable from Tấn (no direct factor on the site):
  // B1 forbids chaining/inverting, so this ASKS rather than inventing arithmetic.
  await assert.rejects(
    () =>
      buildPurchaseOrderProposal(
        fakeSkills(),
        { supplier: SUPPLIER, ambiguous: false, candidates: [] },
        { nlp: nlp("đặt mua 1 tấn cám heo tăng trọng 25kg từ Hà Tiên", [{ value: 1, canonical_unit: "Tấn", raw: "1 tấn", start: 0, end: 6 }]) },
      ),
    (err) => err.code === "PO_UOM_UNRESOLVED",
  );
});

/* -------------------------------------------------------------- 4. payload -- */

test("B4 payload: a bare SUPPLIER link, and schedule_date on every line", () => {
  const data = buildPurchaseOrderData({
    supplierId: "SUP-HATIEN",
    lines: [
      { item_code: "A", qty: 2, uom: "Bao", rate: 100, conversion_factor: 25 },
      { item_code: "B", qty: 1, uom: "Bao", rate: 200, conversion_factor: null },
    ],
    company: "Demo Feed Co",
    transactionDate: "2026-09-20",
    actionId: "act_1",
    correlation: "custom_ai_action_id",
  });
  assert.equal(data.doctype, "Purchase Order");
  assert.equal(data.supplier, "SUP-HATIEN");
  // A customer field on a Purchase Order would create a document with no party.
  assert.equal("customer" in data, false);
  assert.equal("party_name" in data, false);
  assert.equal(data.custom_ai_action_id, "act_1");
  // schedule_date is mandatory on Purchase Order Item in standard ERPNext: a
  // payload without it fails on the real site, so it is on EVERY line.
  for (const item of data.items) {
    assert.equal(item.schedule_date, "2026-09-20", "every line carries schedule_date");
  }
  assert.deepEqual(data.items[0], { item_code: "A", qty: 2, uom: "Bao", rate: 100, schedule_date: "2026-09-20", conversion_factor: 25 });
  assert.deepEqual(data.items[1], { item_code: "B", qty: 1, uom: "Bao", rate: 200, schedule_date: "2026-09-20" });
  assert.equal("docstatus" in data, false, "draft comes from ERPNext, never from the caller");
});

/* ------------------------------------------------------------ 5. executing -- */

const STORE_ENV_KEYS = [
  "MOCK_ERP_PO_NO_CORRELATION_FIELD",
  "MOCK_ERP_PO_DROP_LINE",
  "MOCK_ERP_PO_ADD_TAX",
  "MOCK_ERP_FAIL_AFTER_WRITE",
  "MOCK_ERP_FAIL_WRITE",
  "MOCK_ERP_STATE",
];
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

const DEFAULT_LINES = [
  { item_code: "CAM-HEO-25KG", item_name: "Cám heo", qty: 2, uom: "Bao", rate: 295_000, amount_vnd: 590_000, stock_uom: "Bao", conversion_factor: null },
];
function purchaseProposal({ lines, supplier = "SUP-HATIEN", actionId = "act_b4_test" } = {}) {
  const useLines = lines ?? DEFAULT_LINES;
  return buildProposal({
    action: "create_purchase_order",
    risk: "HIGH",
    entity: { kind: "supplier", id: supplier, name: "Hà Tiên" },
    params: {
      lines: useLines,
      line_count: useLines.length,
      estimated_total_vnd: useLines.reduce((s, l) => s + l.amount_vnd, 0),
      total_source: "qty_x_erpnext_buying_rate",
      price_side: "buying",
      submit_now: false,
    },
    summary: "Tạo đơn MUA NHÁP",
    extra: { action_id: actionId, warnings: [] },
  });
}

async function withGateway(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "b4-po-"));
  try {
    const { runExecute } = await import("../src/safety-gateway.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    return await fn({ runExecute, store: new IdempotencyStore(dir) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("B4 gateway: a purchase order is created as a DRAFT, verified by reading it back, and replayable", async () => {
  // A state file, so the fresh client below opens a NEW mock process that still
  // sees the document — the persistence a real site has by definition.
  const dir = mkdtempSync(path.join(tmpdir(), "b4-po-draft-"));
  process.env.MOCK_ERP_STATE = path.join(dir, "state.json");
  try {
    await withGateway(async ({ runExecute, store }) => {
      const commandId = randomUUID();
      const verdict = await runExecute({ command_id: commandId, proposal: purchaseProposal(), store });
      assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
      const result = verdict.body.result;
      assert.match(result.erpnext_doc, /^PO-M\d+$/);
      assert.equal(result.docstatus, 0, "draft only");
      assert.equal(result.supplier, "SUP-HATIEN");
      assert.equal(result.price_side, "buying");
      assert.equal(result.erpnext_total_vnd, 590_000);
      assert.equal(result.action_id, "act_b4_test");
      assert.match(result.note, /NHÁP/);
      assert.match(result.note, /MUA/);

      // Same command_id ⇒ the stored result, not a second order.
      const replay = await runExecute({ command_id: commandId, proposal: purchaseProposal(), store });
      assert.equal(replay.body.replay, true);
      assert.equal(replay.body.result.erpnext_doc, result.erpnext_doc);

      // The order really is on the mock "site", exactly once, with a supplier.
      const client = createMcpClient({ serverScript: MOCK_SERVER });
      try {
        await client.initialize();
        const found = await client.callTool("erpnext_doc_list", {
          doctype: "Purchase Order",
          fields: ["name", "supplier", "docstatus"],
          limit: 20,
        });
        assert.equal(found.data.data.length, 1);
        assert.equal(found.data.data[0].supplier, "SUP-HATIEN");
      } finally {
        await client.close().catch(() => {});
      }
    });
  } finally {
    delete process.env.MOCK_ERP_STATE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B4 gateway: the SAME proposal under a NEW command_id is refused 409 with the existing document", async () => {
  // The mock must REMEMBER the first order across calls (a real ERPNext would):
  // a fresh in-memory mock per call would hide the very duplicate this catches.
  const dir = mkdtempSync(path.join(tmpdir(), "b4-po-state-"));
  await withEnv({ MOCK_ERP_STATE: path.join(dir, "state.json") }, async () => {
    try {
      await withGateway(async ({ runExecute, store }) => {
        const first = await runExecute({ command_id: randomUUID(), proposal: purchaseProposal(), store });
        assert.equal(first.status, 200, JSON.stringify(first.body));

        const second = await runExecute({ command_id: randomUUID(), proposal: purchaseProposal(), store });
        // 409 (not 500) and the existing document NAME — the B2 finding, applied
        // to this path from the start instead of being rediscovered.
        assert.equal(second.status, 409, JSON.stringify(second.body));
        assert.equal(second.body.code, "PO_DUPLICATE_ACTION");
        assert.equal(second.body.existing_doc, first.body.result.erpnext_doc);
        assert.equal(second.body.retry_same_command_id, undefined, "terminal: a retry cannot help");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("B4 gateway: no correlation field on the site ⇒ refuse BEFORE writing", async () => {
  await withEnv({ MOCK_ERP_PO_NO_CORRELATION_FIELD: "1" }, async () => {
    await withGateway(async ({ runExecute, store }) => {
      const verdict = await runExecute({ command_id: randomUUID(), proposal: purchaseProposal(), store });
      assert.equal(verdict.status, 500, JSON.stringify(verdict.body));
      assert.equal(verdict.body.code, "PO_CORRELATION_FIELD_MISSING");
      assert.match(verdict.body.error, /custom_ai_action_id/);
      assert.match(verdict.body.error, /migration/i);
    });
  });
});

test("B4 gateway: an order that reads back wrong is NOT reported as success", async () => {
  await withEnv({ MOCK_ERP_PO_DROP_LINE: "1" }, async () => {
    await withGateway(async ({ runExecute, store }) => {
      const commandId = randomUUID();
      const verdict = await runExecute({ command_id: commandId, proposal: purchaseProposal(), store });
      assert.equal(verdict.status, 503, JSON.stringify(verdict.body));
      assert.equal(verdict.body.retry_same_command_id, true);
      // It WAS created, so the command stays PENDING (reconcilable) instead of
      // FAILED — FAILED is what pushes a user toward a second document.
      assert.equal(store.status(commandId).status, "PENDING");
    });
  });
});

test("B4 gateway: a purchase order that may have landed keeps its intent locked", async () => {
  await withEnv({ MOCK_ERP_FAIL_AFTER_WRITE: "1" }, async () => {
    await withGateway(async ({ runExecute, store }) => {
      const first = randomUUID();
      const v1 = await runExecute({ command_id: first, proposal: purchaseProposal(), store });
      assert.equal(v1.status, 503);
      const second = await runExecute({ command_id: randomUUID(), proposal: purchaseProposal(), store });
      assert.equal(second.status, 409, JSON.stringify(second.body));
      assert.equal(second.body.code, "IDEMPOTENCY_INTENT_IN_FLIGHT");
      assert.equal(second.body.clash_command_id, first);
    });
  });
});

test("B4 gateway: a moved BUYING price is a REFUSAL (PROPOSAL_STALE), never a silent re-price", async () => {
  await withGateway(async ({ runExecute, store }) => {
    const proposal = purchaseProposal({
      lines: [{ ...DEFAULT_LINES[0], rate: 999, amount_vnd: 1998 }],
    });
    const verdict = await runExecute({ command_id: randomUUID(), proposal, store });
    assert.equal(verdict.status, 409, JSON.stringify(verdict.body));
    // The gateway REFINES the skill's PROPOSAL_STALE into the specific taxonomy
    // code (data moved vs entity changed) — same contract as the SO/QT paths.
    assert.equal(verdict.body.code, "PROPOSAL_VERSION_STALE");
    assert.match(verdict.body.problems.join(" "), /giá mua đổi 999/i);
  });
});

/* ------------------------------------------- 6. false writes + regression -- */

test("B4 false write: a declared-but-unimplemented action cannot execute, and the table has no entry for it", async () => {
  // `create_purchase_receipt` gained a REAL executor in P9-B, so the gateway's
  // false-write refusal is exercised on a STILL-fictional action now (an
  // ActionProposal is frozen — mutating it is neither possible nor the point;
  // the point is what the GATEWAY does with an action it does not know).
  await withGateway(async ({ runExecute, store }) => {
    const stub = buildProposal({
      action: "create_stock_entry",
      risk: "HIGH",
      entity: { kind: "supplier", id: "SUP-HATIEN", name: "Hà Tiên" },
      params: { lines: DEFAULT_LINES, line_count: 1, estimated_total_vnd: 590_000 },
      summary: "Tạo phiếu nhập kho (chưa hỗ trợ)",
      extra: { action_id: "act_b4_stub", warnings: [] },
    });
    const verdict = await runExecute({ command_id: randomUUID(), proposal: stub, store });
    // A fictional action has no capability mapping at all, so the FIRST gate
    // refuses it with the "only these actions are executable" 400 (the
    // code-bearing EXECUTOR_NOT_REGISTERED refusal sits one gate deeper).
    assert.equal(verdict.status, 400, JSON.stringify(verdict.body));
    assert.match(String(verdict.body.error), /only .* proposals are executable/, JSON.stringify(verdict.body));
  });
});

test("B4 false write: the write gate refuses a doctype the contract does not declare", async () => {
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();
    await assert.rejects(
      () => client.callWriteTool("erpnext_doc_create", { doctype: "Purchase Order Delete", data: {} }),
      (err) => /not declared|undeclared|refus/i.test(String(err?.message ?? err)),
    );
  } finally {
    await client.close().catch(() => {});
  }
});

test("B4 regression: payment and sales paths still build and execute through the SAME gateway", async () => {
  // The party resolution was refactored (one generic resolver, two master lists)
  // — a change to a shared code path, so the paths that share it are re-proved
  // here, not assumed.
  const soBuilt = await buildSalesOrderProposal(
    {
      findItem: async () => ({ data: { data: ITEM_ROWS } }),
      listUoms: async () => ({ data: { data: UOM_NAMES } }),
      listUomFactors: async () => ({ data: { data: UOM_FACTORS } }),
      listItemPrices: async () => ({ data: { data: SELLING_PRICES } }),
    },
    { customer: { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" }, ambiguous: false, candidates: [] },
    { nlp: nlp("đặt hàng cho Lan 2 bao cám heo tăng trọng 25kg", [{ value: 2, canonical_unit: "Bao", raw: "2 bao", start: 0, end: 5 }]) },
  );
  assert.equal(soBuilt.proposal.action, "create_sales_order");
  assert.equal(soBuilt.lines[0].rate, 305_000, "the sales path still uses the SELLING price");
  // The SO path still reports its own codes — the generic resolver did not
  // change its taxonomy.
  await assert.rejects(
    () =>
      buildSalesOrderProposal(
        {
          findItem: async () => ({ data: { data: ITEM_ROWS } }),
          listUoms: async () => ({ data: { data: UOM_NAMES } }),
          listUomFactors: async () => ({ data: { data: UOM_FACTORS } }),
          listItemPrices: async () => ({ data: { data: SELLING_PRICES } }),
        },
        { customer: { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" }, ambiguous: false, candidates: [] },
        { nlp: nlp("đặt hàng cám heo tăng trọng 25kg cho Lan", []) },
      ),
    (err) => err.code === "SO_QTY_MISSING",
  );

  // Payment still builds — the payment branch reads its own party and context.
  const payment = await buildPaymentProposal(
    {
      listUnpaidInvoices: async () => ({
        data: { data: [{ name: "SINV-0001", customer: "CUST-00001", outstanding_amount: 2_500_000, posting_date: "2026-09-01" }] },
      }),
      // P9-D: the payment builder reads the party's open DRAFT Payment Entries.
      listOpenDraftPaymentEntries: async () => ({ data: { doctype: "Payment Entry", data: [] } }),
      getPaymentEntryDoc: async () => {
        throw new Error("no draft is expected in this fixture");
      },
    },
    { customer: { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" }, ambiguous: false, candidates: [] },
    { amount_vnd: 2_500_000, requireExplicitAmount: true, submit_now: false },
  );
  assert.equal(payment.proposal.action, "create_payment_entry");

  // Every write is still registered. P9-A2 added the delivery note, P9-D the
  // sales invoice; the set is spelled out on purpose so it can never grow
  // silently (B2/B3/B4 convention).
  // P9-E (2026-09-23) added the eighth: the stock write-off. P9-F added the
  // ninth: the customer return. The list stays spelled out here so a new write
  // cannot join the path silently.
  assert.deepEqual(executableWriteActions().sort(), [
    "create_customer", // M1 (2026-09-23, user decision (a) — result64 §3.1)
    "create_delivery_note",
    "create_payment_entry",
    "create_purchase_order",
    "create_purchase_receipt",
    "create_quotation",
    "create_sales_invoice",
    "create_sales_order",
    "create_sales_return",
    "create_stock_adjustment",
  ]);
});

/* ------------------------------------------------- 7. end-to-end pipeline -- */

/** Strip ERPNEXT_* so the child always talks to the in-memory mock. */
const MOCK_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));
const COPILOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "copilot-server.mjs");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function startNlpService() {
  const { spawn } = await import("node:child_process");
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

async function startCopilot(port) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...MOCK_ENV, NLP_SERVICE_PORT: String(port) },
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
    request,
    async call(text) {
      const res = await request("tools/call", { name: "copilot_ask", arguments: { text } });
      assert.equal(res.isError, undefined, `tool error: ${res.content?.[0]?.text}`);
      return res.structuredContent ?? JSON.parse(res.content[0].text);
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

test("B4 E2E: a purchase sentence produces a HIGH draft MUA proposal for the SUPPLIER, and nothing is written", async () => {
  const nlpSvc = await startNlpService();
  const copilot = await startCopilot(nlpSvc.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("đặt mua 2 bao cám heo tăng trọng 25kg từ Hà Tiên");
    assert.equal(out.routed.group, "purchase_order_write", JSON.stringify(out.routed));
    assert.equal(out.proposal?.action, "create_purchase_order", JSON.stringify(out.proposal));
    assert.equal(out.proposal.risk, "HIGH");
    // THE B4 assertion: the party is a SUPPLIER, under the supplier key. A
    // customer key here would be the pre-B4 misroute reappearing.
    assert.equal(out.proposal.entity.kind, "supplier");
    assert.equal(out.proposal.entity.id, "SUP-HATIEN");
    assert.equal(out.supplier?.id, "SUP-HATIEN");
    assert.equal(out.customer, undefined, "a purchase answer must not answer with a customer");
    // Buying price from ERPNext (295.000), quantity from the sentence, draft-only.
    assert.equal(out.proposal.params.lines[0].rate, 295_000);
    assert.equal(out.proposal.params.lines[0].qty, 2);
    assert.equal(out.proposal.params.price_side, "buying");
    assert.equal(out.proposal.params.submit_now, false);
    // The answer says MUA + NHÁP — the sentence and the card must agree.
    assert.match(out.answer, /ĐƠN MUA/);
    assert.match(out.answer, /NHÁP/);
    // Nothing is written by asking.
    const client = createMcpClient({ serverScript: MOCK_SERVER });
    try {
      await client.initialize();
      const found = await client.callTool("erpnext_doc_list", { doctype: "Purchase Order", fields: ["name"], limit: 5 });
      assert.equal(found.data.count, 0, "an ASK must not create a document");
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await copilot.close();
    nlpSvc.child.kill();
  }
});

test("B4 E2E: a supplier name that is NOT a customer still produces a purchase proposal", async () => {
  // "Hà Tiên" exists only in the SUPPLIER master list. Before B4 this sentence
  // routed to the sales path, where the customer resolver found nothing and the
  // shop got "không tìm thấy khách hàng" for a perfectly normal purchase — the
  // softer half of the same misroute.
  const nlpSvc = await startNlpService();
  const copilot = await startCopilot(nlpSvc.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("đặt nhà cung cấp Hà Tiên 5 bao cám heo tăng trọng 25kg");
    assert.equal(out.routed.group, "purchase_order_write", JSON.stringify(out.routed));
    assert.equal(out.proposal?.action, "create_purchase_order", JSON.stringify(out));
    assert.equal(out.proposal.entity.id, "SUP-HATIEN");
    assert.equal(out.supplier?.id, "SUP-HATIEN");
    assert.equal(out.customer, undefined);
  } finally {
    await copilot.close();
    nlpSvc.child.kill();
  }
});

test("B4 E2E: a receipt command is wired (P9-B) — and a still-unimplemented stock command is refused, never answered with a stock number", async () => {
  const nlpSvc = await startNlpService();
  const copilot = await startCopilot(nlpSvc.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    // P9-B: the receipt path now RESOLVES the supplier and refuses for its OWN
    // business reason (no submitted PO) instead of KNOWN_INTENT_UNIMPLEMENTED —
    // measured here because B4 originally pinned the opposite behaviour.
    const out = await copilot.call("nhận hàng từ Hà Tiên 20 bao cám heo tăng trọng 25kg");
    assert.equal(out.error_code, "PR_PO_UNRESOLVED", JSON.stringify(out));
    assert.equal(out.proposal, null);
    assert.match(String(out.reason), /ĐÃ SUBMIT/);
  } finally {
    await copilot.close();
    nlpSvc.child.kill();
  }
});

/* ------------------------------------------------------------------ R6 -- */

test("B4 builder (R6): the SUPPLIER's own name is not a line — a bare word inside it must not match", async () => {
  // MEASURED on the real site 2026-09-24. `matchItemsByText` matches word
  // PREFIXES of a stored item name and goes all the way down to ONE word, so a
  // supplier called "Đại lý Cám Bình Dương" made every `Cám …` item match on
  // `cám` FROM INSIDE the supplier's name. The READ path survived (best prefix
  // length only); the ORDER path keeps every non-overlapping match, so a phantom
  // second line appeared with no quantity and the builder refused while naming an
  // item the user never said:
  //   reason: "chưa rõ số lượng cho mặt hàng \"Cám heo tăng trọng 25kg\""
  const supplier = { name: "SUP-BD", supplier_name: "Đại lý Cám Bình Dương" };
  const items = [
    { name: "PHI-VAN-CHUYEN", item_code: "PHI-VAN-CHUYEN", item_name: "Phí vận chuyển & bốc xếp", stock_uom: "Nos" },
    ...ITEM_ROWS,
  ];
  const buying = [
    { name: "IPB3", item_code: "PHI-VAN-CHUYEN", uom: "Nos", price_list: "Standard Buying", price_list_rate: 150_000, buying: 1 },
    ...BUYING_PRICES,
  ];
  const text = "đặt mua 3 Nos Phí vận chuyển & bốc xếp từ Đại lý Cám Bình Dương";
  const built = await buildPurchaseOrderProposal(
    // A service line needs no warehouse and no stock_uom conversion; the UOM list
    // carries `Nos` because that is the site's own name for it (measured).
    fakeSkills({ items, buying, isStockItem: false, warehouse: null, uoms: [...UOM_NAMES, "Nos"] }),
    { supplier, ambiguous: false, candidates: [] },
    { nlp: nlp(text, [{ value: 3, unit: "Nos", canonical_unit: "nos", raw: "3 Nos", start: 8, end: 13 }]) },
  );
  assert.equal(built.lines.length, 1, `expected ONE line, got ${JSON.stringify(built.lines.map((l) => l.item_code))}`);
  assert.equal(built.lines[0].item_code, "PHI-VAN-CHUYEN");
  assert.equal(built.lines[0].qty, 3);
  assert.equal(built.lines[0].uom, "Nos", "the site's own UOM name, and no conversion");
});

test("B4 builder (R6): masking the party name does NOT stop an item the user really names outside it", async () => {
  // The rule is containment, not "drop any short match": an item genuinely named
  // `Cám …` still becomes a line when the words are the user's OWN, outside the
  // supplier phrase. Without this, the R6 fix could silently drop real lines.
  const supplier = { name: "SUP-BD", supplier_name: "Đại lý Cám Bình Dương" };
  const built = await buildPurchaseOrderProposal(
    fakeSkills(),
    { supplier, ambiguous: false, candidates: [] },
    {
      nlp: nlp("đặt mua 2 bao cám heo tăng trọng 25kg từ Đại lý Cám Bình Dương", [
        { value: 2, unit: "Bao", canonical_unit: "Bao", raw: "2 bao", start: 8, end: 13 },
      ]),
    },
  );
  assert.equal(built.lines.length, 1);
  assert.equal(built.lines[0].item_code, "CAM-HEO-25KG", "the item the user named outside the party phrase survives");
  assert.equal(built.lines[0].qty, 2);
});
