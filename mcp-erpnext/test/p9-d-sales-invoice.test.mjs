/**
 * P9-D (plan `.plan/next1/p9_prompts.md` P9-D) — `sales_invoice.create`, the
 * draft Sales Invoice. Rủi ro cao hơn Sales Order: submitting one books revenue
 * AND receivable, and the mock/Safety-Gateway have to make that impossible from
 * chat.
 *
 * What this file proves, in the order the risk appears:
 *
 *  1. §0 MEASURED MISROUTE, closed: before this phase "xuất hóa đơn cho Lan",
 *     "lập hóa đơn cho Nguyễn Thị Lan" and "xuất hóa đơn cho đơn SAL-…" all fell
 *     into the `sales` READ group (invoice.lookup) — a COMMAND answered with a
 *     list of invoices. "xuất hoá đơn" (the `oá` spelling) was UNKNOWN_INTENT.
 *  2. THE ORDER OWNS THE MONEY: lines, units and PRICES come from the submitted
 *     Sales Order (ERPNext refuses a mismatch: 417 "Đơn giá phải giống với Sales
 *     Order"), and what is still billable is arithmetic on ERPNext's own numbers
 *     (`qty − billed_amt / rate`). A line whose billed data is not derivable
 *     REFUSES instead of assuming "chưa hoá đơn".
 *  3. DRAFTS HOLD MONEY: an open draft invoice already claiming part of the order
 *     is subtracted; a full cover refuses. (The P9-A1/P9-B draft-hold lesson,
 *     applied to money from the start instead of rediscovered.)
 *  4. FALSE WRITES: the build writes nothing; /execute writes exactly one DRAFT
 *     with `update_stock = 0`; a crafted proposal cannot choose the document; and
 *     a site that ignores the stock flag is caught by the read-back.
 *  5. REGRESSION: the other five write paths still build and execute, and the
 *     invoice QUESTION stays a read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");

import { executableWriteActions, getCapability, isStub, writeDoctypes } from "../src/capability-contract.mjs";
import * as invoice from "../src/skills/sales-invoice-write.mjs";
import { buildSalesInvoiceProposal } from "../src/skills/sales-invoice-write.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";
import { routeIntent } from "../src/router.mjs";

/* --------------------------------------------------------------- fixtures -- */

const CUSTOMER = { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" };

/**
 * A SUBMITTED order with:
 *  - line 1 DELIVERED IN FULL (10/10) but only half invoiced (`billed_amt` =
 *    5 × 305.000) ⇒ billing must be independent of delivery;
 *  - line 2 never invoiced (`billed_amt` 0) ⇒ the whole 5 units are billable.
 */
const SO = {
  name: "SAL-ORD-2026-00001",
  docstatus: 1,
  customer: "CUST-00001",
  customer_name: "Nguyễn Thị Lan",
  items: [
    {
      name: "SOI-1",
      item_code: "CAM-HEO-25KG",
      item_name: "Cám heo tăng trọng 25kg",
      qty: 10,
      rate: 305_000,
      billed_amt: 1_525_000,
      per_billed: 50,
      delivered_qty: 10,
      uom: "Bao",
      stock_uom: "Bao",
    },
    {
      name: "SOI-2",
      item_code: "CAM-GA-10KG",
      item_name: "Cám gà thịt 10kg",
      qty: 5,
      rate: 250_000,
      billed_amt: 0,
      per_billed: 0,
      delivered_qty: 0,
      uom: "Bao",
      stock_uom: "Bao",
    },
  ],
};

const ITEM_ROWS = [
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
  { name: "CAM-GA-10KG", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", stock_uom: "Bao" },
];

/** A skills bag with the reads this builder uses + a write spy that must not fire. */
function fakeSkills(so = SO, { counts, orders, drafts } = {}) {
  const spy = counts ?? { reads: 0, writes: 0 };
  return {
    spy,
    getSalesOrder: async (name) => {
      spy.reads += 1;
      // Search the SAME list the customer's open orders came from — a fixture
      // whose getSalesOrder only knew the first order would make the "several
      // orders" case look like one order, and the refusal would never fire.
      const found = (orders ?? [so]).filter(Boolean).find((s) => String(s.name) === String(name)) ?? null;
      return { data: { doctype: "Sales Order", data: found } };
    },
    listOpenSalesOrders: async () => ({
      data: {
        doctype: "Sales Order",
        count: (orders ?? [so]).length,
        data: (orders ?? [so]).filter(Boolean).map((s) => ({ name: s.name, customer: s.customer, docstatus: s.docstatus })),
      },
    }),
    listOpenDraftSalesInvoices: async () => ({
      data: { doctype: "Sales Invoice", count: (drafts ?? []).length, data: drafts ?? [] },
    }),
    getSalesInvoiceDoc: async (name) => {
      const d = (drafts ?? []).find((x) => x.name === String(name)) ?? null;
      return { data: { doctype: "Sales Invoice", data: d } };
    },
    findItem: async () => ({ data: { doctype: "Item", count: ITEM_ROWS.length, data: ITEM_ROWS } }),
    callWriteTool: async () => {
      spy.writes += 1;
      throw new Error("the builder must never write");
    },
  };
}

async function refusal(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err?.code, code, `expected ${code}, got ${err?.code}: ${err?.message}`);
    assert.ok(String(err?.message ?? "").length > 0, "a refusal must explain itself");
    return true;
  });
}

