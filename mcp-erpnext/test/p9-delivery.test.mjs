/**
 * P9-A1 (plan .plan/next1/p9_guide.md §3 P9-A) — delivery.create, PROPOSAL ONLY.
 *
 * What this file proves, in the order the risk appears:
 *
 *  1. CONTRACT — the capability now names its builder and carries the write
 *     policy (draft_only, verify_document), AND it is still `status: "stub"`
 *     with no executor and no declared doctype. Both halves matter: the builder
 *     exists, the write path does not.
 *  2. BUILDING FROM THE ORDER, NOT FROM THE SENTENCE — a delivery takes its
 *     lines from the Sales Order; the utterance can only decide HOW MUCH of what
 *     the order already promises. Every "where would a guess happen" case
 *     refuses with the delivery's OWN code (DN_*).
 *  3. FALSE WRITES — /execute refuses (EXECUTOR_NOT_REGISTERED) and the MCP
 *     write gate refuses "Delivery Note" as an undeclared doctype. A proposal
 *     that renders is not a write that can happen.
 *  4. NO WRITE INSIDE THE BUILD — a spied `callWriteTool` must stay untouched:
 *     the builder is a READ-and-shape step.
 *
 * P9-A2 adds the WIRED half of the same capability: the route (commands reach
 * it, questions do not), the /ask answer + card, and the EXECUTE path through
 * the Safety Gateway (draft only, idempotent, chaos-retry reconciles instead of
 * shipping twice). The cross-write guard that "giao hàng" never becomes a Sales
 * Order stays in b2-sales-order.test.mjs, where it was first measured.
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
/** Repo root — the cross-check below reads the Flutter client's own source. */
const REPO = path.join(HERE, "..", "..");

import { buildProposal } from "../src/action-proposal.mjs";
import {
  executableWriteActions,
  getCapability,
  isStub,
  writeDoctypes,
} from "../src/capability-contract.mjs";
import * as delivery from "../src/skills/delivery-write.mjs";
import { buildDeliveryProposal } from "../src/skills/delivery-write.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";
import { routeIntent } from "../src/router.mjs";

/* --------------------------------------------------------------- fixtures -- */

