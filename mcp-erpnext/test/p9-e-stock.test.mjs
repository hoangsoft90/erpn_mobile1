/**
 * P9-E — `stock.adjustment`: xuất hủy hàng hỏng = a DRAFT Stock Entry
 * (Material Issue).
 *
 * SCOPE SPLIT (user decision 2026-09-23): this file covers what can be proven
 * WITHOUT the shop's site — the contract, the routing, and every refusal the
 * BUILDER makes from an injected reads bag. The end-to-end proof (a real draft
 * created, verified, and deleted on the live ERPNext) lives in
 * `.plan/loop-p9e-real.mjs` and was run against the real site; a mock cannot
 * stand in for it, and the fixtures here are deliberately NOT presented as
 * ERPNext data — they are "what the tool returned", which is all a unit test can
 * honestly claim.
 *
 * What makes this capability different from the seven writes before it:
 *   - NO PARTY. Its entity is an ITEM, and its correctness depends on TWO
 *     slots the user SPOKE: how many AND out of which room.
 *   - It is the only write whose document has NO price at all (the valuation
 *     belongs to ERPNext's ledger), so a price in the params is a bug.
 *   - The document is a DRAFT that moves NOTHING; only a submit writes a Stock
 *     Ledger Entry, and submit does not exist on this path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");

import {
  executableWriteActions,
  getCapability,
  isStub,
  writeDoctypes,
} from "../src/capability-contract.mjs";
import * as stock from "../src/skills/stock-adjustment-write.mjs";
import { buildStockAdjustmentProposal } from "../src/skills/stock-adjustment-write.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";
import { routeIntent } from "../src/router.mjs";
import { buildProposal } from "../src/action-proposal.mjs";

/* ------------------------------------------------------------ fixtures ----- */

const ITEMS = [
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
  { name: "CAM-GA-10KG", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", stock_uom: "Bao" },
  // A Kg-stocked item: the only case where a DIRECT conversion factor exists.
  { name: "THEP-D16", item_code: "THEP-D16", item_name: "Thép D16", stock_uom: "Kg" },
];

const UOMS = ["Bao", "Tấn", "Kg"];
const FACTORS = [{ from_uom: "Bao", to_uom: "Kg", value: 25 }, { from_uom: "Tấn", to_uom: "Kg", value: 1000 }];

/** What `Bin` returns: the SAME item in TWO rooms (the real-site shape, which
 *  is why "name the warehouse" is a real requirement and not a hurdle). */
const BIN = [
  { item_code: "CAM-HEO-25KG", warehouse: "Kho chính", actual_qty: 120, reserved_qty: 5, projected_qty: 115 },
  { item_code: "CAM-HEO-25KG", warehouse: "Kho Hàng Lỗi - MP", actual_qty: 6, reserved_qty: 0, projected_qty: 6 },
  // The Kg-stocked item needs its own row: the conversion rule is reached only
  // AFTER the room is resolved, so a missing row would make that test pass for
  // the wrong reason (it would refuse at SE_WAREHOUSE_NOT_FOUND instead).
  { item_code: "THEP-D16", warehouse: "Kho chính", actual_qty: 500, reserved_qty: 0, projected_qty: 500 },
];

/**
 * The reads bag, in the shape the REAL tool answers (raw payload, unwrapped by
 * the skill's own `rowsOf`/`docOf`). Every entry is overridable so a test can
 * describe the ONE thing it is about.
 */
function skills({ items = ITEMS, bin = BIN, drafts = [], unreadable = false, page = 1 } = {}) {
  const spy = { writes: 0 };
  return {
    spy,
    findItem: async () => ({ data: { doctype: "Item", count: items.length, data: items } }),
    listUoms: async () => ({ data: { doctype: "UOM", count: UOMS.length, data: UOMS } }),
    listUomFactors: async () => ({ data: { doctype: "UOM Conversion Factor", count: FACTORS.length, data: FACTORS } }),
    listStockRows: async () => ({ data: { doctype: "Bin", count: bin.length, data: bin } }),
    listOpenDraftStockEntries: async () => ({
      data: { doctype: "Stock Entry", count: drafts.length, data: drafts.map((d) => ({ name: d.name, docstatus: 0, stock_entry_type: "Material Issue" })) },
    }),
    getStockEntryDoc: async (name) => {
      if (unreadable) throw new Error(`cannot read ${name}`);
      const d = drafts.find((x) => x.name === String(name));
      return { data: { data: d ?? { name } } };
    },
    callWriteTool: async () => {
      spy.writes += 1;
      throw new Error("the builder must never write");
    },
  };
}

const qty = (value, unit, raw) => ({ value, canonical_unit: unit, raw, start: 9, end: 9 + String(raw).length });

const nlp = (text, quantities = []) => ({ text, quantities });

async function refusal(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err?.code, code, `expected ${code}, got ${err?.code}: ${err?.message}`);
    assert.ok(String(err?.message ?? "").length > 0, "a refusal must explain itself");
    return true;
  });
}

/* ------------------------------------------------- 1. contract + write gate - */

