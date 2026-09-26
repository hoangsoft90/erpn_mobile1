#!/usr/bin/env node
/**
 * Falsification harness for P5-2 (plan5_final §4.4 posting_date snapshot,
 * §4.2 submit error kind).
 *
 * Two guards, both about a value that decides what the shop's books say, so
 * neither may be decoration:
 *
 *   §4.4 — the posting DAY is frozen into the proposal when it is built and read
 *          back at execute time. If the executor goes back to reading the clock,
 *          a confirm that lands after midnight moves the receipt to the next day
 *          (review2 §9) — and posting_date is what decides which day's takings
 *          the money appears in.
 *   §4.2 — each submit refusal is NAMED (permission / period_locked / workflow /
 *          other) beside ERPNext's verbatim message, so the card can advise.
 *
 * Every case must turn the NAMED test RED. Uses scripts/falsify/lib/harness.mjs,
 * which checks the baseline is green first, reports a moved anchor instead of
 * skipping it, restores the file byte-identically, and restores on Ctrl-C.
 */
import { runCases, PATHS } from "./lib/harness.mjs";

const SRC = "src/skills/payment-write.mjs";
const SUITE = "test/payment-write.test.mjs";

const CASES = [
  {
    name: "A. (§4.4) the executor goes back to the CLOCK — the validated snapshot is ignored",
    file: SRC,
    old: "const postingDate = readPostingDate(proposal, opts.now ?? new Date());",
    new: "const postingDate = shopDay(opts.now ?? new Date());",
    only: "P5-2 §4.4: 23:59 propose ⇒ 00:01 execute writes the PROPOSAL's day",
  },
  {
    name: "B. (§4.4) the proposal stops freezing the day — posting_date never reaches params",
    file: SRC,
    old: "      posting_date: opts.now ? shopDay(opts.now) : shopDay(),\n",
    new: "",
    only: "P5-2 §4.4: the proposal FREEZES posting_date at propose time",
  },
  {
    name: "C. (§4.4) no fallback for cards built before this change (an absent field becomes a refusal)",
    file: SRC,
    old: "  if (raw === undefined || raw === null) return shopDay(now);",
    new: "  if (false) return shopDay(now);",
    only: "P5-2 §4.4: a card built BEFORE this change",
  },
  {
    name: "D. (§4.2) permission refusals are no longer recognised",
    file: SRC,
    old: "  if (/PermissionError|not permitted|no permission|insufficient permission|HTTP 403\\b/i.test(text)) {",
    new: "  if (/NEVER_MATCHES_PERMISSION/i.test(text)) {",
    only: "P5-2 §4.2: submit_error_kind is reported beside the VERBATIM",
  },
  {
    name: "E. (§4.2) period-lock refusals are no longer recognised",
    file: SRC,
    old: "  if (/PeriodClosingVoucher|Period Closing Voucher|period.{0,24}(closed|lock)|closed period|accounting period.{0,24}closed|(khóa|khoá) (sổ|kỳ)/i.test(text)) {",
    new: "  if (/NEVER_MATCHES_PERIODLOCK/i.test(text)) {",
    only: "P5-2 §4.2: submit_error_kind is reported beside the VERBATIM",
  },
  {
    name: "F. (§4.2) workflow refusals are no longer recognised",
    file: SRC,
    old: "  if (/Workflow|workflow state|WorkflowStateError|not allowed to transition|invalid transition|được duyệt/i.test(text)) {",
    new: "  if (/NEVER_MATCHES_WORKFLOW/i.test(text)) {",
    only: "P5-2 §4.2: submit_error_kind is reported beside the VERBATIM",
  },
  {
    name: "G. (§4.2) the UNVERIFIED submit (call reported success, docstatus still 0) loses its kind",
    file: SRC,
    old: '    result.submit_error_kind = "other";',
    new: "",
    only: "P5-2 §4.2: a submit that REPORTS success but leaves docstatus 0",
  },
  {
    name: "H. (review) the ±1-day window is gone — a client may pick any day it likes",
    file: SRC,
    old: "export const POSTING_DATE_MAX_SKEW_DAYS = 1;",
    new: "export const POSTING_DATE_MAX_SKEW_DAYS = 100000;",
    only: "P5-2 review: a posting_date OUTSIDE ±1 day is REFUSED",
  },
  {
    name: "I. (review) the real-date round-trip is dropped — 2026-02-30 rolls over into March",
    file: SRC,
    old: "  if (Number.isNaN(asUtcMidnight.getTime()) || asUtcMidnight.toISOString().slice(0, 10) !== raw) {",
    new: "  if (false) {",
    only: "P5-2 review: a malformed posting_date is REFUSED",
  },
];

// NOTE (measured, not assumed): there is deliberately NO case mutating the
// `^\d{4}-\d{2}-\d{2}$` shape test. Removing it does NOT turn the malformed
// test red — `""` and `"02-01-2026"` are still stopped by the round-trip below
// it, and a non-string by the `typeof`. The regex is therefore a clearer error
// message, not a load-bearing guard, and a case for it would only report
// NOT RED. Recorded so a future reader does not "restore" a case that was never
// real (the P4-3 lesson: a falsify case whose fixture is stopped by a DIFFERENT
// branch proves nothing).

process.exit(
  runCases(CASES, { title: "P5-2 payment snapshot + submit kind", nodeFiles: { default: SUITE }, root: PATHS.ROOT }) === 0
    ? 0
    : 1,
);