/** A SUBMITTED order with one partially-delivered line and one untouched. */
const SO = {
  name: "SAL-ORD-2026-00001",
  docstatus: 1,
  customer: "CUST-00001",
  customer_name: "Nguyễn Thị Lan",
  items: [
    { name: "SOI-1", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", qty: 10, delivered_qty: 4, uom: "Bao", stock_uom: "Bao" },
    { name: "SOI-2", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", qty: 5, delivered_qty: 0, uom: "Bao", stock_uom: "Bao" },
  ],
};
const CUSTOMER = { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" };

/** A skills bag with the ONE read this builder uses + a write spy that must
 *  never fire (the builder is given skills, not a write-capable client). */
function fakeSkills(so = SO, { counts, orders, drafts } = {}) {
  const spy = counts ?? { reads: 0, writes: 0 };
  return {
    spy,
    getSalesOrder: async (name) => {
      spy.reads += 1;
      // Search the SAME list the customer's open orders came from: a fixture
      // whose getSalesOrder only knew the first order made the "several orders"
      // case look like one order (the refusal never fired) — the fake has to
      // hold both halves consistently or it tests nothing.
      const found = (orders ?? [so]).filter(Boolean).find((s) => String(s.name) === String(name)) ?? null;
      return { data: { doctype: "Sales Order", data: found } };
    },
    // The customer's SUBMITTED orders (what "giao hàng cho Lan" resolves
    // against). Default: exactly this one order, so the happy path needs no
    // extra fixture; pass `orders: []` for "khách chưa có đơn nào".
    listOpenSalesOrders: async () => ({
      data: {
        doctype: "Sales Order",
        count: (orders ?? [so]).length,
        data: (orders ?? [so]).filter(Boolean).map((s) => ({ name: s.name, customer: s.customer, docstatus: s.docstatus })),
      },
    }),
    // P9-B review fix — the customer's OPEN DRAFT delivery notes (goods raw
    // pending still counts). Default: none, so existing cases are untouched.
    listOpenDraftDeliveryNotes: async () => ({
      data: { doctype: "Delivery Note", count: (drafts ?? []).length, data: drafts ?? [] },
    }),
    getDeliveryNoteDoc: async (name) => {
      const d = (drafts ?? []).find((x) => x.name === String(name)) ?? null;
      return { data: { doctype: "Delivery Note", data: d } };
    },
    findItem: async () => ({ data: { doctype: "Item", count: ITEM_ROWS.length, data: ITEM_ROWS } }),
    callWriteTool: async () => {
      spy.writes += 1;
      throw new Error("the builder must never write");
    },
  };
}

/** The catalogue the item matcher reads — same rows the mock serves. */
const ITEM_ROWS = [
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
  { name: "CAM-GA-10KG", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", stock_uom: "Bao" },
];

async function refusal(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err?.code, code, `expected ${code}, got ${err?.code}: ${err?.message}`);
    assert.ok(String(err?.message ?? "").length > 0, "a refusal must explain itself");
    return true;
  });
}

/* ---------------------------------------------- 1. contract + write path -- */

test("P9-A2 contract: delivery.create is a real WRITE — draft-only, and creatable but never submittable", () => {
  const cap = getCapability("delivery.create");
  assert.equal(cap.skill, "skills/delivery-write.mjs#buildDeliveryProposal");
  assert.equal(cap.proposal_action, "create_delivery_note");
  assert.equal(cap.risk.level, "HIGH");
  assert.equal(cap.risk.requires_confirmation, true);
  assert.equal(cap.execution.draft_only, true);
  assert.equal(cap.execution.allow_submit, false, "a submitted DN moves stock — never from chat");
  assert.equal(cap.execution.verify_document, true);
  assert.equal(cap.execution.idempotent, true);
  assert.equal(cap.execution.write_doctype, "Delivery Note");
  assert.equal(cap.execution.correlation_field, "custom_ai_action_id");
  assert.deepEqual(cap.entities.required, ["order"]);

  // The write path is OPEN for CREATE and closed for SUBMIT — the two halves of
  // the same decision, both read from the contract by the client's write gate.
  assert.equal(isStub("delivery.create"), false);
  assert.equal(writeDoctypes()["Delivery Note"].create, true);
  assert.equal(writeDoctypes()["Delivery Note"].submit, false);
  assert.equal(executableWriteActions().includes("create_delivery_note"), true);

  // And the file ships both halves of the capability now: builder + executor.
  assert.equal(typeof delivery.buildDeliveryProposal, "function");
  assert.equal(typeof delivery.executeDeliveryProposal, "function");
});

/* ------------------------------------------------------- 2. refusals ------- */

test("P9-A2 builder: no Sales Order to deliver against is a refusal — a delivery never picks its own order", async () => {
  // A customer with NO submitted order yet: ERPNext cannot deliver against a
  // draft, so there is nothing to propose.
  await refusal(
    buildDeliveryProposal(fakeSkills(SO, { orders: [] }), { customer: CUSTOMER }),
    "DN_SO_UNRESOLVED",
  );
  // No customer and no order named at all.
  await refusal(buildDeliveryProposal(fakeSkills(), {}), "DN_SO_UNRESOLVED");
  // Several orders still owing goods ⇒ ASK which one. Delivering "the backlog"
  // is the failure mode this refusal exists for: the wrong goods leave the shop
  // and nothing in chat can put them back.
  const second = { ...SO, name: "SAL-ORD-2026-00002" };
  await assert.rejects(
    buildDeliveryProposal(fakeSkills(SO, { orders: [SO, second] }), { customer: CUSTOMER }),
    (err) => {
      assert.equal(err.code, "DN_SO_UNRESOLVED");
      assert.match(err.message, /SAL-ORD-2026-00001/);
      assert.match(err.message, /SAL-ORD-2026-00002/);
      return true;
    },
  );
});

test("P9-A1 builder: an order ERPNext does not have is not a draft to invent", async () => {
  await refusal(
    buildDeliveryProposal(fakeSkills({ ...SO, name: "SAL-ORD-OTHER" }), { order: "SAL-ORD-2026-00001" }),
    "DN_SO_NOT_FOUND",
  );
});

test("P9-A1 builder: a DRAFT order cannot be delivered against (ERPNext rejects against_sales_order on draft)", async () => {
  const draft = { ...SO, docstatus: 0 };
  await refusal(buildDeliveryProposal(fakeSkills(draft), { order: SO.name }), "DN_SO_NOT_SUBMITTED");
});

test("P9-A1 builder: nothing to deliver is answered, not written as an empty note", async () => {
  await refusal(buildDeliveryProposal(fakeSkills({ ...SO, items: [] }), { order: SO.name }), "DN_NOTHING_TO_DELIVER");
  const fully = {
    ...SO,
    items: SO.items.map((it) => ({ ...it, delivered_qty: it.qty })),
  };
  await refusal(buildDeliveryProposal(fakeSkills(fully), { order: SO.name }), "DN_NOTHING_TO_DELIVER");
});

test("P9-A1 builder: the ORDER decides the customer — a mismatched resolved customer is refused", async () => {
  await refusal(
    buildDeliveryProposal(fakeSkills(), { order: SO.name, customer: { name: "CUST-99999", customer_name: "Người khác" } }),
    "DN_CUSTOMER_MISMATCH",
  );
  await refusal(
    buildDeliveryProposal(fakeSkills({ ...SO, customer: null }), { order: SO.name }),
    "DN_CUSTOMER_UNRESOLVED",
  );
});

test("P9-A1 builder: explicit quantities must belong to THIS order and fit what is still owed", async () => {
  const sk = () => fakeSkills();
  // An item that is not on the order at all.
  // NOTE: explicit quantities are the THIRD argument (opts), not part of the
  // resolved bag — passing them in the resolved bag silently means "no lines
  // named", which builds the whole pending set instead of refusing.
  await refusal(
    buildDeliveryProposal(sk(), { order: SO.name }, { lines: [{ item_code: "CAM-BO-1KG", qty: 1 }] }),
    "DN_ITEM_NOT_IN_SO",
  );
  // An item that IS on the order but already delivered in full.
  const delivered = { ...SO, items: SO.items.map((it) => (it.item_code === "CAM-HEO-25KG" ? { ...it, delivered_qty: it.qty } : it)) };
  await refusal(
    buildDeliveryProposal(fakeSkills(delivered), { order: SO.name }, { lines: [{ item_code: "CAM-HEO-25KG", qty: 1 }] }),
    "DN_ALREADY_DELIVERED",
  );
  // Quantity that is not a positive number.
  for (const bad of [0, -3, Number.NaN, undefined, "5 bao"]) {
    await refusal(
      buildDeliveryProposal(sk(), { order: SO.name }, { lines: [{ item_code: "CAM-HEO-25KG", qty: bad }] }),
      "DN_QTY_INVALID",
    );
  }
  // More than the order still owes (6 pending) ⇒ refuse, never clamp.
  await refusal(
    buildDeliveryProposal(sk(), { order: SO.name }, { lines: [{ item_code: "CAM-HEO-25KG", qty: 7 }] }),
    "DN_QTY_EXCEEDS_PENDING",
  );
  // The same item named twice is a question, not a sum (the order path refuses
  // "2 bao và 3 bao" for the same reason) — merging would deliver 5 silently.
  await refusal(
    buildDeliveryProposal(
      sk(),
      { order: SO.name },
      { lines: [{ item_code: "CAM-HEO-25KG", qty: 2 }, { item_code: "CAM-HEO-25KG", qty: 3 }] },
    ),
    "DN_QTY_AMBIGUOUS",
  );
  // Exactly the pending quantity is legal (boundary, no off-by-one).
  const ok = await buildDeliveryProposal(sk(), { order: SO.name }, { lines: [{ item_code: "CAM-HEO-25KG", qty: 6 }] });
  assert.deepEqual(ok.lines.map((l) => [l.item_code, l.qty]), [["CAM-HEO-25KG", 6]]);
});

test("P9-A1 builder: a line cap is enforced before any payload is shaped", async () => {
  const wide = {
    ...SO,
    items: Array.from({ length: 25 }, (_, i) => ({
      name: `SOI-${i}`,
      item_code: `IT-${i}`,
      item_name: `Hàng ${i}`,
      qty: 1,
      delivered_qty: 0,
      uom: "Bao",
    })),
  };
  await refusal(buildDeliveryProposal(fakeSkills(wide), { order: SO.name }), "DN_LINE_LIMIT");
});

/* --------------------------------------------------- 3. the happy path ----- */

test("P9-A1 builder: a HIGH proposal carries the order's own lines, and reports what is still owed", async () => {
  const skills = fakeSkills();
  const built = await buildDeliveryProposal(skills, { order: SO.name, customer: CUSTOMER });

  assert.equal(built.proposal.action, "create_delivery_note");
  assert.equal(built.proposal.risk, "HIGH");
  assert.equal(built.proposal.need_confirm, true);
  assert.equal(built.proposal.entity.id, "CUST-00001");
  assert.equal(built.proposal.entity.name, "Nguyễn Thị Lan");
  assert.equal(built.proposal.params.against_sales_order, SO.name);
  assert.equal(built.proposal.params.submit_now, false, "a delivery note is never submitted from chat");
  assert.equal(built.proposal.params.line_count, 2);

  // Default = everything the order still owes (10−4=6 and 5−0=5), with the
  // order's own uom and the child-row link ERPNext needs.
  assert.deepEqual(
    built.lines.map((l) => [l.item_code, l.qty, l.uom, l.against_sales_order, l.so_detail]),
    [
      ["CAM-HEO-25KG", 6, "Bao", SO.name, "SOI-1"],
      ["CAM-GA-10KG", 5, "Bao", SO.name, "SOI-2"],
    ],
  );
  // The partially-delivered line is NAMED, so a 6/10 delivery cannot read as a
  // 6-unit order.
  assert.ok(built.warnings.some((w) => /Cám heo/.test(w) && /6\/10/.test(w)));

  // Zero writes, and the read is the order read (nothing else was touched).
  assert.equal(skills.spy.writes, 0, "the builder must not write");
  assert.equal(skills.spy.reads, 1);
});

test("P9-A1 builder: an explicit partial quantity is proposed AND labelled as partial", async () => {
  const built = await buildDeliveryProposal(
    fakeSkills(),
    { order: SO.name },
    { lines: [{ item_code: "CAM-GA-10KG", qty: 2 }] },
  );
  assert.deepEqual(built.lines.map((l) => [l.item_code, l.qty]), [["CAM-GA-10KG", 2]]);
  assert.ok(built.warnings.some((w) => /giao một phần 2\/5/.test(w)), JSON.stringify(built.warnings));
});

/* ------------------------------------------------------- 4. false writes -- */

async function withGateway(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "p9a1-dn-"));
  try {
    const { runExecute } = await import("../src/safety-gateway.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    return await fn({ runExecute, store: new IdempotencyStore(dir) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P9-A2 false write: Delivery Note is creatable but SUBMIT is refused in code — the chat path cannot submit it", async () => {
  // The mock can only CREATE drafts, so the order to deliver against has to come
  // from the submitted-order fixture (the site's "orders someone submitted on
  // ERPNext"). Env is set BEFORE the client spawns the mock child process.
  const prevFixture = process.env.MOCK_ERP_SO_FIXTURE;
  process.env.MOCK_ERP_SO_FIXTURE = JSON.stringify([
    { ...SO, docstatus: 1, items: SO.items.map((it) => ({ ...it, warehouse: "Kho chính" })) },
  ]);
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();
    // Creating the draft is allowed (the capability declares the doctype)…
    const created = await client.callWriteTool("erpnext_doc_create", {
      doctype: "Delivery Note",
      data: {
        customer: "CUST-00001",
        company: "Demo Feed Co",
        items: [
          {
            item_code: "CAM-HEO-25KG",
            qty: 1,
            uom: "Bao",
            against_sales_order: SO.name,
            so_detail: "SOI-1",
          },
        ],
      },
    });
    assert.match(created.data.data.name, /^DN-M\d+$/);
    // …but SUBMITTING it is refused in code: that is the step that moves stock.
    await assert.rejects(
      () => client.callWriteTool("erpnext_doc_submit", { doctype: "Delivery Note", name: created.data.data.name }),
      /WRITE_REFUSED/,
    );
    // The note really is still a draft, and creating it did not advance the
    // order's delivered quantity (only submit does that on ERPNext).
    const back = await client.callTool("erpnext_doc_get", { doctype: "Delivery Note", name: created.data.data.name });
    assert.equal(back.data.data.docstatus, 0);
  } finally {
    await client.close().catch(() => {});
    if (prevFixture === undefined) delete process.env.MOCK_ERP_SO_FIXTURE;
    else process.env.MOCK_ERP_SO_FIXTURE = prevFixture;
  }
});