test("P9-E contract: stock.adjustment is a real WRITE — draft-only, Stock Entry, never submittable", () => {
  const cap = getCapability("stock.adjustment");
  assert.equal(cap.type, "WRITE");
  assert.equal(cap.skill, "skills/stock-adjustment-write.mjs#buildStockAdjustmentProposal");
  assert.equal(cap.proposal_action, "create_stock_adjustment");
  assert.equal(cap.risk.level, "HIGH");
  assert.equal(cap.risk.requires_confirmation, true);
  // The whole reason this one is HIGH rather than LOW: TWO slots must be spoken.
  assert.equal(cap.risk.double_confirm, true);
  assert.deepEqual(cap.entities.required, ["item", "quantity", "warehouse"]);
  assert.equal(cap.execution.draft_only, true);
  assert.equal(cap.execution.allow_submit, false, "submit writes a Stock Ledger Entry — never from chat");
  assert.equal(cap.execution.write_doctype, "Stock Entry");
  assert.equal(cap.execution.correlation_field, "custom_ai_action_id");
  assert.equal(cap.execution.verify_document, true);
  assert.equal(cap.execution.idempotent, true);
  assert.equal(cap.amount_policy, null, "no single amount exists to gate");
  // The declared purpose is POLICY, not a constant copied into the skill: the
  // skill refuses when the contract stops saying it.
  assert.equal(cap.line_policy.entry_type, "Material Issue");
  assert.equal(cap.line_policy.max_lines, 1, "one write-off is one item");
  assert.equal(cap.line_policy.rate_source, "erpnext");

  assert.equal(isStub("stock.adjustment"), false);
  assert.equal(writeDoctypes()["Stock Entry"].create, true);
  assert.equal(writeDoctypes()["Stock Entry"].submit, false);
  assert.equal(executableWriteActions().includes("create_stock_adjustment"), true);
  assert.equal(typeof stock.buildStockAdjustmentProposal, "function");
  assert.equal(typeof stock.executeStockAdjustmentProposal, "function");
  assert.equal(stock.WRITE_DOCTYPE, "Stock Entry");
});

