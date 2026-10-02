/**
 * B1 — Item / Supplier / UOM resolvers (plan3 Trụ B, phase `B1-item-supplier-uom`).
 *
 * Four groups, all falsifiable:
 *
 *  1. UOM extraction — the trap is "bao" inside "bao nhiêu": a stock question
 *     must not turn into a unit question.
 *  2. UOM resolution — "không quy đổi ẩn": the unit NAME and the FACTOR both come
 *     from ERPNext, only a DIRECT factor is applied, and everything else ASKS.
 *     The fixtures mirror the LIVE site (verified read-only 2026-09-20): it has
 *     Bao/Tấn/Kg/Xe/Thung/Viên/Mét/m3, factors Tấn→Kg=1000 and Bao→Kg=25, and
 *     NO Kg→Bao / Tấn→Bao, and NO Cây/Tạ/Bó.
 *  3. Entity resolution states (item 4 states "như P1 customer") + the supplier
 *     resolver, including the longest-name-wins and picker rules.
 *  4. The read-only boundary: the supplier READ tool is whitelisted, supplier
 *     WRITE tools are still refused.
 *
 * The E2E group (5) runs the real Python NLP + the real copilot process against
 * the mock ERPNext, so the states are exercised through `/ask`, not just as
 * functions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  candidatesForUnit,
  extractUom,
  findDirectFactor,
  matchUomCandidates,
  normalizeUomToken,
  resolveLineUom,
  unitFormFromNlp,
  UOM_ACTIONS,
  UOM_CODES,
} from "../src/uom.mjs";
import {
  ENTITY_ACCESSORS,
  ENTITY_STATES,
  classifyEntityResolution,
  entityPolicy,
  pickerForRowsByText,
  resolveEntityByText,
} from "../src/entity-resolution.mjs";
import { getCapability, __contract, validateContract } from "../src/capability-contract.mjs";
import { assertReadOnly, auditAgainstAdvertisedTools } from "../src/readonly-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const COPILOT = path.join(ROOT, "src", "copilot-server.mjs");

/** Live-site fixtures (see the file doc). */
// `Nos` was added 2026-09-24 after a read-only probe of the same site: `UOM` has
// `Nos` (must_be_whole_number 1) and does NOT have `Cái`/`Chiếc`. The service item
// `PHI-VAN-CHUYEN` has `stock_uom: "Nos"`.
const LIVE_UOMS = ["Bao", "Tấn", "Kg", "Xe", "Thung", "Viên", "Mét", "m3", "Nos"];
const LIVE_FACTORS = [
  { name: "MAT-UOM-CNV-00237", from_uom: "Tấn", to_uom: "Kg", value: 1000 },
  { name: "MAT-UOM-CNV-00236", from_uom: "Bao", to_uom: "Kg", value: 25 },
];
const POLICY = __contract.defaults.uom_policy;

const FEED_BAO = { item_code: "CAM-GA-25KG", item_name: "Cám gà thịt 25kg", stock_uom: "Bao" };
const FEED_KG = { item_code: "P1F-ACCEPT Livestock Item", item_name: "P1F Livestock", stock_uom: "Kg" };

const resolve = (over) =>
  resolveLineUom({ erpUomNames: LIVE_UOMS, factors: LIVE_FACTORS, policy: POLICY, ...over });

// ───────────────────────── 1. UOM extraction ────────────────────────────────

test("B1: a unit is extracted next to its quantity — and 'bao nhiêu' is NOT the unit 'Bao'", () => {
  const order = extractUom("đặt 40 bao cám cho anh bảy");
  assert.equal(order.surface, "Bao");
  assert.equal(order.ambiguous, false);
  assert.equal(order.quantity_context, true, "40 stands right before it");

  // The trap this deny-list exists for: a stock QUESTION contains the word
  // "bao" and must not be read as a unit.
  const question = extractUom("cám gà còn tồn kho bao nhiêu");
  assert.equal(question.surface, null, "'bao nhiêu' is a question word, not the UOM Bao");
  assert.deepEqual(question.matches, []);

  // "tám" (8) and "tấm" share a normalized form — a number word is never a unit.
  assert.equal(extractUom("tám bao cám").surface, "Bao");
  // ...but the item-question that mention NO unit stays unit-less.
  assert.equal(extractUom("tồn kho cám heo").surface, null);

  // Homographs that must NOT name a unit.
  assert.equal(extractUom("cám gà còn tồn kho").surface, null, "'còn' is not the unit Con");
  assert.deepEqual(extractUom("bao gồm 5 mặt hàng").matches, []);
  const quote = extractUom("báo giá 5 tấn cám");
  assert.equal(quote.surface, "Tấn", "'báo giá' must not be read as the unit Bao");
  assert.equal(quote.ambiguous, false);
});