test("P9-A2 cross-check: the Flutter card confirms EXACTLY the actions the contract can execute", async () => {
  // Same tripwire as B2's, re-asserted from this phase: the card's confirm set
  // and the gateway's executor registry are two halves of one decision.
  const dart = readFileSync(
    path.join(REPO, "apps", "mobile", "lib", "features", "chat", "data", "chat_models.dart"),
    "utf8",
  );
  const match = dart.match(/_confirmableActions = \{([^}]*)\}/);
  assert.ok(match, "the client must keep the _confirmableActions set");
  const clientActions = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(clientActions, executableWriteActions().sort());
});

test("P9-A1 guard: a delivery proposal is still a proposal, not a document (no side effect on /ask)", async () => {
  // The shape the card consumes must be an erpn.proposal/v1 and must not carry
  // an ERPNext document name — nothing was written at proposal time.
  const built = await buildDeliveryProposal(fakeSkills(), { order: SO.name });
  assert.equal(built.proposal.schema, "erpn.proposal/v1");
  assert.equal(Object.prototype.hasOwnProperty.call(built, "erpnext_doc"), false);
  // A HIGH card is a confirm card: the numbers to approve travel with it, and
  // the ORDER it will be delivered against is named on the card, not inferred
  // later at execute time.
  assert.equal(built.proposal.need_confirm, true);
  assert.equal(built.proposal.params.against_sales_order, SO.name);
  // `proposal.executable` is the RISK-DISPLAY flag (only READ is "executable"
  // in the Phase-6 sense) — NOT the write gate. The write gate is the Safety
  // Gateway, and it refuses this action (asserted above). Pinned so nobody
  // later reads `executable: false` as "this write is disabled" and removes the
  // executor check that actually stops it.
  assert.equal(built.proposal.executable, false);
  assert.equal(buildProposal({ action: "create_delivery_note", risk: "HIGH", entity: { kind: "customer", id: SO.customer } }).executable, false);
});