test("P9-E contract: a blank `entry_type` is refused at LOAD time (the guard cannot go dead)", () => {
  // The skill refuses when the declaration is MISSING, and the contract refuses
  // a BLANK one — together there is no edit that leaves the purpose undeclared
  // yet valid. Driven through a child process with `ERPN_CAPABILITY_CONTRACT`
  // pointing at a mutated copy of the shipped file: the real contract is frozen
  // and validated at import, so it cannot be perturbed in-process.
  const real = JSON.parse(readFileSync(path.join(HERE, "..", "capabilities.json"), "utf8"));
  const loader = path.join(HERE, "..", "src", "capability-contract.mjs").replace(/\\/g, "/");
  const dir = mkdtempSync(path.join(tmpdir(), "p9e-contract-"));
  try {
    const check = (mutate) => {
      const copy = JSON.parse(JSON.stringify(real));
      mutate(copy.capabilities["stock.adjustment"].line_policy);
      const file = path.join(dir, `cap-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(copy));
      const res = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `import("${loader}").then(()=>console.log("LOADED")).catch(e=>console.log("REFUSED: "+e.message))`],
        { encoding: "utf8", env: { ...process.env, ERPN_CAPABILITY_CONTRACT: file } },
      );
      return `${res.stdout}${res.stderr}`;
    };
    // Absent is LEGAL for the contract (the SKILL is what refuses a missing
    // declaration) — so it must load, and the skill's own refusal is what makes
    // the pair fail-closed.
    assert.match(check((p) => { delete p.entry_type; }), /LOADED/);
    assert.match(check((p) => { p.entry_type = ""; }), /REFUSED: .*entry_type/);
    assert.match(check((p) => { p.entry_type = "   "; }), /REFUSED: .*entry_type/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P9-E skill: with `entry_type` UNDECLARED the builder refuses — the guard is not a constant", () => {
  // The half that matters for the SKILL: it must not fall back to a literal when
  // the contract stops saying which way the goods move. `?? ENTRY_TYPE` is how
  // that guard dies (it would compare the default against itself and always
  // pass), and this test is what makes the difference visible.
  const real = JSON.parse(readFileSync(path.join(HERE, "..", "capabilities.json"), "utf8"));
  delete real.capabilities["stock.adjustment"].line_policy.entry_type;
  const dir = mkdtempSync(path.join(tmpdir(), "p9e-skill-"));
  try {
    const file = path.join(dir, "capabilities.json");
    writeFileSync(file, JSON.stringify(real));
    const skill = path.join(HERE, "..", "src", "skills", "stock-adjustment-write.mjs").replace(/\\/g, "/");
    const res = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import("${skill}");\n` +
          `const skills = { findItem: async () => ({data:{data:[{name:"A",item_code:"A",item_name:"A",stock_uom:"Bao"}]}}), listUoms: async () => ({data:{data:["Bao"]}}), listUomFactors: async () => ({data:{data:[]}}), listStockRows: async () => ({data:{data:[{item_code:"A",warehouse:"W",actual_qty:9}]}}), listOpenDraftStockEntries: async () => ({data:{data:[]}}), getStockEntryDoc: async () => ({data:{data:{}}}) };\n` +
          `try { await m.buildStockAdjustmentProposal(skills, {}, { nlp: { text: "xuất hủy 1 bao A ở W", quantities: [{value:1,canonical_unit:"Bao",raw:"1 bao"}] } }); console.log("BUILT"); } catch (e) { console.log("REFUSED:" + e.code); }`,
      ],
      { encoding: "utf8", env: { ...process.env, ERPN_CAPABILITY_CONTRACT: file } },
    );
    const out = `${res.stdout}${res.stderr}`;
    assert.match(out, /REFUSED:SE_PURPOSE_UNSUPPORTED/, `the builder must refuse an undeclared purpose: ${out}`);
    assert.doesNotMatch(out, /^BUILT/m, "a proposal was built with no declared purpose");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P9-E: need_double_confirm can only be RAISED — never used to weaken CRITICAL", () => {
  const read = buildProposal({ action: "read_balance", risk: "READ", entity: { kind: "customer", id: "C1" } });
  assert.equal(read.need_double_confirm, false);
  const raised = buildProposal({
    action: "read_balance",
    risk: "READ",
    entity: { kind: "customer", id: "C1" },
    needDoubleConfirm: true,
  });
  assert.equal(raised.need_double_confirm, true, "a capability may add the second condition");
  assert.equal(raised.need_confirm, true, "…and a double confirm implies a confirm");
  // The floor: `extras` spread last, so an extra trying to UNDO the flag is
  // re-pinned from the risk level.
  const sneaky = buildProposal({
    action: "delete_document",
    risk: "CRITICAL",
    entity: { kind: "customer", id: "C1" },
    extra: { need_double_confirm: false, need_confirm: false, risk: "READ", executable: true },
  });
  assert.equal(sneaky.need_double_confirm, true, "CRITICAL keeps its two-step confirm");
  assert.equal(sneaky.need_confirm, true);
  assert.equal(sneaky.risk, "CRITICAL");
  assert.equal(sneaky.executable, false);
});

/* ---------------------------------------------------------- 2. routing ----- */

test("P9-E routing: write-off COMMANDS reach stock.adjustment; stock QUESTIONS stay stock.balance", () => {
  const COMMANDS = [
    "xuất hủy 5 bao cám heo",
    "xuất huỷ 3 bao cám gà",
    "xuất bỏ 10kg thép",
    "hàng hỏng 2 bao cám heo",
    "báo hỏng 4 bao cám gà",
    "hủy hàng hỏng 1 bao cám heo",
  ];
  for (const t of COMMANDS) {
    const hit = routeIntent(t);
    assert.equal(hit?.capability, "stock.adjustment", `${t} → ${hit?.capability}`);
    assert.equal(hit?.group, "stock_adjustment_write", t);
    assert.equal(hit?.forbidden, false, t);
  }
  // A QUESTION never opens a HIGH card.
  for (const t of [
    "hàng hỏng tháng này bao nhiêu",
    "trong kho còn bao nhiêu cám heo",
    "tồn kho cám heo còn bao nhiêu",
    "kho còn mấy bao cám gà",
    "kiểm kho cám heo 25kg",
    "xem tồn kho cám gà",
  ]) {
    const hit = routeIntent(t);
    assert.notEqual(hit?.capability, "stock.adjustment", `"${t}" must not open a card`);
  }
  assert.equal(routeIntent("tồn kho cám heo còn bao nhiêu")?.capability, "stock.balance");
  assert.equal(routeIntent("hàng hỏng tháng này bao nhiêu")?.capability, "stock.balance");
  // The DELETE group keeps its own commands: the new keywords are PHRASES
  // ("xuất hủy" / "hàng hỏng"), never a bare "hủy".
  assert.equal(routeIntent("xóa hoá đơn vừa tạo")?.capability, "document.delete");
  assert.equal(routeIntent("hủy đơn SAL-ORD-2026-00001")?.capability, "document.delete");
  assert.equal(routeIntent("xóa khoản vừa thu")?.forbidden, true);
  // Neighbouring write groups are untouched.
  assert.equal(routeIntent("giao hàng cho Lan")?.capability, "delivery.create");
  assert.equal(routeIntent("nhập hàng cho Hà Tiên")?.capability, "purchase_receipt.create");
});

/* ---------------------------------------------------------- 3. builder ----- */

test("P9-E builder: 2 slots spoken ⇒ a draft proposal that writes nothing", async () => {
  const s = skills();
  const built = await buildStockAdjustmentProposal(s, {}, {
    nlp: nlp("xuất hủy 5 bao cám heo ở Kho chính", [qty(5, "Bao", "5 bao")]),
  });
  assert.equal(built.proposal.action, "create_stock_adjustment");
  assert.equal(built.proposal.risk, "HIGH");
  assert.equal(built.proposal.need_double_confirm, true, "the two-slot condition reaches the card");
  assert.equal(built.proposal.entity.kind, "item");
  assert.equal(built.proposal.entity.id, "CAM-HEO-25KG");
  assert.equal(built.proposal.params.qty, 5);
  assert.equal(built.proposal.params.uom, "Bao");
  assert.equal(built.proposal.params.warehouse, "Kho chính");
  assert.equal(built.proposal.params.submit_now, false);
  assert.equal(built.proposal.params.available_before, 120);
  assert.equal(built.proposal.params.available_after, 115);
  assert.match(built.proposal.summary, /^Xuất hủy NHÁP/);
  // The card names the room AND the number: those are the two things the user
  // is being asked to check.
  assert.match(built.proposal.summary, /Kho chính/);
  assert.equal(s.spy.writes, 0, "building a proposal never writes");
  // NO PRICE, anywhere. The valuation is ERPNext's own ledger.
  for (const key of ["rate", "price", "amount", "amount_vnd", "valuation_rate"]) {
    assert.equal(built.proposal.params[key], undefined, `params.${key} must not exist on a write-off`);
  }
});

test("P9-E builder: the WAREHOUSE is mandatory — it is never inferred, even from live stock", async () => {
  await refusal(
    buildStockAdjustmentProposal(skills(), {}, { nlp: nlp("xuất hủy 5 bao cám heo", [qty(5, "Bao", "5 bao")]) }),
    "SE_WAREHOUSE_MISSING",
  );
  // …and the refusal names the rooms that really hold it, so the next sentence
  // can be right instead of a guess.
  try {
    await buildStockAdjustmentProposal(skills(), {}, { nlp: nlp("xuất hủy 5 bao cám heo", [qty(5, "Bao", "5 bao")]) });
  } catch (err) {
    assert.deepEqual(err.warehouses, ["Kho chính", "Kho Hàng Lỗi - MP"]);
    assert.match(err.message, /Kho chính/);
  }
});

test("P9-E builder: a warehouse the item is NOT in refuses (never a near-miss)", async () => {
  await refusal(
    buildStockAdjustmentProposal(skills(), {}, {
      nlp: nlp("xuất hủy 1 bao cám heo ở Kho VLXD", [qty(1, "Bao", "1 bao")]),
    }),
    "SE_WAREHOUSE_MISSING",
  );
});

test("P9-E builder: asking for more than the room holds REFUSES — it is never clamped", async () => {
  await refusal(
    buildStockAdjustmentProposal(skills(), {}, {
      nlp: nlp("xuất hủy 999 bao cám heo ở Kho chính", [qty(999, "Bao", "999 bao")]),
    }),
    "SE_QTY_EXCEEDS_STOCK",
  );
  // The second room is its own ceiling: 6, not 126.
  const ok = await buildStockAdjustmentProposal(skills(), {}, {
    nlp: nlp("xuất hủy 6 bao cám heo ở Kho Hàng Lỗi - MP", [qty(6, "Bao", "6 bao")]),
  });
  assert.equal(ok.proposal.params.available_before, 6);
  await refusal(
    buildStockAdjustmentProposal(skills(), {}, {
      nlp: nlp("xuất hủy 7 bao cám heo ở Kho Hàng Lỗi - MP", [qty(7, "Bao", "7 bao")]),
    }),
    "SE_QTY_EXCEEDS_STOCK",
  );
});

test("P9-E builder: an open DRAFT claims its goods (a draft does not move Bin)", async () => {
  // The lesson the delivery/receipt/invoice paths already learned, and the one
  // that matters MOST here: a draft Stock Entry leaves `Bin` untouched, so its
  // goods are still on the shelf and a second confirmation would write them off
  // twice.
  const draft = {
    name: "STE-DRAFT-1",
    docstatus: 0,
    items: [{ item_code: "CAM-HEO-25KG", qty: 20, s_warehouse: "Kho chính" }],
  };
  const built = await buildStockAdjustmentProposal(skills({ drafts: [draft] }), {}, {
    nlp: nlp("xuất hủy 100 bao cám heo ở Kho chính", [qty(100, "Bao", "100 bao")]),
  });
  assert.equal(built.proposal.params.available_before, 100, "120 − 20 đang nằm trong phiếu NHÁP");
  assert.equal(built.proposal.params.draft_covered, 20);
  assert.equal(built.proposal.params.available_after, 0);
  assert.ok(
    built.warnings.some((w) => /NHÁP/.test(w)),
    `expected a draft-cover warning, got ${built.warnings.join(" | ")}`,
  );
  // …and the ceiling follows: 101 now refuses, even though Bin still says 120.
  await refusal(
    buildStockAdjustmentProposal(skills({ drafts: [draft] }), {}, {
      nlp: nlp("xuất hủy 101 bao cám heo ở Kho chính", [qty(101, "Bao", "101 bao")]),
    }),
    "SE_QTY_EXCEEDS_STOCK",
  );
  // A draft for ANOTHER item does not touch this one.
  const other = { name: "STE-DRAFT-2", docstatus: 0, items: [{ item_code: "CAM-GA-10KG", qty: 30, s_warehouse: "Kho chính" }] };
  const clean = await buildStockAdjustmentProposal(skills({ drafts: [other] }), {}, {
    nlp: nlp("xuất hủy 5 bao cám heo ở Kho chính", [qty(5, "Bao", "5 bao")]),
  });
  assert.equal(clean.proposal.params.available_before, 120);
});

test("P9-E builder: an unreadable draft makes the cover UNKNOWABLE — refuse, do not narrow it", async () => {
  // Assuming "nothing pending" because a draft could not be read is how the same
  // goods leave the warehouse twice.
  await refusal(
    buildStockAdjustmentProposal(skills({ drafts: [{ name: "STE-DRAFT-3" }], unreadable: true }), {}, {
      nlp: nlp("xuất hủy 5 bao cám heo ở Kho chính", [qty(5, "Bao", "5 bao")]),
    }),
    "SE_DRAFT_COVER_UNKNOWN",
  );
});

test("P9-E builder: a full page of open drafts is UNKNOWABLE too (there may be more)", async () => {
  const full = Array.from({ length: 10 }, (_, i) => ({ name: `STE-D${i}`, docstatus: 0, items: [] }));
  await refusal(
    buildStockAdjustmentProposal(skills({ drafts: full }), {}, {
      nlp: nlp("xuất hủy 5 bao cám heo ở Kho chính", [qty(5, "Bao", "5 bao")]),
    }),
    "SE_DRAFT_COVER_UNKNOWN",
  );
});

test("P9-E builder: nothing left in that room refuses instead of proposing 0", async () => {
  const empty = [{ item_code: "CAM-HEO-25KG", warehouse: "Kho chính", actual_qty: 0 }];
  await refusal(
    buildStockAdjustmentProposal(skills({ bin: empty }), {}, {
      nlp: nlp("xuất hủy 1 bao cám heo ở Kho chính", [qty(1, "Bao", "1 bao")]),
    }),
    "SE_NOTHING_TO_ISSUE",
  );
});

test("P9-E builder: an item with NO Bin row at all is not 'everything available'", async () => {
  await refusal(
    buildStockAdjustmentProposal(skills({ bin: [] }), {}, {
      nlp: nlp("xuất hủy 1 bao cám heo ở Kho chính", [qty(1, "Bao", "1 bao")]),
    }),
    "SE_WAREHOUSE_NOT_FOUND",
  );
});

test("P9-E builder: TWO items in one sentence is a question, not a sum", async () => {
  await refusal(
    buildStockAdjustmentProposal(skills(), {}, {
      nlp: nlp("xuất hủy 2 bao cám heo và 3 bao cám gà ở Kho chính", [
        qty(2, "Bao", "2 bao"),
        qty(3, "Bao", "3 bao"),
      ]),
    }),
    "SE_ITEM_AMBIGUOUS",
  );
});

test("P9-E builder: an item nobody named, and a missing quantity, each refuse as themselves", async () => {
  await refusal(
    buildStockAdjustmentProposal(skills(), {}, { nlp: nlp("xuất hủy 2 bao ở Kho chính", [qty(2, "Bao", "2 bao")]) }),
    "SE_ITEM_UNRESOLVED",
  );
  await refusal(
    buildStockAdjustmentProposal(skills(), {}, { nlp: nlp("xuất hủy cám heo ở Kho chính", []) }),
    "SE_QTY_MISSING",
  );
});

test("P9-E builder: the unit must be the item's own, or a DECLARED factor — never a hidden conversion", async () => {
  // A Kg-stocked item with a Bao→Kg factor on the books: the conversion is
  // allowed because ERPNext declares it, and the factor travels ON the line.
  const built = await buildStockAdjustmentProposal(skills(), {}, {
    nlp: nlp("xuất hủy 1 bao thép d16 ở Kho chính", [qty(1, "Bao", "1 bao")]),
  });
  assert.equal(built.proposal.params.uom, "Bao");
  assert.equal(built.line.conversion_factor, 25, "the factor ERPNext declared, not an invented one");
  // The reverse has no declared factor ⇒ ASK, never invert.
  await refusal(
    buildStockAdjustmentProposal(skills(), {}, {
      nlp: nlp("xuất hủy 1 kg cám heo ở Kho chính", [qty(1, "Kg", "1 kg")]),
    }),
    "SE_UOM_UNRESOLVED",
  );
});

test("P9-E builder: the stock ceiling is compared IN STOCK UNITS — a converted ask cannot sneak past Bin", async () => {
  // THEP-D16 is stocked in Kg (500 on the shelf) and Bao→Kg=25. Asking for
  // "25 bao" = 625 Kg > 500: if the ceiling compared the RAW 25 against the
  // stock-unit 500, the write-off would pass while asking for more than exists
  // (review P9-G found exactly this hole on the CONVERT path).
  await refusal(
    buildStockAdjustmentProposal(skills(), {}, {
      nlp: nlp("xuất hủy 25 bao thép d16 ở Kho chính", [qty(25, "Bao", "25 bao")]),
    }),
    "SE_QTY_EXCEEDS_STOCK",
  );
  // And the refusal speaks in BOTH units, so the shop can see why.
  try {
    await buildStockAdjustmentProposal(skills(), {}, {
      nlp: nlp("xuất hủy 25 bao thép d16 ở Kho chính", [qty(25, "Bao", "25 bao")]),
    });
  } catch (err) {
    // Canonical unit "Bao" (capitalized by the NLP shape) + both numbers.
    assert.match(err.message, /25 Bao/);
    assert.match(err.message, /625/);
    assert.match(err.message, /500/);
  }
  // A CONVERTED ask that FITS still proposes: 19 bao = 475 Kg ≤ 500 — the line
  // and params carry the stock-unit numbers the executor re-checks.
  const built = await buildStockAdjustmentProposal(skills(), {}, {
    nlp: nlp("xuất hủy 19 bao thép d16 ở Kho chính", [qty(19, "Bao", "19 bao")]),
  });
  assert.equal(built.line.qty_in_stock_uom, 475);
  assert.equal(built.line.available_after, 25);
  assert.equal(built.proposal.params.qty_in_stock_uom, 475);
  assert.equal(built.proposal.params.conversion_factor, 25);
});

test("P9-E builder: a NON-stock draft line covers its goods in STOCK units", async () => {
  // A Bao-counted draft (cf=25) holds qty×25 Kg of the shelf, not qty — the
  // CORRECT arithmetic, corrected 2026-09-23 during the P9-E review: the earlier
  // version of this test asked for cf=25 but expected 1×25 = 500, which pinned a
  // 20× over-count of the cover. With 20 Bao drafted the shelf holds 500 Kg of
  // the item, so asking 19 bao (475 Kg) must REFUSE — and if the cover summed
  // raw qty it would only see 20 Kg and let the write through.
  const s = skills({
    drafts: [{ name: "MAT-STE-D1", items: [{ item_code: "THEP-D16", qty: 20, uom: "Bao", s_warehouse: "Kho chính", conversion_factor: 25 }] }],
  });
  await refusal(
    buildStockAdjustmentProposal(s, {}, {
      nlp: nlp("xuất hủy 19 bao thép d16 ở Kho chính", [qty(19, "Bao", "19 bao")]),
    }),
    // Fully covered ⟹ nothing left UNCLAIMED, which is a different (and more
    // accurate) refusal than "more than the shelf holds".
    "SE_NOTHING_TO_ISSUE",
  );
  try {
    await buildStockAdjustmentProposal(s, {}, {
      nlp: nlp("xuất hủy 19 bao thép d16 ở Kho chính", [qty(19, "Bao", "19 bao")]),
    });
  } catch (err) {
    assert.match(err.message, /500/, "500 on hand");
    assert.match(err.message, /đã có phiếu NHÁP chiếm 500/, "and all of it already claimed by the draft");
  }
  // Same shape but counted IN the stock unit (cf absent ⇒ 1): covers 1 only.
  const s2 = skills({
    drafts: [{ name: "MAT-STE-D2", items: [{ item_code: "THEP-D16", qty: 1, uom: "Kg", s_warehouse: "Kho chính" }] }],
  });
  const built = await buildStockAdjustmentProposal(s2, {}, {
    nlp: nlp("xuất hủy 19 bao thép d16 ở Kho chính", [qty(19, "Bao", "19 bao")]),
  });
  assert.equal(built.proposal.params.qty_in_stock_uom, 475);
});

/* ------------------------------------------------- 4. mock = RULES, not data */

test("P9-E mock: the create path enforces the rules MEASURED on the real site", async () => {
  // These assertions are about the mock being a faithful RULE model — every
  // rule here was read off the live site on 2026-09-23 (StockEntryDetail
  // DocField meta + UOM.must_be_whole_number + DocField.naming_series). No
  // fixture DATA is involved, on purpose: the site is the source of truth for
  // data (user decision 2026-09-23), and a fabricated entry would be a claim
  // nothing measured.
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();
    const base = {
      company: "Demo Feed Co",
      stock_entry_type: "Material Issue",
      naming_series: "MAT-STE-.YYYY.-",
      items: [{ item_code: "CAM-HEO-25KG", qty: 2, uom: "Bao", s_warehouse: "Kho chính", stock_uom: "Bao", conversion_factor: 1 }],
    };
    const ok = await client.callWriteTool("erpnext_doc_create", { doctype: "Stock Entry", data: base });
    assert.equal(ok.data.data.docstatus, 0, "a create is ALWAYS a draft");

    const refuses = async (patch, re, why) => {
      const data = { ...base, ...patch };
      if (patch.items) data.items = patch.items;
      await assert.rejects(
        () => client.callWriteTool("erpnext_doc_create", { doctype: "Stock Entry", data }),
        re,
        why,
      );
    };
    await refuses({ company: "" }, /company is mandatory/, "company is reqd on the real site");
    await refuses({ stock_entry_type: "Material Transfer" }, /not supported by this path/, "only Material Issue moves goods OUT");
    await refuses({ naming_series: "" }, /naming_series is mandatory/, "reqd=1 with default=null — nothing fills it in");
    await refuses({ items: [] }, /items cannot be empty/, "a child table is reqd");
    await refuses(
      { items: [{ ...base.items[0], conversion_factor: undefined }] },
      /conversion_factor is required/,
      "reqd and NOT fetch_from — the measured reason the skill sends it",
    );
    await refuses(
      { items: [{ ...base.items[0], qty: 1.5 }] },
      /whole number for UOM Bao/,
      "UOM.must_be_whole_number=1 on Bao",
    );
    await refuses(
      { items: [{ ...base.items[0], item_code: "NOPE-1" }] },
      /Could not find Item/,
      "an invented item is a link error",
    );
    await refuses(
      { items: [{ ...base.items[0], uom: "Thùng" }] },
      /Could not find UOM/,
      "an invented UOM is a link error",
    );
    await refuses(
      { items: [{ ...base.items[0], t_warehouse: "Kho chính" }] },
      /must not carry t_warehouse/,
      "a target warehouse would MOVE goods, not write them off",
    );
    await refuses(
      { items: [{ ...base.items[0], stock_uom: "Kg" }] },
      /does not match Item/,
      "the line must be counted in the item's own stock unit",
    );
  } finally {
    await client.close().catch(() => {});
  }
});