test("B1: the Python layer's quantity parse is the AUTHORITY; the local table only adds units it does not know", () => {
  // "cám còn bao nhiêu" — Python found no quantity, and the deny-list keeps the
  // local fallback quiet too.
  assert.deepEqual(unitFormFromNlp({ text: "cám còn bao nhiêu", quantities: [] }), {
    form: null,
    quantity: null,
    ambiguous: false,
    source: "none",
  });

  // Python parsed "1 tấn" (value + unit) — the unit form AND the number come
  // from there, so the display is exact.
  const fromNlp = unitFormFromNlp({ text: "đặt 1 tấn cám", quantities: [{ value: 1, canonical_unit: "tan" }] });
  assert.equal(fromNlp.form, "tan");
  assert.equal(fromNlp.quantity, 1);
  assert.equal(fromNlp.source, "nlp");
  // The canonical form is mapped to the site's name through the SAME table the
  // text path uses — one unit table, not two.
  assert.deepEqual(candidatesForUnit("tan"), ["Tấn"]);
  assert.deepEqual(candidatesForUnit("khoi"), ["m3"], "Python's 'khoi' is the site's m3");

  // Two different units in one sentence ⇒ ambiguous, and nobody re-reads the
  // text to quietly pick one of them.
  const two = unitFormFromNlp({
    text: "1 bao và 2 tấn",
    quantities: [{ value: 1, canonical_unit: "bao" }, { value: 2, canonical_unit: "tan" }],
  });
  assert.equal(two.ambiguous, true);
  assert.equal(two.form, null);
  const asked = resolveLineUom({ text: "1 bao và 2 tấn", uom: two.form, forceAmbiguous: true, item: FEED_KG, policy: POLICY });
  assert.equal(asked.code, UOM_CODES.UOM_AMBIGUOUS);
  assert.equal(asked.action, UOM_ACTIONS.ASK);

  // A quantity that is part of the ITEM'S OWN NAME is ERPNext data, not a
  // request (live finding 2026-09-20: "Cám gà thịt 25kg" made the parser report
  // "25kg", so asking for stock looked like the user asked for Kg — and two
  // quantities from one sentence asked a question nobody asked).
  const bagged = { item_name: "Cám gà thịt 25kg", item_code: "CAM-GA-25KG" };
  const both = [
    { value: 25, canonical_unit: "kg", raw: "25kg" },
    { value: 1, canonical_unit: "tan", raw: "1 tấn" },
  ];
  const cleaned = unitFormFromNlp({ text: "tồn kho cám gà thịt 25kg 1 tấn", quantities: both }, null, { item: bagged });
  assert.equal(cleaned.form, "tan", "the user's own '1 tấn' survives");
  assert.equal(cleaned.quantity, 1);
  assert.equal(cleaned.ambiguous, false, "the item's own '25kg' must not create a second unit");

  const onlyName = unitFormFromNlp({ text: "tồn kho cám gà thịt 25kg", quantities: [both[0]] }, null, { item: bagged });
  assert.equal(onlyName.source, "none", "no unit was asked for ⇒ default unit, no warning");

  // A unit Python does NOT know (cây) still reaches the resolver through the
  // local fallback — otherwise it would silently become the stock unit.
  const fallback = unitFormFromNlp({ text: "10 cây thép d16", quantities: [] });
  assert.equal(fallback.source, "text");
  assert.equal(fallback.form, "cay");
  assert.equal(resolve({ text: "10 cây thép d16", item: FEED_BAO }).code, UOM_CODES.UOM_UNKNOWN);
});

test("B1: colloquial synonyms map to CANDIDATE names, and two units in one sentence are ambiguous", () => {
  assert.equal(extractUom("5 khối cát").surface, "m3", "'khối' is the colloquial form of m3");
  assert.equal(extractUom("3 ký cám").surface, "Kg");
  const two = extractUom("1 tấn và 2 bao cám");
  assert.equal(two.ambiguous, true);
  assert.equal(two.surface, null, "an ambiguous sentence names no single unit");
  assert.deepEqual([...two.candidates].sort(), ["Bao", "Tấn"]);
});