/* ----------------------------------------------------------- 5. routing ---- */

test("P9-A2 routing: Vietnamese delivery COMMANDS reach the delivery path (measured misroute, closed)", () => {
  // Every command form a shop owner actually says. "giao 5 bao … cho Lan" is
  // the one that matters most: measured before this change it fell into
  // inventory/stock.balance, i.e. a COMMAND was answered with a STOCK NUMBER
  // (the exact bug class B4 closed for "nhập kho").
  for (const t of [
    "giao hàng cho Nguyễn Thị Lan",
    "giao hàng cho Nguyễn Thị Lan 2 bao cám heo tăng trọng 25kg",
    "giao 5 bao cám gà thịt 10kg cho Nguyễn Thị Lan",
    "giao cho Nguyễn Thị Lan 3 bao cám heo",
    "xuất hàng cho Nguyễn Thị Lan 3 bao cám heo",
    "giao đơn hàng cho Nguyễn Thị Lan",
    "giao hàng đơn SAL-ORD-2026-00001",
  ]) {
    const hit = routeIntent(t);
    assert.equal(hit?.capability, "delivery.create", t);
    assert.equal(hit?.group, "delivery_write", t);
  }

  // The other WRITE paths are untouched: an order is still an order, an offer
  // still an offer.
  assert.equal(routeIntent("đặt hàng cho Nguyễn Thị Lan 2 bao cám heo tăng trọng 25kg")?.capability, "sales_order.create");
  assert.equal(routeIntent("báo giá cho Nguyễn Thị Lan 10 bao cám heo")?.capability, "quotation.create");

  // The deny-list is only honoured because the group is sentence-initial: a
  // non-startsWith group silently ignores its own notIf (measured first in B4,
  // where the golden run failed exactly this way).
  const contract = JSON.parse(readFileSync(path.join(REPO, "mcp-erpnext", "capabilities.json"), "utf8"));
  const raw = contract.routing.find((g) => g.group === "delivery_write");
  assert.equal(raw.startsWith, true, "delivery_write must be startsWith or its notIf is dead code");
  assert.ok(raw.notIf, "delivery_write must carry a question deny-list");
});

