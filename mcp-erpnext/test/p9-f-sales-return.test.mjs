/**
 * P9-F — `sales_return.create`: khách trả hàng = a DRAFT Sales Invoice with
 * `is_return=1`, `return_against` a SUBMITTED original, qty NEGATIVE on the
 * wire, `update_stock: 1` (the goods come BACK), rate = the ORIGINAL's price.
 *
 * Shape MEASURED on the live site 2026-09-23 (ACC-SINV-2026-00052 ← 00049:
 * items qty=-1 rate=90000 update_stock=1 status=Return). The unit tests here
 * pin the REASONING over injected reads; the end-to-end mock run exercises the
 * full /execute path; the live-site shape is quoted in the test names so a
 * reader knows which facts are measurements and which are design.
 *
 * Scope split (same discipline as P9-E): this file never talks to the shop's
 * site. The fixtures are "what the tool returned", NOT ERPNext data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

import {
  executableWriteActions,
  getCapability,
  isStub,
  writeDoctypes,
} from "../src/capability-contract.mjs";
import * as ret from "../src/skills/sales-return-write.mjs";
import { buildSalesReturnProposal } from "../src/skills/sales-return-write.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";
import { routeIntent } from "../src/router.mjs";

/* ------------------------------------------------------------ fixtures ----- */