// ───────────────────────── 2. UOM resolution ────────────────────────────────

test("B1: no unit said ⇒ the ITEM's default unit, said out loud as '(mặc định)'", () => {
  const d = resolve({ text: "đặt 40 cám gà", item: FEED_BAO, quantity: 40 });
  assert.equal(d.code, UOM_CODES.NO_UOM);
  assert.equal(d.action, UOM_ACTIONS.USE);
  assert.equal(d.uom, "Bao");
  assert.equal(d.uom_source, "item_default");
  assert.equal(d.quantity, 40, "the quantity is passed through, never recomputed");
  assert.match(d.display, /mặc định/);
});

test("B1: a unit ERPNext does not have is UNKNOWN ⇒ ask, never a silent swap to the stock unit", () => {
  const d = resolve({ text: "10 cây thép d16", item: FEED_BAO, quantity: 10 });
  assert.equal(d.code, UOM_CODES.UOM_UNKNOWN);
  assert.equal(d.action, UOM_ACTIONS.ASK);
  assert.equal(d.uom, null);
  assert.match(d.reason, /Cây/);
  assert.equal(d.hidden_conversion, false);
});

test("B1: the unit name comes from the SITE, matching accent/case-insensitively ('thùng' → live 'Thung')", () => {
  assert.equal(matchUomCandidates(candidatesForUnit("Thùng"), LIVE_UOMS).name, "Thung");
  assert.equal(matchUomCandidates(candidatesForUnit("tấn"), LIVE_UOMS).name, "Tấn");
  // A unit the site lacks must NOT be fuzzy-matched onto a similar name.
  assert.equal(matchUomCandidates(candidatesForUnit("Cuộn"), LIVE_UOMS).name, null);
  assert.equal(normalizeUomToken("Thùng"), normalizeUomToken("Thung"));
});

test("B1: a unit safe to use as-is never triggers the ambiguous rule; converting FROM it does", () => {
  // Nothing is converted here, so "xe" being vehicle-dependent is irrelevant.
  const asIs = resolve({ text: "tồn kho 3 xe", item: { ...FEED_BAO, stock_uom: "Xe" }, quantity: 3 });
  assert.equal(asIs.code, UOM_CODES.NO_CONVERSION_NEEDED);
  assert.equal(asIs.action, UOM_ACTIONS.USE);

  // But converting "1 xe cát" needs a vehicle type nobody declared ⇒ ask.
  const converting = resolve({ text: "1 xe cát", item: FEED_KG, quantity: 1 });
  assert.equal(converting.code, UOM_CODES.UOM_AMBIGUOUS);
  assert.equal(converting.action, UOM_ACTIONS.ASK);
  assert.equal(converting.converted_quantity, null);
});

test("B1: the factor is applied DIRECTLY and visibly — and a missing direction ASKS instead of inverting", () => {
  const converted = resolve({ text: "2 tấn", item: FEED_KG, quantity: 2 });
  assert.equal(converted.code, UOM_CODES.CONVERTED);
  assert.equal(converted.action, UOM_ACTIONS.CONVERT);
  assert.equal(converted.converted_quantity, 2000, "2 × 1000 (Tấn→Kg), the site's own factor");
  assert.equal(converted.factor.value, 1000);
  assert.equal(converted.factor.scope, "global", "the live doctype has no item_code field");
  assert.match(converted.display, /2 Tấn = 2000 Kg/);
  assert.match(converted.warning, /chung toàn hệ thống/, "a global factor is disclosed, not hidden");
  assert.equal(converted.hidden_conversion, false);

  // "1 tấn cám" with stock_uom Bao: the site has Tấn→Kg and Bao→Kg but NOT
  // Tấn→Bao. The forbidden move is computing 1000/25 = 40 by itself.
  const missing = resolve({ text: "1 tấn cám", item: FEED_BAO, quantity: 1 });
  assert.equal(missing.code, UOM_CODES.UOM_FACTOR_MISSING);
  assert.equal(missing.action, UOM_ACTIONS.ASK);
  assert.equal(missing.converted_quantity, null, "no inverse, no chain, no guess");
  assert.match(missing.reason, /Tấn/);
  assert.match(missing.reason, /Bao/);

  // The factor finder itself is direction-sensitive (the units of the rule).
  assert.equal(findDirectFactor(LIVE_FACTORS, "Bao", "Kg").value, 25);
  assert.equal(findDirectFactor(LIVE_FACTORS, "Kg", "Bao"), null);
  assert.equal(findDirectFactor(LIVE_FACTORS, "Tấn", "Bao"), null);
});