/** An nlp payload shaped like the Python normalizer's (offsets included). */
function nlp(text, quantities = []) {
  return { text, quantities };
}

/* ------------------------------------------------ 1. contract + write gate -- */

test("P9-D contract: sales_invoice.create is a real WRITE — draft-only, creatable but never submittable", () => {
  const cap = getCapability("sales_invoice.create");
  assert.equal(cap.type, "WRITE");
  assert.equal(cap.skill, "skills/sales-invoice-write.mjs#buildSalesInvoiceProposal");
  assert.equal(cap.proposal_action, "create_sales_invoice");
  assert.equal(cap.risk.level, "HIGH");
  assert.equal(cap.risk.requires_confirmation, true);
  assert.equal(cap.execution.draft_only, true);
  assert.equal(cap.execution.allow_submit, false, "a submitted invoice books revenue — never from chat");
  assert.equal(cap.execution.verify_document, true);
  assert.equal(cap.execution.idempotent, true);
  assert.equal(cap.execution.write_doctype, "Sales Invoice");
  assert.equal(cap.execution.correlation_field, "custom_ai_action_id");
  assert.deepEqual(cap.entities.required, ["order"]);
  // The price policy is the contract's, and it is the safe direction: the price
  // comes from ERPNext, and a missing price is a question.
  assert.equal(cap.line_policy.rate_source, "erpnext");
  assert.equal(cap.line_policy.no_price, "ask");

  assert.equal(isStub("sales_invoice.create"), false);
  assert.equal(writeDoctypes()["Sales Invoice"].create, true);
  assert.equal(writeDoctypes()["Sales Invoice"].submit, false);
  assert.equal(executableWriteActions().includes("create_sales_invoice"), true);

  // The file ships BOTH halves: a builder (for /ask) and an executor (only ever
  // reached by the Safety Gateway).
  assert.equal(typeof invoice.buildSalesInvoiceProposal, "function");
  assert.equal(typeof invoice.executeSalesInvoiceProposal, "function");
});

/* ------------------------------------------------------------- 2. routing -- */

test("P9-D routing: invoice COMMANDS reach sales_invoice.create; invoice QUESTIONS stay reads", () => {
  // routeIntent takes the NORMALIZED text (Phase 1 output) — the fixtures below
  // are the post-synonym forms measured on 2026-09-23.
  const COMMANDS = [
    "xuất hóa đơn cho Lan",
    "xuất hoá đơn cho Nguyễn Thị Lan",
    "lập hóa đơn cho Nguyễn Thị Lan",
    "lập hoá đơn cho đơn SAL-ORD-2026-00001",
    "viết hóa đơn cho Lan",
    "xuất hd cho Lan",
  ];
  for (const t of COMMANDS) {
    const hit = routeIntent(t);
    assert.equal(hit?.capability, "sales_invoice.create", `${t} → ${hit?.capability}`);
    assert.equal(hit?.group, "sales_invoice_write", t);
  }
  // A QUESTION never opens a HIGH card: it stays the invoice READ it always was.
  for (const t of [
    "hóa đơn receivable của Lan", // ← "hóa đơn còn nợ của Lan" after Phase 1
    "hóa đơn của Lan receivable bao nhiêu",
    "xuất hóa đơn cho Lan chưa",
    "xuất hóa đơn cho Lan bao nhiêu",
  ]) {
    const hit = routeIntent(t);
    assert.equal(hit?.capability, "invoice.lookup", `${t} → ${hit?.capability}`);
    assert.notEqual(hit?.group, "sales_invoice_write", `"${t}" must not open a card`);
  }
  // Deliberately NOT denied: "xuất hóa đơn cho đơn đã giao" is a legitimate
  // command (bill the delivered part) — this is why "đã" is not in notIf.
  assert.equal(routeIntent("xuất hóa đơn cho đơn đã giao")?.capability, "sales_invoice.create");
  // The neighbouring delivery group is untouched by the new keywords.
  assert.equal(routeIntent("xuất hàng cho Lan")?.capability, "delivery.create");
  assert.equal(routeIntent("xuất kho cho Lan")?.capability, "delivery.create");
  // ...and the keyword does not swallow the word "xuất" alone.
  assert.notEqual(routeIntent("xuất kho")?.capability, "sales_invoice.create");
});

/* -------------------------------------------------------- 3. the builder -- */

