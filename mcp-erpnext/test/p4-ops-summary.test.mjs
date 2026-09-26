/**
 * P4-1 — ops.daily_summary (plan4_final §4, §7 acceptance cases 1–8, 11–12).
 *
 * The fixture is the 20-document matrix of plan4_review3.md §1.2 (D = the day
 * under test), served by the mock through ONE env-declared JSON object
 * (MOCK_ERP_P4_FIXTURE). Expected numbers are DERIVED from the fixture in this
 * file — the review's own arithmetic misses PE-0006 in Block 3, so §7.12's
 * "don't copy the SQL blind" warning applies to the expected values too.
 *
 * Blocks under test:
 *   A. ROUTING   — the capability is reachable by ID only; no keyword route.
 *   B. CONTRACT  — READ / no confirm / no write executor.
 *   C. AGGREGATE — the §7 acceptance cases with exact expected numbers.
 *   D. PARTIAL   — a failed branch never fabricates a 0 (§4.3).
 *   E. UNCLASSIFIED — money accounts with no account_type stay unclassified.
 *   F. NO-WRITE  — the route exists, no write verb is reachable from it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";
import { routeIntent, routeByCapability } from "../src/router.mjs";
import { getCapability } from "../src/capability-contract.mjs";

const D = "2026-09-21";
const PREV = "2026-09-20";
const NEXT = "2026-09-22";
const COMPANY = "Minh Phát Cám & VLXD";
const CASH_ACC = "1110 - Tiền mặt - MP";
const BANK_ACC = "1210 - ACB 110296868 - MP";
const DEBTORS = "1310 - Phải thu khách hàng - MP";
const PAYABLE = "2110 - Phải trả người bán - MP";

/* ------------------------------------------------------------------ fixture */
/* plan4_review3 §1.2 — 20 documents, dates anchored to D. Expected values in
 * this file are derived from THESE rows (see the derivation comments inline). */

const COMPANY_ROWS = [
  { name: COMPANY, default_cash_account: CASH_ACC, default_bank_account: BANK_ACC, company: COMPANY },
];

const ACCOUNT_ROWS = [
  { name: CASH_ACC, account_type: "Cash", company: COMPANY },
  { name: BANK_ACC, account_type: "Bank", company: COMPANY },
  { name: DEBTORS, account_type: "Receivable", company: COMPANY },
  { name: PAYABLE, account_type: "Payable", company: COMPANY },
  // An untyped money account (no account_type): must stay UNCLASSIFIED.
  { name: "1311 - Két quầy - MP", account_type: null, company: COMPANY },
];

const GL_ROWS = [
  // Opening for the cash account: +5M on D-1 (review3 §1.2 "opening 5.000.000").
  { posting_date: PREV, account: CASH_ACC, debit: 5_000_000, credit: 0, is_cancelled: 0 },
  // A cancelled GL row must NOT move the opening.
  { posting_date: PREV, account: CASH_ACC, debit: 7_000_000, credit: 0, is_cancelled: 1 },
  // Rows after the day do not count toward the opening.
  { posting_date: D, account: CASH_ACC, debit: 1_000_000, credit: 0, is_cancelled: 0 },
];

function so(name, status, grand, docstatus, date = D) {
  return { name, docstatus, status, grand_total: grand, transaction_date: date, company: COMPANY };
}
function si(name, status, grand, extra = {}) {
  return { name, docstatus: 1, status, grand_total: grand, posting_date: D, company: COMPANY, ...extra };
}
function pe(name, type, mode, amount, extra = {}) {
  return {
    name, docstatus: 1, status: "Submitted", posting_date: D, payment_type: type,
    party_type: "Customer", paid_amount: amount, received_amount: amount,
    paid_to: CASH_ACC, paid_from: DEBTORS, company: COMPANY,
    unallocated_amount: 0, mode_of_payment: mode, ...extra,
  };
}