test("P9-E gate: the client refuses to SUBMIT a Stock Entry at all", async () => {
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();
    const made = await client.callWriteTool("erpnext_doc_create", {
      doctype: "Stock Entry",
      data: {
        company: "Demo Feed Co",
        stock_entry_type: "Material Issue",
        naming_series: "MAT-STE-.YYYY.-",
        items: [{ item_code: "CAM-HEO-25KG", qty: 1, uom: "Bao", s_warehouse: "Kho chính", stock_uom: "Bao", conversion_factor: 1 }],
      },
    });
    await assert.rejects(
      () => client.callWriteTool("erpnext_doc_submit", { doctype: "Stock Entry", name: made.data.data.name }),
      /WRITE_REFUSED/,
      "submit writes a Stock Ledger Entry — the contract never opts in",
    );
  } finally {
    await client.close().catch(() => {});
  }
});

/* ------------------------------------------ 4b. executor (fake MCP, no site) */

/**
 * The READS the executor makes, in one fake, with one knob per test.
 *
 * This is deliberately NOT a stock-entry fixture: what is being pinned is the
 * executor's REASONING (refuse before writing / believe the read-back), which is
 * the half a live loop proves once and a suite must keep proving. The payload's
 * shape is proven in section 5 and the real site has already accepted it.
 */
