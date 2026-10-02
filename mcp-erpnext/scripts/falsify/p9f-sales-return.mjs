#!/usr/bin/env node
/**
 * Falsification harness for P9-F (`sales_return.create` — khách trả hàng = a
 * DRAFT Sales Invoice with `is_return=1`, negative qty, `update_stock=1`, linked
 * by `return_against` to a SUBMITTED original).
 *
 * Same discipline as p9e: each case deletes ONE guard, the NAMED test must go
 * RED, and `lib/harness.mjs` enforces the rest (baseline green first, a moved
 * anchor reported rather than skipped, restore byte-identical, Ctrl-C restores).
 *
 * The guards are ordered by what a mistake would cost the shop:
 *
 *  - a QUESTION ("đã trả hàng… bao nhiêu?") must never open a HIGH write card
 *    (routing), and every money-neighbour path stays where it was;
 *  - the return's NATURE and STOCK DIRECTION are DECLARED, never defaulted:
 *    a return built as SI-bán (update_stock=0) refunds money WITHOUT the goods
 *    coming back — the worst outcome on this path;
 *  - the ORIGINAL invoice is mandatory, SUBMITTED and non-return: returning
 *    against a draft/return is a document the shop never sold;
 *  - the ceiling is qty − returned(submitted) − drafted(open): two
 *    confirmations must not receive the same goods twice, and over-asking
 *    REFUSES (clamping = the agent deciding how much money goes back);
 *  - a FULL page of either kind is UNKNOWABLE — refuse, never guess;
 *  - the price is the INVOICE's, re-checked at execute, never the sentence's;
 *  - the unit is the invoice's own (no hidden conversion on a credit note);
 *  - no correlation field ⇒ no write (the only server-side dedup);
 *  - qty is compared on re-read, and the SIGN of the stored line is what we
 *    believe: a site that stored +2 refunded the wrong way;
 *  - update_stock is part of what was approved — a site that dropped it is not
 *    a success;
 *  - and the contract never opts IN to submit (submit books the credit note).
 */
import { runCases, PATHS } from "./lib/harness.mjs";

const SKILL = "src/skills/sales-return-write.mjs";
const CONTRACT = "capabilities.json";
const VALIDATOR = "src/capability-contract.mjs";
const MOCK = "src/mock-server.mjs";
const SUITE = "test/p9-f-sales-return.test.mjs";