/** review3 §1.2 — the 20 documents (order preserved for the audit trail). */
const SO_ROWS = [
  so("SO-0001", "To Deliver", 50_000_000, 1), // #1 submitted
  so("SO-0002", "Draft", 120_000_000, 0), // #5 draft
];
const SI_ROWS = [
  si("INV-0001", "Paid", 50_000_000), // #2
  si("INV-0002", "Unpaid", 88_000_000), // #4 VAT 8M
  si("INV-0003", "Cancelled", 20_000_000), // #7 cancelled → excluded
  si("INV-0004", "Paid", 20_000_000, { amended_from: "INV-0003" }), // #8 amend → counted once
  si("INV-0005", "Unpaid", 102_600_000), // #10
  si("INV-0006", "Unpaid", 220_000_000), // #13
  si("INV-0007", "Paid", 33_000_000), // #17 POS
  si("SINV-RET-1", "Return", -10_000_000, { is_return: 1 }), // #15 → excluded (§3.5)
];
const PE_ROWS = [
  pe("PE-0001", "Receive", "Cash", 30_000_000, { references: [{ reference_name: "INV-0001" }] }), // #3
  pe("PE-0002", "Receive", "Chuyển khoản", 20_000_000, { paid_to: BANK_ACC, references: [] }), // #6 advance
  pe("PE-0003", "Receive", "Cash", 40_000_000, { references: [{ reference_name: "INV-0002" }] }), // #9
  pe("PE-0004", "Receive", "Cash", -5_000_000, { references: [{ reference_name: "INV-0001" }] }), // #11 refund
  pe("PE-0005", "Pay", "Cash", 8_000_000, { paid_from: CASH_ACC, paid_to: PAYABLE, party_type: "" }), // #12 expense
  pe("PE-0006", "Receive", "Chuyển khoản", 100_000_000, { paid_to: BANK_ACC, references: [{ reference_name: "INV-0006" }] }), // #14
  pe("PE-0007", "Receive", "Cash", 50_000_000, { references: [{ reference_name: "INV-0004" }, { reference_name: "INV-0005" }] }), // #16
  pe("PE-0008", "Receive", "Cash", 33_000_000, { references: [{ reference_name: "INV-0007" }] }), // #18
  pe("PE-0009", "Receive", "Cash", 20_000_000, { references: [] }), // #19 advance
  pe("PE-0010", "Pay", "Wire Transfer", 50_000_000, { paid_from: BANK_ACC, paid_to: PAYABLE, party_type: "Supplier" }), // #20
];

/** The single fixture object one test run shares (per-process env). */
function fixtureEnv(over = {}) {
  const fixture = {
    Company: over.Company ?? COMPANY_ROWS,
    Account: over.Account ?? ACCOUNT_ROWS,
    "GL Entry": over["GL Entry"] ?? GL_ROWS,
    "Sales Order": over["Sales Order"] ?? SO_ROWS,
    "Sales Invoice": over["Sales Invoice"] ?? SI_ROWS,
    "Payment Entry": over["Payment Entry"] ?? PE_ROWS,
  };
  return { ...process.env, MOCK_ERP_P4_FIXTURE: JSON.stringify(fixture) };
}