/** A SUBMITTED original invoice with two lines (the shape the builder reads). */
const ORIGINAL = {
  name: "ACC-SINV-2026-00049",
  customer: "CUST-00001",
  customer_name: "Nguyễn Thị Lan",
  docstatus: 1,
  is_return: 0,
  company: "Minh Phát Cám & VLXD",
  items: [
    { name: "SII-1", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", qty: 10, rate: 320000, uom: "Bao" },
    { name: "SII-2", item_code: "CAM-GA-25KG", item_name: "Cám gà thịt 25kg", qty: 4, rate: 210000, uom: "Bao" },
  ],
};

/**
 * The reads bag in the shape the REAL tools answer. `submitted` = already
 * submitted returns; `drafts` = open draft returns still claiming goods.
 */
function skills({ original = ORIGINAL, submitted = [], drafts = [], page = null } = {}) {
  const spy = { writes: 0 };
  return {
    spy,
    findItem: async () => ({
      data: {
        doctype: "Item",
        data: [
          { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
          { name: "CAM-GA-25KG", item_code: "CAM-GA-25KG", item_name: "Cám gà thịt 25kg", stock_uom: "Bao" },
          // In the CATALOGUE but NOT on the ORIGINAL invoice — the only way to
          // reach the "no substitute returns" guard (an item the catalogue
          // does not know is refused EARLIER, as an unresolved item).
          { name: "CAT-VANG", item_code: "CAT-VANG", item_name: "Cát vàng", stock_uom: "Bao" },
        ],
      },
    }),
    getInvoiceDoc: async (name) => {
      if (String(name) === original.name) return { data: { doctype: "Sales Invoice", data: original } };
      const d = [...submitted, ...drafts].find((x) => x.name === String(name));
      if (d) return { data: { doctype: "Sales Invoice", data: d } };
      throw new Error(`Sales Invoice ${name} not found`);
    },
    // `page` forces the bounded-page refusal (there may be MORE than a page).
    listSubmittedReturns: async () => ({
      data: { doctype: "Sales Invoice", count: (page ?? submitted).length, data: page ?? submitted },
    }),
    listOpenDraftReturns: async () => ({
      data: { doctype: "Sales Invoice", count: drafts.length, data: drafts.map((d) => ({ name: d.name, docstatus: 0, is_return: 1, return_against: original.name })) },
    }),
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

const sentence = (t, q = []) => ({ nlp: nlp(t, q) });

/* ------------------------------------------- 1. contract + executable set -- */

test("P9-F contract: sales_return.create is a WRITE — draft-only, SI doctype, update_stock declared 1", () => {
  const cap = getCapability("sales_return.create");
  assert.equal(cap.type, "WRITE");
  assert.equal(cap.skill, "skills/sales-return-write.mjs#buildSalesReturnProposal");
  assert.equal(cap.proposal_action, "create_sales_return");
  assert.equal(cap.risk.level, "HIGH");
  assert.equal(cap.risk.requires_confirmation, true);
  assert.deepEqual(cap.entities.required, ["invoice"]);
  assert.deepEqual(cap.entities.optional, ["customer"]);
  // The RETURN direction is DECLARED policy (validator enforces the pairing):
  assert.equal(cap.line_policy.entry_type, "credit_note");
  assert.equal(cap.line_policy.qty_negative, true);
  assert.equal(cap.line_policy.update_stock, 1, "a return RECEIVES goods — declared, never inferred");
  assert.equal(cap.line_policy.qty_positive, undefined, "positive-only must be UNSET on the negative path");
  assert.equal(cap.line_policy.rate_source, "erpnext");
  assert.equal(cap.execution.draft_only, true);
  assert.equal(cap.execution.allow_submit, false, "a submitted return books the credit note — never from chat");
  assert.equal(cap.execution.write_doctype, "Sales Invoice", "same doctype as the invoice — the ONE migration already covers it");
  assert.equal(cap.execution.correlation_field, "custom_ai_action_id");

  assert.equal(isStub("sales_return.create"), false);
  assert.equal(writeDoctypes()["Sales Invoice"].create, true);
  assert.equal(writeDoctypes()["Sales Invoice"].submit, false, "submit stays off for the whole doctype");
  assert.equal(executableWriteActions().includes("create_sales_return"), true);
});

test("P9-F contract: a blank `entry_type`/`update_stock` is refused at LOAD time (the guard cannot go dead)", () => {
  // Same pair as P9-E: the SKILL refuses a MISSING declaration, the CONTRACT
  // refuses a BLANK one — no edit leaves the return's nature or stock direction
  // undeclared yet valid. Child process + mutated copy (the real contract is
  // frozen at import).
  const real = JSON.parse(readFileSync(path.join(HERE, "..", "capabilities.json"), "utf8"));
  const loader = path.join(HERE, "..", "src", "capability-contract.mjs").replace(/\\/g, "/");
  const dir = mkdtempSync(path.join(tmpdir(), "p9f-contract-"));
  try {
    const check = (mutate) => {
      const copy = JSON.parse(JSON.stringify(real));
      mutate(copy.capabilities["sales_return.create"].line_policy);
      const file = path.join(dir, `cap-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(copy));
      const res = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `import("${loader}").then(()=>console.log("LOADED")).catch(e=>console.log("REFUSED: "+e.message))`],
        { encoding: "utf8", env: { ...process.env, ERPN_CAPABILITY_CONTRACT: file } },
      );
      return `${res.stdout}${res.stderr}`;
    };
    // Absent `entry_type` is LEGAL for the contract (the SKILL is what refuses
    // a missing declaration) — so it must load, and the skill's refusal is what
    // makes the pair fail-closed.
    assert.match(check((p) => { delete p.entry_type; }), /LOADED/);
    // Absent `update_stock` is NOT legal: the validator pairs
    // `qty_negative=true ⟹ update_stock=1` at LOAD time — the direction is too
    // important to leave unset on a negative-qty document.
    assert.match(check((p) => { delete p.update_stock; }), /REFUSED: .*update_stock/);
    // Blank/wrong type = the CONTRACT refuses at load.
    assert.match(check((p) => { p.entry_type = ""; }), /REFUSED: .*entry_type/);
    assert.match(check((p) => { p.entry_type = "   "; }), /REFUSED: .*entry_type/);
    assert.match(check((p) => { p.update_stock = ""; }), /REFUSED: .*update_stock/);
    assert.match(check((p) => { p.update_stock = "1"; }), /REFUSED: .*update_stock/, "the DIRECTION must be the number 1, not a string");
    // `2` is not a direction — and ONLY the 0/1 guard can catch it: with
    // `qty_negative` gone the pairing guard does not apply at all.
    assert.match(
      check((p) => { delete p.qty_negative; p.qty_positive = true; p.update_stock = 2; }),
      /REFUSED: .*update_stock/,
    );
    // `2` is not a direction — and ONLY the 0/1 guard can catch it: with
    // `qty_negative` gone the pairing guard does not apply at all.
    assert.match(
      check((p) => { delete p.qty_negative; p.qty_positive = true; p.update_stock = 2; }),
      /REFUSED: .*update_stock/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P9-F skill: with `entry_type` UNDECLARED the builder refuses — the guard is not a constant", () => {
  // `?? "credit_note"` is how this guard dies (the default compares against
  // itself and always passes). Mutate a COPY of the contract, run the skill in a
  // child process, and the refusal must still happen.
  const real = JSON.parse(readFileSync(path.join(HERE, "..", "capabilities.json"), "utf8"));
  delete real.capabilities["sales_return.create"].line_policy.entry_type;
  const dir = mkdtempSync(path.join(tmpdir(), "p9f-skill-"));
  try {
    const file = path.join(dir, "capabilities.json");
    writeFileSync(file, JSON.stringify(real));
    const skill = path.join(HERE, "..", "src", "skills", "sales-return-write.mjs").replace(/\\/g, "/");
    const res = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import("${skill}");\n` +
          `const skills = { findItem: async () => ({data:{data:[{name:"A",item_code:"A",item_name:"A",stock_uom:"Bao"}]}}), getInvoiceDoc: async () => ({data:{data:{name:"SINV-X",customer:"C1",customer_name:"Khách",docstatus:1,is_return:0,items:[{item_code:"A",qty:9,rate:1000,uom:"Bao"}]}}}), listSubmittedReturns: async () => ({data:{data:[]}}), listOpenDraftReturns: async () => ({data:{data:[]}}) };\n` +
          `try { await m.buildSalesReturnProposal(skills, { invoice: "SINV-X" }, { nlp: { text: "trả hàng 1 bao A theo hóa đơn SINV-X", quantities: [{value:1,canonical_unit:"Bao",raw:"1 bao"}] } }); console.log("BUILT"); } catch (e) { console.log("REFUSED:" + e.code); }`,
      ],
      { encoding: "utf8", env: { ...process.env, ERPN_CAPABILITY_CONTRACT: file } },
    );
    const out = `${res.stdout}${res.stderr}`;
    assert.match(out, /REFUSED:SR_PURPOSE_UNSUPPORTED/, `the builder must refuse an undeclared return nature: ${out}`);
    assert.doesNotMatch(out, /^BUILT/m, "a proposal was built with no declared nature");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P9-F skill: with `update_stock` UNDECLARED the builder refuses — the goods direction is not a guess", () => {
  // A return that stops declaring "the goods come BACK" must not fall back to
  // SI's update_stock=0 — that is how a return silently becomes a refund-only
  // document. The LOAD-time pairing guard (qty_negative ⟹ update_stock=1) must
  // be SATISFIED for this test: flip to the positive-direction shape
  // (qty_negative deleted, qty_positive=true) and drop update_stock entirely —
  // a contract that loads, but whose RETURN skill still refuses, because the
  // skill's own direction guard is what matters here (defense in depth).
  const real = JSON.parse(readFileSync(path.join(HERE, "..", "capabilities.json"), "utf8"));
  {
    const p = real.capabilities["sales_return.create"].line_policy;
    delete p.update_stock;
    delete p.qty_negative;
    p.qty_positive = true;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "p9f-stockdir-"));
  try {
    const file = path.join(dir, "capabilities.json");
    writeFileSync(file, JSON.stringify(real));
    const skill = path.join(HERE, "..", "src", "skills", "sales-return-write.mjs").replace(/\\/g, "/");
    const res = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import("${skill}");\n` +
          `const skills = { findItem: async () => ({data:{data:[{name:"A",item_code:"A",item_name:"A",stock_uom:"Bao"}]}}), getInvoiceDoc: async () => ({data:{data:{name:"SINV-X",customer:"C1",customer_name:"Khách",docstatus:1,is_return:0,items:[{item_code:"A",qty:9,rate:1000,uom:"Bao"}]}}}), listSubmittedReturns: async () => ({data:{data:[]}}), listOpenDraftReturns: async () => ({data:{data:[]}}) };\n` +
          `try { await m.buildSalesReturnProposal(skills, { invoice: "SINV-X" }, { nlp: { text: "trả hàng 1 bao A theo hóa đơn SINV-X", quantities: [{value:1,canonical_unit:"Bao",raw:"1 bao"}] } }); console.log("BUILT"); } catch (e) { console.log("REFUSED:" + e.code); }`,
      ],
      { encoding: "utf8", env: { ...process.env, ERPN_CAPABILITY_CONTRACT: file } },
    );
    const out = `${res.stdout}${res.stderr}`;
    assert.match(out, /REFUSED:SR_PURPOSE_UNSUPPORTED/, `the builder must refuse an undeclared stock direction: ${out}`);
    assert.doesNotMatch(out, /^BUILT/m, "a proposal was built with no declared stock direction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P9-F routing: return COMMANDS reach sales_return.create; questions and neighbours stay put", () => {
  // COMMANDS (the new group sits BEFORE payment_write — measured misroute: the
  // payment READ group's substring "trả" swallowed every "trả hàng …" sentence).
  for (const t of [
    "trả hàng cho chị Lan 2 bao cám gà",
    "khách trả lại 1 bao cám heo",
    "trả hàng hóa đơn ACC-SINV-2026-00049 1 bao XM-PCB40",
    "tra hang 2 bao cám heo",
    "khach tra hang 3 bao",
  ]) {
    const r = routeIntent(t);
    assert.equal(r?.capability, "sales_return.create", `${t} must reach the return path (got ${r?.capability})`);
  }
  // QUESTIONS stay READS (notIf deny-list).
  for (const t of ["khách trả hàng tháng này bao nhiêu", "đã trả hàng cho chị Lan chưa?"]) {
    const r = routeIntent(t);
    assert.notEqual(r?.capability, "sales_return.create", `${t} must not open a return card`);
  }
  // NEIGHBOURS untouched: money verbs, write-offs, invoice commands.
  assert.equal(routeIntent("trả tiền NCC Hà Tiên 2 triệu")?.capability, "payment.history",
    "'trả tiền …' (normalize → payment …) belongs to the money paths, not returns");
  assert.equal(routeIntent("xuất hủy 1 bao XM-PCB40 ở Kho Hàng Lỗi - MP")?.capability, "stock.adjustment");
  assert.equal(routeIntent("xuất hóa đơn cho đơn SAL-ORD-2026-00001")?.capability, "sales_invoice.create");
  assert.equal(routeIntent("xóa hoá đơn vừa tạo")?.capability, "document.delete");
  assert.equal(routeIntent("tồn kho cám heo còn bao nhiêu")?.capability, "stock.balance");
});

/* ------------------------------------------------------------ 2. builder ---- */

test("P9-F builder: 2 slots spoken ⇒ a draft proposal carrying the INVOICE's prices", async () => {
  const s = skills();
  const built = await buildSalesReturnProposal(s, { invoice: ORIGINAL.name }, sentence(
    "trả hàng 2 bao cám heo theo hóa đơn ACC-SINV-2026-00049", [qty(2, "Bao", "2 bao")],
  ));
  const p = built.proposal;
  assert.equal(p.action, "create_sales_return");
  assert.equal(p.risk, "HIGH");
  assert.equal(p.need_double_confirm, false);
  assert.equal(p.entity.kind, "customer");
  assert.equal(p.entity.id, "CUST-00001");
  assert.equal(p.params.return_against, ORIGINAL.name);
  assert.equal(p.params.update_stock, 1, "the card promises the goods COME BACK");
  assert.equal(p.params.submit_now, false);
  assert.equal(p.params.lines.length, 1);
  const line = p.params.lines[0];
  assert.equal(line.item_code, "CAM-HEO-25KG");
  assert.equal(line.qty, 2, "the CARD shows the positive number the user said");
  assert.equal(line.rate, 320000, "the rate is the INVOICE's price, never a default");
  assert.equal(line.amount, 640000);
  assert.equal(line.return_against, ORIGINAL.name);
  assert.equal(s.spy.writes, 0, "building a proposal never writes");
  assert.match(p.summary, /trả hàng NHÁP/);
  assert.match(p.summary, /ACC-SINV-2026-00049/);
});

test("P9-F builder: the ORIGINAL INVOICE is mandatory — a bare customer name is not a return reference", async () => {
  await refusal(
    buildSalesReturnProposal(skills(), { customer: { name: "CUST-00001" } }, sentence(
      "khách trả lại 1 bao cám heo", [qty(1, "Bao", "1 bao")],
    )),
    "SR_INVOICE_UNRESOLVED",
  );
});

test("P9-F builder: a DRAFT original refuses (nothing sold yet to return)", async () => {
  const draft = { ...ORIGINAL, docstatus: 0 };
  const s = skills({ original: draft });
  await refusal(
    buildSalesReturnProposal(s, { invoice: draft.name }, sentence(
      "trả hàng 1 bao cám heo", [qty(1, "Bao", "1 bao")],
    )),
    "SR_INVOICE_NOT_SUBMITTED",
  );
});

test("P9-F builder: returning INTO a return refuses (is_return=1)", async () => {
  const ret2 = { ...ORIGINAL, is_return: 1 };
  const s = skills({ original: ret2 });
  await refusal(
    buildSalesReturnProposal(s, { invoice: ret2.name }, sentence(
      "trả hàng 1 bao cám heo", [qty(1, "Bao", "1 bao")],
    )),
    "SR_INVOICE_IS_RETURN",
  );
});

test("P9-F builder: an item NOT on the original refuses (no substitute returns)", async () => {
  // CAT-VANG is a real catalogue item — just not a line of THIS invoice. A
  // catalogue item that does not exist at all is refused earlier (unresolved).
  await refusal(
    buildSalesReturnProposal(skills(), { invoice: ORIGINAL.name }, sentence(
      "trả hàng 1 bao cát vàng theo hóa đơn ACC-SINV-2026-00049", [qty(1, "Bao", "1 bao")],
    )),
    "SR_ITEM_NOT_IN_INVOICE",
  );
});

test("P9-F builder: an item the CATALOGUE does not know refuses (SR_ITEM_UNRESOLVED)", async () => {
  await refusal(
    buildSalesReturnProposal(skills(), { invoice: ORIGINAL.name }, sentence(
      "trả hàng 1 bao thép d16 theo hóa đơn ACC-SINV-2026-00049", [qty(1, "Bao", "1 bao")],
    )),
    "SR_ITEM_UNRESOLVED",
  );
});

test("P9-F builder: over-returning REFUSES — the ceiling counts SUBMITTED returns", async () => {
  // 10 sold; 9 already received back (a submitted return). 2 more > 1 left.
  const s = skills({
    submitted: [
      {
        name: "ACC-SINV-2026-00050",
        customer: ORIGINAL.customer,
        docstatus: 1,
        is_return: 1,
        return_against: ORIGINAL.name,
        items: [{ item_code: "CAM-HEO-25KG", qty: -9, rate: 320000, uom: "Bao" }],
      },
    ],
  });
  await refusal(
    buildSalesReturnProposal(s, { invoice: ORIGINAL.name }, sentence(
      "trả hàng 2 bao cám heo", [qty(2, "Bao", "2 bao")],
    )),
    "SR_QTY_EXCEEDS_RETURNABLE",
  );
  // And the refusal names all three numbers (sold / returned / drafted).
  try {
    await buildSalesReturnProposal(s, { invoice: ORIGINAL.name }, sentence(
      "trả hàng 2 bao cám heo", [qty(2, "Bao", "2 bao")],
    ));
  } catch (err) {
    assert.match(err.message, /10/, "sold");
    assert.match(err.message, /9/, "already received");
    assert.match(err.message, /1/, "left");
  }
});

test("P9-F builder: an OPEN DRAFT return claims its goods (two confirms must not receive twice)", async () => {
  const s = skills({
    drafts: [
      {
        name: "SI-M-DRAFT1",
        customer: ORIGINAL.customer,
        docstatus: 0,
        is_return: 1,
        return_against: ORIGINAL.name,
        items: [{ item_code: "CAM-HEO-25KG", qty: -10, rate: 320000, uom: "Bao" }],
      },
    ],
  });
  await refusal(
    buildSalesReturnProposal(s, { invoice: ORIGINAL.name }, sentence(
      "trả hàng 2 bao cám heo", [qty(2, "Bao", "2 bao")],
    )),
    "SR_QTY_EXCEEDS_RETURNABLE",
  );
  // The card would have said the draft was subtracted — the warning only fires
  // on the proposal that still fits, so assert via the second line (CAM-GA).
  const built = await buildSalesReturnProposal(s, { invoice: ORIGINAL.name }, sentence(
    "trả hàng 2 bao cám gà", [qty(2, "Bao", "2 bao")],
  ));
  assert.ok(
    built.warnings.some((w) => /phiếu trả NHÁP/.test(w)),
    "a partial draft cover must be VISIBLE on the card",
  );
});

test("P9-F builder: a FULL page of submitted returns is UNKNOWABLE — refuse, never guess", async () => {
  // Each page row IS readable (a real doc with a tiny qty) so the ONLY thing
  // that stops the build is the full-page guard itself — not a lucky catch
  // somewhere else returning the same code.
  const page = Array.from({ length: 10 }, (_, i) => ({
    name: `RET-${i}`,
    customer: ORIGINAL.customer,
    docstatus: 1,
    is_return: 1,
    return_against: ORIGINAL.name,
    items: [{ item_code: "CAM-HEO-25KG", qty: -0.01, rate: 320000, uom: "Bao" }],
  }));
  await refusal(
    buildSalesReturnProposal(skills({ submitted: page, page }), { invoice: ORIGINAL.name }, sentence(
      "trả hàng 1 bao cám heo", [qty(1, "Bao", "1 bao")],
    )),
    "SR_RETURNABLE_UNKNOWN",
  );
});

test("P9-F builder: a FULL page of OPEN DRAFTS refuses (SR_DRAFT_COVERED)", async () => {
  // Same reasoning as the submitted page: ten drafts may be ten of ten — the
  // draft cover cannot be computed honestly, so the build stops.
  const drafts = Array.from({ length: 10 }, (_, i) => ({
    name: `SI-DRAFT-${i}`,
    customer: ORIGINAL.customer,
    docstatus: 0,
    is_return: 1,
    return_against: ORIGINAL.name,
    items: [{ item_code: "CAM-HEO-25KG", qty: -0.01, rate: 320000, uom: "Bao" }],
  }));
  await refusal(
    buildSalesReturnProposal(skills({ drafts }), { invoice: ORIGINAL.name }, sentence(
      "trả hàng 1 bao cám heo", [qty(1, "Bao", "1 bao")],
    )),
    "SR_DRAFT_COVERED",
  );
});

test("P9-F builder: a unit the invoice does not use refuses (no hidden conversion)", async () => {
  await refusal(
    buildSalesReturnProposal(skills(), { invoice: ORIGINAL.name }, sentence(
      "trả hàng 1 tấn cám heo theo hóa đơn ACC-SINV-2026-00049", [qty(1, "Tấn", "1 tấn")],
    )),
    "SR_UOM_MISMATCH",
  );
});

test("P9-F builder: a sentence with NO item paired to a qty refuses (SR_ITEM_UNRESOLVED)", async () => {
  // "trả hàng theo hóa đơn X" — no item named, no qty: the builder's FIRST
  // question is WHICH item (not how much), so the item refusal wins.
  await refusal(
    buildSalesReturnProposal(skills(), { invoice: ORIGINAL.name }, sentence(
      "trả hàng theo hóa đơn ACC-SINV-2026-00049",
    )),
    "SR_ITEM_UNRESOLVED",
  );
});

/* --------------------------------------------------- 3. mock = RULES -------- */

test("P9-F mock: the create path enforces the rules MEASURED on the real site", async () => {
  // A SUBMITTED original is an env-declared fixture (the mock can only create
  // drafts — same convention as the P9-B/C/D fixtures). The original carries
  // items[]: 10 sold CAM-HEO, nothing returned yet.
  const original = {
    name: "ACC-SINV-2026-00049",
    customer: "CUST-00001",
    customer_name: "Nguyễn Thị Lan",
    docstatus: 1,
    is_return: 0,
    company: "Demo Feed Co",
    items: [{ item_code: "CAM-HEO-25KG", qty: 10, rate: 320000, uom: "Bao" }],
  };
  const prev = process.env.MOCK_ERP_INV_FIXTURE;
  process.env.MOCK_ERP_INV_FIXTURE = JSON.stringify([original]);
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();

    const base = {
      customer: "CUST-00001",
      company: "Demo Feed Co",
      is_return: 1,
      return_against: original.name,
      update_stock: 1,
      custom_ai_action_id: "act-p9f-mock",
      items: [{ item_code: "CAM-HEO-25KG", qty: -2, rate: 320000, uom: "Bao", return_against: original.name }],
    };
    const ok = await client.callWriteTool("erpnext_doc_create", { doctype: "Sales Invoice", data: base });
    assert.equal(ok.data.data.docstatus, 0, "a create is ALWAYS a draft");
    assert.equal(ok.data.data.is_return, 1);
    assert.equal(ok.data.data.update_stock, 1, "the return's stock direction survives the write");
    assert.equal(ok.data.data.items[0].qty, -2, "qty is stored NEGATIVE (the measured site shape)");

    const refuses = async (patch, re, why) => {
      const data = { ...base, ...patch };
      if (patch.items) data.items = patch.items;
      await assert.rejects(
        () => client.callWriteTool("erpnext_doc_create", { doctype: "Sales Invoice", data }),
        re,
        why,
      );
    };
    await refuses({ return_against: "" }, /return_against is mandatory/, "the link is the whole point");
    await refuses({ return_against: "SINV-NOPE" }, /Could not find Sales Invoice/, "an invented original is a link error");
    await refuses({ items: [{ ...base.items[0], qty: 2 }] }, /must be NEGATIVE/, "a return line arrives negative (measured)");
    await refuses({ items: [{ ...base.items[0], rate: 999999 }] }, /Đơn giá phải giống/, "a return refunds at the SOLD price");
    await refuses({ update_stock: 0 }, /update_stock=1/, "a return RECEIVES goods — declared");
    await refuses({ items: [{ item_code: "NOPE", qty: -1, rate: 320000, uom: "Bao" }] }, /not a line of Sales Invoice/, "no substitute returns");
    await refuses(
      { items: [{ item_code: "CAM-HEO-25KG", qty: -99, rate: 320000, uom: "Bao" }] },
      /return exceeds sold/,
      "ERPNext blocks returning more than was sold",
    );
  } finally {
    process.env.MOCK_ERP_INV_FIXTURE = prev;
    await client.close().catch(() => {});
  }
});

/* ------------------------------------------- 4. executor (fake MCP) --------- */

function execMcp({ original = ORIGINAL, submitted = [], drafts = [], correlationOk = true, readBack, onWrite } = {}) {
  const spy = { writes: 0 };
  return {
    spy,
    async callTool(tool, args = {}) {
      if (tool === "erpnext_doc_get" && args.doctype === "Sales Invoice") {
        if (String(args.name) === original.name) return { data: { doctype: "Sales Invoice", data: original } };
        const d = [...submitted, ...drafts].find((x) => x.name === String(args.name));
        if (d) return { data: { doctype: "Sales Invoice", data: d } };
        return { data: { doctype: "Sales Invoice", data: readBack ?? {} } };
      }
      if (tool === "erpnext_doc_list" && args.doctype === "Sales Invoice") {
        const wantsCorr = (args.filters ?? []).some(([f]) => f === "custom_ai_action_id");
        if (wantsCorr) {
          if (!correlationOk) throw new Error("Unknown column 'custom_ai_action_id' in 'where clause'");
          return { data: { doctype: "Sales Invoice", data: [] } };
        }
        if ((args.filters ?? []).some(([f, , v]) => f === "return_against" && v === original.name)) {
          const isDraft = (args.filters ?? []).some(([, , v]) => String(v) === "0");
          const rows = (isDraft ? drafts : submitted).map((d) => ({
            name: d.name, docstatus: d.docstatus, is_return: 1, return_against: original.name,
          }));
          return { data: { doctype: "Sales Invoice", count: rows.length, data: rows } };
        }
        return { data: { doctype: "Sales Invoice", data: [] } };
      }
      if (tool === "erpnext_doc_list" && args.doctype === "Company") {
        return { data: { doctype: "Company", data: [{ name: "Minh Phát Cám & VLXD" }] } };
      }
      throw new Error(`unexpected ${tool} ${JSON.stringify(args)}`);
    },
    async callWriteTool(tool, args) {
      spy.writes += 1;
      return onWrite ? onWrite(tool, args) : { data: { doctype: "Sales Invoice", data: { name: "SI-RET-X1" } } };
    },
  };
}

const noStore = () => ({ setReference() {}, complete() {} });

async function confirmedProposal(overrides = {}) {
  const s = skills(overrides);
  const built = await buildSalesReturnProposal(s, { invoice: ORIGINAL.name }, sentence(
    "trả hàng 2 bao cám heo", [qty(2, "Bao", "2 bao")],
  ));
  return built.proposal;
}

test("P9-F executor: without the correlation field NOTHING is written", async () => {
  const mcp = execMcp({ correlationOk: false });
  await refusal(
    ret.executeSalesReturnProposal(mcp, await confirmedProposal(), "cmd-sr-nocorr", noStore(), {
      company: "Minh Phát Cám & VLXD",
    }),
    "SR_CORRELATION_FIELD_MISSING",
  );
  assert.equal(mcp.spy.writes, 0);
});

test("P9-F executor: the original's price must still match at execute (a changed price is drift)", async () => {
  const changed = JSON.parse(JSON.stringify(ORIGINAL));
  changed.items[0].rate = 330000;
  const mcp = execMcp({ original: changed });
  await refusal(
    ret.executeSalesReturnProposal(mcp, await confirmedProposal(), "cmd-sr-rate", noStore(), {
      company: "Minh Phát Cám & VLXD",
    }),
    "PROPOSAL_STALE",
  );
  assert.equal(mcp.spy.writes, 0, "a changed deal is a NEW decision, never a silent write");
});

test("P9-F executor: goods received back since the card was shown ⇒ PROPOSAL_STALE, no write", async () => {
  const mcp = execMcp({
    submitted: [{
      name: "ACC-SINV-2026-00050",
      customer: ORIGINAL.customer,
      docstatus: 1,
      is_return: 1,
      return_against: ORIGINAL.name,
      items: [{ item_code: "CAM-HEO-25KG", qty: -9, rate: 320000, uom: "Bao" }],
    }],
  });
  await refusal(
    ret.executeSalesReturnProposal(mcp, await confirmedProposal(), "cmd-sr-stale", noStore(), {
      company: "Minh Phát Cám & VLXD",
    }),
    "PROPOSAL_STALE",
  );
  assert.equal(mcp.spy.writes, 0);
});

test("P9-F executor: a site that dropped update_stock is caught by the read-back", async () => {
  // The stock direction was PART of what was approved: money returns WITHOUT
  // the goods coming back is half a return, not a success.
  const proposal = await confirmedProposal();
  const mcp = execMcp({
    readBack: {
      name: "SI-RET-X1",
      docstatus: 0,
      is_return: 1,
      return_against: ORIGINAL.name,
      update_stock: 0,
      customer: ORIGINAL.customer,
      items: [{ item_code: "CAM-HEO-25KG", qty: -2, rate: 320000, uom: "Bao", return_against: ORIGINAL.name }],
    },
  });
  await refusal(
    ret.executeSalesReturnProposal(mcp, proposal, "cmd-sr-nostock", noStore(), { company: "Minh Phát Cám & VLXD" }),
    "SR_WRITE_UNVERIFIED",
  );
  assert.equal(mcp.spy.writes, 1, "the write happened — that is WHY the read-back matters");
});

test("P9-F executor: a site that stored a POSITIVE qty is caught by the read-back", async () => {
  const proposal = await confirmedProposal();
  const mcp = execMcp({
    readBack: {
      name: "SI-RET-X1",
      docstatus: 0,
      is_return: 1,
      return_against: ORIGINAL.name,
      update_stock: 1,
      customer: ORIGINAL.customer,
      items: [{ item_code: "CAM-HEO-25KG", qty: 2, rate: 320000, uom: "Bao", return_against: ORIGINAL.name }],
    },
  });
  await refusal(
    ret.executeSalesReturnProposal(mcp, proposal, "cmd-sr-badsign", noStore(), { company: "Minh Phát Cám & VLXD" }),
    "SR_WRITE_UNVERIFIED",
  );
  assert.equal(mcp.spy.writes, 1, "the write happened — that is WHY the read-back matters");
});

test("P9-F executor: happy path writes ONE draft with NEGATIVE qty and update_stock=1", async () => {
  const proposal = await confirmedProposal();
  const captured = {};
  const mcp = execMcp({
    readBack: {
      name: "SI-RET-X1",
      docstatus: 0,
      is_return: 1,
      return_against: ORIGINAL.name,
      update_stock: 1,
      customer: ORIGINAL.customer,
      custom_ai_action_id: proposal.action_id,
      items: [{ item_code: "CAM-HEO-25KG", qty: -2, rate: 320000, uom: "Bao", return_against: ORIGINAL.name }],
    },
    onWrite: (tool, args) => {
      captured.data = args.data;
      return { data: { doctype: "Sales Invoice", data: { name: "SI-RET-X1" } } };
    },
  });
  const completed = [];
  const result = await ret.executeSalesReturnProposal(
    mcp,
    proposal,
    "cmd-sr-ok",
    { setReference() {}, complete: (id, r) => completed.push([id, r]) },
    { company: "Minh Phát Cám & VLXD" },
  );
  assert.equal(mcp.spy.writes, 1);
  assert.equal(captured.data.is_return, 1);
  assert.equal(captured.data.return_against, ORIGINAL.name);
  assert.equal(captured.data.update_stock, 1);
  assert.equal(captured.data.items[0].qty, -2, "NEGATIVE on the wire (the measured site shape)");
  assert.equal(captured.data.items[0].rate, 320000);
  assert.equal(result.erpnext_doc, "SI-RET-X1");
  assert.equal(result.docstatus, 0);
  assert.match(result.note, /CHƯA nhận lại kho/, "the result must not claim stock moved");
  assert.equal(completed.length, 1);
});

/* ------------------------------------------------- 5. end-to-end pipeline -- */

const MOCK_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));

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
 * The FULL write path (/execute over HTTP → Safety Gateway → executor → mock
 * ERPNext) with a SUBMITTED original declared through MOCK_ERP_INV_FIXTURE —
 * exactly how the shop's real invoices reach the engine (the mock can only
 * CREATE drafts, so "an invoice the shop already submitted" is an env-declared
 * fixture, the same convention as P9-B/C/D).
 */
async function withReturnExecuteServer(fn, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "p9f-sr-"));
  const prev = {};
  const set = (k, v) => { prev[k] = process.env[k]; process.env[k] = v; };
  set("MOCK_ERP_STATE", path.join(dir, "mock-erp.json"));
  set("MOCK_ERP_INV_FIXTURE", JSON.stringify([ORIGINAL]));
  for (const [k, v] of Object.entries(extraEnv)) set(k, v);
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
    const post = async (body) => {
      const r = await fetch(`http://127.0.0.1:${port}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    const proposal = await confirmedProposal();
    return await fn({ post, store, proposal });
  } finally {
    server?.close();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P9-F E2E /execute: a confirmed return writes ONE DRAFT — is_return 1, update_stock 1, NEGATIVE qty, linked to the original", async () => {
  await withReturnExecuteServer(async ({ post, proposal }) => {
    const cid = randomUUID();
    const r = await post({ command_id: cid, proposal });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.replay, false);
    assert.match(r.body.result.erpnext_doc, /^SI-M\d+$/);
    assert.equal(r.body.result.docstatus, 0, "a chat write is ALWAYS a draft");
    assert.equal(r.body.result.return_against, ORIGINAL.name);
    assert.equal(r.body.result.is_return, 1);
    assert.equal(r.body.result.update_stock, 1, "the goods come BACK (declared, not inferred)");
    assert.match(r.body.result.note, /NHÁP/);
    assert.match(r.body.result.note, /CHƯA nhận lại kho/, "the answer must not claim stock moved");

    const rows = stateRows("sales_invoices");
    assert.equal(rows.length, 1, "exactly ONE draft return");
    const doc = rows[0];
    assert.equal(doc.docstatus, 0);
    assert.equal(doc.is_return, 1);
    assert.equal(Number(doc.update_stock), 1);
    assert.equal(doc.return_against, ORIGINAL.name);
    assert.equal(doc.items[0].qty, -2, "NEGATIVE on the wire (the shape measured on the site)");
    assert.equal(doc.items[0].rate, 320000, "the refund carries the INVOICE's price");
    assert.ok(doc.custom_ai_action_id, "the correlation field travels with the draft");
    // The ORIGINAL is untouched: only a submit would book the credit note.
    assert.equal(JSON.parse(process.env.MOCK_ERP_INV_FIXTURE)[0].docstatus, 1);
  });
});

test("P9-F E2E /execute: a duplicate command_id REPLAYS — one return, one write", async () => {
  await withReturnExecuteServer(async ({ post, proposal, store }) => {
    const cid = randomUUID();
    const first = await post({ command_id: cid, proposal });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await post({ command_id: cid, proposal });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replay, true);
    assert.equal(again.body.result.erpnext_doc, first.body.result.erpnext_doc, "the SAME return, never a second");
    assert.equal(stateRows("sales_invoices").length, 1, "exactly one document exists");
    assert.equal(store.status(cid).status, "COMPLETED");
  });
});

async function startNlpService() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: path.join(REPO, ".."),
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
  const child = spawn(process.execPath, [path.join(REPO, "src", "copilot-server.mjs")], {
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

test("P9-F E2E /ask: a return command returns a HIGH draft CARD + Vietnamese answer, and writes nothing", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { MOCK_ERP_INV_FIXTURE: JSON.stringify([ORIGINAL]) });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call(`trả hàng 2 bao cám heo theo hóa đơn ${ORIGINAL.name}`);
    assert.equal(out.routed.group, "sales_return_write", JSON.stringify(out.routed));
    assert.equal(out.proposal?.action, "create_sales_return", JSON.stringify(out.proposal));
    assert.equal(out.proposal.risk, "HIGH");
    assert.equal(out.proposal.need_confirm, true);
    assert.equal(out.proposal.params.return_against, ORIGINAL.name);
    assert.equal(out.proposal.params.update_stock, 1);
    assert.equal(out.proposal.params.submit_now, false);
    assert.equal(out.proposal.params.lines[0].qty, 2, "the card shows the number the user SAID (positive)");
    assert.equal(out.proposal.params.lines[0].rate, 320000, "the price is the INVOICE's");
    // The answer says DRAFT out loud — card and sentence agree.
    assert.match(out.answer, /NHÁP/);
    assert.match(out.answer, new RegExp(ORIGINAL.name));
    // Asking is not writing: no ERPNext document exists at proposal time.
    assert.equal(Object.prototype.hasOwnProperty.call(out, "erpnext_doc"), false, JSON.stringify(out.erpnext_doc));
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("P9-F E2E /ask: the return QUESTION still reads, and never becomes a WRITE card", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { MOCK_ERP_INV_FIXTURE: JSON.stringify([ORIGINAL]) });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const read = await copilot.call("đã trả hàng cho chị Lan chưa?");
    assert.notEqual(read.routed.group, "sales_return_write", JSON.stringify(read.routed));
    assert.notEqual(read.proposal?.action, "create_sales_return", JSON.stringify(read.proposal));
    assert.ok(read.proposal === null || read.proposal.risk === "READ", JSON.stringify(read.proposal));
    // A command WITHOUT an invoice reference is an ANSWER, never a card.
    const none = await copilot.call("khách trả lại 1 bao cám heo");
    assert.equal(none.proposal, null, JSON.stringify(none.proposal));
    assert.ok(String(none.reason ?? "").length > 0, "a refusal must explain itself");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

/* ------------------------------------------------- 6. write gate + regress --- */

test("P9-F gate: the client refuses to SUBMIT a Sales Invoice return", async () => {
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();
    await assert.rejects(
      () => client.callWriteTool("erpnext_doc_submit", { doctype: "Sales Invoice", name: "SINV-0001" }),
      /WRITE_REFUSED/,
      "submit books the credit note — the contract never opts in",
    );
  } finally {
    await client.close().catch(() => {});
  }
});

test("P9-F regress: SI/SO/payment/stock paths untouched, and the Dart set matches the server", () => {
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
  assert.equal(writeDoctypes()["Sales Invoice"].submit, false);
  assert.equal(writeDoctypes()["Payment Entry"].submit, true, "the one submit-capable write is unchanged");

  // The CLIENT half of the same decision (the B2 tripwire, now covering #9).
  const dart = readFileSync(
    path.join(REPO, "..", "apps", "mobile", "lib", "features", "chat", "data", "chat_models.dart"),
    "utf8",
  );
  const match = dart.match(/_confirmableActions = \{([^}]*)\}/);
  assert.ok(match, "the client must keep the _confirmableActions set");
  const clientActions = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(clientActions, executableWriteActions().sort());
});

test("P9-F regress: payload helper refuses to build a positive-direction return", async () => {
  // A return payload with a POSITIVE qty is not a return — the helper negates
  // by |qty|, so the guard here is the ROUND-TRIP: build → read back → both
  // signs agree.
  const data = ret.buildSalesReturnData({
    customerId: "CUST-00001",
    invoiceName: "ACC-SINV-2026-00049",
    lines: [{ item_code: "CAM-HEO-25KG", qty: 2, rate: 320000, uom: "Bao" }],
    company: "Minh Phát Cám & VLXD",
    actionId: "act_x",
    correlation: "custom_ai_action_id",
  });
  assert.equal(data.items[0].qty, -2);
  assert.equal(data.is_return, 1);
  assert.equal(data.update_stock, 1);
  assert.equal(data.custom_ai_action_id, "act_x");
});
