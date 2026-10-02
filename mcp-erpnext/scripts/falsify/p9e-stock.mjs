#!/usr/bin/env node
/**
 * Falsification harness for P9-E (`stock.adjustment` — a DRAFT Stock Entry
 * Material Issue, the first write with NO party and the first whose correctness
 * depends on TWO spoken slots: how much AND out of which room).
 *
 * Same discipline as p9d: each case deletes ONE guard, the NAMED test must go
 * RED, and `lib/harness.mjs` enforces the rest (baseline green first, a moved
 * anchor reported rather than skipped, restore byte-identical, Ctrl-C restores).
 *
 * The guards are listed in the order a mistake would cost the shop the most:
 *
 *  - the PURPOSE is declared, not defaulted: a Material Receipt built while the
 *    card says "xuất hủy" moves goods the other way;
 *  - the WAREHOUSE is spoken, never inferred: the wrong room is the wrong
 *    inventory count, and chat cannot undo it;
 *  - the QUANTITY is bounded by real stock MINUS what open drafts already claim
 *    (a draft does not move Bin), and over-asking REFUSES — clamping would mean
 *    the agent deciding how much stock gets destroyed;
 *  - the unit is the item's own, or a DECLARED factor;
 *  - NOTHING with a price on it is written (a write-off has no price at all);
 *  - the write only happens when the site can hold the correlation field (the
 *    only server-side dedup a Stock Entry has);
 *  - stock re-read at execute is compared, never trusted (a ten-minute-old card);
 *  - and the READ-BACK is what we believe: a site that stored something else is
 *    not a success.
 *
 * Two of the cases live in the router/contract rather than the skill, on
 * purpose: P9-E's most dangerous failure is a QUESTION ("hàng hỏng tháng này
 * bao nhiêu") being answered with a HIGH card, which is a routing property.
 */
import { runCases, PATHS } from "./lib/harness.mjs";

const SKILL = "src/skills/stock-adjustment-write.mjs";
const CONTRACT = "capabilities.json";
const VALIDATOR = "src/capability-contract.mjs";
const MOCK = "src/mock-server.mjs";
const SUITE = "test/p9-e-stock.test.mjs";