/** A skill-layer client wired to the fixture; returns the summary directly. */
async function withFixture(over, fn) {
  const client = createMcpClient({
    serverScript: MOCK_SERVER,
    env: fixtureEnv(over),
  });
  try {
    await client.initialize();
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function summaryFor(client, opts = {}) {
  const { getDailySummary } = await import("../src/skills/ops-summary.mjs");
  return getDailySummary(client, { date: D, company: COMPANY, ...opts });
}

/* -------------------------------------------------------------- A. routing */

test("P4 routing: ops.daily_summary has NO keyword route — drawer reaches it by id only", () => {
  // Free text that a naive keyword table would steal:
  for (const text of ["tổng hợp ngày", "tóm tắt hôm nay", "doanh thu hôm nay", "thu chi hôm nay"]) {
    const hit = routeIntent(text);
    // None of these may land on the ops group (they stay whatever they were
    // before P4 — mostly inventory/customer — or null).
    if (hit) assert.notEqual(hit.capability, "ops.daily_summary", `"${text}" must not route to ops`);
  }
  const byId = routeByCapability("ops.daily_summary");
  assert.equal(byId.capability, "ops.daily_summary");
  assert.equal(byId.group, "ops");
  assert.equal(byId.forbidden, false);
  assert.equal(typeof byId.factory, "function");
});

/* ----------------------------------------------------------- B. contract */

test("P4 contract: READ, no confirmation, no write executor, company scoped", () => {
  const cap = getCapability("ops.daily_summary");
  assert.equal(cap.type, "READ");
  assert.equal(cap.risk.level, "READ");
  assert.equal(cap.risk.requires_confirmation, false);
  assert.equal(cap.authorization.scope.company, "required");
  assert.equal(cap.confirmation, null);
  assert.ok(!cap.execution?.write_doctype, "a READ must not declare a write doctype");
  assert.ok(Array.isArray(cap.errors) && cap.errors.includes("ERP_UNAVAILABLE"));
});

/* --------------------------------------------------------- C. aggregates */

test("P4 §7.1: SO and SI amounts differ for the same day (two blocks, two truths)", async () => {
  await withFixture({}, async (client) => {
    const s = await summaryFor(client);
    assert.equal(s.sales_orders.submitted.amount, 50_000_000);
    assert.equal(s.sales_invoices.amount, 513_600_000); // ≠ 50M ⇒ blocks differ
    assert.equal(s.meta.partial, false);
    assert.deepEqual(s.meta.errors, []);
  });
});

test("P4 §10.1 + review3 §1.3: SO submitted vs draft are SEPARATE, draft never merged", async () => {
  await withFixture({}, async (client) => {
    const s = await summaryFor(client);
    assert.deepEqual(s.sales_orders.submitted, { count: 1, amount: 50_000_000 });
    assert.deepEqual(s.sales_orders.draft, { count: 1, amount: 120_000_000 });
  });
});

test("P4 §3.1b: cancelled excluded, amended counted once (INV-0003 → INV-0004)", async () => {
  await withFixture({}, async (client) => {
    const s = await summaryFor(client);
    // 6 active: INV-0001, 0002, 0004, 0005, 0006, 0007 — INV-0003 excluded.
    assert.equal(s.sales_invoices.count, 6);
    // 50 + 88 + 20 + 102.6 + 220 + 33 = 513.6M (grand_total per §10.5).
    assert.equal(s.sales_invoices.amount, 513_600_000);
  });
});

test("P4 §3.5: returns/credit notes never inflate the invoice amount", async () => {
  await withFixture({}, async (client) => {
    const s = await summaryFor(client);
    assert.equal(s.sales_invoices.amount, 513_600_000); // the -10M return row is OUT
    assert.equal(s.returns, null); // §3.5: null, never a fabricated 0
  });
});

test("P4 §3.2 + §1.3: receipts split against_invoice vs advances, cash vs bank", async () => {
  await withFixture({}, async (client) => {
    const s = await summaryFor(client);
    const r = s.receipts;
    // against_invoice = PE-0001 30M + PE-0003 40M + PE-0004 (−5M refund) +
    // PE-0006 100M + PE-0007 50M + PE-0008 33M = 248M
    // (the review's own 153M "forgets" PE-0006 — not copied, §7.12).
    assert.equal(r.against_invoice, 248_000_000);
    // advances = PE-0002 20M + PE-0009 20M = 40M.
    assert.equal(r.advances, 40_000_000);
    // cash side = 30+40−5+50+33 (against) + 20 (advance) = 168M.
    assert.equal(r.cash, 168_000_000);
    // bank side = 100 (PE-0006) + 20 (PE-0002) = 120M.
    assert.equal(r.bank, 120_000_000);
    assert.equal(r.total, 288_000_000);
  });
});

test("P4 §7.3 + P4-0 lesson: 'Chuyển khoản' (mode type=Cash) lands in BANK by account_type", async () => {
  await withFixture({}, async (client) => {
    const s = await summaryFor(client);
    // PE-0002 + PE-0006 use the mode whose MoP.type is Cash on the real site,
    // but their money account is the ACB bank account — the classifier follows
    // the account, not the mode (docs/plan4-mode-map.md).
    assert.equal(s.receipts.bank, 120_000_000);
    assert.equal(s.receipts.cash, 168_000_000);
  });
});

test("P4 §7.2: payments_out = PE Pay only, with the JE footnote (§10.2)", async () => {
  await withFixture({}, async (client) => {
    const s = await summaryFor(client);
    // PE-0005 8M cash + PE-0010 50M bank.
    assert.deepEqual(
      { cash: s.payments_out.cash, bank: s.payments_out.bank, total: s.payments_out.total },
      { cash: 8_000_000, bank: 50_000_000, total: 58_000_000 },
    );
    assert.equal(s.payments_out.includes_journal_entry, false);
    assert.equal(s.payments_out.footnote, "Chưa gồm chi qua Journal Entry");
  });
});

test("P4 §7.12 + §3.6: cash drawer opening from GL, cancelled GL ignored, inflows from THIS response", async () => {
  await withFixture({}, async (client) => {
    const s = await summaryFor(client);
    const k = s.cash_drawer;
    assert.ok(k, "both companies have default_cash_account (P4-0) — the block must exist");
    assert.equal(k.opening, 5_000_000); // cancelled +7M GL row and today's +1M row excluded
    assert.equal(k.cash_in_today, 168_000_000); // the receipts cash side
    assert.equal(k.cash_out_today, 8_000_000); // the payments_out cash side
    assert.equal(k.expected_closing, 165_000_000); // 5 + 168 − 8
    assert.equal(k.account, CASH_ACC);
    assert.equal(k.includes_bank, false);
  });
});

test("P4 §3.6/§10.3: no default_cash_account on the company ⇒ cash_drawer = null (hidden, not 0)", async () => {
  await withFixture({ Company: [{ name: COMPANY, default_cash_account: null, default_bank_account: null, company: COMPANY }] }, async (client) => {
    const s = await summaryFor(client);
    assert.equal(s.cash_drawer, null);
  });
});

test("P4: untyped money account stays unclassified — never guessed into cash/bank", async () => {
  await withFixture(
    {
      "Payment Entry": [
        pe("PE-X", "Receive", "Cash", 12_000_000, { paid_to: "1311 - Két quầy - MP", references: [] }),
      ],
    },
    async (client) => {
      const s = await summaryFor(client);
      assert.equal(s.receipts.unclassified, 12_000_000);
      assert.equal(s.receipts.cash, 0); // this PE is NOT silently cash
      assert.equal(s.cash_drawer.cash_in_today, 0); // the két only counts real cash-side money
    },
  );
});

test("P4 §7.4: draft SI never enters sales_invoices (policy is submitted-only)", async () => {
  await withFixture(
    {
      "Sales Invoice": [
        si("INV-DRAFT", "Draft", 99_000_000, { docstatus: 0 }),
        si("INV-OK", "Paid", 10_000_000),
      ],
    },
    async (client) => {
      const s = await summaryFor(client);
      assert.deepEqual(s.sales_invoices, { count: 1, amount: 10_000_000, includes_draft: false });
    },
  );
});

test("P4 §7.8: the same PE cannot be counted twice (idempotent aggregation)", async () => {
  await withFixture(
    {
      "Payment Entry": [pe("PE-DUP", "Receive", "Cash", 20_000_000, { references: [] })],
    },
    async (client) => {
      const first = await summaryFor(client);
      const second = await summaryFor(client);
      assert.equal(first.receipts.advances, 20_000_000);
      assert.deepEqual(second.receipts, first.receipts); // read-only, no side effects
    },
  );
});

test("P4 §3.4: receivables are CURRENT (outstanding > 0 only), overdue by due_date", async () => {
  await withFixture(
    {
      "Sales Invoice": [
        si("INV-A", "Unpaid", 88_000_000, { outstanding_amount: 88_000_000, due_date: PREV }),
        si("INV-B", "Unpaid", 33_000_000, { outstanding_amount: 33_000_000, due_date: NEXT }),
        si("INV-C", "Paid", 50_000_000, { outstanding_amount: 0 }),
        si("INV-NET", "Credit Note Issued", -320_000, { outstanding_amount: -320_000 }),
      ],
    },
    async (client) => {
      const s = await summaryFor(client);
      assert.equal(s.receivables.outstanding_total, 121_000_000); // negative netted OUT (result20)
      assert.equal(s.receivables.overdue_total, 88_000_000);
      assert.equal(s.receivables.overdue_count, 1);
      assert.equal(s.receivables.as_of, "current");
    },
  );
});

/* ------------------------------------------------------------ D. partial */

test("P4 §4.3 partial: a REAL failing invoices branch → partial:true, receipts stay real", async () => {
  // A genuinely failing SI read: the fixture handler receives the string
  // "__BROKEN__" (not an array) and its .filter throws — like a real site
  // failing on an unreadable field. (A MISSING key is honestly an empty day,
  // which is a different, passing case — see the §7.4 empty-day shapes.)
  await withFixture(
    { "Sales Invoice": "__BROKEN__" },
    async (client) => {
      const s = await summaryFor(client);
      const siErr = s.meta.errors.find((e) => e.block === "sales_invoices");
      assert.ok(siErr, "the failing SI branch must be recorded");
      assert.equal(siErr.code, "ERP_UNAVAILABLE");
      assert.equal(s.meta.partial, true);
      // §4.3 literal: the failed block is NULL (UI shows "Lỗi · Thử lại"),
      // the surviving blocks stay REAL — no cascade, no invented zeros.
      assert.equal(s.sales_invoices, null);
      assert.equal(s.sales_orders.submitted.count, 1);
      assert.equal(s.receipts.total, 288_000_000);
    },
  );
});

test("P4 §7.6: a doctype the user may NOT read is a NULL block — never an empty 0-day", async () => {
  // A permission denial (Frappe PermissionError / 403) is a DIFFERENT shape from
  // an empty page, and the difference is money: an empty page is a real "0
  // today", a denial is "I was not allowed to look". Collapsing the second into
  // the first is the fabricated 0 §4.3 forbids — the owner would read "hôm nay
  // chưa bán được gì" when the truth is "không đọc được".
  await withFixture(
    { "Sales Invoice": "__FORBIDDEN__" },
    async (client) => {
      const s = await summaryFor(client);
      // The answer still comes back (no crash) and says it is incomplete.
      assert.equal(s.meta.partial, true);
      // The denied block is NULL, explicitly not 0.
      assert.equal(s.sales_invoices, null, "a denied read must never become 0");
      assert.notEqual(s.sales_invoices, 0);
      // receivables reads the SAME doctype ⇒ it is denied too, and equally null.
      // (Two blocks failing from one denial is honest; inventing a 0 for either
      // would not be.)
      assert.equal(s.receivables, null, "the second SI-dependent block is null too");
      const err = s.meta.errors.find((e) => e.block === "sales_invoices");
      assert.ok(err, "the denial is recorded as a block error");
      // The REASON survives to the UI, so "Lỗi · Thử lại" can say why.
      assert.match(err.detail, /permitted|permission/i);
      // No cascade into blocks that do not depend on that doctype.
      assert.equal(s.sales_orders.submitted.count, 1);
      assert.equal(s.receipts.total, 288_000_000);
    },
  );
});

test("P4 §7.6 (real shape): the REAL client's 403 message must pass the same denial regex", async () => {
  // The sentinel above throws "PermissionError: Not permitted to read …" — the
  // SHAPE (throw) matches the pinned 3.0.4 client (it throws FrappeAPIError on
  // !response.ok), but the real message text is built by the client as
  // `[FrappeClient] <METHOD> <path> failed: <frappe message> (HTTP 403)`. This
  // test pins the contract against that exact text, so the denial regex in the
  // UI-facing detail cannot quietly match only the mock's wording.
  const { getDailySummary } = await import("../src/skills/ops-summary.mjs");
  const failing = new Error(
    "[FrappeClient] GET /api/resource/Sales Invoice failed: Not permitted to read Sales Invoice. Please enable role permissions (HTTP 403)",
  );
  failing.status = 403;
  const stub = {
    callTool: async (tool, args) => {
      if (tool === "erpnext_doc_list" && args?.doctype === "Sales Invoice") throw failing;
      // Company lookup still succeeds: only SI is denied.
      if (tool === "erpnext_doc_list" && args?.doctype === "Company") {
        return { data: { doctype: "Company", count: 1, data: [{ name: COMPANY, default_cash_account: null }] } };
      }
      return { data: { doctype: args?.doctype, count: 0, data: [] } };
    },
  };
  const s = await getDailySummary(stub, { date: D, company: COMPANY });
  assert.equal(s.meta.partial, true);
  assert.equal(s.sales_invoices, null);
  assert.equal(s.receivables, null);
  const err = s.meta.errors.find((e) => e.block === "sales_invoices");
  assert.ok(err, "the denial is recorded");
  // THE assertion the whole case exists for: the REAL text matches what the UI shows.
  assert.match(err.detail, /permitted|permission/i);
});

test("P4 §4.3 partial: account+company lookups failing ⇒ unclassified, drawer hidden — never guessed cash", async () => {
  // "__BROKEN__" is not an array ⇒ the fixture handler's .filter throws ⇒ the
  // branches genuinely fail (undefined keys would just be DROPPED by the
  // fixtureEnv spread and the full fixture would be served — not a failure).
  const brokenLookups = { Account: "__BROKEN__", Company: "__BROKEN__", "GL Entry": "__BROKEN__" };
  await withFixture(brokenLookups, async (client) => {
    const s = await summaryFor(client);
    assert.ok(s.meta.errors.find((e) => e.block === "accounts"), "accounts branch failure recorded");
    assert.ok(s.meta.errors.find((e) => e.block === "company_defaults"), "company_defaults branch failure recorded");
    assert.equal(s.receipts.unclassified, s.receipts.total, "no account data ⇒ nothing may be called cash/bank");
    assert.equal(s.cash_drawer, null, "company defaults failed ⇒ no opening ⇒ block hidden");
    assert.equal(s.meta.partial, true);
  });
});

test("P4 §4.3: every backbone block down ⇒ every block null + errors recorded — NEVER a half-invented summary", async () => {
  // Site fully down (callTool always throws). Per the §4.3 partial policy the
  // call still ANSWERS — but every failed block is null and partial=true with
  // one error row per failed branch. Nothing invented, nothing fake-0.
  const { getDailySummary } = await import("../src/skills/ops-summary.mjs");
  const boom = { callTool: async () => { throw new Error("site down"); } };
  const s = await getDailySummary(boom, { date: D, company: COMPANY });
  assert.equal(s.meta.partial, true);
  // app_drafts belongs in this list too: it USED to absorb its own failures
  // with an inner try/catch and answer "0 nháp", which is exactly the
  // fabricated zero §4.3 forbids — measured on the real site the correlation
  // field is missing on 3 of its 4 doctypes, so that 0 was the common case.
  const blocks = ["sales_orders", "sales_invoices", "receipts", "receivables", "app_drafts", "cash_drawer"];
  for (const b of blocks) assert.equal(s[b], null, `${b} must be null when its read failed`);
  assert.ok(s.meta.errors.length >= 5, "each failed branch is recorded (≥5, lookups included)");
  for (const e of s.meta.errors) assert.equal(e.code, "ERP_UNAVAILABLE");
});

test("P4 §4.3 + measured real-tool behaviour: a TRUNCATED page fails the block — it never sums a partial set", async () => {
  // The real tool returns `count` = the number of rows RETURNED (measured
  // 2026-09-21: limit 3 → count 3), so a full page and a truncated page are
  // indistinguishable from the payload alone. The skill therefore asks for
  // limit+1 and refuses to aggregate when it gets one row more than it accepts:
  // 1001 Sales Orders against its 1000-row page.
  const { getDailySummary } = await import("../src/skills/ops-summary.mjs");
  const many = Array.from({ length: 1001 }, (_, i) => ({
    name: `SO-${i}`,
    docstatus: 1,
    status: "To Deliver and Bill",
    grand_total: 1_000,
    transaction_date: D,
    company: COMPANY,
  }));
  const client = {
    callTool: async (_tool, args) => ({
      data: { doctype: args.doctype, count: many.length, data: args.doctype === "Sales Order" ? many : [] },
    }),
  };
  const s = await getDailySummary(client, { date: D, company: COMPANY });
  assert.equal(s.sales_orders, null, "a truncated page must not be summed into a money number");
  assert.equal(s.meta.partial, true);
  assert.ok(
    s.meta.errors.some((e) => e.block === "sales_orders" && /ERP_TRUNCATED/.test(e.detail)),
    "the truncation must be recorded, not silently swallowed",
  );
});

/* The numeric-filter-literal invariant is repo-wide, so it lives in ONE place:
 * test/filter-literal-types.test.mjs (scans all of src/ — it is what catches
 * `filters: [["docstatus","=",1]]` here and `[["selling","=",1]]` in the
 * sales-order/quotation writers). Not duplicated here. */

test("P4: a malformed ERP payload fails the block with a CLEAR error, never iterates garbage", async () => {
  // The list tool can answer with something that is not a row array (site error
  // object, a string). Iterating that would classify invented data, so docList
  // throws ERP_MALFORMED_RESPONSE — asserted here on the message, because
  // without the guard a downstream TypeError would also be caught and the two
  // cases would look identical.
  const { getDailySummary } = await import("../src/skills/ops-summary.mjs");
  const client = {
    callTool: async (_tool, args) => ({ data: args.doctype === "Sales Order" ? "Internal Server Error" : { doctype: args.doctype, count: 0, data: [] } }),
  };
  const s = await getDailySummary(client, { date: D, company: COMPANY });
  assert.equal(s.sales_orders, null);
  const err = s.meta.errors.find((e) => e.block === "sales_orders");
  assert.ok(err, "the malformed read is recorded");
  assert.match(err.detail, /ERP_MALFORMED_RESPONSE/);
});

test("P4: missing date or company is refused (no implicit defaults in the skill)", async () => {
  const { getDailySummary } = await import("../src/skills/ops-summary.mjs");
  await assert.rejects(() => getDailySummary({ callTool: async () => ({ data: [] }) }, { company: COMPANY }), /OPS_DATE_REQUIRED/);
  await assert.rejects(() => getDailySummary({ callTool: async () => ({ data: [] }) }, { date: D }), /COMPANY_UNRESOLVED/);
});

/* ------------------------------------------------------- G. provenance */

test("P4 provenance: meta.erp_target is PASSED THROUGH, and null when nobody said", async () => {
  // The label is what the app's footer prints next to the numbers. Two rules:
  //  - never GUESS it: with no erpTarget the field is null ("không rõ nguồn"),
  //    because a fabricated "REAL" on unfamiliar data is exactly the class of
  //    lie this project refuses;
  //  - pass through VERBATIM, so the value can only come from
  //    copilot-server.mjs#erpTargetLabel (test/target.test.mjs ties it to the
  //    switch that picks the server).
  const { getDailySummary } = await import("../src/skills/ops-summary.mjs");
  const client = { callTool: async (_t, args) => ({ data: { doctype: args.doctype, count: 0, data: [] } }) };
  const unpinned = await getDailySummary(client, { date: D, company: COMPANY });
  assert.equal(unpinned.meta.erp_target, null, "never invented");
  const mock = await getDailySummary(client, { date: D, company: COMPANY, erpTarget: "MOCK" });
  assert.equal(mock.meta.erp_target, "MOCK");
  const real = await getDailySummary(client, { date: D, company: COMPANY, erpTarget: "REAL" });
  assert.equal(real.meta.erp_target, "REAL");
});

/* ----------------------------------------------------------- F. no-write */

test("P4 §7.9/§7.10: the ops path carries no /execute, no callWriteTool, no command_id", async () => {
  const { getDailySummary } = await import("../src/skills/ops-summary.mjs");
  const seenTools = [];
  const recording = {
    callTool: async (tool) => {
      seenTools.push(tool);
      return { __untrusted: true, source: tool, data: { data: [] } };
    },
  };
  await getDailySummary(recording, { date: D, company: COMPANY });
  assert.ok(seenTools.length > 0, "the summary must actually read through the client");
  for (const tool of seenTools) {
    assert.ok(!/create|update|submit|cancel|delete|insert/.test(tool), `tool ${tool} must be read-only`);
  }
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/skills/ops-summary.mjs", import.meta.url), "utf8");
  // Strip comments: the doc-block EXPLAINS why callWriteTool must stay out;
  // the assert is about CODE references, not documentation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!code.includes("callWriteTool"), "ops-summary must not reference the write path in code");
});