function execMcp({ correlationFieldOk = true, item = ITEMS[0], bin = BIN, drafts = [], readBack, onWrite } = {}) {
  const spy = { writes: 0 };
  return {
    spy,
    async callTool(tool, args = {}) {
      if (tool === "erpnext_doc_list" && args.doctype === "Stock Entry") {
        const wantsCorrelation = (args.filters ?? []).some(([f]) => f === "custom_ai_action_id");
        if (wantsCorrelation) {
          // The real site answers a filter on a column that does not exist with
          // an error — that is how "the Custom Field was never migrated" is
          // detected, so the fake must fail the same way.
          if (!correlationFieldOk) throw new Error("Unknown column 'custom_ai_action_id' in 'where clause'");
          return { data: { doctype: "Stock Entry", data: [] } };
        }
        return {
          data: {
            doctype: "Stock Entry",
            data: drafts.map((d) => ({ name: d.name, docstatus: 0, stock_entry_type: "Material Issue" })),
          },
        };
      }
      if (tool === "erpnext_doc_get" && args.doctype === "Stock Entry") {
        return { data: { doctype: "Stock Entry", data: readBack ?? {} } };
      }
      if (tool === "erpnext_item_list") return { data: { doctype: "Item", data: item ? [item] : [] } };
      if (tool === "erpnext_stock_balance") return { data: { doctype: "Bin", data: bin } };
      if (tool === "erpnext_doc_list" && args.doctype === "Company") {
        return { data: { doctype: "Company", data: [{ name: "Demo Feed Co" }] } };
      }
      throw new Error(`unexpected ${tool} ${JSON.stringify(args)}`);
    },
    async callWriteTool(tool, args) {
      spy.writes += 1;
      return onWrite ? onWrite(tool, args) : { data: { doctype: "Stock Entry", data: { name: "MAT-STE-X1" } } };
    },
  };
}