const CASES = [
  {
    name: "A. the write group stops requiring a LEADING verb — “hàng hỏng tháng này bao nhiêu” opens a HIGH card",
    file: CONTRACT,
    // `notIf` is only consulted when the group declares `startsWith` (the B4
    // lesson): killing `startsWith` kills the deny-list with it, which is the
    // coupling worth pinning — a QUESTION must never become a write-off.
    old: '      "startsWith": true,\n      "notIf": "bao nhiêu|bao nhieu|mấy|may |chưa|chua |xem|kiểm|kiem |tình trạng|tinh trang|không|khong |dịch|',
    new: '      "startsWith": false,\n      "notIf": "bao nhiêu|bao nhieu|mấy|may |chưa|chua |xem|kiểm|kiem |tình trạng|tinh trang|không|khong |dịch|',
    only: "P9-E routing: write-off COMMANDS reach stock.adjustment; stock QUESTIONS stay stock.balance",
  },
  {
    // Not a contract edit: the skill's own test perturbs a COPY of the contract
    // (entry_type deleted) and runs the skill against it, so the only mutation it
    // can see is in the skill. `?? ENTRY_TYPE` is exactly how the guard dies —
    // the default is compared against itself and always passes.
    name: "B. an undeclared purpose silently DEFAULTS to Material Issue — the guard compares a literal to itself",
    file: SKILL,
    old: "  const declared = policies().line?.entry_type ?? null;",
    new: "  const declared = policies().line?.entry_type ?? ENTRY_TYPE;",
    only: "P9-E skill: with `entry_type` UNDECLARED the builder refuses — the guard is not a constant",
  },
  {
    name: "C. the load-time validator stops rejecting a blank entry_type — the guard could go dead",
    file: VALIDATOR,
    old: '  if (p.entry_type !== undefined && (typeof p.entry_type !== "string" || p.entry_type.trim() === "")) {',
    new: "  if (false) {",
    only: "P9-E contract: a blank `entry_type` is refused at LOAD time (the guard cannot go dead)",
  },
  {
    name: "D. the skill defaults the purpose instead of refusing — a wrong direction reaches a stock document",
    file: SKILL,
    old: "  if (declared !== ENTRY_TYPE) {",
    new: "  if (false) {",
    only: "P9-E skill: with `entry_type` UNDECLARED the builder refuses — the guard is not a constant",
  },
  {
    name: "E. the WAREHOUSE stops being mandatory — the room is guessed from live stock",
    file: SKILL,
    old: '  if (picked.reason === "not_named") {',
    new: "  if (false) {",
    only: "P9-E builder: the WAREHOUSE is mandatory — it is never inferred, even from live stock",
  },
  {
    name: "F. over-asking stops refusing — the quantity is silently clamped to what is on the shelf",
    file: SKILL,
    old: "  if (qty > available + EPS) {\n    throw refuse(\n      `${CODE_PREFIX}QTY_EXCEEDS_STOCK`,",
    new: "  if (false && qty > available + EPS) {\n    throw refuse(\n      `${CODE_PREFIX}QTY_EXCEEDS_STOCK`,",
    only: "P9-E builder: asking for more than the room holds REFUSES — it is never clamped",
  },
  {
    name: "G. open DRAFTS stop covering their goods at build — a draft does not move Bin, so the same goods get written off twice",
    file: SKILL,
    old: "drawn: cover.drawn })",
    new: "drawn: new Map() })",
    only: "P9-E builder: an open DRAFT claims its goods (a draft does not move Bin)",
  },
  {
    name: "H. a cover that cannot be computed stops refusing — a number that looks precise replaces an honest refusal",
    file: SKILL,
    old: "  if (cover.unknown) {",
    new: "  if (false) {",
    only: "P9-E builder: a full page of open drafts is UNKNOWABLE too (there may be more)",
  },
  {
    name: "I. a price stops being refused — someone else's number reaches a stock document",
    file: SKILL,
    old: "    if (params && params[key] !== undefined && params[key] !== null) {",
    new: "    if (false) {",
    only: "P9-E executor: a price on the proposal refuses before it can reach a stock document",
  },
  {
    name: "J. the naming series stops being sent (reqd=1, default=null on the real site — nothing fills it in)",
    file: SKILL,
    old: "const NAMING_SERIES = \"MAT-STE-.YYYY.-\";",
    new: "const NAMING_SERIES = null;",
    only: "P9-E regress: the payload carries the measured Stock Entry shape, and no price",
  },
  {
    name: "K. the payload stops sending stock_uom — a reqd child field the site does NOT fetch for us",
    file: SKILL,
    old: "        ...(stockUom ? { stock_uom: stockUom } : {}),",
    new: "",
    only: "P9-E regress: the payload carries the measured Stock Entry shape, and no price",
  },
  {
    name: "L. a missing correlation field stops refusing — a write happens with no server-side dedup",
    file: SKILL,
    old: "  if (probe.correlation_field_unavailable) {",
    new: "  if (false) {",
    only: "P9-E executor: without the correlation field NOTHING is written (a Stock Entry has no other dedup)",
  },
  {
    name: "M. stock re-read at execute stops being compared — a stale card writes the old number",
    file: SKILL,
    old: "  if (drift.length > 0) {",
    new: "  if (false) {",
    only: "P9-E executor: stock that moved since the card was shown refuses BEFORE any write",
  },
  {
    name: "N. the read-back stops comparing qty — a site that stored something ELSE counts as success",
    file: SKILL,
    old: "if (Math.abs(Number(got.qty) - Number(qty)) > EPS) problems.push(`qty=${got.qty}`);",
    new: "if (false) problems.push(`qty=${got.qty}`);",
    only: "P9-E executor: a site that stored something ELSE is caught by the read-back",
  },
  {
    name: "O. the contract opts IN to submit — the card could move stock instead of writing a draft",
    file: CONTRACT,
    old: '        "write_doctype": "Stock Entry",\n        "correlation_field": "custom_ai_action_id",\n        "reference_field": "custom_ai_action_id",\n        "draft_only": true,\n        "allow_submit": false',
    new: '        "write_doctype": "Stock Entry",\n        "correlation_field": "custom_ai_action_id",\n        "reference_field": "custom_ai_action_id",\n        "draft_only": true,\n        "allow_submit": true',
    only: "P9-E gate: the client refuses to SUBMIT a Stock Entry at all",
  },
  {
    name: "P. the mock stops enforcing reqd naming_series — the rule measured on the live site goes unchecked",
    file: MOCK,
    old: '  if (!namingSeries) throw new Error("naming_series is mandatory");',
    new: "",
    only: "P9-E mock: the create path enforces the rules MEASURED on the real site",
  },
  {
    name: "Q. the mock accepts any stock_entry_type — the fake stops modelling the one direction this path supports",
    file: MOCK,
    old: '  if (entryType !== "Material Issue") {',
    new: "  if (false) {",
    only: "P9-E mock: the create path enforces the rules MEASURED on the real site",
  },
];

process.exit(
  runCases(CASES, { title: "P9-E stock write-off", nodeFiles: { default: SUITE }, root: PATHS.ROOT }) === 0
    ? 0
    : 1,
);
