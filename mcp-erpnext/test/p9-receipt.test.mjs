/**
 * P9-B — purchase_receipt.create, plan .plan/next1/p9_prompts.md (mirror of
 * test/p9-delivery.test.mjs, party SUPPLIER, source PURCHASE ORDER).
 *
 * What this file proves, in the order the risk appears:
 *
 *  1. CONTRACT — the capability is a real WRITE: draft-only, allow_submit
 *     false, correlation field declared, skill wired, NOT executable-in-dsh.
 *  2. BUILDING FROM THE ORDER, NOT FROM THE SENTENCE — a receipt takes its
 *     lines from the Purchase Order; the utterance can only decide HOW MUCH of
 *     what the order already buys is received. Every "where would a guess
 *     happen" case refuses with the receipt's OWN code (PR_*).
 *  3. ROUTING — commands reach it; QUESTIONS keep the old READ behaviour
 *     ("nhập hàng … bao nhiêu" still answers stock, the B4-measured contract).
 *  4. FALSE WRITES — no confirm ⇒ 0; STALE card ⇒ 0; duplicate command_id ⇒
 *     ONE document; lost-response (CHAOS) ⇒ reconcile, never a second receipt.
 *  5. REGRESSION — the other five write capabilities keep their behaviour.
 *
 * Everything here mirrors p9-delivery.test.mjs on purpose: the two paths are
 * structural mirrors (customer/order vs supplier/order), and the tests are the
 * cheapest place to see a mirror drift.
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

import {
  __contract,
  executableWriteActions,
  getCapability,
  isStub,
  writeDoctypes,
} from "../src/capability-contract.mjs";
import * as receipt from "../src/skills/purchase-receipt-write.mjs";
import { buildPurchaseReceiptProposal } from "../src/skills/purchase-receipt-write.mjs";
import { routeIntent } from "../src/router.mjs";

/* --------------------------------------------------------------- fixtures -- */