/** A confirmed proposal for the happy path, built by the REAL builder. */
async function confirmedProposal() {
  const built = await buildStockAdjustmentProposal(skills(), {}, {
    nlp: nlp("xuất hủy 5 bao cám heo ở Kho chính", [qty(5, "Bao", "5 bao")]),
  });
  return built.proposal;
}

const noStore = () => ({ setReference() {}, complete() {} });

test("P9-E executor: without the correlation field NOTHING is written (a Stock Entry has no other dedup)", async () => {
  const mcp = execMcp({ correlationFieldOk: false });
  await refusal(
    stock.executeStockAdjustmentProposal(mcp, await confirmedProposal(), "cmd-se-nocorr", noStore(), {
      company: "Demo Feed Co",
    }),
    "SE_CORRELATION_FIELD_MISSING",
  );
  assert.equal(mcp.spy.writes, 0, "no dedup on the site ⇒ no write at all");
});

test("P9-E executor: a price on the proposal refuses before it can reach a stock document", async () => {
  const mcp = execMcp();
  // The builder's proposal is FROZEN (asserted elsewhere), so the crafted card
  // a compromised/hostile caller could send is modelled the way it would really
  // arrive: a plain object with an extra field.
  const built = await confirmedProposal();
  const proposal = { ...built, params: { ...built.params, rate: 12345 } };
  await refusal(
    stock.executeStockAdjustmentProposal(mcp, proposal, "cmd-se-price", noStore(), { company: "Demo Feed Co" }),
    "SE_PRICE_FORBIDDEN",
  );
  assert.equal(mcp.spy.writes, 0, "a write-off has no price — refuse, never strip silently");
});