test("B1: a MISSING quantity stays missing — `Number(null) === 0` must never become '0 Kg'", () => {
  // The live probe (real ERPNext, 2026-09-20) showed "đặt 2 tấn" printing
  // "quy đổi: 1 Tấn = 0 Kg" because Number(null) is 0. A zero that reaches a
  // written line quantity is a real-world wrong document, so it is asserted.
  const d = resolve({ text: "2 tấn", item: FEED_KG, quantity: null });
  assert.equal(d.action, UOM_ACTIONS.CONVERT);
  assert.equal(d.converted_quantity, null, "no quantity in ⇒ no converted quantity out");
  assert.match(d.display, /1 Tấn = 1000 Kg/);
  assert.doesNotMatch(d.display, /= 0 /);

  // An explicit 0 is still a real quantity (the refusal happens elsewhere, on
  // the amount/quantity policy), and converts to 0 honestly.
  const zero = resolve({ text: "0 tấn", item: FEED_KG, quantity: 0 });
  assert.equal(zero.converted_quantity, 0);
});

test("B1: an item without stock_uom asks too — 'each'/'Nos' is a guess, not a default", () => {
  const d = resolve({ text: "5 bao", item: { item_code: "X" }, quantity: 5 });
  assert.equal(d.code, UOM_CODES.UOM_FACTOR_MISSING);
  assert.equal(d.action, UOM_ACTIONS.ASK);
  assert.match(d.reason, /stock_uom/);
});

test("B1: ERPNext's own `Nos` unit resolves for a service line — one candidate, zero conversion", () => {
  // R5 (measured live 2026-09-24): an e-invoice line for a SERVICE carries the
  // file's UOM, and this site's service items are `Nos`. The composed sentence
  // `3 Nos Phí vận chuyển` used to lose its quantity entirely (PO_QTY_MISSING)
  // because `Nos` was not a unit the layers recognised.
  assert.deepEqual(candidatesForUnit("nos"), ["Nos"]);
  assert.deepEqual(candidatesForUnit("Nos"), ["Nos"]);
  // ONE candidate on purpose. `Cái` is not a UOM this site has, so offering it
  // could only ever resolve to UOM_UNKNOWN — that guess is not made here.
  assert.ok(!candidatesForUnit("nos").includes("Cái"));

  const extracted = extractUom("3 nos phí vận chuyển & bốc xếp");
  assert.equal(extracted.surface, "Nos");
  assert.equal(extracted.quantity_context, true);

  const SERVICE = { item_code: "PHI-VAN-CHUYEN", item_name: "Phí vận chuyển & bốc xếp", stock_uom: "Nos" };
  const d = resolve({ text: "3 nos phí vận chuyển & bốc xếp", uom: "nos", quantity: 3, item: SERVICE });
  assert.equal(d.code, UOM_CODES.NO_CONVERSION_NEEDED);
  assert.equal(d.action, UOM_ACTIONS.USE);
  assert.equal(d.uom, "Nos");
  assert.equal(d.uom_source, "user");
  // An IDENTITY alias: naming `Nos` for a `Nos` item must never invent arithmetic.
  assert.equal(d.converted_quantity, null);
  assert.equal(d.factor, null);
  assert.equal(d.hidden_conversion, false);

  // And the alias is NOT a default: an item with no stock_uom still ASKS rather
  // than falling back to `Nos` (the rule asserted by the test above).
  const noStock = resolve({ text: "3 nos phí vận chuyển", uom: "nos", quantity: 3, item: { item_code: "X" } });
  assert.equal(noStock.action, UOM_ACTIONS.ASK);
  assert.equal(noStock.code, UOM_CODES.UOM_FACTOR_MISSING);
});