/** A SUBMITTED purchase order with one partly-received line and one untouched. */
const PO = {
  name: "PUR-ORD-2026-00001",
  docstatus: 1,
  supplier: "SUP-HATIEN",
  supplier_name: "Hà Tiên",
  items: [
    { name: "POI-1", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", qty: 10, received_qty: 4, returned_qty: 0, uom: "Bao", stock_uom: "Bao", rate: 295_000, warehouse: "Kho chính - DFC" },
    { name: "POI-2", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", qty: 5, received_qty: 0, returned_qty: 0, uom: "Bao", stock_uom: "Bao", rate: 240_000, warehouse: "Kho chính - DFC" },
  ],
};
const SUPPLIER = { name: "SUP-HATIEN", supplier_name: "Hà Tiên" };

/** The catalogue the item matcher reads — same rows the mock serves. */
const ITEM_ROWS = [
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
  { name: "CAM-GA-10KG", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", stock_uom: "Bao" },
];

/**
 * A skills bag with the reads this builder uses + a write spy that must never
 * fire. Same shape as the delivery test's fakeSkills — including the rule that
 * the fake must hold BOTH halves consistently (getPurchaseOrder searches the
 * SAME list listOpenPurchaseOrders serves).
 */
function fakeSkills(po = PO, { counts, orders, drafts } = {}) {
  const spy = counts ?? { reads: 0, writes: 0 };
  return {
    spy,
    getPurchaseOrder: async (name) => {
      spy.reads += 1;
      const found = (orders ?? [po]).filter(Boolean).find((s) => String(s.name) === String(name)) ?? null;
      return { data: { doctype: "Purchase Order", data: found } };
    },
    listOpenPurchaseOrders: async () => ({
      data: {
        doctype: "Purchase Order",
        count: (orders ?? [po]).length,
        data: (orders ?? [po]).filter(Boolean).map((s) => ({ name: s.name, supplier: s.supplier, docstatus: s.docstatus })),
      },
    }),
    listOpenDraftPurchaseReceipts: async () => ({
      data: { doctype: "Purchase Receipt", count: (drafts ?? []).length, data: drafts ?? [] },
    }),
    getPurchaseReceiptDoc: async (name) => {
      const d = (drafts ?? []).find((x) => x.name === String(name)) ?? null;
      return { data: { doctype: "Purchase Receipt", data: d } };
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

/* ---------------------------------------------- 1. contract + write path -- */

test("P9-B contract: purchase_receipt.create is a real WRITE — draft-only, creatable but never submittable", () => {
  const cap = getCapability("purchase_receipt.create");
  assert.ok(cap, "the capability exists");
  assert.equal(cap.type, "WRITE");
  assert.equal(isStub("purchase_receipt.create"), false, "P9-B: implemented, no longer a stub");
  assert.equal(cap.execution.write_doctype, "Purchase Receipt");
  assert.equal(cap.execution.allow_submit, false, "a chat write NEVER submits — submit moves stock");
  assert.equal(cap.execution.draft_only, true);
  assert.equal(cap.execution.verify_document, true);
  assert.equal(cap.execution.reconcile_on_unknown, true);
  assert.equal(cap.execution.correlation_field, "custom_ai_action_id");
  assert.equal(cap.risk.level, "HIGH");
  assert.equal(cap.risk.requires_confirmation, true);
  assert.ok(cap.skill?.includes("purchase-receipt-write.mjs"), "the skill file is wired");
  assert.ok(writeDoctypes()["Purchase Receipt"], "Purchase Receipt is a declared write doctype");
  assert.ok(executableWriteActions().includes("create_purchase_receipt"), "the action is executable");
});

test("P9-B contract: the read-only AI mode (dsh) derives the block from the contract", async () => {
  // dsh-optin derives its group set from the contract — no hardcode may be
  // needed for a new WRITE to be blocked there (the B2 lesson, pinned).
  const { blockedInDshContext } = await import("../src/dsh-optin.mjs");
  assert.equal(blockedInDshContext({ group: "purchase_receipt_write" }), true);
});

/* ------------------------------------------------- 2. builder (proposal) -- */

test("P9-B builder: no PO named + no supplier resolved ⇒ refusal, not a guess", async () => {
  await refusal(buildPurchaseReceiptProposal(fakeSkills(), {}), "PR_PO_UNRESOLVED");
});

test("P9-B builder: a DRAFT purchase order refuses (ERPNext refuses receiving against a draft)", async () => {
  const draft = { ...PO, docstatus: 0 };
  await refusal(
    buildPurchaseReceiptProposal(fakeSkills(draft), { supplier: SUPPLIER, order: draft.name }),
    "PR_PO_NOT_SUBMITTED",
  );
});

test("P9-B builder: the ORDER decides the supplier — a mismatch refuses", async () => {
  await refusal(
    buildPurchaseReceiptProposal(fakeSkills(), { supplier: { name: "SUP-BAY", supplier_name: "Anh Bảy" }, order: PO.name }),
    "PR_SUPPLIER_MISMATCH",
  );
});

test("P9-B builder: an item not on the PO refuses — receipts carry only the order's own goods", async () => {
  await refusal(
    buildPurchaseReceiptProposal(
      fakeSkills(),
      { supplier: SUPPLIER, order: PO.name },
      { lines: [{ item_code: "NOT-IN-PO", qty: 1 }] },
    ),
    "PR_ITEM_NOT_IN_PO",
  );
});

test("P9-B builder: a quantity over the pending refuses — never clamped", async () => {
  await refusal(
    buildPurchaseReceiptProposal(
      fakeSkills(),
      { supplier: SUPPLIER, order: PO.name },
      { lines: [{ item_code: "CAM-GA-10KG", qty: 6 }] },
    ),
    "PR_QTY_EXCEEDS_PENDING",
  );
});

test("P9-B builder: the same item named twice is a QUESTION (PR_QTY_AMBIGUOUS), not a sum", async () => {
  await refusal(
    buildPurchaseReceiptProposal(
      fakeSkills(),
      { supplier: SUPPLIER, order: PO.name },
      // Note: lines live in OPTS (third argument) — the A1 review trap.
      { lines: [{ item_code: "CAM-GA-10KG", qty: 2 }, { item_code: "CAM-GA-10KG", qty: 3 }] },
    ),
    "PR_QTY_AMBIGUOUS",
  );
});

test("P9-B builder: a unit the ORDER does not use refuses (PR_UOM_MISMATCH) — no hidden conversion", async () => {
  // "1 Tấn" against a Bao row must not become a card that receives 1 Bao.
  await refusal(
    buildPurchaseReceiptProposal(fakeSkills(), { supplier: SUPPLIER, order: PO.name }, {
      nlp: { text: "nhận 1 tấn cám heo tăng trọng 25kg", quantities: [{ value: 1, canonical_unit: "Tấn", raw: "1 tấn", start: 0, end: 6 }] },
    }),
    "PR_UOM_MISMATCH",
  );
});

test("P9-B builder: happy path — proposal HIGH, draft-only, lines from the ORDER with pending arithmetic", async () => {
  const skillsBag = fakeSkills();
  const built = await buildPurchaseReceiptProposal(
    skillsBag,
    { supplier: SUPPLIER, order: PO.name },
    { lines: [{ item_code: "CAM-GA-10KG", qty: 3 }] },
  );
  assert.equal(built.proposal.action, "create_purchase_receipt");
  assert.equal(built.proposal.risk, "HIGH");
  assert.equal(built.proposal.params.submit_now, false);
  assert.equal(built.proposal.entity.id, "SUP-HATIEN");
  assert.equal(built.proposal.params.purchase_order, PO.name);
  const line = built.proposal.params.lines[0];
  assert.equal(line.qty, 3);
  assert.equal(line.uom, "Bao");
  assert.equal(line.rate, 240_000, "the rate is the PO ROW's rate — never from the utterance");
  assert.equal(line.purchase_order, PO.name);
  assert.equal(line.po_detail, "POI-2");
  assert.equal(line.warehouse, "Kho chính - DFC", "the PO's warehouse travels");
  // Warnings speak for the CHOSEN lines: a partial receipt says so out loud.
  // (The untouched CAM-HEO line is not chosen here, so it has no warning —
  // "còn phải nhận 6/10" only ever appears when that line is on the receipt.)
  assert.equal(built.warnings.some((w) => /nhận một phần 3\/5/.test(w)), true, JSON.stringify(built.warnings));
  // The builder is a READ-and-shape step: no writes through the bag.
  assert.equal(skillsBag.spy.writes, 0);
});

test("P9-B builder: an OPEN DRAFT receipt already holding the goods refuses (PR_DRAFT_COVERED) or reduces the proposal", async () => {
  const draftRow = (name, item_code, qty) => ({
    name,
    docstatus: 0,
    supplier: "SUP-HATIEN",
    items: [{ item_code, qty, purchase_order: PO.name }],
  });
  // (a) Drafts covering EVERY line: "nhận hết" must refuse.
  await refusal(
    buildPurchaseReceiptProposal(
      fakeSkills(PO, { drafts: [draftRow("PR-M001", "CAM-HEO-25KG", 6), draftRow("PR-M002", "CAM-GA-10KG", 5)] }),
      { supplier: SUPPLIER, order: PO.name },
    ),
    "PR_DRAFT_COVERED",
  );
  // (b) A partial draft (2 of 6): the proposal offers the REMAINDER, out loud.
  const partial = await buildPurchaseReceiptProposal(
    fakeSkills(PO, { drafts: [draftRow("PR-M001", "CAM-HEO-25KG", 2)] }),
    { supplier: SUPPLIER, order: PO.name },
  );
  assert.equal(partial.proposal.params.lines[0].qty, 4, "6 pending − 2 held by the open draft");
  assert.ok(partial.warnings.some((w) => /NHÁP/.test(w)), JSON.stringify(partial.warnings));
  // (c) An explicit quantity the draft already covers refuses with its own code.
  await refusal(
    buildPurchaseReceiptProposal(
      fakeSkills(PO, { drafts: [draftRow("PR-M001", "CAM-GA-10KG", 5)] }),
      { supplier: SUPPLIER, order: PO.name },
      { lines: [{ item_code: "CAM-GA-10KG", qty: 3 }] },
    ),
    "PR_DRAFT_COVERED",
  );
});

test("P9-B executor: the re-check also subtracts open drafts — a proposal written before the draft existed goes STALE, no second receipt", async () => {
  const draft = {
    name: "PR-M001",
    docstatus: 0,
    supplier: "SUP-HATIEN",
    items: [{ item_code: "CAM-HEO-25KG", qty: 6, purchase_order: PO.name }],
  };
  const mcp = {
    async callTool(tool, args) {
      if (tool === "erpnext_doc_list" && args?.doctype === "Purchase Receipt") {
        // The correlation probe finds nothing; the draft list finds the draft.
        const wantsCorrelation = (args?.filters ?? []).some(([f]) => f === "custom_ai_action_id");
        return { data: { doctype: "Purchase Receipt", data: wantsCorrelation ? [] : [draft] } };
      }
      if (tool === "erpnext_doc_get" && args?.doctype === "Purchase Receipt") {
        if (args?.name === draft.name) return { data: { data: draft } };
        throw new Error(`Purchase Receipt ${args?.name} not found`);
      }
      if (tool === "erpnext_doc_get" && args?.doctype === "Purchase Order") return { data: { data: PO } };
      throw new Error(`unexpected ${tool} ${JSON.stringify(args)}`);
    },
    async callWriteTool() {
      throw new Error("a stale proposal must be refused BEFORE any write");
    },
  };
  const built = await buildPurchaseReceiptProposal(fakeSkills(), { supplier: SUPPLIER, order: PO.name });
  // The builder (no drafts in its bag) proposed the full remainder; the live
  // site HAS a draft covering it — the executor must refuse, not write.
  await refusal(
    receipt.executePurchaseReceiptProposal(mcp, built.proposal, "cmd-stale-1", { setReference() {}, complete() {} }),
    "PROPOSAL_STALE",
  );
});

test("P9-B builder: a FULL page of open orders is a question (PR_PO_UNRESOLVED), never a silent pick", async () => {
  // Exactly OPEN_ORDER_LOOKUP_LIMIT submitted orders, exactly one still owing —
  // the old `>` clause would have picked it silently (the delivery-review trap).
  const page = Array.from({ length: 5 }, (_, i) => ({
    name: `PUR-ORD-2026-0000${i + 1}`,
    docstatus: 1,
    supplier: "SUP-HATIEN",
    supplier_name: "Hà Tiên",
    items: [
      ...(i === 0 ? [{ name: `POI-A${i}`, item_code: "CAM-HEO-25KG", item_name: "Cám heo", qty: 5, received_qty: 0, returned_qty: 0, uom: "Bao", rate: 295_000 }] : []),
      { name: `POI-B${i}`, item_code: "CAM-GA-10KG", item_name: "Cám gà", qty: 4, received_qty: 4, returned_qty: 0, uom: "Bao", rate: 240_000 },
    ],
  }));
  await refusal(
    buildPurchaseReceiptProposal(fakeSkills(PO, { orders: page }), { supplier: SUPPLIER }),
    "PR_PO_UNRESOLVED",
  );
});

test("P9-B builder: returned_qty subtracts — a part-returned row owes only the true remainder", async () => {
  const po = {
    ...PO,
    items: [{ name: "POI-1", item_code: "CAM-GA-10KG", item_name: "Cám gà", qty: 10, received_qty: 3, returned_qty: 5, uom: "Bao", rate: 240_000 }],
  };
  const built = await buildPurchaseReceiptProposal(fakeSkills(po), { supplier: SUPPLIER, order: po.name });
  // pending = 10 − 3 − 5 = 2 (NOT 7 — the recipes §1171 measured lesson)
  assert.equal(built.proposal.params.lines[0].qty, 2, JSON.stringify(built.proposal.params.lines));
});

/* ------------------------------------------------------- 3. routing ------- */

test("P9-B routing: receipt commands reach the capability; questions keep the READ behaviour", () => {
  for (const t of [
    "nhận hàng từ Hà Tiên",
    "nhận hàng Hà Tiên 5 bao cám gà",
    "nhận đơn PUR-ORD-2026-00001",
    "nhập hàng từ Hà Tiên",
    "nhập đơn mua 500 bao cám heo",
    "nhận hàng poPUR-ORD-2026-00001",
  ]) {
    const hit = routeIntent(t);
    assert.equal(hit?.capability, "purchase_receipt.create", `${t} → ${hit?.capability}`);
    assert.equal(hit?.group, "purchase_receipt_write", t);
  }
  for (const t of [
    "nhập hàng cám heo tuần này bao nhiêu",
    "Hà Tiên giao bao nhiêu rồi",
    "xem tình trạng nhập hàng",
    "đơn của Hà Tiên đã nhận chưa",
  ]) {
    assert.notEqual(routeIntent(t)?.capability, "purchase_receipt.create", `"${t}" must not open a card`);
  }
  // The B4 guard still holds: "nhận hàng" never becomes a purchase ORDER.
  assert.notEqual(routeIntent("nhận hàng từ Hà Tiên")?.capability, "purchase_order.create");
  // startsWith + notIf must travel together (the measured resolveCapability rule).
  const rawRouting = __contract?.routing ?? [];
  const routingList = Array.isArray(rawRouting) ? rawRouting : (rawRouting.routing ?? []);
  const r = routingList.find((g) => g.group === "purchase_receipt_write");
  assert.ok(r, "the routing group exists");
  assert.equal(r.startsWith, true, "purchase_receipt_write must be startsWith or its notIf is dead code");
  assert.ok(r.notIf, "purchase_receipt_write must carry a question deny-list");
});

/* ------------------------------------------- 4. executor + false writes --- */

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
 * mock ERPNext). Mirrors the delivery/QT/PO execute harness on purpose.
 */
async function withExecuteServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "p9b-pr-"));
  const prevState = process.env.MOCK_ERP_STATE;
  const prevFixture = process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE;
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE = JSON.stringify([PO]);
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
    const built = await buildPurchaseReceiptProposal(fakeSkills(), { supplier: SUPPLIER, order: PO.name });
    return await fn({ post, store, proposal: built.proposal, base });
  } finally {
    server?.close();
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    if (prevFixture === undefined) delete process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE;
    else process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE = prevFixture;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P9-B E2E /execute: a confirmed receipt writes ONE DRAFT doc — docstatus 0, received_qty does NOT move", async () => {
  await withExecuteServer(async ({ post, proposal }) => {
    const cid = randomUUID();
    const r = await post({ command_id: cid, proposal });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.replay, false);
    assert.match(r.body.result.erpnext_doc, /^PR-M\d+$/);
    assert.equal(r.body.result.docstatus, 0, "a chat write is ALWAYS a draft");
    assert.equal(r.body.result.purchase_order, PO.name);
    assert.equal(r.body.result.line_count, 2);
    assert.match(r.body.result.note, /NHÁP/);

    const rows = stateRows("purchase_receipts");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].docstatus, 0);
    for (const line of rows[0].items) {
      assert.equal(line.purchase_order, PO.name, "every line must link the order it fulfils");
      assert.ok(line.po_detail, "the child-row link travels too");
    }
    // The fixture's received_qty is untouched by a DRAFT write.
    const poRow = JSON.parse(process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE)[0].items[0];
    assert.equal(poRow.received_qty, 4, "a draft receipt must NOT advance the order's received qty");
    assert.equal(getCapability("purchase_receipt.create").execution.allow_submit, false);
  });
});