test("P9-E executor: stock that moved since the card was shown refuses BEFORE any write", async () => {
  // Same room, but the shelf now holds 3 — the card said 5. A silent smaller
  // write-off would be a decision nobody made.
  const mcp = execMcp({
    bin: BIN.map((r) => (r.warehouse === "Kho chính" && r.item_code === "CAM-HEO-25KG" ? { ...r, actual_qty: 3 } : r)),
  });
  await refusal(
    stock.executeStockAdjustmentProposal(mcp, await confirmedProposal(), "cmd-se-stale", noStore(), {
      company: "Demo Feed Co",
    }),
    "PROPOSAL_STALE",
  );
  assert.equal(mcp.spy.writes, 0, "stale ⇒ refuse, never write fewer");
});

test("P9-E executor: a site that stored something ELSE is caught by the read-back", async () => {
  // The write response is not evidence: this fake accepts the write and then
  // answers a document with the wrong qty, which must be reported as
  // unverified rather than counted as a success.
  const mcp = execMcp({
    readBack: {
      name: "MAT-STE-X1",
      docstatus: 0,
      stock_entry_type: "Material Issue",
      items: [{ item_code: "CAM-HEO-25KG", qty: 99, uom: "Bao", s_warehouse: "Kho chính" }],
    },
  });
  await refusal(
    stock.executeStockAdjustmentProposal(mcp, await confirmedProposal(), "cmd-se-badread", noStore(), {
      company: "Demo Feed Co",
    }),
    "SE_WRITE_UNVERIFIED",
  );
  assert.equal(mcp.spy.writes, 1, "the write really happened — that is WHY the read-back matters");
});

