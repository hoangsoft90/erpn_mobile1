#!/usr/bin/env node
/**
 * Falsification harness for P9-D (`sales_invoice.create` — the draft Sales
 * Invoice). Each case deletes ONE guard and the NAMED test must go red.
 *
 * Why this file exists rather than a one-off script: a guard nobody can re-run
 * is decoration, and P9-B taught the harder half of the lesson — a mutation that
 * comes back GREEN can mean the guard is dead OR that the case points at the
 * wrong test. Both are reported here, and the anchor/restore discipline lives in
 * `lib/harness.mjs` (baseline control first, moved anchor reported, restore
 * byte-identical, Ctrl-C restores).
 *
 * What is being defended, in the order the money appears:
 *
 *  - the ROUTING half: an invoice COMMAND opens a card, an invoice QUESTION
 *    stays a read (`notIf` only ever applies when the group has `startsWith`);
 *  - the PRICE half: the order's rate is re-derived at execute, so a crafted
 *    card cannot choose what the shop charges;
 *  - the DRAFT half: what an open draft invoice already claims is subtracted at
 *    build AND re-checked at execute (a card can be ten minutes old);
 *  - the STOCK half: `update_stock: 0` is sent, and the read-back proves the
 *    site kept it — a stock-updating invoice books revenue with no COGS;
 *  - the EVIDENCE half: the read-back is what we believe, so a site that stores
 *    a different document (fewer lines, a re-derived price) must be caught;
 *  - the ONCE-ONLY half: without the correlation field there is no server-side
 *    dedup, so nothing may be written;
 *  - and the card must never offer a submit the path cannot perform.
 */
import { runCases, PATHS } from "./lib/harness.mjs";

const SKILL = "src/skills/sales-invoice-write.mjs";
const CONTRACT = "capabilities.json";
const SUITE = "test/p9-d-sales-invoice.test.mjs";

const CASES = [
  {
    name: "A. the write group no longer requires a LEADING verb — “xuất hóa đơn cho Lan chưa” opens a HIGH card",
    file: CONTRACT,
    // `notIf` is only consulted when the group declares `startsWith` (the B4
    // lesson, re-measured then written into the contract's own comment). Killing
    // `startsWith` therefore kills the deny-list with it, which is exactly the
    // coupling worth pinning: a question must never become an invoice.
    old: '      "startsWith": true,\n      "notIf": "chưa|chua |bao nhiêu',
    new: '      "startsWith": false,\n      "notIf": "chưa|chua |bao nhiêu',
    only: "P9-D routing: invoice COMMANDS reach sales_invoice.create; invoice QUESTIONS stay reads",
  },
  {
    name: "B. the card offers a submit the path cannot do (submit_now flipped on)",
    file: SKILL,
    old: "      submit_now: false,",
    new: "      submit_now: true,",
    only: "P9-D builder: the ORDER's own lines and PRICES build the draft invoice",
  },
  {
    name: "C. the payload stops sending update_stock 0 — a chat invoice would move stock",
    file: SKILL,
    old: "    update_stock: 0,",
    new: "    update_stock: 1,",
    only: "P9-D E2E /execute: a confirmed invoice writes ONE DRAFT",
  },
  {
    name: "D. the read-back stops proving the stock flag survived — a site that moved stock passes",
    file: SKILL,
    old: "  if (Number(doc.update_stock ?? 0) !== 0) {",
    new: "  if (false) {",
    only: "P9-D verify: a site that IGNORES update_stock is caught by the read-back",
  },
  {
    name: "E. the read-back stops comparing line COUNT — a silently dropped line passes",
    file: SKILL,
    old: "  if (gotLines.length !== lines.length) {",
    new: "  if (false) {",
    only: "P9-D verify: a site that stores FEWER lines than we sent is caught by the read-back",
  },
  {
    name: "F. the read-back stops comparing the PRICE — a re-derived rate passes",
    file: SKILL,
    old: "      if (Math.abs(Number(got.rate) - Number(want.rate)) > 1e-9) problems.push(`${want.item_code}: rate=${got.rate}`);",
    new: "      if (false) problems.push(`${want.item_code}: rate=${got.rate}`);",
    only: "P9-D verify: a site that re-derived the PRICE is caught by the read-back",
  },
  {
    name: "G. the executor stops re-deriving the ORDER's price — a crafted rate is adopted",
    file: SKILL,
    old: "    if (Math.abs(Number(want.rate) - line.rate) > EPS) {",
    new: "    if (false) {",
    only: "P9-D false write: a crafted proposal cannot choose the document or the price",
  },
  {
    name: "H. no correlation field is no longer a refusal — a write happens with no server-side dedup",
    file: SKILL,
    old: "  if (probe.correlation_field_unavailable) {",
    new: "  if (false) {",
    only: "P9-D correlation: without the Custom Field the executor refuses BEFORE writing",
  },
  {
    name: "I. the BUILDER stops subtracting open draft invoices — the same money is proposed twice",
    file: SKILL,
    old: "  const pending = subtractDrawn(rawPending, draftCover.drawn);",
    new: "  const pending = rawPending;",
    only: "P9-D builder: an OPEN DRAFT invoice already claiming the order is subtracted",
  },
  {
    name: "J. the EXECUTOR stops re-checking open drafts — a ten-minute-old card duplicates a live draft",
    file: SKILL,
    old: "  const pending = so?.name ? subtractDrawn(pendingRaw, draftCover.drawn) : [];",
    new: "  const pending = so?.name ? pendingRaw : [];",
    only: "P9-D builder: the EXECUTOR re-check also subtracts open drafts",
  },
  {
    name: "K. the payload stops linking each line to its order — the invoice bills nothing",
    file: SKILL,
    old: "      uom: l.uom,\n      sales_order: salesOrder,",
    new: "      uom: l.uom,",
    only: "P9-D E2E /execute: a confirmed invoice writes ONE DRAFT",
  },
];

process.exit(
  runCases(CASES, { title: "P9-D sales invoice", nodeFiles: { default: SUITE }, root: PATHS.ROOT }) === 0
    ? 0
    : 1,
);