test("B1: every conversion carries a display string (asserted for the whole decision table)", () => {
  const cases = [
    { text: "2 tấn", item: FEED_KG },
    { text: "1 tấn cám", item: FEED_BAO },
    { text: "5 bao", item: FEED_KG },
    { text: "1 xe cát", item: FEED_KG },
    { text: "10 cây thép", item: FEED_BAO },
    { text: "không có đơn vị", item: FEED_BAO },
  ].map((c) => resolve({ ...c, quantity: 1 }));
  for (const d of cases) {
    assert.equal(d.hidden_conversion, false, `${d.code} must not be a hidden conversion`);
    if (d.action === UOM_ACTIONS.CONVERT) assert.ok(d.display, `${d.code} needs a visible conversion`);
    assert.ok(
      [UOM_ACTIONS.USE, UOM_ACTIONS.CONVERT, UOM_ACTIONS.ASK].includes(d.action),
      `unknown action ${d.action} — a caller must not receive an unclassified decision`,
    );
  }
});

test("B1: the UOM policy is contract-declared and cannot be relaxed by editing JSON", () => {
  assert.equal(POLICY.allow_inverse_factor, false);
  assert.equal(POLICY.allow_two_hop_chain, false);
  assert.ok(Array.isArray(POLICY.ambiguous_uoms) && POLICY.ambiguous_uoms.includes("xe"));

  for (const mutate of [
    (c) => (c.defaults.uom_policy.missing_factor = "convert"),
    (c) => (c.defaults.uom_policy.unknown_uom = "use_stock"),
    (c) => (c.defaults.uom_policy.allow_inverse_factor = true),
    (c) => (c.defaults.uom_policy.allow_two_hop_chain = true),
    (c) => (c.defaults.uom_policy.always_show_conversion = false),
    (c) => delete c.defaults.uom_policy.ambiguous_uoms,
    (c) => (c.defaults.uom_policy.default_uom_source = "first_uom_in_list"),
    (c) => delete c.defaults.uom_policy,
  ]) {
    const broken = JSON.parse(JSON.stringify(__contract));
    mutate(broken);
    assert.throws(() => validateContract(broken), /uom_policy|UOM/, "a relaxed UOM policy must stop the process");
  }
});

// ───────────────── 3. Item 4 states + supplier resolver ─────────────────────

