#!/usr/bin/env node
/**
 * Falsification harness for P9-C (extend payment.create to Pay / supplier).
 *
 * This change makes ONE capability write money in TWO directions. Every guard
 * below exists to stop the direction being chosen by the wrong thing, so none of
 * them may be decoration — each one is deleted here and the NAMED test must go
 * red.
 *
 * The measured starting point (2026-09-23, real Phase 1 + router): Phase 1's
 * synonym map rewrites "thu tiền" and "trả tiền" onto the SAME label "payment",
 * so a pay-out order carried no direction of its own and reached the Receive
 * path — which, for a supplier that also exists as a customer, would have
 * written a RECEIPT for a payment. The direction is therefore derived from
 * WHICH MASTER LIST holds the name (data), while the sentence is read only as a
 * contradiction check, never to flip.
 *
 * Uses scripts/falsify/lib/harness.mjs: baseline control first, a moved anchor
 * is reported rather than skipped, restore is byte-identical, Ctrl-C restores.
 */
import { runCases, PATHS } from "./lib/harness.mjs";

const SKILL = "src/skills/payment-write.mjs";
const SERVER = "src/copilot-server.mjs";
const SUITE = "test/p9-pay.test.mjs";

const CASES = [
  {
    name: "A. the pay VERB marker is dropped — a store expense stops being named as one",
    file: SERVER,
    old: 'verbDirection(rawText) === "pay"',
    new: "false",
    only: "P9-C E2E /ask: a pay-out order returns a PAY card",
  },
  {
    name: "B. the spoken amount is NOT stripped before resolving the party — “Hà Tiên 2 triệu” is read as a name",
    file: SERVER,
    old: "const partyText = isPaymentGroup ? textWithoutAmounts(nlp.text, nlp) : nlp.text;",
    new: "const partyText = nlp.text;",
    only: "P9-C E2E /ask: a pay-out order returns a PAY card",
  },
  {
    name: "C. a name held by BOTH masters is no longer refused — the direction gets GUESSED",
    file: SERVER,
    old: 'if (route.group === "payment_write" && customerMatched && supplierMatched) {',
    new: "if (false) {",
    only: "P9-C E2E /ask: a name that is BOTH a customer and a supplier refuses",
  },
  {
    name: "D. the executor stops proving the party really is a SUPPLIER",
    file: SKILL,
    old: "if (!supplierDoc?.name) {",
    new: "if (false) {",
    only: "P9-C false write: no confirm ⇒ 0 documents",
  },
  {
    name: "E. the sentence is allowed to CONTRADICT the master-derived direction",
    file: SKILL,
    old: "if (!fromVerb || fromVerb === masterDirection) return masterDirection;",
    new: "if (true) return masterDirection;",
    only: "P9-C builder: the sentence may CONTRADICT the data, never flip it",
  },
  {
    name: "F. the pay sides are swapped — the money account and the payable trade places",
    file: SKILL,
    old: 'anchor_account_field: "credit_to",\n    money_side: "paid_from",',
    new: 'anchor_account_field: "credit_to",\n    money_side: "paid_to",',
    only: "P9-C E2E /execute: a confirmed PAY writes ONE DRAFT Payment Entry",
  },
  {
    name: "G. the pay direction no longer allocates a PURCHASE invoice",
    file: SKILL,
    old: 'anchor_doctype: "Purchase Invoice",',
    new: 'anchor_doctype: "Sales Invoice",',
    // The anchor doctype reaches ERPNext as `references[].reference_doctype`, so
    // it is asserted at the level where the document is READ BACK (the E2E case),
    // not in the builder test. Measured, not assumed: pointing this case at the
    // builder first reported "NOT RED" — the harness's control step catching a
    // mislabelled case, not a dead guard (P4-3 lesson).
    only: "P9-C E2E /execute: a confirmed PAY writes ONE DRAFT Payment Entry",
  },
  {
    name: "I. the read-back stops proving WHICH WAY the money moved",
    file: SKILL,
    old: "  if (direction) {",
    new: "  if (false) {",
    only: "P9-C verify: the read-back PROVES the direction",
  },
  {
    // P9-D widened the guard above this one (a fully draft-covered invoice is
    // filtered out of `effective` before the target is chosen), so the anchor is
    // the refusal that now carries "nothing left to pay" — same guard, moved.
    name: "H. a supplier with nothing owed no longer refuses — it would write an unallocated advance",
    file: SKILL,
    old: "if (effective.length === 0) {",
    new: "if (false) {",
    only: "P9-C builder: a supplier with NO open invoice refuses instead of writing an advance",
  },
  {
    // P9-D — the money the task exists for. With the cover read neutered, the
    // second /ask proposes the FULL 2.500.000 again: the measured §0 gap.
    name: "K. the DRAFT cover is ignored again — a second /ask re-proposes money a live draft already holds",
    file: SKILL,
    old: "const draftCover = await openDraftCover(skills, party.name, direction);",
    new: "const draftCover = { drawn: new Map(), drafts: [] };",
    only: "P9-D builder: a live draft lowers the proposal to the REMAINDER",
  },
  {
    // The executor half: without the re-derivation the ceiling is the raw GL
    // number, so a card built BEFORE the draft is accepted and the same money is
    // written twice — the double-draft this task closes.
    name: "L. the executor stops re-deriving the cover — a stale card writes the same money again",
    file: SKILL,
    old: "const liveEffective = Math.max(0, liveOutstanding - (liveCover.drawn.get(String(target.name)) ?? 0));",
    new: "const liveEffective = liveOutstanding;",
    only: "P9-D E2E (real mock): a draft written from chat",
  },
  {
    // J (2026-09-24) — the false positive measured on the site's own data: the
    // substring pass matched the span "lý" (from the verb "xử lý") inside the
    // supplier "Đại lý Cám Bình Dương", so a sentence naming a CUSTOMER resolved a
    // SUPPLIER and the direction guard refused a legitimate pay-out. Deleting the
    // length floor must bring that refusal back.
    name: "J. the minimum substring fragment is removed — the verb “xử lý” resolves a supplier again",
    file: SERVER,
    old: "    if (low.length < MIN_SUBSTRING_FRAGMENT) continue;\n",
    new: "",
    only: "P9-C regression: a 2-character fragment of a VERB must not resolve a supplier (measured bug)",
  },
];

process.exit(
  runCases(CASES, { title: "P9-C payment pay-out direction", nodeFiles: { default: SUITE }, root: PATHS.ROOT }) === 0
    ? 0
    : 1,
);
