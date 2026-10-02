/**
 * next8 / Phase 1 — TRANSACTION DRAFT primitives (plan §7/§11/§12; lock §6.1/§6.3).
 *
 * Two kinds of assertion live here:
 *   1. the RULES: one payment method per collect, allocations mandatory whenever
 *      something is open and legal-to-empty when nothing is, per-invoice ceilings,
 *      and a server-computed summary that a client's number can only contradict
 *      (never set);
 *   2. the ABSENCE of the rule the plan forbids: no FIFO/oldest/first helper exists
 *      in the module. That one is asserted against the SOURCE, because "there is no
 *      function" is not something a runtime import can prove — a future edit that
 *      adds one would otherwise be invisible.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DRAFT_CODES,
  MAX_METHODS_PER_TRANSACTION,
  buildTransactionSummary,
  invoiceAllocation,
  paymentMethod,
  transactionItem,
  validateAllocations,
  validatePaymentMethods,
  validateTransactionDraft,
} from "../src/transaction-draft.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRAFT_SOURCE = readFileSync(path.resolve(HERE, "../src/transaction-draft.mjs"), "utf8");

const OPEN = [
  { invoice_id: "SINV-0001", outstanding_vnd: 2_500_000 },
  { invoice_id: "SINV-0003", outstanding_vnd: 7_500_000 },
];

const cash = (amount) => ({ mode: "cash", amount });
const bank = (amount) => ({ mode: "bank_transfer", amount });

test("primitives refuse malformed money (integer VND only — plan §26)", () => {
  assert.deepEqual(paymentMethod(cash(500_000)), { mode: "cash", amount: 500_000, account_id: null });
  assert.throws(() => paymentMethod({ mode: "credit", amount: 1 }), (e) => e.code === DRAFT_CODES.METHOD_MODE_INVALID);
  assert.throws(() => paymentMethod({ mode: "cash", amount: 1.5 }), (e) => e.code === DRAFT_CODES.AMOUNT_INVALID);
  assert.throws(() => invoiceAllocation({ invoice_id: "", allocated_amount: 1 }), (e) => e.code === DRAFT_CODES.ALLOCATION_REQUIRED);
  assert.throws(() => transactionItem({ item_id: "ITEM-1", qty: 0 }), (e) => e.code === DRAFT_CODES.AMOUNT_INVALID);
});

test("lock §6.1 — exactly ONE payment method per collect, enforced server-side", () => {
  assert.equal(MAX_METHODS_PER_TRANSACTION, 1);
  assert.equal(validatePaymentMethods([cash(500_000)]).ok, true);
  const two = validatePaymentMethods([cash(300_000), bank(200_000)]);
  assert.equal(two.ok, false);
  assert.equal(two.code, DRAFT_CODES.METHOD_COUNT_INVALID);
  assert.match(two.reason, /một hình thức thanh toán/);
  // The same rule twice (two cash rows) is also refused — the limit is on ROWS.
  assert.equal(validatePaymentMethods([cash(1), cash(1)]).ok, false);
  // A future screen may lift the limit via the parameter, WITHOUT editing collect's rule.
  assert.equal(validatePaymentMethods([cash(1), bank(1)], { maxMethods: 2 }).ok, true);
});

test("lock §6.3 — allocations are mandatory with open invoices, and legal-to-empty without", () => {
  const missing = validateAllocations([], { openInvoices: OPEN });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, DRAFT_CODES.ALLOCATION_REQUIRED);
  assert.match(missing.reason, /không tự chọn giúp/, "the refusal says the system will not pick for the user");

  const onAccount = validateAllocations([], { openInvoices: [] });
  assert.equal(onAccount.ok, true);
  assert.deepEqual(onAccount.allocations, []);

  // Nothing open but allocations given ⇒ the invoice cannot exist; refuse instead
  // of writing money against a document the server cannot see.
  const unknownTarget = validateAllocations([{ invoice_id: "SINV-9999", allocated_amount: 1 }], { openInvoices: [] });
  assert.equal(unknownTarget.ok, false);
  assert.equal(unknownTarget.code, DRAFT_CODES.ALLOCATION_EXCEEDS);
});

test("per-invoice ceilings and duplicate targets", () => {
  const over = validateAllocations([{ invoice_id: "SINV-0001", allocated_amount: 2_500_001 }], { openInvoices: OPEN });
  assert.equal(over.ok, false);
  assert.equal(over.code, DRAFT_CODES.ALLOCATION_EXCEEDS);

  const dup = validateAllocations(
    [{ invoice_id: "SINV-0001", allocated_amount: 1 }, { invoice_id: "SINV-0001", allocated_amount: 1 }],
    { openInvoices: OPEN },
  );
  assert.equal(dup.ok, false);
  assert.equal(dup.code, DRAFT_CODES.DUPLICATE_INVOICE);

  const notMine = validateAllocations([{ invoice_id: "SINV-0003", allocated_amount: 1 }], { openInvoices: OPEN.slice(0, 1) });
  assert.equal(notMine.ok, false);
  assert.equal(notMine.code, "NO_MATCH");
});

test("the whole draft: totals must match, and a client's total is only ever a claim", () => {
  const mismatched = validateTransactionDraft(
    { payment_methods: [cash(300_000)], allocations: [{ invoice_id: "SINV-0001", allocated_amount: 500_000 }] },
    { openInvoices: OPEN },
  );
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, DRAFT_CODES.TOTAL_MISMATCH);

  const claimedWrong = validateTransactionDraft(
    { payment_methods: [cash(500_000)], allocations: [{ invoice_id: "SINV-0001", allocated_amount: 500_000 }] },
    { openInvoices: OPEN, claimedTotalVnd: 499_999 },
  );
  assert.equal(claimedWrong.ok, false);
  assert.equal(claimedWrong.code, DRAFT_CODES.CLIENT_AUTHORITY);

  const good = validateTransactionDraft(
    { payment_methods: [cash(500_000)], allocations: [{ invoice_id: "SINV-0001", allocated_amount: 500_000 }] },
    { openInvoices: OPEN, claimedTotalVnd: 500_000 },
  );
  assert.equal(good.ok, true);
  assert.equal(good.summary.payment_total_vnd, 500_000);
  assert.equal(good.summary.allocated_total_vnd, 500_000);
  assert.equal(good.summary.unallocated_vnd, 0);
});

test("the on-account draft (0 open invoices) is legal and reads as unallocated money", () => {
  const verdict = validateTransactionDraft(
    { payment_methods: [bank(300_000)], allocations: [] },
    { openInvoices: [] },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.allocations.length, 0);
  assert.equal(verdict.summary.unallocated_vnd, 300_000, "the whole receipt is unallocated (advance)");
});

test("summary keeps the two discount layers apart and never invents a channel for credit", () => {
  const s = buildTransactionSummary({
    items: [
      { qty: 2, unit_price: 100_000, line_discount: 20_000 },
      { qty: 1, unit_price: 50_000, line_discount: 0 },
    ],
    orderDiscount: 10_000,
    paymentMethods: [cash(100_000)],
    allocations: [{ allocated_amount: 100_000 }],
  });
  // 2×100.000 − 20.000 + 1×50.000 = 230.000; minus the 10.000 order discount = 220.000
  assert.equal(s.subtotal_vnd, 230_000, "line discounts are inside the subtotal");
  assert.equal(s.line_discount_vnd, 20_000);
  assert.equal(s.order_discount_vnd, 10_000, "the order discount is reported separately, never merged");
  assert.equal(s.total_vnd, 220_000);
  assert.equal(s.payment_total_vnd, 100_000);
  assert.equal(s.outstanding_after_vnd, 120_000, "credit remainder is a NUMBER, not a payment method");
  assert.equal("credit" in s, false);
});

test("TRIPWIRE: no auto-allocation helper exists anywhere in the module (plan §2.1(11)/§8.2/§9)", () => {
  // Comments are stripped first on purpose: the module's own header NAMES the
  // forbidden rules in order to explain their absence, and a tripwire that cannot
  // tell `// no FIFO here` from `const fifo = …` fires on its own documentation.
  const code = DRAFT_SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const banned = [/\bfifo\b/i, /\boldest\b/i, /\bfirst_open\b/i, /\bnewest\b/i, /sort\(/, /reduce\(.*outstanding/];
  const offenders = banned.filter((re) => re.test(code));
  assert.deepEqual(offenders.map(String), [], "the draft module must never order or auto-pick invoices");
  // The single legitimate sort in the whole system lives in the OLD builder (the
  // one Phase 0 classified WRONG and Phase 3 removes), never here.
  assert.equal(code.includes("posting_date"), false);
});