test("B1: items get the same four resolution states as customers, under the contract policy", () => {
  const GA = { item_code: "CAM-GA-25KG", item_name: "Cám gà thịt 25kg" };

  // Full stored name in the text ⇒ EXACT.
  const exact = classifyEntityResolution(
    { entity: GA, ambiguous: false, candidates: [] },
    { ...ENTITY_ACCESSORS.item, candidates: ["cám gà thịt 25kg", "cám gà"] },
  );
  assert.equal(exact.state, ENTITY_STATES.EXACT_MATCH);

  // A shorter phrase the user really says ⇒ FUZZY (never "exact").
  const fuzzy = classifyEntityResolution(
    { entity: GA, ambiguous: false, candidates: [] },
    { ...ENTITY_ACCESSORS.item, candidates: ["cám gà", "cám"] },
  );
  assert.equal(fuzzy.state, ENTITY_STATES.FUZZY_SINGLE_MATCH);

  const many = classifyEntityResolution(
    { entity: null, ambiguous: true, candidates: ["Cám heo tăng trọng 25kg", "Cám gà thịt 25kg"] },
    { ...ENTITY_ACCESSORS.item, candidates: ["cám"] },
  );
  assert.equal(many.state, ENTITY_STATES.AMBIGUOUS_MATCH);
  assert.equal(many.candidates.length, 2);

  const none = classifyEntityResolution({ entity: null, ambiguous: false, candidates: [] }, {});
  assert.equal(none.state, ENTITY_STATES.NO_MATCH);

  // Policy: a READ may auto-select a single fuzzy item; several matched items
  // must offer the picker instead of silently picking the first one.
  const stock = getCapability("stock.balance");
  assert.equal(entityPolicy(ENTITY_STATES.FUZZY_SINGLE_MATCH, stock, __contract.defaults.entity_policy).auto_select, true);
  const ambiguousRule = entityPolicy(ENTITY_STATES.AMBIGUOUS_MATCH, stock, __contract.defaults.entity_policy);
  assert.equal(ambiguousRule.require_picker, true);
  assert.equal(ambiguousRule.code, "AMBIGUOUS_ENTITY");

  // The picker lists what is on offer, id + label only.
  const picked = pickerForRowsByText(
    [
      { item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg" },
      { item_code: "CAM-GA-25KG", item_name: "Cám gà thịt 25kg" },
    ],
    ["cám"],
    { ...ENTITY_ACCESSORS.item, limit: 5 },
  );
  assert.equal(picked.length, 2);
  assert.equal(picked[0].id, "CAM-HEO-25KG");
  assert.match(picked[0].label, /Cám heo tăng trọng 25kg/);
});

test("B1: the supplier resolver uses the same states, prefers the longest stored name, and refuses invented ids", () => {
  const ROWS = [
    { name: "SUP-HATIEN", supplier_name: "Hà Tiên", supplier_group: "Vật liệu", disabled: 0 },
    { name: "SUP-HATIEN-2", supplier_name: "Hà Tiên 2", supplier_group: "Vật liệu", disabled: 0 },
  ];
  // Longest name wins: naming supplier 2 must not resolve to supplier 1 just
  // because supplier 1's name is a substring of the sentence.
  assert.equal(resolveEntityByText(ROWS, "nhà cung cấp hà tiên 2", ENTITY_ACCESSORS.supplier).entity.name, "SUP-HATIEN-2");
  assert.equal(resolveEntityByText(ROWS, "nhà cung cấp hà tiên", ENTITY_ACCESSORS.supplier).entity.name, "SUP-HATIEN");

  // A fragment that fits several suppliers is AMBIGUOUS with candidates to show.
  const partial = resolveEntityByText(ROWS, "nhà cung cấp hà ti", ENTITY_ACCESSORS.supplier);
  assert.equal(partial.entity, null);
  assert.equal(partial.ambiguous, true);
  assert.deepEqual(partial.candidates.sort(), ["Hà Tiên", "Hà Tiên 2"]);

  // Unknown supplier ⇒ NO_MATCH with no candidate invented from nothing.
  const none = resolveEntityByText(ROWS, "nhà cung cấp phương nam", ENTITY_ACCESSORS.supplier);
  assert.equal(none.entity, null);
  assert.equal(none.ambiguous, false);
  assert.deepEqual(none.candidates, []);

  // The resolver classifies its own output into the SAME states.
  const cls = classifyEntityResolution(partial, { ...ENTITY_ACCESSORS.supplier, candidates: ["nhà cung cấp hà ti"] });
  assert.equal(cls.state, ENTITY_STATES.AMBIGUOUS_MATCH);
  assert.equal(entityPolicy(cls.state, getCapability("supplier.lookup"), __contract.defaults.entity_policy).require_picker, true);
});

// ───────────────────── 4. Read-only boundary (B1) ───────────────────────────

test("B1: the supplier LIST is whitelisted for READ, every supplier write verb stays refused", () => {
  assert.equal(assertReadOnly("erpnext_supplier_list"), true);
  for (const tool of ["erpnext_supplier_create", "erpnext_supplier_update", "erpnext_doc_create", "erpnext_doc_submit"]) {
    assert.throws(() => assertReadOnly(tool), /TOOL_REFUSED/, `${tool} must not be callable from a skill`);
  }
  // The advertised-hint cross-check keeps the same rule for the new tool.
  assert.deepEqual(
    auditAgainstAdvertisedTools([{ name: "erpnext_supplier_list", annotations: { readOnlyHint: true } }]),
    [],
  );
  assert.deepEqual(
    auditAgainstAdvertisedTools([{ name: "erpnext_supplier_list", annotations: { readOnlyHint: false } }]),
    ["erpnext_supplier_list"],
  );
  // And the supplier skill reaches ONLY whitelisted READ tools. A2 (e-invoice)
  // added `erpnext_doc_list` (with an explicit `fields` projection) because the
  // list tool drops `tax_id` on the real site — measured 2026-09-23 — so the
  // tax-id match needs the generic READ tool. Both stay read-only; a write verb
  // here is what the loop above refuses.
  const src = readFileSync(path.join(ROOT, "src", "skills", "purchasing.mjs"), "utf8");
  const calls = [...src.matchAll(/callTool\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["erpnext_supplier_list", "erpnext_doc_list"]);
  for (const call of calls) assert.equal(assertReadOnly(call), true, `${call} must be whitelisted`);
});

// ───────────────────────────── 5. E2E /ask ─────────────────────────────────

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

test("B1 E2E: /ask resolves supplier + item states + the line unit (mock ERPNext, real NLP)", async () => {
  const nlp = await startNlpService();
  let server = null;
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    const { createAskServer } = await import("../src/http-ask.mjs");
    server = createAskServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ask = async (text) => {
      const res = await fetch(`${base}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return { status: res.status, body: await res.json() };
    };
    const result = async (text) => (await ask(text)).body.result;

    // ── supplier READ ──
    const sup = await result("nhà cung cấp hà tiên");
    assert.match(sup.answer.join("\n"), /Hà Tiên/);
    assert.equal(sup.supplier.id, "SUP-HATIEN");
    assert.equal(sup.proposal.action, "read_supplier");
    assert.equal(sup.entity.state, ENTITY_STATES.EXACT_MATCH);
    assert.equal(sup.ui, null, "no drill-down screen declared for suppliers");

    const supAmb = await result("nhà cung cấp hà ti");
    assert.equal(supAmb.error_code, "AMBIGUOUS_SUPPLIER");
    assert.equal(supAmb.proposal, null, "an ambiguous supplier produces no proposal");
    assert.equal(supAmb.candidates.length, 2, "the picker gets both candidates");

    const supNone = await result("nhà cung cấp phương nam");
    assert.equal(supNone.error_code, "SUPPLIER_NOT_FOUND");
    assert.equal(supNone.answer, null);

    // ── ERPNext down while resolving a supplier ──
    // The capability DECLARES ERP_UNAVAILABLE. Without an explicit guard the
    // throw escapes answerQuestion and /ask answers a bare 500 with no
    // error_code — a declared error that could never be emitted (found in
    // review, 2026-09-20).
    process.env.MOCK_ERP_FAIL_SUPPLIER_LIST = "1";
    try {
      const supDown = await ask("nhà cung cấp hà tiên");
      assert.equal(supDown.body.result.error_code, "ERP_UNAVAILABLE");
      assert.equal(supDown.body.result.proposal, null, "nothing may be proposed from a failed read");
      assert.equal(supDown.body.result.uncertainty.code, "ERP_UNAVAILABLE", "and the client gets copy, not a bare code");
      assert.match(supDown.body.result.reason, /danh sách nhà cung cấp/);
    } finally {
      delete process.env.MOCK_ERP_FAIL_SUPPLIER_LIST;
    }
    // ...and the SAME question answers normally once ERPNext is back.
    assert.equal((await result("nhà cung cấp hà tiên")).error_code, undefined);

    // ── item states on the stock read ──
    const stockOne = await result("tồn kho cám gà");
    assert.equal(stockOne.entity.state, ENTITY_STATES.FUZZY_SINGLE_MATCH);
    assert.equal(stockOne.proposal.entity.id, "CAM-GA-10KG");
    assert.equal(stockOne.uom.stock_uom, "Bao", "the item's default unit travels with the answer");
    assert.equal(stockOne.proposal.params.default_uom, "Bao", "and is on the proposal the card renders");
    assert.equal(stockOne.uom.code, UOM_CODES.NO_UOM);
    assert.equal(stockOne.answer.length, stockOne.rows.length, "no extra prose when no unit was said");

    const stockMany = await result("tồn kho cám");
    assert.equal(stockMany.entity.state, ENTITY_STATES.AMBIGUOUS_MATCH);
    assert.equal(stockMany.entity.policy.require_picker, true);
    assert.ok(stockMany.item_candidates.length >= 2, "several items matched ⇒ offer the picker");
    assert.ok(stockMany.answer.some((l) => /khớp nhiều mặt hàng/.test(l)), "and still answer with a warning");

    // ── the unit rules, end to end ──
    const notAUnit = await result("cám gà còn tồn kho bao nhiêu");
    assert.equal(notAUnit.uom.code, UOM_CODES.NO_UOM, "'bao nhiêu' never becomes the unit Bao");
    assert.equal(notAUnit.answer.length, notAUnit.rows.length);

    const asked = await result("tồn kho cám gà 1 tấn");
    assert.equal(asked.uom.code, UOM_CODES.UOM_FACTOR_MISSING);
    assert.equal(asked.uom.action, UOM_ACTIONS.ASK);
    assert.ok(asked.answer.some((l) => /⚠️/.test(l) && /quy đổi/.test(l)), "the refusal is visible in the answer");

    const unknownUnit = await result("tồn kho cám gà 10 cây");
    assert.equal(unknownUnit.uom.code, UOM_CODES.UOM_UNKNOWN);

    // ── no regression on the money path (B1 must not touch it) ──
    const pay = await result("thu tiền cho Nguyễn Thị Lan 10000");
    assert.equal(pay.proposal.action, "create_payment_entry");
    assert.equal("uom" in pay, false, "the WRITE path is untouched by B1");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    nlp.child.kill();
  }
});