test("P9-B E2E /execute: a duplicate command_id REPLAYS — one document, one write", async () => {
  await withExecuteServer(async ({ post, proposal, store }) => {
    const cid = randomUUID();
    const first = await post({ command_id: cid, proposal });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await post({ command_id: cid, proposal });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replay, true);
    assert.equal(again.body.result.erpnext_doc, first.body.result.erpnext_doc, "the SAME receipt, never a second");
    assert.equal(stateRows("purchase_receipts").length, 1, "exactly one document exists");
    assert.equal(store.status(cid).status, "COMPLETED");
  });
});

test("P9-B E2E /execute CHAOS: a LOST RESPONSE after the write reconciles on retry instead of receiving twice", async () => {
  await withExecuteServer(async ({ post, proposal, store }) => {
    const cid = randomUUID();
    process.env.MOCK_ERP_FAIL_AFTER_WRITE = "1";
    let first;
    try {
      first = await post({ command_id: cid, proposal });
    } finally {
      delete process.env.MOCK_ERP_FAIL_AFTER_WRITE;
    }
    assert.equal(first.status, 503, JSON.stringify(first.body));
    assert.equal(first.body.retry_same_command_id, true, "the client must retry the SAME id, not a new one");
    assert.ok(stateRows("purchase_receipts").length === 1, "the receipt did land — the response was what was lost");
    assert.equal(store.status(cid).status, "PENDING", "a maybe-written command stays PENDING so it can reconcile");

    const retry = await post({ command_id: cid, proposal });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.reconciled, true, JSON.stringify(retry.body));
    assert.equal(retry.body.duplicate_documents, 0);
    assert.equal(stateRows("purchase_receipts").length, 1, "NO second purchase receipt");
    assert.equal(retry.body.result.docstatus, 0);
  });
});