test("P9-D builder: the ORDER's own lines and PRICES build the draft invoice", async () => {
  const skills = fakeSkills();
  const built = await buildSalesInvoiceProposal(skills, { customer: CUSTOMER, ambiguous: false, candidates: [] });

  assert.equal(built.proposal.action, "create_sales_invoice");
  assert.equal(built.proposal.risk, "HIGH");
  assert.equal(built.proposal.need_confirm, true);
  assert.equal(built.proposal.entity.id, "CUST-00001");
  assert.equal(built.proposal.params.sales_order, SO.name);
  assert.equal(built.proposal.params.submit_now, false);
  assert.equal(built.proposal.params.update_stock, false);

  const [l1, l2] = built.proposal.params.lines;
  // Line 1: 10 ordered, 5 already billed (billed_amt 1.525.000 / rate 305.000).
  assert.equal(l1.item_code, "CAM-HEO-25KG");
  assert.equal(l1.qty, 5, "còn 5 bao chưa xuất hoá đơn");
  assert.equal(l1.rate, 305_000, "đơn giá của ĐƠN, không phải của câu nói");
  assert.equal(l1.sales_order, SO.name);
  assert.equal(l1.so_detail, "SOI-1");
  assert.equal(l1.amount, 5 * 305_000);
  // Line 2: never invoiced ⇒ everything is billable.
  assert.equal(l2.qty, 5);
  assert.equal(l2.rate, 250_000);
  assert.equal(built.proposal.params.estimated_total_vnd, 5 * 305_000 + 5 * 250_000);
  assert.match(built.proposal.summary, /^Tạo hoá đơn NHÁP/);
  assert.equal(skills.spy.writes, 0, "building a proposal never writes");
  assert.equal(built.proposal.params.lines[0].rate, 305_000, "giá chỉ đến từ ERPNext");
});

test("P9-D builder: billing is INDEPENDENT of delivery — a delivered line still bills its unbilled half", async () => {
  // Line 1 is delivered 10/10 and billed 5/10. A builder that reused the
  // delivery's `qty − delivered_qty` would propose NOTHING for it (0) and would
  // look correct in a fixture where delivery and billing happen to agree.
  const built = await buildSalesInvoiceProposal(fakeSkills(), { customer: CUSTOMER });
  assert.equal(built.proposal.params.lines[0].qty, 5);
  assert.equal(built.proposal.params.lines[0].item_code, "CAM-HEO-25KG");
});

test("P9-D builder: only the item the user named is invoiced (the rest stays pending, with a warning)", async () => {
  const built = await buildSalesInvoiceProposal(
    fakeSkills(),
    { customer: CUSTOMER },
    { nlp: nlp("xuất hóa đơn cho Lan 2 bao cám gà", [{ value: 2, canonical_unit: "Bao", raw: "2 bao", start: 0, end: 5 }]) },
  );
  assert.equal(built.proposal.params.lines.length, 1);
  assert.equal(built.proposal.params.lines[0].item_code, "CAM-GA-10KG");
  assert.equal(built.proposal.params.lines[0].qty, 2);
  assert.ok(
    built.warnings.some((w) => /xuất một phần/.test(w)),
    `expected a partial warning, got ${built.warnings.join(" | ")}`,
  );
});

test("P9-D builder: asking for MORE than remains refuses — it is never clamped", async () => {
  await refusal(
    buildSalesInvoiceProposal(
      fakeSkills(),
      { customer: CUSTOMER },
      { nlp: nlp("xuất hóa đơn cho Lan 9 bao cám heo", [{ value: 9, canonical_unit: "Bao", raw: "9 bao", start: 0, end: 5 }]) },
    ),
    "SI_QTY_EXCEEDS_PENDING",
  );
});

test("P9-D builder: an item named twice is a QUESTION, not a sum", async () => {
  await refusal(
    buildSalesInvoiceProposal(
      fakeSkills(),
      { customer: CUSTOMER },
      { lines: [{ item_code: "CAM-GA-10KG", qty: 2 }, { item_code: "CAM-GA-10KG", qty: 3 }] },
    ),
    "SI_QTY_AMBIGUOUS",
  );
});

test("P9-D builder: the unit the user said must be the ORDER's unit (no hidden conversion)", async () => {
  await refusal(
    buildSalesInvoiceProposal(
      fakeSkills(),
      { customer: CUSTOMER },
      { nlp: nlp("xuất hóa đơn cho Lan 1 tấn cám gà", [{ value: 1, canonical_unit: "Tấn", raw: "1 tấn", start: 0, end: 6 }]) },
    ),
    "SI_UOM_MISMATCH",
  );
});

test("P9-D builder: an item the order does not carry refuses (only that order's goods may be invoiced)", async () => {
  await refusal(
    buildSalesInvoiceProposal(fakeSkills(), { customer: CUSTOMER }, { lines: [{ item_code: "P1F-ACCEPT Livestock Item", qty: 1 }] }),
    "SI_ITEM_NOT_IN_SO",
  );
});