test("P9-A2 routing: a QUESTION about deliveries never becomes a delivery note", () => {
  for (const t of [
    "đã giao chưa",
    "giao bao nhiêu",
    "còn giao không",
    "khách Lan đã giao bao nhiêu",
    "giao hàng tháng này bao nhiêu",
    "xem tình trạng giao hàng",
    "hôm qua tôi giao hàng cho Lan",
    "giao dịch hôm nay",
    "giao dịch tháng này",
  ]) {
    assert.notEqual(routeIntent(t)?.capability, "delivery.create", `"${t}" must not open a card`);
  }
});

/* -------------------------- 5b. P9-B review fixes (guards added after review) -- */

/** An NLP shape with an explicit SPOKEN unit — what the pipeline really hands over. */
const nlpSaying = (text, unit, value) => ({
  text,
  quantities: [{ value, canonical_unit: unit, raw: `${value} ${unit.toLowerCase()}`, start: 0, end: 6 }],
});

test("P9-B review fix: a unit the ORDER does not use refuses (DN_UOM_MISMATCH) — no hidden conversion", async () => {
  // "1 Tấn" against a Bao line must not become a card that ships 1 Bao.
  await refusal(
    buildDeliveryProposal(fakeSkills(), { customer: CUSTOMER, order: SO.name }, {
      nlp: nlpSaying("giao 1 tấn cám heo tăng trọng 25kg", "Tấn", 1),
    }),
    "DN_UOM_MISMATCH",
  );
  // The same NUMBER in the order's own unit (case-insensitive) is fine.
  const ok = await buildDeliveryProposal(fakeSkills(), { customer: CUSTOMER, order: SO.name }, {
    nlp: nlpSaying("giao 2 bao cám heo tăng trọng 25kg", "bao", 2),
  });
  assert.equal(ok.proposal.params.lines[0].qty, 2);
  assert.equal(ok.proposal.params.lines[0].uom, "Bao");
});