test("P9-B false write: without a confirm nothing is written, and a STALE card writes nothing at all", async () => {
  await withExecuteServer(async ({ post, proposal }) => {
    assert.equal(stateRows("purchase_receipts").length, 0);

    // (a) A card older than the TTL is refused BEFORE any reservation.
    const cid = randomUUID();
    const stale = { ...proposal, created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }; // TTL = 10 phút
    const r = await post({ command_id: cid, proposal: stale });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "PROPOSAL_EXPIRED");
    assert.equal(stateRows("purchase_receipts").length, 0, "an expired card must not write");

    // (b) A card whose LINES drifted from the live order is refused too.
    const drifted = {
      ...proposal,
      params: { ...proposal.params, lines: proposal.params.lines.map((l) => ({ ...l, qty: l.qty + 100 })) },
    };
    const r2 = await post({ command_id: randomUUID(), proposal: drifted });
    assert.equal(r2.status, 409, JSON.stringify(r2.body));
    assert.equal(r2.body.code, "PROPOSAL_VERSION_STALE");
    assert.equal(r2.body.legacy_code, "PROPOSAL_STALE");
    assert.equal(stateRows("purchase_receipts").length, 0, "drift must not be clamped into a write");
  });
});

test("P9-B executor: the correlation-field-missing refusal fires BEFORE any write", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p9b-pr-nocorr-"));
  const prevState = process.env.MOCK_ERP_STATE;
  const prevFixture = process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE;
  const prevNoCorr = process.env.MOCK_ERP_PR_NO_CORRELATION_FIELD;
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE = JSON.stringify([PO]);
  process.env.MOCK_ERP_PR_NO_CORRELATION_FIELD = "1";
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    const server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const built = await buildPurchaseReceiptProposal(fakeSkills(), { supplier: SUPPLIER, order: PO.name });
    const r = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: randomUUID(), proposal: built.proposal }),
    });
    const body = await r.json();
    // 500 on purpose (the B2/B4-pinned convention): a missing correlation field
    // means the SITE is misconfigured — a server error, not a client conflict.
    assert.equal(r.status, 500, JSON.stringify(body));
    assert.equal(body.code, "PR_CORRELATION_FIELD_MISSING");
    assert.equal(stateRows("purchase_receipts").length, 0, "no once-only guard ⇒ no write");
    server.close();
  } finally {
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    if (prevFixture === undefined) delete process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE;
    else process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE = prevFixture;
    if (prevNoCorr === undefined) delete process.env.MOCK_ERP_PR_NO_CORRELATION_FIELD;
    else process.env.MOCK_ERP_PR_NO_CORRELATION_FIELD = prevNoCorr;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------ 5. E2E /ask (wired pipeline) -- */

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

test("P9-B E2E /ask: a receipt command returns a HIGH draft CARD + Vietnamese answer, and writes nothing", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { MOCK_ERP_PO_SUBMITTED_FIXTURE: JSON.stringify([PO]) });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("nhận hàng từ Hà Tiên");
    assert.equal(out.routed.group, "purchase_receipt_write", JSON.stringify(out.routed));
    assert.equal(out.proposal?.action, "create_purchase_receipt", JSON.stringify(out.proposal));
    assert.equal(out.proposal.risk, "HIGH");
    assert.equal(out.proposal.need_confirm, true);
    assert.equal(out.proposal.params.purchase_order, PO.name);
    assert.equal(out.proposal.params.lines.length, 2);
    assert.equal(out.proposal.params.lines[0].qty, 6, "nhận hết phần còn chờ nhận của dòng 1 (10 − 4)");
    assert.equal(out.proposal.params.lines[0].po_detail, "POI-1");
    assert.equal(out.proposal.params.submit_now, false, "a receipt is never submitted from chat");
    assert.match(out.answer, /NHÁP/);
    assert.match(out.answer, new RegExp(PO.name));
    assert.match(out.answer, /CHƯA cộng kho/);
    // Asking is not writing: no ERPNext document exists at proposal time.
    assert.equal(Object.prototype.hasOwnProperty.call(out, "erpnext_doc"), false);
    // Asking is not writing (spy half): the persisted mock ledger stays empty.
    assert.equal(stateRows("purchase_receipts").length, 0);
    // No submitted PO for the supplier ⇒ an ASK, not a card.
    const none = await copilot.call("nhận hàng từ Anh Bảy");
    assert.equal(none.proposal, null, JSON.stringify(none.proposal));
    assert.ok(String(none.reason ?? "").length > 0, "a refusal must explain itself");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("P9-B safety: in the read-only AI mode (dsh) a receipt command is BLOCKED before any skill runs", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { COPILOT_DSH_CONTEXT: "1", MOCK_ERP_PO_SUBMITTED_FIXTURE: JSON.stringify([PO]) });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("nhận hàng từ Hà Tiên");
    assert.equal(out.error_code, "DSH_WRITE_BLOCKED", JSON.stringify(out));
    assert.equal(out.proposal, null, "the read-only mode never produces a write card");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});