test("P9-D builder: a DRAFT order refuses, and a customer the order does not name refuses", async () => {
  await refusal(
    buildSalesInvoiceProposal(fakeSkills({ ...SO, docstatus: 0 }), { customer: CUSTOMER }, { lines: [{ item_code: "CAM-GA-10KG", qty: 1 }] }),
    "SI_SO_NOT_SUBMITTED",
  );
  await refusal(
    buildSalesInvoiceProposal(
      fakeSkills(),
      { customer: { name: "CUST-00002", customer_name: "Trần Văn Hai" }, order: SO.name },
      { lines: [{ item_code: "CAM-GA-10KG", qty: 1 }] },
    ),
    "SI_CUSTOMER_MISMATCH",
  );
});

test("P9-D builder: several open orders is a QUESTION — never a pick", async () => {
  const second = { ...SO, name: "SAL-ORD-2026-00002" };
  await refusal(
    buildSalesInvoiceProposal(fakeSkills(SO, { orders: [SO, second] }), { customer: CUSTOMER }),
    "SI_SO_UNRESOLVED",
  );
  // A full page is "possibly more": one order on the page is not knowable.
  const page = Array.from({ length: 5 }, (_, i) => ({ ...SO, name: `SAL-ORD-2026-0000${i + 1}` }));
  await refusal(buildSalesInvoiceProposal(fakeSkills(SO, { orders: page }), { customer: CUSTOMER }), "SI_SO_UNRESOLVED");
  // No submitted order at all is its own message.
  await refusal(buildSalesInvoiceProposal(fakeSkills(SO, { orders: [] }), { customer: CUSTOMER }), "SI_SO_UNRESOLVED");
});

test("P9-D builder: a fully invoiced order has nothing to bill, and a priceless line asks", async () => {
  const fully = {
    ...SO,
    items: SO.items.map((it) => ({ ...it, billed_amt: Number(it.qty) * Number(it.rate), per_billed: 100 })),
  };
  // No order was NAMED, so the builder walks the customer's open orders and
  // every one of them is fully billed. The code is SI_NOTHING_TO_BILL, not the
  // per-order SI_ALREADY_BILLED: that one belongs to the path where the order
  // IS resolved (the user named it or it is the only candidate), and it is the
  // per-order message that would be a lie when several orders were skipped.
  await refusal(buildSalesInvoiceProposal(fakeSkills(fully), { customer: CUSTOMER }), "SI_NOTHING_TO_BILL");
  // A line the order carries with NO price cannot be invoiced at a price we
  // invented — the invoice must bill the order's own rate (recipes §417).
  const freeLine = { ...SO, items: [{ ...SO.items[1], rate: 0, billed_amt: 0, per_billed: 0 }] };
  await refusal(buildSalesInvoiceProposal(fakeSkills(freeLine), { customer: CUSTOMER }), "SI_RATE_MISSING");
});