test("P9-B review fix: a FULL page of open orders is a question (DN_SO_UNRESOLVED), never a silent pick", async () => {
  // Exactly OPEN_ORDER_LOOKUP_LIMIT submitted orders, exactly one still owing —
  // the old `>` clause treated the full page as "no more orders" and picked it.
  const page = Array.from({ length: 5 }, (_, i) => ({
    name: `SAL-ORD-2026-0000${i + 1}`,
    docstatus: 1,
    customer: "CUST-00001",
    customer_name: "Nguyễn Thị Lan",
    items: [
      // Only the first order still owes goods — the trap the old clause fell in.
      ...(i === 0 ? [{ name: "SOI-1", item_code: "CAM-HEO-25KG", item_name: "Cám heo", qty: 5, delivered_qty: 0, uom: "Bao" }] : []),
      { name: `SOI-D${i}`, item_code: "CAM-GA-10KG", item_name: "Cám gà", qty: 4, delivered_qty: 4, uom: "Bao" },
    ],
  }));
  await refusal(
    buildDeliveryProposal(fakeSkills(SO, { orders: page }), { customer: CUSTOMER }),
    "DN_SO_UNRESOLVED",
  );
});

test("P9-B review fix: an OPEN DRAFT note already holding the goods refuses (DN_DRAFT_COVERED) or reduces the proposal", async () => {
  const draftRow = (name, item_code, qty) => ({
    name,
    docstatus: 0,
    customer: "CUST-00001",
    items: [{ item_code, qty, against_sales_order: SO.name }],
  });
  // (a) Drafts covering EVERY line: "giao hết" must refuse — raw pending
  // still counts goods the live drafts hold, so "everything left" is empty.
  await refusal(
    buildDeliveryProposal(fakeSkills(SO, { drafts: [draftRow("DN-M001", "CAM-HEO-25KG", 6), draftRow("DN-M002", "CAM-GA-10KG", 5)] }), {
      customer: CUSTOMER,
      order: SO.name,
    }),
    "DN_DRAFT_COVERED",
  );
  // (b) A partial draft (2 of 6): the proposal offers the REMAINDER, out loud.
  const partial = await buildDeliveryProposal(
    fakeSkills(SO, { drafts: [draftRow("DN-M001", "CAM-HEO-25KG", 2)] }),
    { customer: CUSTOMER, order: SO.name },
  );
  assert.equal(partial.proposal.params.lines[0].qty, 4, "6 pending − 2 held by the open draft");
  assert.ok(partial.warnings.some((w) => /NHÁP/.test(w)), JSON.stringify(partial.warnings));
  // (c) An explicit quantity the draft already covers refuses with its own
  // code. (`lines` belongs in OPTS — the third argument. Passing it in
  // `resolved` silently ignores it — the same trap the A1 review caught.)
  await refusal(
    buildDeliveryProposal(
      fakeSkills(SO, { drafts: [draftRow("DN-M001", "CAM-GA-10KG", 5)] }),
      { customer: CUSTOMER, order: SO.name },
      { lines: [{ item_code: "CAM-GA-10KG", qty: 3 }] },
    ),
    "DN_DRAFT_COVERED",
  );
});

test("P9-B review fix: the EXECUTOR re-check also subtracts open drafts — a proposal written before the draft existed goes STALE, no second note", async () => {
  const draft = {
    name: "DN-M001",
    docstatus: 0,
    customer: "CUST-00001",
    items: [{ item_code: "CAM-HEO-25KG", qty: 6, against_sales_order: SO.name }],
  };
  const mcp = {
    async callTool(tool, args) {
      if (tool === "erpnext_doc_list" && args?.doctype === "Delivery Note") {
        // The correlation probe finds nothing; the draft list finds the draft.
        const wantsCorrelation = (args?.filters ?? []).some(([f]) => f === "custom_ai_action_id");
        return { data: { doctype: "Delivery Note", data: wantsCorrelation ? [] : [draft] } };
      }
      if (tool === "erpnext_doc_get" && args?.doctype === "Delivery Note") {
        if (args?.name === draft.name) return { data: { data: draft } };
        throw new Error(`Delivery Note ${args?.name} not found`);
      }
      if (tool === "erpnext_doc_get" && args?.doctype === "Sales Order") return { data: { data: SO } };
      throw new Error(`unexpected ${tool} ${JSON.stringify(args)}`);
    },
    async callWriteTool() {
      throw new Error("a stale proposal must be refused BEFORE any write");
    },
  };
  const built = await buildDeliveryProposal(fakeSkills(), { customer: CUSTOMER, order: SO.name });
  // The builder (no drafts in its bag) proposed the full remainder; the live
  // site HAS a draft covering it — the executor must refuse, not write.
  await refusal(
    delivery.executeDeliveryProposal(mcp, built.proposal, "cmd-stale-1", { setReference() {}, complete() {} }),
    "PROPOSAL_STALE",
  );
});