const CASES = [
  {
    name: "A. the write group stops requiring a LEADING verb — “khách trả hàng tháng này bao nhiêu” opens a HIGH return card",
    file: CONTRACT,
    // `notIf` is only consulted when the group declares `startsWith` (the B4
    // lesson): killing `startsWith` kills the deny-list with it, which is the
    // coupling worth pinning — a QUESTION must never become a credit note.
    old: '      "startsWith": true,\n      "notIf": "bao nhiêu|bao nhieu|mấy|may |lịch sử|lich su|đã trả hàng|da tra hang|xem|kiểm|kiem |tình trạng|tinh trang|',
    new: '      "startsWith": false,\n      "notIf": "bao nhiêu|bao nhieu|mấy|may |lịch sử|lich su|đã trả hàng|da tra hang|xem|kiểm|kiem |tình trạng|tinh trang|',
    only: "P9-F routing: return COMMANDS reach sales_return.create; questions and neighbours stay put",
  },
  {
    name: "B. the deny-list stops excluding HISTORY questions — “đã trả hàng cho chị Lan chưa?” becomes a write",
    file: CONTRACT,
    old: '"notIf": "bao nhiêu|bao nhieu|mấy|may |lịch sử|lich su|đã trả hàng|da tra hang|xem|kiểm|kiem |tình trạng|tinh trang|',
    // A prefix that matches nothing keeps the JSON valid while killing the
    // deny-list (the remaining `\\?` tail is left in place on purpose).
    new: '"notIf": "zzz-never-matches|',
    only: "P9-F routing: return COMMANDS reach sales_return.create; questions and neighbours stay put",
  },
  {
    name: "C. the return's NATURE silently DEFAULTS to credit_note — the guard compares a literal to itself",
    file: SKILL,
    old: "  const declared = policies().line?.entry_type ?? null;",
    new: '  const declared = policies().line?.entry_type ?? "credit_note";',
    only: "P9-F skill: with `entry_type` UNDECLARED the builder refuses",
  },
  {
    name: "D. the nature check stops refusing a DIFFERENT declared type — a wrong document kind reaches the site",
    file: SKILL,
    old: '  if (declared !== "credit_note") {',
    new: "  if (false) {",
    only: "P9-F skill: with `entry_type` UNDECLARED the builder refuses",
  },
  {
    name: "E. the STOCK DIRECTION silently DEFAULTS — a return that refunds money without the goods coming back",
    file: SKILL,
    old: "  const declared = policies().line?.update_stock ?? null;",
    new: "  const declared = policies().line?.update_stock ?? 1;",
    only: "P9-F skill: with `update_stock` UNDECLARED the builder refuses",
  },
  {
    name: "F. the stock-direction check stops refusing — update_stock != 1 passes as a return",
    file: SKILL,
    old: "  if (declared !== 1) {",
    new: "  if (false) {",
    only: "P9-F skill: with `update_stock` UNDECLARED the builder refuses",
  },
  {
    name: "G. a blank entry_type is no longer refused at LOAD time — the guard could go dead",
    file: VALIDATOR,
    old: '  if (p.entry_type !== undefined && (typeof p.entry_type !== "string" || p.entry_type.trim() === "")) {',
    new: "  if (false) {",
    only: "P9-F contract: a blank `entry_type`/`update_stock` is refused at LOAD time",
  },
  {
    name: "H. the pairing `qty_negative ⟹ update_stock=1` is dropped — a negative-qty document with no declared direction loads",
    file: VALIDATOR,
    old: "  if (qtyNegative && (p.qty_positive === true || p.update_stock !== 1)) {",
    new: "  if (false) {",
    only: "P9-F contract: a blank `entry_type`/`update_stock` is refused at LOAD time",
  },
  {
    name: "I. update_stock stops being checked as 0/1 — a string direction sails through",
    file: VALIDATOR,
    old: "  if (p.update_stock !== undefined && ![0, 1].includes(p.update_stock)) fail(",
    new: "  if (false) fail(",
    only: "P9-F contract: a blank `entry_type`/`update_stock` is refused at LOAD time",
  },
  {
    name: "J. the ORIGINAL invoice stops being mandatory — a bare customer name becomes a return reference",
    file: SKILL,
    old: "  if (!invoiceName) {\n    throw refuse(\n      `${CODE_PREFIX}INVOICE_UNRESOLVED`,",
    new: "  if (false) {\n    throw refuse(\n      `${CODE_PREFIX}INVOICE_UNRESOLVED`,",
    only: "P9-F builder: the ORIGINAL INVOICE is mandatory",
  },
  {
    name: "K. a SUBMITTED-only rule stops being enforced — a DRAFT original (nothing sold yet) is accepted",
    file: SKILL,
    old: "  if (Number(inv.docstatus) !== 1) {",
    new: "  if (false) {",
    only: "P9-F builder: a DRAFT original refuses",
  },
  {
    name: "L. returning INTO a return stops refusing — a credit note gains a credit note",
    file: SKILL,
    old: "  if (Number(inv.is_return ?? 0) === 1) {",
    new: "  if (false) {",
    only: "P9-F builder: returning INTO a return refuses",
  },
  {
    name: "M. an item that is not ON the original stops refusing — substitute returns reach a credit note",
    file: SKILL,
    old: "    if (!invLine) {\n      throw refuse(\n        `${CODE_PREFIX}ITEM_NOT_IN_INVOICE`,",
    new: "    if (false) {\n      throw refuse(\n        `${CODE_PREFIX}ITEM_NOT_IN_INVOICE`,",
    only: "P9-F builder: an item NOT on the original refuses (no substitute returns)",
  },
  {
    name: "N. a unit the invoice does not use stops refusing — “1 tấn” returns as “1 bao”",
    file: SKILL,
    old: "      if (spoken && spoken !== invUom.toLowerCase()) {",
    new: "      if (false) {",
    only: "P9-F builder: a unit the invoice does not use refuses",
  },
  {
    name: "O. over-returning stops refusing — the quantity is silently clamped to what is returnable",
    file: SKILL,
    old: "    if (want.qty - returnable > EPS) {",
    new: "    if (false && want.qty - returnable > EPS) {",
    only: "P9-F builder: over-returning REFUSES",
  },
  {
    name: "P. open DRAFT returns stop covering their goods — two confirmations receive the same goods twice",
    file: SKILL,
    old: "  const draftCover = await openReturnDraftCover(reads, invoice.name);",
    new: "  const draftCover = { drawn: new Map(), drafts: [] };",
    only: "P9-F builder: an OPEN DRAFT return claims its goods",
  },
  {
    name: "Q. a FULL page of SUBMITTED returns stops refusing — a number that looks precise replaces an honest “unknown”",
    file: SKILL,
    old: "  if (submittedRows.length >= DRAFT_LOOKUP_LIMIT) {",
    new: "  if (false) {",
    only: "P9-F builder: a FULL page of submitted returns is UNKNOWABLE",
  },
  {
    name: "R. a FULL page of OPEN DRAFTS stops refusing — the draft cover is computed from a page that may be partial",
    file: SKILL,
    old: "  if (rows.length >= DRAFT_LOOKUP_LIMIT) {",
    new: "  if (false) {",
    only: "P9-F builder: a FULL page of OPEN DRAFTS refuses",
  },
  {
    name: "S. the price re-read at execute stops being compared — a stale card refunds at yesterday's price",
    file: SKILL,
    old: "    if (Math.abs(Number(want.rate) - rate) > EPS) {",
    new: "    if (false && Math.abs(Number(want.rate) - rate) > EPS) {",
    only: "P9-F executor: the original's price must still match at execute",
  },
  {
    name: "T. drift stops refusing — goods received back since the card was shown are written over",
    file: SKILL,
    old: "  if (drift.length > 0) {",
    new: "  if (false) {",
    only: "P9-F executor: goods received back since the card was shown",
  },
  {
    name: "U. a missing correlation field stops refusing — a write happens with no server-side dedup",
    file: SKILL,
    old: "  if (probe.correlation_field_unavailable) {",
    new: "  if (false) {",
    only: "P9-F executor: without the correlation field NOTHING is written",
  },
  {
    name: "V. the read-back stops checking the SIGN — a site that stored +2 counts as returned",
    file: SKILL,
    old: "      if (Number(got.qty) > 0) problems.push(",
    new: "      if (false) problems.push(",
    only: "P9-F executor: a site that stored a POSITIVE qty is caught by the read-back",
  },
  {
    name: "W. the read-back stops checking update_stock — money back WITHOUT the goods back counts as success",
    file: SKILL,
    old: "  if (Number(doc.update_stock ?? 0) !== 1) {",
    new: "  if (false) {",
    only: "P9-F executor: a site that dropped update_stock is caught by the read-back",
  },
  {
    name: "X. the payload stops sending qty NEGATIVE — the site stores a return the wrong way round",
    file: SKILL,
    old: "      qty: -Math.abs(Number(l.qty)),",
    new: "      qty: Math.abs(Number(l.qty)),",
    only: "P9-F regress: payload helper refuses to build a positive-direction return",
  },
  {
    name: "Y. the contract opts IN to submit — the card could book the credit note instead of writing a draft",
    file: CONTRACT,
    old: '        "write_doctype": "Sales Invoice",\n        "correlation_field": "custom_ai_action_id",\n        "reference_field": "custom_ai_action_id",\n        "draft_only": true,\n        "allow_submit": false\n      },\n      "errors": [\n        "SR_INVOICE_UNRESOLVED",',
    new: '        "write_doctype": "Sales Invoice",\n        "correlation_field": "custom_ai_action_id",\n        "reference_field": "custom_ai_action_id",\n        "draft_only": true,\n        "allow_submit": true\n      },\n      "errors": [\n        "SR_INVOICE_UNRESOLVED",',
    // The CONTRACT test is the named one: the client gate merges per-doctype
    // flags (a second capability's draft_only keeps submit off), so the
    // contract's own declaration is what must be pinned here.
    only: "P9-F contract: sales_return.create is a WRITE",
  },
  {
    name: "Z. the mock stops requiring the link — a return with no return_against is written",
    file: MOCK,
    old: '  if (!against) throw new Error("return_against is mandatory on a Sales Return");',
    new: "  // ",
    only: "P9-F mock: the create path enforces the rules MEASURED on the real site",
  },
  {
    name: "AA. the mock accepts a POSITIVE return qty — the measured negative-qty rule goes unchecked",
    file: MOCK,
    old: "    if (!Number.isFinite(qty) || qty >= 0) {",
    new: "    if (false) {",
    only: "P9-F mock: the create path enforces the rules MEASURED on the real site",
  },
  {
    name: "AB. the mock stops matching the ORIGINAL's price — the fake stops modelling “refund at the sold price”",
    file: MOCK,
    old: "    if (Math.abs(rate - Number(origLine.rate ?? 0)) > 1e-9) {",
    new: "    if (false) {",
    only: "P9-F mock: the create path enforces the rules MEASURED on the real site",
  },
  {
    name: "AC. the mock accepts update_stock=0 — a return that receives nothing passes as one",
    file: MOCK,
    old: "  if (Number(data.update_stock ?? 0) !== 1) {",
    new: "  if (false) {",
    only: "P9-F mock: the create path enforces the rules MEASURED on the real site",
  },
  {
    name: "AD. the mock stops bounding the return by what was SOLD — returning 99 of 10 passes",
    file: MOCK,
    old: "    if (wantBack - (Math.abs(Number(origLine.qty) || 0) - alreadyBack) > 1e-9) {",
    new: "    if (false) {",
    only: "P9-F mock: the create path enforces the rules MEASURED on the real site",
  },
];

process.exit(
  runCases(CASES, { title: "P9-F sales return", nodeFiles: { default: SUITE }, root: PATHS.ROOT }) === 0
    ? 0
    : 1,
);