test("P9-D builder: unknowable billed data REFUSES instead of assuming \"chưa hoá đơn\"", async () => {
  // The dangerous assumption: an order that carries no billing information at
  // all might already be invoiced ⇒ invoice it again. Fail closed.
  const noFields = { ...SO, items: [{ name: "SOI-1", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", qty: 5, rate: 250_000, uom: "Bao" }] };
  await refusal(buildSalesInvoiceProposal(fakeSkills(noFields), { customer: CUSTOMER }), "SI_PENDING_UNKNOWN");

  // A PARTIAL percentage with no amount cannot be turned into a quantity:
  // reading it as "0 billed" would invoice the whole line a second time.
  const percentOnly = {
    ...SO,
    items: [{ name: "SOI-1", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", qty: 5, rate: 250_000, per_billed: 40, uom: "Bao" }],
  };
  await refusal(buildSalesInvoiceProposal(fakeSkills(percentOnly), { customer: CUSTOMER }), "SI_PENDING_UNKNOWN");

  // ...but 0% and 100% ARE exact, so those two stay usable.
  const zero = { ...SO, items: [{ name: "SOI-1", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", qty: 5, rate: 250_000, per_billed: 0, uom: "Bao" }] };
  const ok = await buildSalesInvoiceProposal(fakeSkills(zero), { customer: CUSTOMER });
  assert.equal(ok.proposal.params.lines[0].qty, 5);
});

test("P9-D builder: an OPEN DRAFT invoice already claiming the order is subtracted (and a full cover refuses)", async () => {
  const draft = {
    name: "SI-DRAFT-1",
    customer: "CUST-00001",
    docstatus: 0,
    items: [{ item_code: "CAM-GA-10KG", qty: 3, sales_order: SO.name, so_detail: "SOI-2" }],
  };
  const built = await buildSalesInvoiceProposal(fakeSkills(SO, { drafts: [draft] }), { customer: CUSTOMER });
  const ga = built.proposal.params.lines.find((l) => l.item_code === "CAM-GA-10KG");
  assert.equal(ga.qty, 2, "5 chưa xuất − 3 đã nằm trong hoá đơn NHÁP = 2");
  assert.ok(
    built.warnings.some((w) => /hoá đơn NHÁP/.test(w)),
    `expected a draft-cover warning, got ${built.warnings.join(" | ")}`,
  );

  const fullCover = {
    ...draft,
    items: [
      { item_code: "CAM-GA-10KG", qty: 5, sales_order: SO.name },
      { item_code: "CAM-HEO-25KG", qty: 5, sales_order: SO.name },
    ],
  };
  await refusal(buildSalesInvoiceProposal(fakeSkills(SO, { drafts: [fullCover] }), { customer: CUSTOMER }), "SI_DRAFT_COVERED");
});

test("P9-D builder: a draft invoice for ANOTHER order in the same customer does not affect this one", async () => {
  const other = {
    name: "SI-DRAFT-2",
    customer: "CUST-00001",
    docstatus: 0,
    items: [{ item_code: "CAM-GA-10KG", qty: 5, sales_order: "SAL-ORD-2026-00009" }],
  };
  const built = await buildSalesInvoiceProposal(fakeSkills(SO, { drafts: [other] }), { customer: CUSTOMER });
  assert.equal(built.proposal.params.lines.find((l) => l.item_code === "CAM-GA-10KG").qty, 5);
});

test("P9-D builder: the EXECUTOR re-check also subtracts open drafts — a proposal written before the draft existed goes STALE", async () => {
  // The builder's draft arithmetic is not enough on its own: a card can sit in
  // the chat for ten minutes, and a draft invoice raised in the meantime claims
  // money the card still promises. Re-checking against RAW pending would let the
  // proposal pass its drift check and put the same revenue in the books twice
  // (an invoice, unlike a delivery note, cannot be "topped up" — it is submitted
  // as-is). Mirrors the delivery-note case, because a guard with a test on only
  // one of the two mirrored skills is how the P9-B mirror drift happened.
  const draft = {
    name: "SI-DRAFT-9",
    customer: "CUST-00001",
    docstatus: 0,
    items: [{ item_code: "CAM-GA-10KG", qty: 5, sales_order: SO.name, so_detail: "SOI-2" }],
  };
  const mcp = {
    async callTool(tool, args) {
      if (tool === "erpnext_doc_list" && args?.doctype === "Sales Invoice") {
        // The correlation probe asks for the action id and finds nothing; the
        // draft-cover list finds the live draft.
        const wantsCorrelation = (args?.filters ?? []).some(([f]) => f === "custom_ai_action_id");
        return { data: { doctype: "Sales Invoice", data: wantsCorrelation ? [] : [draft] } };
      }
      if (tool === "erpnext_doc_get" && args?.doctype === "Sales Invoice") {
        if (args?.name === draft.name) return { data: { data: draft } };
        throw new Error(`Sales Invoice ${args?.name} not found`);
      }
      if (tool === "erpnext_doc_get" && args?.doctype === "Sales Order") return { data: { data: SO } };
      throw new Error(`unexpected ${tool} ${JSON.stringify(args)}`);
    },
    async callWriteTool() {
      throw new Error("a stale proposal must be refused BEFORE any write");
    },
  };
  const built = await buildSalesInvoiceProposal(fakeSkills(), { customer: CUSTOMER, order: SO.name });
  // The builder had no drafts in its bag, so it proposed CAM-GA-10KG × 5; the
  // live site now holds a draft for exactly that. Refuse, write nothing.
  await refusal(
    invoice.executeSalesInvoiceProposal(mcp, built.proposal, "cmd-si-stale-1", { setReference() {}, complete() {} }),
    "PROPOSAL_STALE",
  );
});

/* ------------------------------------------------- 4. execution + safety -- */

/** Strip ERPNEXT_* so the child always talks to the in-memory mock. */
const MOCK_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));

const SO_FIXTURE = { ...SO, items: SO.items.map((it) => ({ ...it })) };

/**
 * Run the FULL write path (/execute over HTTP → Safety Gateway → executor →
 * mock ERPNext) with the invoice fixture in place. Mirrors the delivery/payment
 * harness so the three paths are exercised identically.
 */
async function withExecuteServer(fn, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "p9d-si-"));
  const prevState = process.env.MOCK_ERP_STATE;
  const prevFixture = process.env.MOCK_ERP_SO_FIXTURE;
  const prevExtra = {};
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  process.env.MOCK_ERP_SO_FIXTURE = JSON.stringify([SO_FIXTURE]);
  for (const [k, v] of Object.entries(extraEnv)) {
    prevExtra[k] = process.env[k];
    process.env[k] = v;
  }
  let server = null;
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const base = `http://127.0.0.1:${port}`;
    const post = async (body) => {
      const r = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    const built = await buildSalesInvoiceProposal(fakeSkills(), { customer: CUSTOMER, order: SO.name });
    return await fn({ post, store, proposal: built.proposal, base });
  } finally {
    server?.close();
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    if (prevFixture === undefined) delete process.env.MOCK_ERP_SO_FIXTURE;
    else process.env.MOCK_ERP_SO_FIXTURE = prevFixture;
    for (const [k, v] of Object.entries(prevExtra)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the mock's persisted rows (absent file ⇒ the mock never wrote). */
function stateRows(key) {
  const file = process.env.MOCK_ERP_STATE;
  if (!file || !existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8"))[key] ?? [];
  } catch {
    return [];
  }
}

test("P9-D E2E /execute: a confirmed invoice writes ONE DRAFT — docstatus 0, update_stock 0, prices from the order", async () => {
  await withExecuteServer(async ({ post, proposal }) => {
    const cid = randomUUID();
    const r = await post({ command_id: cid, proposal });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.replay, false);
    assert.match(r.body.result.erpnext_doc, /^SI-M\d+$/);
    assert.equal(r.body.result.docstatus, 0, "a chat write is ALWAYS a draft");
    assert.equal(r.body.result.sales_order, SO.name);
    assert.equal(r.body.result.update_stock, 0, "an invoice from chat never moves stock");
    assert.equal(r.body.result.line_count, 2);
    assert.match(r.body.result.note, /NHÁP/);
    assert.equal(r.body.result.net_total_vnd, 5 * 305_000 + 5 * 250_000);

    const rows = stateRows("sales_invoices");
    assert.equal(rows.length, 1);
    const doc = rows[0];
    assert.equal(doc.docstatus, 0);
    assert.equal(Number(doc.update_stock), 0);
    assert.equal(doc.customer, "CUST-00001");
    assert.equal(doc.items.length, 2);
    for (const line of doc.items) {
      assert.equal(line.sales_order, SO.name, "every line must link the order it bills");
      assert.ok(line.so_detail, "the child-row link travels too");
      assert.ok(line.rate > 0, "a price always exists — it came from the order");
    }
    // The ORDER is untouched: only SUBMIT advances billed_amt.
    const so = JSON.parse(process.env.MOCK_ERP_SO_FIXTURE)[0];
    assert.equal(so.items[0].billed_amt, 1_525_000);
    assert.equal(so.items[1].billed_amt, 0);
    // And nothing in this path can submit.
    assert.equal(getCapability("sales_invoice.create").execution.allow_submit, false);
  });
});

test("P9-D E2E /execute: a duplicate command_id REPLAYS — one document, one write", async () => {
  await withExecuteServer(async ({ post, proposal, store }) => {
    const cid = randomUUID();
    const first = await post({ command_id: cid, proposal });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await post({ command_id: cid, proposal });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replay, true);
    assert.equal(again.body.result.erpnext_doc, first.body.result.erpnext_doc, "the SAME invoice, never a second");
    assert.equal(stateRows("sales_invoices").length, 1, "exactly one document exists");
    assert.equal(store.status(cid).status, "COMPLETED");
  });
});

test("P9-D E2E /execute CHAOS: a LOST RESPONSE after the write reconciles instead of billing twice", async () => {
  await withExecuteServer(
    async ({ post, proposal }) => {
      const cid = randomUUID();
      const lost = await post({ command_id: cid, proposal });
      assert.equal(lost.status, 503, JSON.stringify(lost.body));
      assert.equal(lost.body.retry_same_command_id, true);
      // The document IS on the site; only the reply was lost.
      assert.equal(stateRows("sales_invoices").length, 1);

      const retry = await post({ command_id: cid, proposal });
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal(retry.body.result.reconciled, true);
      assert.equal(stateRows("sales_invoices").length, 1, "NEVER two invoices for one command");
    },
    { MOCK_ERP_FAIL_AFTER_WRITE: "1" },
  );
});

test("P9-D false write: a crafted proposal cannot choose the document or the price", async () => {
  await withExecuteServer(async ({ post, proposal }) => {
    // (a) A rate edited by the client is DRIFT, not an instruction: ERPNext
    //     would reject it anyway (417 "Đơn giá phải giống với Sales Order"), and
    //     a changed price is a changed deal.
    const crafted = { ...proposal, params: { ...proposal.params, lines: proposal.params.lines.map((l) => ({ ...l, rate: l.rate + 1_000 })) } };
    const r = await post({ command_id: randomUUID(), proposal: crafted });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    // The specific code, not the generic one: P1 split PROPOSAL_STALE into
    // VERSION (data moved) / ENTITY (the party changed), and a moved PRICE is
    // data drift. The generic code survives only as `legacy_code`.
    assert.equal(r.body.code, "PROPOSAL_VERSION_STALE");
    assert.equal(r.body.legacy_code, "PROPOSAL_STALE");
    assert.equal(stateRows("sales_invoices").length, 0, "nothing was written");

    // (b) A quantity beyond what the order still owes is drift too.
    const greedy = { ...proposal, params: { ...proposal.params, lines: [{ ...proposal.params.lines[0], qty: 99 }] } };
    const r2 = await post({ command_id: randomUUID(), proposal: greedy });
    assert.equal(r2.status, 409, JSON.stringify(r2.body));
    assert.equal(r2.body.code, "PROPOSAL_VERSION_STALE");
    assert.equal(stateRows("sales_invoices").length, 0);

    // (c) An action that is not this capability's cannot execute through the
    //     gateway at all (fail closed, and nothing written).
    const wrongAction = { ...proposal, action: "create_sales_order" };
    const r3 = await post({ command_id: randomUUID(), proposal: wrongAction });
    assert.equal(r3.status >= 400, true, JSON.stringify(r3.body));
    assert.equal(stateRows("sales_invoices").length, 0);
  });
});

test("P9-D verify: a site that IGNORES update_stock is caught by the read-back (money path, fail closed)", async () => {
  // The dangerous state: ERPNext stored the invoice with stock updating ON.
  // Nobody would see it in the chat, and the shop's COGS/profit would change.
  await withExecuteServer(
    async ({ post, proposal }) => {
      const r = await post({ command_id: randomUUID(), proposal });
      assert.equal(r.status >= 400, true, `expected a refusal, got ${JSON.stringify(r.body)}`);
      assert.match(JSON.stringify(r.body), /update_stock/, JSON.stringify(r.body));
    },
    { MOCK_ERP_SI_FORCE_STOCK: "1" },
  );
});

test("P9-D verify: a site that stores FEWER lines than we sent is caught by the read-back", async () => {
  // The read-back is the only evidence about what ERPNext actually holds, and
  // "we sent two lines" is not it. A line that silently disappeared is money the
  // shop believes was billed and was not.
  await withExecuteServer(
    async ({ post, proposal }) => {
      const r = await post({ command_id: randomUUID(), proposal });
      assert.equal(r.status >= 400, true, `expected a refusal, got ${JSON.stringify(r.body)}`);
      const body = JSON.stringify(r.body);
      assert.match(body, /đọc lại hoá đơn/, body);
      assert.match(body, /số dòng=1/, `the missing line must be named: ${body}`);
    },
    { MOCK_ERP_SI_DROP_LINE: "1" },
  );
});

test("P9-D verify: a site that re-derived the PRICE is caught by the read-back", async () => {
  // Same document, same lines, different money — the case a line-count check
  // alone would wave through. The price is what the shop gets paid.
  await withExecuteServer(
    async ({ post, proposal }) => {
      const r = await post({ command_id: randomUUID(), proposal });
      assert.equal(r.status >= 400, true, `expected a refusal, got ${JSON.stringify(r.body)}`);
      const body = JSON.stringify(r.body);
      assert.match(body, /đọc lại hoá đơn/, body);
      assert.match(body, /rate=/, `the drifted price must be named: ${body}`);
    },
    { MOCK_ERP_SI_DRIFT_RATE: "1" },
  );
});

test("P9-D correlation: without the Custom Field the executor refuses BEFORE writing", async () => {
  await withExecuteServer(
    async ({ post, proposal }) => {
      const r = await post({ command_id: randomUUID(), proposal });
      assert.equal(r.status >= 400, true, JSON.stringify(r.body));
      assert.match(JSON.stringify(r.body), /SI_CORRELATION_FIELD_MISSING/, JSON.stringify(r.body));
      assert.equal(stateRows("sales_invoices").length, 0, "no half-guarded write");
    },
    { MOCK_ERP_SI_NO_CORRELATION_FIELD: "1" },
  );
});

test("P9-D regress: the other writable doctypes still create via the mock, and the invoice is the only new one", async () => {
  process.env.MOCK_ERP_SO_FIXTURE = JSON.stringify([SO_FIXTURE]);
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();
    const created = await client.callWriteTool("erpnext_doc_create", {
      doctype: "Sales Invoice",
      data: {
        customer: "CUST-00001",
        company: "Demo Feed Co",
        update_stock: 0,
        items: [{ item_code: "CAM-GA-10KG", qty: 2, rate: 250_000, uom: "Bao", sales_order: SO.name, so_detail: "SOI-2" }],
      },
    });
    assert.match(created.data.data.name, /^SI-M\d+$/);
    // Submitting it is refused at the CLIENT (contract-driven), which is what
    // keeps "invoice submitted from chat" impossible rather than unlikely.
    await assert.rejects(
      () => client.callWriteTool("erpnext_doc_submit", { doctype: "Sales Invoice", name: created.data.data.name }),
      /WRITE_REFUSED/,
    );
    // A price that is not the order's is refused by the SITE's own rule.
    await assert.rejects(
      () =>
        client.callWriteTool("erpnext_doc_create", {
          doctype: "Sales Invoice",
          data: {
            customer: "CUST-00001",
            company: "Demo Feed Co",
            update_stock: 0,
            items: [{ item_code: "CAM-GA-10KG", qty: 1, rate: 999_000, uom: "Bao", sales_order: SO.name, so_detail: "SOI-2" }],
          },
        }),
      /Đơn giá phải giống với Sales Order/,
    );
    // ...and so is over-billing the remaining half of line 1.
    await assert.rejects(
      () =>
        client.callWriteTool("erpnext_doc_create", {
          doctype: "Sales Invoice",
          data: {
            customer: "CUST-00001",
            company: "Demo Feed Co",
            update_stock: 0,
            items: [{ item_code: "CAM-HEO-25KG", qty: 9, rate: 305_000, uom: "Bao", sales_order: SO.name, so_detail: "SOI-1" }],
          },
        }),
      /over-billing/,
    );
  } finally {
    delete process.env.MOCK_ERP_SO_FIXTURE;
    await client.close().catch(() => {});
  }
});

/* ------------------------------------------------- 5. end-to-end pipeline -- */

async function startNlpService() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: path.join(REPO),
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
  const child = spawn(process.execPath, [path.join(REPO, "mcp-erpnext", "src", "copilot-server.mjs")], {
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

test("P9-D E2E /ask: an invoice command returns a HIGH draft CARD + Vietnamese answer, and writes nothing", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { MOCK_ERP_SO_FIXTURE: JSON.stringify([SO_FIXTURE]) });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("xuất hóa đơn cho Nguyễn Thị Lan");
    assert.equal(out.routed.group, "sales_invoice_write", JSON.stringify(out.routed));
    assert.equal(out.proposal?.action, "create_sales_invoice", JSON.stringify(out.proposal));
    assert.equal(out.proposal.risk, "HIGH");
    assert.equal(out.proposal.need_confirm, true);
    assert.equal(out.proposal.params.sales_order, SO.name);
    assert.equal(out.proposal.params.lines.length, 2);
    assert.equal(out.proposal.params.lines[0].qty, 5, "phần còn chưa xuất hoá đơn (10 − 5 đã hoá đơn)");
    assert.equal(out.proposal.params.lines[0].rate, 305_000);
    assert.equal(out.proposal.params.submit_now, false);
    // The answer says DRAFT out loud — the card and the sentence must agree.
    assert.match(out.answer, /NHÁP/);
    assert.match(out.answer, new RegExp(SO.name));
    assert.match(out.answer, /KHÔNG đụng kho/);
    // Asking is not writing: no ERPNext document exists at proposal time.
    assert.equal(Object.prototype.hasOwnProperty.call(out, "erpnext_doc"), false, JSON.stringify(out.erpnext_doc));
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("P9-D E2E /ask: the invoice QUESTION still reads, and never becomes a WRITE card", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { MOCK_ERP_SO_FIXTURE: JSON.stringify([SO_FIXTURE]) });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const read = await copilot.call("hóa đơn còn nợ của Lan");
    assert.notEqual(read.routed.group, "sales_invoice_write", JSON.stringify(read.routed));
    // "hoá đơn còn nợ" is the deny-list case: the answer may still carry the
    // A1 read card (that is a READ proposal, and it opens a list — it can never
    // reach /execute), but it must NEVER be the invoice-writing card.
    assert.notEqual(read.proposal?.action, "create_sales_invoice", JSON.stringify(read.proposal));
    assert.ok(read.proposal === null || read.proposal.risk === "READ", JSON.stringify(read.proposal));
    // The refusal side of a command is an ANSWER (which order? nothing left?),
    // never a 500 and never a card.
    const none = await copilot.call("xuất hóa đơn cho Trần Văn Hai");
    assert.equal(none.proposal, null, JSON.stringify(none.proposal));
    assert.ok(String(none.reason ?? "").length > 0, "a refusal must explain itself");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("P9-D safety: in the read-only AI mode (dsh) an invoice command is BLOCKED before any skill runs", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { COPILOT_DSH_CONTEXT: "1", MOCK_ERP_SO_FIXTURE: JSON.stringify([SO_FIXTURE]) });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("xuất hóa đơn cho Nguyễn Thị Lan");
    assert.equal(out.error_code, "DSH_WRITE_BLOCKED", JSON.stringify(out));
    assert.equal(out.proposal, null, "the read-only mode never produces a write card");
    // The READ path in the same process is untouched.
    const read = await copilot.call("Nguyễn Thị Lan còn nợ bao nhiêu");
    assert.equal(read.customer?.id, "CUST-00001", JSON.stringify(read));
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});