/* ------------------------------------------------- 6. end-to-end pipeline -- */

/** Strip ERPNEXT_* so the child always talks to the in-memory mock. */
const MOCK_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));

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

/**
 * A SUBMITTED order as the MOCK serves it — the site's "orders someone already
 * submitted on ERPNext". Declared per-MOCK-process through env because the mock
 * can only CREATE drafts (submitting is the site's job), so without this every
 * mock order is `docstatus: 0` and a delivery has nothing to be raised against.
 */
const SO_FIXTURE = {
  ...SO,
  items: SO.items.map((it) => ({ ...it, rate: 305_000, warehouse: "Kho chính - DFC" })),
};

test("P9-A2 E2E /ask: a delivery command returns a HIGH draft CARD + Vietnamese answer, and writes nothing", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { MOCK_ERP_SO_FIXTURE: JSON.stringify([SO_FIXTURE]) });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("giao hàng cho Nguyễn Thị Lan");
    assert.equal(out.routed.group, "delivery_write", JSON.stringify(out.routed));
    assert.equal(out.proposal?.action, "create_delivery_note", JSON.stringify(out.proposal));
    assert.equal(out.proposal.risk, "HIGH");
    assert.equal(out.proposal.need_confirm, true);
    // The card names the ORDER it fulfils and the order's OWN pending lines.
    assert.equal(out.proposal.params.against_sales_order, SO.name);
    assert.equal(out.proposal.params.lines.length, 2);
    assert.equal(out.proposal.params.lines[0].qty, 6, "giao hết phần còn chờ giao của dòng 1 (10 − 4)");
    assert.equal(out.proposal.params.lines[0].so_detail, "SOI-1");
    assert.equal(out.proposal.params.submit_now, false, "a delivery is never submitted from chat");
    // The answer says DRAFT out loud — the card and the sentence must agree.
    assert.match(out.answer, /NHÁP/);
    assert.match(out.answer, new RegExp(SO.name));
    assert.match(out.answer, /CHƯA trừ kho/);
    // Asking is not writing: no ERPNext document exists at proposal time.
    assert.equal(Object.prototype.hasOwnProperty.call(out, "erpnext_doc"), false, JSON.stringify(out.erpnext_doc));
    // No submitted order for the customer ⇒ an ASK, not a card.
    const none = await copilot.call("giao hàng cho Trần Văn Hai");
    assert.equal(none.proposal, null, JSON.stringify(none.proposal));
    assert.ok(String(none.reason ?? "").length > 0, "a refusal must explain itself");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("P9-A2 safety: in the read-only AI mode (dsh) a delivery command is BLOCKED before any skill runs", async () => {
  // The opt-in gate derives its group set from the CONTRACT, so a capability
  // that becomes writable must inherit the block without an edit there. Pinned
  // from this phase because the failure mode is silent: a new WRITE reachable
  // from the read-only mode.
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { COPILOT_DSH_CONTEXT: "1", MOCK_ERP_SO_FIXTURE: JSON.stringify([SO_FIXTURE]) });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("giao hàng cho Nguyễn Thị Lan");
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

/* --------------------------------------------------------- 7. execution ---- */

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

/**
 * Run the FULL write path (/execute over HTTP → Safety Gateway → executor →
 * mock ERPNext) with the delivery fixture in place. Mirrors the payment/QT/PO
 * execute harness on purpose: same gates, same chaos knobs.
 */
async function withExecuteServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "p9a2-dn-"));
  const prevState = process.env.MOCK_ERP_STATE;
  const prevFixture = process.env.MOCK_ERP_SO_FIXTURE;
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  process.env.MOCK_ERP_SO_FIXTURE = JSON.stringify([SO_FIXTURE]);
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
    const built = await buildDeliveryProposal(fakeSkills(), { customer: CUSTOMER, order: SO.name });
    return await fn({ post, store, proposal: built.proposal, base });
  } finally {
    server?.close();
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    if (prevFixture === undefined) delete process.env.MOCK_ERP_SO_FIXTURE;
    else process.env.MOCK_ERP_SO_FIXTURE = prevFixture;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P9-A2 E2E /execute: a confirmed delivery writes ONE DRAFT note — docstatus 0, and the order's delivered qty does NOT move", async () => {
  await withExecuteServer(async ({ post, proposal }) => {
    const cid = randomUUID();
    const r = await post({ command_id: cid, proposal });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.replay, false);
    assert.match(r.body.result.erpnext_doc, /^DN-M\d+$/);
    assert.equal(r.body.result.docstatus, 0, "a chat write is ALWAYS a draft");
    assert.equal(r.body.result.against_sales_order, SO.name);
    assert.equal(r.body.result.line_count, 2);
    assert.match(r.body.result.note, /NHÁP/);

    const notes = stateRows("delivery_notes");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].docstatus, 0);
    for (const line of notes[0].items) {
      assert.equal(line.against_sales_order, SO.name, "every line must link the order it fulfils");
      assert.ok(line.so_detail, "the child-row link travels too");
    }
    // Nothing in the write path can submit: that is what moves stock.
    assert.equal(getCapability("delivery.create").execution.allow_submit, false);
  });
});