test("P9-E executor: the happy path writes a DRAFT and believes the read-back", async () => {
  // The control case: without it, every assertion above could pass because the
  // executor refuses everything.
  const proposal = await confirmedProposal();
  const mcp = execMcp({
    readBack: {
      name: "MAT-STE-X1",
      docstatus: 0,
      stock_entry_type: "Material Issue",
      custom_ai_action_id: proposal.action_id,
      items: [{ item_code: "CAM-HEO-25KG", qty: 5, uom: "Bao", s_warehouse: "Kho chính" }],
    },
  });
  const completed = [];
  const result = await stock.executeStockAdjustmentProposal(
    mcp,
    proposal,
    "cmd-se-ok",
    { setReference() {}, complete: (id, res) => completed.push([id, res]) },
    { company: "Demo Feed Co" },
  );
  assert.equal(mcp.spy.writes, 1);
  assert.equal(result.erpnext_doc, "MAT-STE-X1");
  assert.equal(result.docstatus, 0, "the document the shop gets is a NHÁP");
  assert.equal(result.warehouse, "Kho chính");
  assert.match(result.note, /CHƯA trừ kho/, "the result must not claim stock moved");
  assert.equal(completed.length, 1, "the command is completed with the verified result");
});

/* ----------------------------------------------------------- 5. regress ---- */

test("P9-E regress: the payload carries the measured Stock Entry shape, and no price", () => {
  const data = stock.buildStockEntryData({
    itemCode: "XM-PCB40",
    qty: 1,
    uom: "Bao",
    warehouse: "Kho Hàng Lỗi - MP",
    company: "Minh Phát Cám & VLXD",
    actionId: "act_x",
    correlation: "custom_ai_action_id",
    stockUom: "Bao",
    conversionFactor: null,
  });
  assert.equal(data.doctype, "Stock Entry");
  assert.equal(data.stock_entry_type, "Material Issue");
  assert.equal(data.naming_series, "MAT-STE-.YYYY.-", "measured reqd=1 on the real site");
  assert.equal(data.company, "Minh Phát Cám & VLXD");
  assert.equal(data.custom_ai_action_id, "act_x");
  assert.equal(data.items.length, 1);
  const line = data.items[0];
  assert.equal(line.item_code, "XM-PCB40");
  assert.equal(line.qty, 1);
  assert.equal(line.uom, "Bao");
  assert.equal(line.stock_uom, "Bao");
  assert.equal(line.s_warehouse, "Kho Hàng Lỗi - MP");
  assert.equal(line.conversion_factor, 1, "reqd, and 1 is what 'already in the stock unit' means");
  assert.equal("rate" in line, false, "a write-off line has no price");
  assert.equal("t_warehouse" in line, false, "Material Issue has no destination");
  // An undeclared factor defaults to 1 rather than being omitted (which the
  // site would refuse) or invented.
  assert.equal(
    stock.buildStockEntryData({ itemCode: "X", qty: 1, uom: "Bao", warehouse: "W", company: "C", actionId: null, correlation: "custom_ai_action_id" })
      .items[0].conversion_factor,
    1,
  );
  assert.throws(
    () => stock.buildStockEntryData({ itemCode: "X", qty: 1, uom: "Bao", warehouse: null, company: "C", actionId: null, correlation: "c" }),
    (e) => e.code === "SE_WAREHOUSE_MISSING",
  );
});

test("P9-E regress: the other write paths still build, and the executable set is exact", () => {
  // P9-F (2026-09-23) added `create_sales_return`, M1 (2026-09-23) added
  // `create_customer` — the write-off path itself is unchanged, which is what
  // this regression is about.
  assert.deepEqual(executableWriteActions().sort(), [
    "create_customer",
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
  // The write gate is derived from the contract: adding a capability is what
  // makes a doctype writable, and submit only when opted in.
  assert.equal(writeDoctypes()["Stock Entry"].submit, false);
  assert.equal(writeDoctypes()["Payment Entry"].submit, true, "the one submit-capable write is unchanged");
});

test("P9-E regress: READ paths that share the Bin/UOM reads are untouched", () => {
  // The write-off reads the same `erpnext_stock_balance`/`erpnext_doc_list`
  // tools the READ groups use, so the question paths must keep their answer.
  const hit = routeIntent("tồn kho cám heo còn bao nhiêu");
  assert.equal(hit?.capability, "stock.balance");
  assert.equal(hit?.group, "inventory");
  assert.equal(routeIntent("doanh thu hôm nay bán được bao nhiêu")?.capability, "sales.summary");
  assert.equal(routeIntent("công nợ của anh Nam là bao nhiêu")?.capability, "customer.balance");
});