test("P9-A2 E2E /execute: a duplicate command_id REPLAYS — one document, one write", async () => {
  await withExecuteServer(async ({ post, proposal, store }) => {
    const cid = randomUUID();
    const first = await post({ command_id: cid, proposal });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // The client retries after a lost response — same command_id.
    const again = await post({ command_id: cid, proposal });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replay, true);
    assert.equal(again.body.result.erpnext_doc, first.body.result.erpnext_doc, "the SAME note, never a second");
    assert.equal(stateRows("delivery_notes").length, 1, "exactly one document exists");
    assert.equal(store.status(cid).status, "COMPLETED");
  });
});

test("P9-A2 E2E /execute CHAOS: a LOST RESPONSE after the write reconciles on retry instead of shipping twice", async () => {
  await withExecuteServer(async ({ post, proposal, store }) => {
    const cid = randomUUID();
    // The document is COMMITTED, then the response is lost (the failure mode
    // that turns a naive retry into a second delivery).
    process.env.MOCK_ERP_FAIL_AFTER_WRITE = "1";
    let first;
    try {
      first = await post({ command_id: cid, proposal });
    } finally {
      delete process.env.MOCK_ERP_FAIL_AFTER_WRITE;
    }
    assert.equal(first.status, 503, JSON.stringify(first.body));
    assert.equal(first.body.retry_same_command_id, true, "the client must retry the SAME id, not a new one");
    assert.ok(stateRows("delivery_notes").length === 1, "the note did land — the response was what was lost");
    assert.equal(store.status(cid).status, "PENDING", "a maybe-written command stays PENDING so it can reconcile");

    // Retry: the gateway reconciles against ERPNext by correlation value and
    // answers with the document that is already there.
    const retry = await post({ command_id: cid, proposal });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.reconciled, true, JSON.stringify(retry.body));
    assert.equal(retry.body.duplicate_documents, 0);
    assert.equal(stateRows("delivery_notes").length, 1, "NO second delivery note");
    assert.equal(retry.body.result.docstatus, 0);
  });
});

test("P9-A2 false write: without a confirm nothing is written, and a STALE card writes nothing at all", async () => {
  await withExecuteServer(async ({ post, proposal }) => {
    // (a) The ASK half: building the proposal (what /ask does) writes nothing —
    // the mock state file is never even created.
    assert.equal(stateRows("delivery_notes").length, 0);

    // (b) A card older than the TTL is refused BEFORE any reservation.
    const cid = randomUUID();
    const stale = { ...proposal, created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }; // TTL = 10 phút
    const r = await post({ command_id: cid, proposal: stale });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "PROPOSAL_EXPIRED");
    assert.equal(stateRows("delivery_notes").length, 0, "an expired card must not write");

    // (c) A card whose LINES drifted from the live order is refused too — the
    // proposal's numbers are compared, never trusted.
    const drifted = {
      ...proposal,
      params: { ...proposal.params, lines: proposal.params.lines.map((l) => ({ ...l, qty: l.qty + 100 })) },
    };
    const r2 = await post({ command_id: randomUUID(), proposal: drifted });
    assert.equal(r2.status, 409, JSON.stringify(r2.body));
    // Same taxonomy as the payment/QT/PO paths (P1 §12): the SPECIFIC code says
    // data moved, the legacy code stays for clients that only know that one.
    assert.equal(r2.body.code, "PROPOSAL_VERSION_STALE");
    assert.equal(r2.body.legacy_code, "PROPOSAL_STALE");
    assert.ok(r2.body.problems.some((p) => /chờ giao/.test(p)), JSON.stringify(r2.body.problems));
    assert.equal(stateRows("delivery_notes").length, 0, "drift must not be clamped into a write");
  });
});
