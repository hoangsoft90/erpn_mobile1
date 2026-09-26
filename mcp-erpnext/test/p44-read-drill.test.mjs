/**
 * P4-4 — `GET|POST /read/drill` (plan4_final §4.4).
 *
 * What this file proves, and why each part needs to be here:
 *
 *  1. CLOSED SET: the input is an id, never a phrase. §4.4 forbids the default
 *     path of "inject free text → classifier → guess the capability", so an
 *     undeclared id is refused and the route holds no classifier call at all.
 *  2. BOUNDED + HONEST LIST: the page size is contract policy (5–10), and the
 *     response always says how many rows exist and whether it was cut, so a
 *     capped list can never be read as "that is the whole day".
 *  3. ONE TRUTH (the reason this file exists): the drill rows must ADD UP to the
 *     numbers `/read/daily-summary` prints for the same day and fixture. The
 *     drill reads rows through the same skill module as the aggregate; if a
 *     future edit changes one side (a filter, the cancelled rule, the return
 *     rule) this test goes red instead of the screen quietly disagreeing with
 *     the number above it.
 *  4. READ ONLY: no write surface in the view module, no `/execute`, and a
 *     failing drill is a refusal — never an empty list standing in for a site
 *     that cannot answer.
 *
 * Hermetic: ERPNEXT_/ASK_ vars are stripped and the fixture is opt-in
 * (COPILOT_MOCK_OK=1) — a missing config must never become fixture data.
 */

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
process.env.COPILOT_MOCK_OK = "1";
delete process.env.COPILOT_COMPANY;
delete process.env.COPILOT_USERS;
delete process.env.ERPN_CAPABILITY_CONTRACT;

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The fixture's day is the SHOP's day, taken from the SAME function the server
 * uses (`vnToday`), and every relative date below is derived from it.
 *
 * These used to be literals (`D = "2026-09-21"`, `"2026-09-20"`,
 * `"2026-09-25"`). That is a time bomb: a drill request with no `date` defaults
 * to `vnToday()`, so on 2026-09-22 the page-size test asked for a day the
 * fixture had no rows on and went red (actual 0 vs expected 4) with NO code
 * change at all — the same class of failure already fixed in the Flutter suite
 * (P5-1, `daily_summary_test.dart`). One clock, one direction: derive, never
 * hard-code.
 *
 * A dynamic import on purpose: the env-stripping loop at the top of this file
 * must run before any module that reads `process.env` is evaluated (that is why
 * the other uses of `vnToday` in here are dynamic too).
 */
const { vnToday } = await import("../src/http-ask.mjs");

/** `YYYY-MM-DD` for `days` relative to the shop's today (UTC arithmetic — no DST to skip). */
function dayOffset(days) {
  const base = new Date(`${vnToday()}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

const D = vnToday();
/** The day BEFORE the fixture's day: cash-drawer opening, and the "yesterday" draft. */
const D_PREV = dayOffset(-1);
/** Comfortably overdue / comfortably not due / the next day — none may drift into another. */
const D_PAST = dayOffset(-11);
const D_FUTURE = dayOffset(4);
const D_NEXT = dayOffset(1);
const COMPANY = "Minh Phát Cám & VLXD";
const CASH = "1110 - Tiền mặt - MP";
const BANK = "1210 - ACB 110296868 - MP";
const DEBTORS = "1310 - Phải thu khách hàng - MP";
const CUST_X = "Chị Lan";
const CUST_Y = "Anh Bảy";

/* ----------------------------------------------------------------- fixture */
/* Deliberately contains one row of every kind the rules EXCLUDE, so the
 * consistency test below cannot pass by accident:
 *   - SO-CANCEL: submitted but Cancelled → belongs to neither SO bucket
 *   - INV-RET:   a return → must not inflate the day's invoice amount
 *   - PE-DRAFT:  an unsubmitted receipt → not part of the day's money
 *   - INV-B:     owes money but is NOT overdue → out of the overdue list
 */
function fixture(day = D) {
  return {
    Company: [{ name: COMPANY, default_cash_account: CASH, default_bank_account: BANK, company: COMPANY }],
    Account: [
      { name: CASH, account_type: "Cash", company: COMPANY },
      { name: BANK, account_type: "Bank", company: COMPANY },
      { name: DEBTORS, account_type: "Receivable", company: COMPANY },
    ],
    "GL Entry": [{ posting_date: D_PREV, account: CASH, debit: 5_000_000, credit: 0, is_cancelled: 0 }],
    "Sales Order": [
      { name: "SO-SUB", docstatus: 1, status: "To Deliver", grand_total: 12_000_000, transaction_date: day, company: COMPANY },
      { name: "SO-DRAFT", docstatus: 0, status: "Draft", grand_total: 99_000_000, transaction_date: day, company: COMPANY },
      { name: "SO-CANCEL", docstatus: 1, status: "Cancelled", grand_total: 5_000_000, transaction_date: day, company: COMPANY },
      // P4-5 — three shapes of a draft WITHOUT the correlation id (missing,
      // null, empty string). The block must never mistake these for the app's.
      { name: "SO-PLAIN", docstatus: 0, status: "Draft", grand_total: 1_000_000, transaction_date: day, company: COMPANY },
      { name: "SO-NULLID", docstatus: 0, status: "Draft", custom_ai_action_id: null, grand_total: 2_000_000, transaction_date: day, company: COMPANY },
    ],
    "Sales Invoice": [
      { name: "INV-A", docstatus: 1, status: "Unpaid", grand_total: 20_000_000, outstanding_amount: 20_000_000, due_date: D_PAST, posting_date: day, customer: CUST_X, company: COMPANY },
      { name: "INV-B", docstatus: 1, status: "Unpaid", grand_total: 5_000_000, outstanding_amount: 5_000_000, due_date: D_FUTURE, posting_date: "2026-09-01", customer: CUST_Y, company: COMPANY },
      // A credit note carries NEGATIVE amounts (that is what makes it a return), so it is
      // kept out of the day's sales by TWO independent rules: `is_return` in the invoice
      // block, and `outstanding_amount > 0` in the receivables read.
      { name: "INV-RET", docstatus: 1, status: "Return", is_return: 1, grand_total: -3_000_000, outstanding_amount: -3_000_000, posting_date: day, customer: CUST_X, company: COMPANY },
    ],
    "Purchase Order": [
      // A copilot-created DRAFT of this shop on the day — the one row the
      // app_drafts block and its drill must both count.
      { name: "PO-APP", docstatus: 0, status: "Draft", custom_ai_action_id: "act-001", transaction_date: day, company: COMPANY, grand_total: 99_000_000 },
      // And one for ANOTHER company on the same day: the correlation column
      // makes it look like "the app's draft" unless the company scoping rule
      // is applied — which is exactly what this row proves.
      { name: "PO-OTHER", docstatus: 0, status: "Draft", custom_ai_action_id: "act-xyz", transaction_date: day, company: "Công Ty Khác", grand_total: 77_000_000 },
    ],
    Quotation: [
      // A correlated draft DATED YESTERDAY: "trong ngày" is the document's own
      // date, so this one belongs to D_PREV, never to D.
      { name: "QT-DRAFT-YDA", docstatus: 0, status: "Draft", custom_ai_action_id: "act-002", transaction_date: D_PREV, company: COMPANY, grand_total: 456_000 },
    ],
    "Payment Entry": [
      // A DRAFT receipt without the correlation id and one with an EMPTY one:
      // both invisible to the app_drafts block and its drill. PE-DRAFT-APP is
      // the app's OWN draft receipt — the one row proving PE's money side is
      // `paid_amount` (PE has no grand_total on the real site).
      { name: "PE-DRAFT-APP", docstatus: 0, status: "Draft", custom_ai_action_id: "act-003", posting_date: day, payment_type: "Receive", party_type: "Customer", received_amount: 3_000_000, paid_amount: 3_000_000, paid_to: CASH, company: COMPANY },
      { name: "PE-PLAIN", docstatus: 0, status: "Draft", posting_date: day, payment_type: "Receive", party_type: "Customer", received_amount: 1_000_000, paid_to: CASH, company: COMPANY },
      { name: "PE-EMPTYID", docstatus: 0, status: "Draft", custom_ai_action_id: "", posting_date: day, payment_type: "Receive", party_type: "Customer", received_amount: 500_000, paid_to: CASH, company: COMPANY },
      { name: "PE-AGAINST", docstatus: 1, status: "Submitted", posting_date: day, payment_type: "Receive", party_type: "Customer", received_amount: 7_000_000, paid_to: CASH, company: COMPANY, unallocated_amount: 0, references: [{ reference_name: "INV-A" }] },
      { name: "PE-ADVANCE", docstatus: 1, status: "Submitted", posting_date: day, payment_type: "Receive", party_type: "Customer", received_amount: 4_000_000, paid_to: BANK, company: COMPANY, unallocated_amount: 4_000_000, references: [] },
      { name: "PE-OUT", docstatus: 1, status: "Submitted", posting_date: day, payment_type: "Pay", party_type: "Supplier", paid_amount: 2_000_000, paid_from: CASH, company: COMPANY },
      { name: "PE-DRAFT", docstatus: 0, status: "Draft", posting_date: day, payment_type: "Receive", party_type: "Customer", received_amount: 1_000_000, paid_to: CASH, company: COMPANY },
    ],
  };
}

const SO_SUB = { count: 1, amount: 12_000_000 };
const SO_DRAFT = { count: 3, amount: 102_000_000 }; // SO-DRAFT + SO-PLAIN + SO-NULLID (P4-5 non-app drafts are still the day's drafts)
const SI_AMOUNT = 20_000_000;
const RECEIPTS_AGAINST = 7_000_000;
const RECEIPTS_ADVANCE = 4_000_000;
const RECEIVABLES_TOTAL = 25_000_000;
const OVERDUE_TOTAL = 20_000_000;

/* ----------------------------------------------------------------- harness */

/** Install the fixture, restoring EXACTLY the keys this helper touched. */
async function withFixture(over, fn) {
  const touched = ["MOCK_ERP_P4_FIXTURE", ...Object.keys(over.env ?? {})];
  const saved = touched.map((k) => [k, process.env[k]]);
  process.env.MOCK_ERP_P4_FIXTURE = JSON.stringify(fixture(over.day ?? D));
  for (const [k, v] of Object.entries(over.env ?? {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function startServer({ env = {}, principal = null, limiter = null, host = "127.0.0.1", policy = null } = {}) {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const server = createAskServer({ port: 0, host, principal, limiter, policy, env: { ...process.env, ...env } });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const port = server.address().port;
  return { base: `http://${host}:${port}`, port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const drill = (base, qs = "") => fetch(`${base}/read/drill${qs}`);
const drillPost = (base, body) =>
  fetch(`${base}/read/drill`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const summary = (base, qs = "") => fetch(`${base}/read/daily-summary${qs}`).then((r) => r.json());

/* ------------------------------------------------- 1. the closed-set input */

test("P4-4 contract: every declared drill is composed by a READ capability, and ids are slugs", async () => {
  const { listDrillScreens, getCapability } = await import("../src/capability-contract.mjs");
  const drills = listDrillScreens();
  // Spelled out independently, so a contract edit that silently drops an id
  // cannot make this test agree with a smaller set. (D1 added the two
  // company-wide drawer drills — drawer-plan-final §3.1.)
  assert.deepEqual(Object.keys(drills).sort(), [
    "app_drafts_today",
    "invoices_today",
    "overdue_customers",
    "overdue_top",
    "receipts_today",
    "receivable_customers",
    "sales_orders_today",
    "stock_low",
    "unpaid_invoices",
  ]);
  for (const [id, drillDef] of Object.entries(drills)) {
    assert.match(id, /^[a-z][a-z0-9_]*$/, `${id} must be a slug`);
    assert.equal(getCapability(drillDef.capability).type, "READ", `${id} must be composed by a READ capability`);
    assert.ok(drillDef.title.trim().length > 0, `${id} needs a title`);
  }
  // D4 — a DAY-scoped screen declares it, and its title stays day-NEUTRAL: the
  // server appends the day it ACTUALLY read, so a baked-in "hôm nay" would
  // produce "Hóa đơn hôm nay hôm qua" — or worse, a screen claiming today over
  // yesterday's rows. Both halves are asserted here because the contract
  // validator refuses the combination (see validateDrillScreens).
  for (const id of ["sales_orders_today", "invoices_today", "receipts_today"]) {
    assert.equal(drills[id].day_scoped, true, `${id} reads a DAY and must say so`);
    assert.equal(
      /hôm nay|hôm qua|ngày\s+\d/i.test(drills[id].title),
      false,
      `${id}.title must be day-neutral ("${drills[id].title}")`,
    );
  }
  // And the company-wide drawer views are NOT day-scoped: their rows do not
  // change with the day, so the server must not attach a day to their titles.
  for (const id of ["receivable_customers", "overdue_top", "unpaid_invoices", "stock_low"]) {
    assert.equal(drills[id].day_scoped, undefined, `${id} is not a day screen`);
  }
});

test("P4-4 400: an id nobody declared is refused with its own code — never a guessed screen", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const res = await drill(s.base, `?drill_id=everything_today`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "UNKNOWN_DRILL_SCREEN");
      assert.match(body.error, /không có trong hợp đồng/);
      // A phrase is not an id either: the same refusal, not a classifier.
      const phrase = await drill(s.base, `?drill_id=${encodeURIComponent("cho tôi xem đơn hàng hôm nay")}`);
      assert.equal(phrase.status, 400);
      assert.equal((await phrase.json()).code, "UNKNOWN_DRILL_SCREEN");
    } finally {
      await s.close();
    }
  });
});

test("P4-4 400: a missing drill_id is its own refusal (and the fixture is never touched)", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const res = await drill(s.base);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "MISSING_DRILL_ID");
      assert.match(body.error, /không nhận câu chữ/);
    } finally {
      await s.close();
    }
  });
});

/* ------------------------------------------------------ 2. the day's shape */

test("P4-4: GET and POST answer the same day, and the day defaults to TODAY at the shop", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const { vnToday } = await import("../src/http-ask.mjs");
      const viaGet = await drill(s.base, `?drill_id=invoices_today`);
      const viaPost = await drillPost(s.base, { drill_id: "invoices_today" });
      const g = await viaGet.json();
      const p = await viaPost.json();
      assert.equal(g.date, vnToday(), "absent date must be the SHOP's today, not the host's");
      assert.deepEqual(g.rows, p.rows);
      assert.equal(g.title, p.title);
      // Explicit bad dates are refused before any read (same rule as the summary).
      const bad = await drill(s.base, `?drill_id=invoices_today&date=2026-02-30`);
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).code, "INVALID_DATE");
    } finally {
      await s.close();
    }
  });
});

test("P4-4: the page size is CONTRACT policy, and a cut list says so", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const wide = await (await drill(s.base, `?drill_id=sales_orders_today&limit=99`)).json();
      assert.equal(wide.limit, 10, "99 must be clamped to the declared maximum");
      const narrow = await (await drill(s.base, `?drill_id=sales_orders_today&limit=1`)).json();
      assert.equal(narrow.limit, 5, "a request below the minimum is raised to it, not honoured");
      // 4 SO rows remain in scope (submitted + 3 drafts; the cancelled one is
      // excluded), so with a page of 5 nothing is cut — and the count still
      // reports all rows (P4-5 added SO-PLAIN/SO-NULLID to prove the drafts
      // filter; they count as the day's DRAFTS here — just not as app drafts).
      assert.equal(narrow.total_documents, 4);
      assert.equal(narrow.truncated, false);
      assert.equal(narrow.rows.length, 4);
      // D0.5 §2.1 — a drill payload must NAME its source. The app replaces every
      // figure with a "no provenance" panel for anything but REAL, so a payload
      // that forgot this field would blank a working screen.
      assert.ok(
        ["REAL", "MOCK"].includes(wide.erp_target),
        `drill payload must carry erp_target, got ${JSON.stringify(wide.erp_target)}`,
      );
    } finally {
      await s.close();
    }
  });
});

/* ------------------------------- 3. ONE TRUTH: rows add up to the aggregate */

test("P4-4 drill rows ADD UP to /read/daily-summary for the same day (the anti-drift guard)", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const day = await summary(s.base, `?date=${D}`);
      assert.equal(day.meta.partial, false, "fixture day must read fully, or this comparison means nothing");

      // ── Sales orders: submitted and draft are SEPARATE, and a cancelled
      // submitted order is in neither bucket (§10.1 / §3.1b).
      const so = await (await drill(s.base, `?drill_id=sales_orders_today&date=${D}&limit=10`)).json();
      const submittedRows = so.rows.filter((r) => r.kind === "submitted");
      const draftRows = so.rows.filter((r) => r.kind === "draft");
      assert.equal(submittedRows.length, day.sales_orders.submitted.count);
      assert.equal(draftRows.length, day.sales_orders.draft.count);
      assert.equal(
        submittedRows.reduce((n, r) => n + r.amount_vnd, 0),
        day.sales_orders.submitted.amount,
      );
      assert.equal(
        draftRows.reduce((n, r) => n + r.amount_vnd, 0),
        day.sales_orders.draft.amount,
      );
      assert.equal(so.rows.some((r) => r.name === "SO-CANCEL"), false, "a cancelled order is in no bucket");
      assert.deepEqual(day.sales_orders.submitted, SO_SUB);
      assert.deepEqual(day.sales_orders.draft, SO_DRAFT);

      // ── Invoices: the return is NOT in the list and NOT in the amount (§3.5).
      const inv = await (await drill(s.base, `?drill_id=invoices_today&date=${D}&limit=10`)).json();
      assert.equal(inv.rows.length, day.sales_invoices.count);
      assert.equal(
        inv.rows.reduce((n, r) => n + r.amount_vnd, 0),
        day.sales_invoices.amount,
        "the drill list must sum to the invoice amount the summary printed",
      );
      assert.equal(inv.rows.some((r) => r.name === "INV-RET"), false, "a return must not appear as the day's invoice");
      assert.equal(day.sales_invoices.amount, SI_AMOUNT);

      // ── Receipts: only Receive, only submitted, split against-invoice/advance
      // exactly like the receipts block (§3.2).
      const rec = await (await drill(s.base, `?drill_id=receipts_today&date=${D}&limit=10`)).json();
      const against = rec.rows.filter((r) => r.kind === "receipt_against_invoice");
      const advances = rec.rows.filter((r) => r.kind === "receipt_advance");
      assert.deepEqual(
        against.map((r) => r.name),
        ["PE-AGAINST"],
      );
      assert.deepEqual(
        advances.map((r) => r.name),
        ["PE-ADVANCE"],
      );
      assert.equal(
        against.reduce((n, r) => n + r.amount_vnd, 0),
        day.receipts.against_invoice,
      );
      assert.equal(
        advances.reduce((n, r) => n + r.amount_vnd, 0),
        day.receipts.advances,
      );
      assert.equal(
        rec.rows.reduce((n, r) => n + r.amount_vnd, 0),
        day.receipts.total,
        "the receipts list must sum to the total the summary printed",
      );
      assert.equal(rec.rows.some((r) => r.name === "PE-DRAFT"), false, "an unsubmitted receipt is not money");
      assert.equal(rec.rows.some((r) => r.name === "PE-OUT"), false, "a payment OUT is not a receipt");
      assert.equal(day.receipts.against_invoice, RECEIPTS_AGAINST);
      assert.equal(day.receipts.advances, RECEIPTS_ADVANCE);

      // ── Overdue customers: grouped, and the sum equals the overdue total that
      // the summary derived from the same invoices (§3.4). Customer Y owes but
      // is not overdue ⇒ absent.
      const over = await (await drill(s.base, `?drill_id=overdue_customers&date=${D}&limit=10`)).json();
      assert.deepEqual(
        over.rows.map((r) => r.name),
        [CUST_X],
      );
      assert.equal(
        over.rows.reduce((n, r) => n + r.amount_vnd, 0),
        day.receivables.overdue_total,
      );
      assert.equal(day.receivables.overdue_total, OVERDUE_TOTAL);
      assert.equal(day.receivables.outstanding_total, RECEIVABLES_TOTAL);
      assert.equal(over.rows.some((r) => r.name === CUST_Y), false, "not-due debt is not overdue");

      // ── App drafts: the drill list and the `app_drafts` block must answer
      // from the SAME set (same correlation filter, same company scoping, same
      // day) — a draft of ANOTHER company (PO-OTHER) is in NEITHER.
      const draftsDrill = await (await drill(s.base, `?drill_id=app_drafts_today&date=${D}&limit=10`)).json();
      assert.equal(
        draftsDrill.rows.length,
        day.app_drafts.count,
        "the drill list must be the same set the app_drafts block counted",
      );
      assert.equal(draftsDrill.rows.some((r) => r.name === "PO-OTHER"), false, "another company's draft is not this shop's draft");
      assert.deepEqual(draftsDrill.rows.map((r) => r.name), ["PE-DRAFT-APP", "PO-APP"]);
      assert.deepEqual(day.app_drafts, { count: 2, by_type: { "Payment Entry": 1, "Purchase Order": 1 } });
    } finally {
      await s.close();
    }
  });
});

test("P4-4: an absent limit is the CONTRACT default, not zero clamped up to the minimum", async () => {
  // Regression (review round, 2026-09-21): Number(null) === 0 made an absent
  // limit clamp to `min` (5), silently shrinking the page the contract
  // promised. `default: 10` is what a client that sends no limit must get.
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const absentGet = await drill(s.base, `?drill_id=invoices_today&date=${D}`);
      assert.equal(absentGet.url.includes("limit"), false, "precondition: the request must carry no limit");
      const absent = await absentGet.json();
      assert.equal(absent.limit, 10, "no limit sent ⇒ the contract default, not min");
      const absentPost = await drillPost(s.base, { drill_id: "invoices_today", date: D });
      assert.equal((await absentPost.json()).limit, 10);
      const blank = await (await drill(s.base, `?drill_id=invoices_today&date=${D}&limit=`)).json();
      assert.equal(blank.limit, 10, "an EMPTY limit param is absent, not zero");
    } finally {
      await s.close();
    }
  });
});

test("D3: a doctype without the correlation field is a SKIPPED SECTION (partial), never a 500 and never a fabricated 0", async () => {
  // The state this site was really in before the Custom Field migration: one
  // doctype that cannot be filtered by the correlation column. Pre-D3 this was
  // a refusal for the WHOLE view (the old version of this test asserted that).
  // §3.4 changes the rule on purpose: "thiếu field trên doctype → skip section
  // + log, không 500 cả màn" — the screen must show the sections that DID
  // answer, name the one that could not, and say the read was partial. What it
  // must still never do is present the missing section as "0 nháp".
  await withFixture({ env: { MOCK_ERP_SO_NO_CORRELATION_FIELD: "1" } }, async () => {
    const s = await startServer();
    try {
      const res = await drill(s.base, `?drill_id=app_drafts_today&date=${D}`);
      assert.equal(res.status, 200, "one unreadable section must not take the whole screen down");
      const body = await res.json();
      assert.equal(body.partial, true, "the read is PARTIAL — the user must be told");
      assert.equal(body.sections["Sales Order"].ok, false);
      assert.equal(body.sections["Sales Order"].code, "FIELD_MISSING", "a missing column is its own code, not 'ERP lỗi'");
      assert.match(body.sections["Sales Order"].error, /custom_ai_action_id/);
      // The other sections still answer, and their rows are the real ones.
      assert.equal(body.sections["Purchase Order"].ok, true);
      assert.deepEqual(body.rows.map((r) => r.name), ["PE-DRAFT-APP", "PO-APP"], "the sections that answered still serve their rows");
      assert.equal(body.summary_lines[0].count, 2);
      // The skipped section is NOT silently a zero: it EXISTS in `sections`
      // with ok:false, which is what the banner renders.
      assert.equal(body.sections["Sales Order"].count, undefined);
    } finally {
      await s.close();
    }
  });
});

/* ------------------------------------------------------------------ 5. P4-5 */

test("P4-5: a draft WITHOUT the correlation id never enters the block or the drill, in any form", async () => {
  // §4.4: "filter theo custom_ai_action_id … không nhầm mọi draft trên site".
  // Every shape a site could present a draft in: no field, null, and empty
  // string (a legacy row where someone cleared the value without nulling it).
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const day = await summary(s.base, `?date=${D}`);
      const drillBody = await (await drill(s.base, `?drill_id=app_drafts_today&date=${D}`)).json();
      for (const pool of [day.app_drafts.by_type, drillBody.rows.map((r) => r.name)]) {
        for (const forbidden of ["SO-PLAIN", "QT-NULL", "PO-EMPTY", "PE-PLAIN"]) {
          assert.equal(JSON.stringify(pool).includes(forbidden), false, `${forbidden} has no correlation id and must be invisible`);
        }
      }
      // The shop's OWN correlated drafts (PO-APP + PE-DRAFT-APP) are the only
      // ones counted — every no-id shape stays invisible.
      assert.deepEqual(day.app_drafts, { count: 2, by_type: { "Payment Entry": 1, "Purchase Order": 1 } });
      assert.deepEqual(drillBody.rows.map((r) => r.name), ["PE-DRAFT-APP", "PO-APP"]);
    } finally {
      await s.close();
    }
  });
});

test("P4-5: the day boundary is the document's own date, not creation order", async () => {
  // "trong ngày" = the doc's posting/transaction date equals the requested
  // day: a draft DATED yesterday (even created today) belongs to yesterday's
  // drill, and one dated tomorrow belongs to tomorrow's.
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const yesterday = await (await drill(s.base, `?drill_id=app_drafts_today&date=${D_PREV}`)).json();
      assert.deepEqual(yesterday.rows.map((r) => r.name), ["QT-DRAFT-YDA"], "a draft dated yesterday is not in today's set");
      const tomorrow = await (await drill(s.base, `?drill_id=app_drafts_today&date=${D_NEXT}`)).json();
      assert.equal(tomorrow.rows.length, 0, "a day with no correlated draft is an empty ANSWER, not an error");
      assert.equal(tomorrow.truncated, false);
    } finally {
      await s.close();
    }
  });
});

test("P4-5: the drill shows the draft's OWN value — a copied grand_total (paid_amount for PE), never a fabricated zero", async () => {
  // P4-5 review finding: rows used to carry amount_vnd: 0 while the document
  // has a real value — an invented number for something that HAS one. PE has
  // NO grand_total (measured on the real site: DocField meta rows = 0 — the
  // read 417s if asked); its money side is paid_amount.
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const body = await (await drill(s.base, `?drill_id=app_drafts_today&date=${D}`)).json();
      const po = body.rows.find((r) => r.name === "PO-APP");
      const pe = body.rows.find((r) => r.name === "PE-DRAFT-APP");
      assert.equal(po.amount_vnd, 99_000_000, "PO-APP's own grand_total, copied verbatim");
      assert.equal(pe.amount_vnd, 3_000_000, "PE-DRAFT-APP's own paid_amount (PE has no grand_total)");
      assert.equal(body.rows.some((r) => r.amount_vnd === 0), false, "no row may show a fabricated 0");
    } finally {
      await s.close();
    }
  });
});

/* ---------------------------------------------------------- 4. read only */

/* ───────────────────────────────────────────────────────── D1 drawer drills */

// The D1 drawer entries (drawer-plan-final §3.1): company-wide debts on the
// GL, an "oldest first" sort, a verbatim footnote, and an OPTIONAL draft
// hint. The fixture's PE-DRAFT-APP (a 3.000.000 draft Receive for Chị Lan,
// unsubmitted, no invoice allocation) is the row that keeps the GL-raw rule
// honest: subtracting open draft PEs from the books would drop Chị Lan's
// 20.000.000 and silently agree with a payment proposal instead of the
// ledger — the exact thing §9 forbids.

test("D1 receivable_customers: company-wide GL raw — an open draft PE never shrinks the debt", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const body = await (await drill(s.base, `?drill_id=receivable_customers&date=${D}`)).json();
      // CUST_X owes 20.000.000 (INV-A) + the −3.000.000 credit note is kept
      // OUT by outstanding_amount > 0; CUST_Y owes the not-yet-due 5.000.000.
      assert.deepEqual(
        body.rows.map((r) => [r.name, r.amount_vnd]),
        [
          [CUST_X, 20_000_000],
          [CUST_Y, 5_000_000],
        ],
        "outstanding DESC, and the DRAFT receipt (PE-DRAFT-APP 3.000.000) must NOT subtract from it",
      );
      assert.equal(body.rows[0].amount_vnd, 20_000_000, "GL raw: 20.000.000 minus nothing");
      assert.equal(body.summary_lines[0].label, "Tổng còn nợ (theo sổ)");
      assert.equal(body.summary_lines[0].amount_vnd, RECEIVABLES_TOTAL, "must equal the summary's receivables.outstanding_total");
      assert.equal(body.footnote, "Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp).", "the §3.1 footnote, verbatim");
      // The hint travels SEPARATELY (optional, not part of the money).
      // Four open draft PEs: PE-DRAFT-APP 3.000.000 + PE-PLAIN 1.000.000 +
      // PE-EMPTYID 500.000 + PE-DRAFT 1.000.000 = 5.500.000.
      assert.deepEqual(body.draft_hint, { count: 4, amount_vnd: 5_500_000 }, "every open draft PE counts — the hint is a count, not an effective figure");
      assert.equal(body.truncated, false);
    } finally {
      await s.close();
    }
  });
});

test("D1 overdue_top: oldest debt FIRST (days_overdue DESC), secondary outstanding DESC", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      // INV-A (CUST_X) is 11 days overdue, outstanding 20.000.000. INV-B is
      // NOT overdue (due D_FUTURE) ⇒ absent. INV-RET is excluded by > 0.
      const body = await (await drill(s.base, `?drill_id=overdue_top&date=${D}`)).json();
      assert.deepEqual(body.rows.map((r) => r.name), [CUST_X]);
      assert.equal(body.rows[0].amount_vnd, 20_000_000);
      assert.match(body.rows[0].note, /Nợ lâu nhất 11 ngày/);
      assert.equal(body.rows[0].date, D_PAST, "the row dates the OLDEST overdue invoice");
      // The "Top" view sorts by AGE, not by amount: prove it with a second
      // customer whose debt is smaller but OLDER — it must come FIRST.
      const older = fixture();
      older["Sales Invoice"].push({
        name: "INV-OLD", docstatus: 1, status: "Unpaid", grand_total: 900_000,
        outstanding_amount: 900_000, due_date: dayOffset(-40), posting_date: D_PAST,
        customer: CUST_Y, company: COMPANY,
      });
      process.env.MOCK_ERP_P4_FIXTURE = JSON.stringify(older);
      const res = await startServer();
      try {
        const top = await (await drill(res.base, `?drill_id=overdue_top&date=${D}`)).json();
        assert.deepEqual(
          top.rows.map((r) => r.name),
          [CUST_Y, CUST_X],
          "40 days late (900.000) ranks ABOVE 11 days late (20.000.000) — age first, amount second",
        );
        assert.match(top.rows[1].note, /Nợ lâu nhất 11 ngày/);
        assert.match(top.rows[0].note, /Nợ lâu nhất 40 ngày/);
      } finally {
        await res.close();
      }
    } finally {
      await s.close();
    }
  });
});

test("D1: the draft hint is OPTIONAL — unreadable draft PEs give NO hint, never an error page", async () => {
  // The money above the list is already correct; the hint is decoration. A
  // site that refuses the PE read must still serve the debt list (with no
  // hint) instead of failing the whole view — the opposite trade from the
  // app_drafts drill, where the data IS the view. MOCK_ERP_FAIL_SI_LIST
  // kills ONLY the Sales Invoice doc_list, so the hint read (Payment Entry)
  // succeeds and the DEBT read fails: the whole view is then a refusal.
  await withFixture({ env: { MOCK_ERP_FAIL_SI_LIST: "1" } }, async () => {
    const s = await startServer();
    try {
      const res = await drill(s.base, `?drill_id=receivable_customers&date=${D}`);
      assert.notEqual(res.status, 200, "an unreadable DEBT read is a refusal, never an empty list");
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, "ERP_UNAVAILABLE");
    } finally {
      await s.close();
    }
  });
  // And the mirror case: the PE read itself failing must not take the view
  // down — the debt list stays, the hint is simply absent.
  await withFixture({ env: { MOCK_ERP_FAIL_PE_LIST: "1" } }, async () => {
    const s = await startServer();
    try {
      const body = await (await drill(s.base, `?drill_id=receivable_customers&date=${D}`)).json();
      assert.equal(body.footnote, "Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp).");
      assert.equal(body.rows.length, 2);
      assert.equal(body.draft_hint, undefined, "no hint when the draft read fails — not null, not 0, absent");
    } finally {
      await s.close();
    }
  });
});

// ───────────────────────── D1c — HĐ chưa trả (§3.2) ───────────────────────

// The invoice-level drawer view: the SAME shared read the debt drills use
// (companyDebtRows — SI docstatus=1, outstanding>0, not cancelled, ALL days),
// one row per INVOICE (§3.2 forbids a PE-able abstraction — the row is the
// invoice, nothing else), money = the invoice's own outstanding_amount.

test("D1c unpaid_invoices: one row per invoice, money = its own outstanding — GL raw, no draft subtraction", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const body = await (await drill(s.base, `?drill_id=unpaid_invoices&date=${D}`)).json();
      // INV-A 20.000.000 (Chị Lan, overdue) before INV-B 5.000.000 (Anh Bảy,
      // not due); INV-RET (−3.000.000) stays out via outstanding > 0. The
      // customer rides in the note; the invoice's due_date is the row date.
      assert.deepEqual(
        body.rows.map((r) => [r.name, r.amount_vnd, r.note, r.date]),
        [
          ["INV-A", 20_000_000, CUST_X, D_PAST],
          ["INV-B", 5_000_000, CUST_Y, D_FUTURE],
        ],
        "outstanding DESC, secondary due_date ASC (near-term due first)",
      );
      assert.equal(body.rows.every((r) => r.kind === "unpaid_invoice"), true, "every row IS an invoice — no PE-able abstraction");
      // The total is the SAME set the debt drills sum (anti-drift): it must
      // equal receivables.outstanding_total on the same fixture.
      assert.equal(body.summary_lines[0].label, "Tổng còn phải thu");
      assert.equal(body.summary_lines[0].amount_vnd, RECEIVABLES_TOTAL);
      assert.equal(body.summary_lines[0].count, 2, "two open invoices — the count of the list itself");
      assert.equal(body.summary_lines[1].label, "Hóa đơn chưa trả");
      assert.equal(body.summary_lines[1].amount_vnd, null, "a count line is not money — null, never 0đ");
      assert.equal(body.footnote, "Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp).", "the §3.1 footnote travels here too — same GL-raw figures");
      // Same optional hint as the debt views: every open draft PE, separately.
      assert.deepEqual(body.draft_hint, { count: 4, amount_vnd: 5_500_000 });
      assert.equal(body.truncated, false);
    } finally {
      await s.close();
    }
  });
});

test("D1c: due-date tiebreak — equal outstanding, the NEARER due date first; an unreadable SI read is a refusal", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      // Two 5.000.000 invoices: the one due sooner must come first.
      const tied = fixture();
      tied["Sales Invoice"].push({
        name: "INV-TIE", docstatus: 1, status: "Unpaid", grand_total: 5_000_000,
        outstanding_amount: 5_000_000, due_date: D_PAST, posting_date: D,
        customer: "Anh C", company: COMPANY,
      });
      process.env.MOCK_ERP_P4_FIXTURE = JSON.stringify(tied);
      const t = await startServer();
      try {
        const body = await (await drill(t.base, `?drill_id=unpaid_invoices&date=${D}`)).json();
        assert.deepEqual(body.rows.map((r) => r.name), ["INV-A", "INV-TIE", "INV-B"],
          "equal 5.000.000: due " + D_PAST + " ranks above due " + D_FUTURE);
      } finally {
        await t.close();
      }
    } finally {
      await s.close();
    }
  });
  // And the mirror of the D1 trade: the DEBT read failing is a refusal —
  // never an empty list standing in for a site that cannot answer.
  await withFixture({ env: { MOCK_ERP_FAIL_SI_LIST: "1" } }, async () => {
    const s = await startServer();
    try {
      const res = await drill(s.base, `?drill_id=unpaid_invoices&date=${D}`);
      assert.notEqual(res.status, 200, "an unreadable invoice read is a refusal, never an empty list");
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, "ERP_UNAVAILABLE");
    } finally {
      await s.close();
    }
  });
});

// ───────────────────── D2 — Tồn kho nóng (§3.3) ─────────────────────

// The low-stock drawer view: ONE pinned warehouse (COPILOT_DEFAULT_WAREHOUSE),
// qty ASC. Rows are QUANTITIES — amount_vnd carries the Bin's actual_qty so
// the shared DrillRow shape can hold it, and the CLIENT renders it unit-less.
// The money-rule tests above still guard every other drill: the fabricated-0
// assertion here is about the SHELF, not the books.

test("D2 stock_low: pinned warehouse only — the pin is required, and the header names it", async () => {
  await withFixture({}, async () => {
    // 1. NO pin ⇒ configuration error naming the fix — never warehouses[0],
    //    never a silent fallback to whatever stock list answered first.
    const s = await startServer({ env: { COPILOT_DEFAULT_WAREHOUSE: undefined } });
    try {
      const res = await drill(s.base, `?drill_id=stock_low&date=${D}`);
      assert.notEqual(res.status, 200, "unpinned warehouse must be a refusal, not a guess");
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, "STOCK_WAREHOUSE_UNPINNED");
      assert.match(body.error, /COPILOT_DEFAULT_WAREHOUSE/);
      assert.match(body.error, /warehouses\[0\]/, "the refusal teaches the operator the rule that was NOT broken silently");
    } finally {
      await s.close();
    }
  });

  // 2. Pinned ⇒ rows come ONLY from that warehouse, qty ASC, and the header
  //    carries the warehouse name (§3.3: "Tồn thấp — Kho: {tên}").
  const s = await startServer({ env: { COPILOT_DEFAULT_WAREHOUSE: "Kho chính" } });
  assert.ok(s.base, "server started");
  try {
    const body = await (await drill(s.base, `?drill_id=stock_low&date=${D}`)).json();
    assert.equal(body.rows.every((r) => r.note === "Kho chính"), true, "every row is scoped to the pinned warehouse");
    assert.deepEqual(
      body.rows.map((r) => [r.name, r.amount_vnd]),
      [
        ["CAM-GA-10KG", 40],
        ["CAM-HEO-25KG", 120],
      ],
      "qty ASCENDING — the low stock leads (§3.3)",
    );
    assert.equal(body.rows.every((r) => r.kind === "stock_low_item"), true, "rows are stock quantities, kind names the unit-less rendering");
    assert.equal(body.summary_lines[0].label, "Tồn thấp — Kho: Kho chính");
    assert.equal(body.summary_lines[0].amount_vnd, null, "a header line is a COUNT of items, not money");
    assert.equal(body.summary_lines[0].count, 2);
    // The quantity total is also a COUNT (sum of shelf quantities), carried in
    // the count slot — never printed as "đ" by the client.
    assert.equal(body.summary_lines[1].label, "Tổng số lượng đang có");
    assert.equal(body.summary_lines[1].amount_vnd, null);
    assert.equal(body.summary_lines[1].count, 160);
    assert.equal(body.truncated, false);
  } finally {
    await s.close();
  }
});

// ─────────────────── D3 — Nháp hôm nay (§3.4) ───────────────────

test("D3: one unreadable doctype is a PARTIAL section — the others still answer, and the screen is told which", async () => {
  // §3.4: "Một doctype fail → partial: true + sections status + vẫn trả items
  // OK (loadedPartial)". The failure here is a plain ERP error on ONE doctype
  // (MOCK_ERP_FAIL_LIST_DOCTYPE), which is the shape a timeout/permission
  // failure has on the real site: the other sections must still serve.
  await withFixture({ env: { MOCK_ERP_FAIL_LIST_DOCTYPE: "Quotation" } }, async () => {
    const s = await startServer();
    try {
      const res = await drill(s.base, `?drill_id=app_drafts_today&date=${D}`);
      assert.equal(res.status, 200, "a partial read is an ANSWER with a warning, not a 500");
      const body = await res.json();
      assert.equal(body.partial, true);
      assert.equal(body.sections.Quotation.ok, false);
      assert.equal(body.sections.Quotation.code, "ERP_UNAVAILABLE");
      assert.equal(body.sections["Purchase Order"].ok, true);
      assert.equal(body.sections["Purchase Order"].count, 1);
      assert.deepEqual(body.rows.map((r) => r.name), ["PE-DRAFT-APP", "PO-APP"], "the OK sections' rows are served as usual");
      assert.match(body.summary_lines[1].label, /3\/4 loại chứng từ/, "the header counts the sections that ANSWERED");
    } finally {
      await s.close();
    }
  });

  // NOTHING answered ⇒ an OUTAGE, not a partial day: §2.2 says unreachable
  // ERPNext is an error with a retry, and an empty list with a warning would
  // read as "hôm nay không có nháp nào". (Found live: the site's tunnel went
  // down while this phase was being verified and the view still answered 200.)
  await withFixture({ env: { MOCK_ERP_FAIL_LIST: "1" } }, async () => {
    const s = await startServer();
    try {
      const res = await drill(s.base, `?drill_id=app_drafts_today&date=${D}`);
      assert.equal(res.status, 503, "zero readable sections is a refusal, not a partial empty view");
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, "ERP_UNAVAILABLE");
      assert.match(body.error, /loại chứng từ nào/);
      assert.equal("rows" in body, false, "an outage serves no rows at all");
    } finally {
      await s.close();
    }
  });

  // And an answered-but-PARTIAL day must not be dressed up as complete: with
  // every section readable, `partial` is false and every section is ok.
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const body = await (await drill(s.base, `?drill_id=app_drafts_today&date=${D}`)).json();
      assert.equal(body.partial, false);
      assert.deepEqual(Object.keys(body.sections).sort(), ["Payment Entry", "Purchase Order", "Quotation", "Sales Order"]);
      assert.equal(Object.values(body.sections).every((x) => x.ok === true), true);
      assert.equal(body.duplicates_dropped, 0);
    } finally {
      await s.close();
    }
  });
});

test("D3: the SAME action id is ONE row — the SERVER picks canonical and counts what it dropped", async () => {
  // D0 measured the site's index as unique PER DOCTYPE, so a duplicate can only
  // arrive ACROSS doctypes: one user action that left a follow-on document (an
  // order and the payment raised for it) shares its `custom_ai_action_id`.
  // §3.4: the backend chooses canonical — the client must never be handed two
  // rows for one action and asked to pick.
  await withFixture({}, async () => {
    const dup = fixture();
    // Same action, same day, second doctype. Same-date ties resolve by name ASC
    // ("PE-SAME" < "PO-APP"), so the rule is deterministic and this test pins it.
    dup["Payment Entry"].push({
      name: "PE-SAME", docstatus: 0, status: "Draft", custom_ai_action_id: "act-001",
      posting_date: D, payment_type: "Receive", party_type: "Customer",
      received_amount: 1_000_000, paid_amount: 1_000_000, paid_to: CASH, company: COMPANY,
    });
    process.env.MOCK_ERP_P4_FIXTURE = JSON.stringify(dup);
    const s = await startServer();
    try {
      const body = await (await drill(s.base, `?drill_id=app_drafts_today&date=${D}`)).json();
      const act = body.rows.filter((r) => ["PE-SAME", "PO-APP"].includes(r.name));
      assert.equal(act.length, 1, "ONE row per action id — never both");
      assert.equal(act[0].name, "PE-SAME", "canonical = the deterministic winner (same date ⇒ name ASC)");
      assert.equal(body.duplicates_dropped, 1, "what was collapsed is COUNTED, never silently invisible");
      // The row is still a real document of this day with its OWN copied value.
      assert.equal(act[0].amount_vnd, 1_000_000);
      assert.equal(body.rows.some((r) => r.name === "PE-DRAFT-APP"), true, "unrelated drafts are untouched by dedupe");
    } finally {
      await s.close();
    }
  });
});

test("D3: /read/app-drafts IS the app-drafts aggregate — and the id cannot be swapped from the client", async () => {
  await withFixture({}, async () => {
    const s = await startServer();
    try {
      const viaAlias = await fetch(`${s.base}/read/app-drafts?date=${D}`);
      assert.equal(viaAlias.status, 200);
      const alias = await viaAlias.json();
      const viaDrill = await (await drill(s.base, `?drill_id=app_drafts_today&date=${D}`)).json();
      // SAME code path ⇒ byte-for-byte the same view (generated_at aside).
      const strip = (o) => JSON.stringify({ ...o, generated_at: null });
      assert.equal(strip(alias), strip(viaDrill), "the alias and the drill must be ONE aggregate, not two implementations");
      // The pin holds: a client cannot use this route to open another screen.
      const forced = await (await fetch(`${s.base}/read/app-drafts?date=${D}&drill_id=receivable_customers`)).json();
      assert.equal(forced.drill, "app_drafts_today", "this route IS the id — the parameter is ignored");
      // And it carries the D3 shape the drawer renders.
      assert.equal(alias.partial, false);
      assert.equal(typeof alias.sections, "object");
      assert.equal(alias.duplicates_dropped, 0);
      assert.equal(alias.erp_target, "MOCK", "provenance travels here too (D0.5 gate)");
    } finally {
      await s.close();
    }
  });
});

/* ------------------------------------------ 6. D4: the title names the day */

test("D4: a day-scoped drill titles itself with the day it ACTUALLY read — never a day it did not", async () => {
  // drawer-plan-final §7 D4 ("title phản ánh filter"). Tapping a metric while
  // the summary shows Hôm qua must land on a screen whose title says yesterday,
  // because the rows beneath it ARE yesterday's. Before D4 the contract title
  // ("Hóa đơn hôm nay") was sent verbatim, so the screen claimed TODAY over
  // yesterday's invoices — a mislabel on a money screen.
  // The warehouse pin only exists so `stock_low` (the LAST assertion below,
  // which checks a NON-day drill keeps its title) can read at all: D2 is
  // fail-closed without it, and a 503 carries no title to check.
  await withFixture({ env: { COPILOT_DEFAULT_WAREHOUSE: "Kho chính" } }, async () => {
    const s = await startServer();
    try {
      // No date ⇒ the shop's own today (and the title agrees).
      const todayBody = await (await drill(s.base, "?drill_id=invoices_today")).json();
      assert.equal(todayBody.date, D);
      assert.equal(todayBody.title, "Hóa đơn đã xuất hôm nay");

      // The day before ⇒ the title says so and names the SAME day it read.
      const yBody = await (await drill(s.base, `?drill_id=invoices_today&date=${D_PREV}`)).json();
      assert.equal(yBody.date, D_PREV);
      assert.equal(yBody.title, "Hóa đơn đã xuất hôm qua");

      // Any other day: the DATE is stated instead of a wrong day word (the
      // server will not call an 11-day-old read "hôm qua").
      const oldBody = await (await drill(s.base, `?drill_id=invoices_today&date=${D_PAST}`)).json();
      assert.equal(oldBody.title, `Hóa đơn đã xuất ngày ${D_PAST}`);

      // The other two day drills follow the same rule (they are the §6 delta
      // metrics, i.e. exactly the cards that can inherit Hôm qua).
      const so = await (await drill(s.base, `?drill_id=sales_orders_today&date=${D_PREV}`)).json();
      assert.equal(so.title, "Đơn hàng hôm qua");
      const rec = await (await drill(s.base, `?drill_id=receipts_today&date=${D_PREV}`)).json();
      assert.equal(rec.title, "Phiếu thu hôm qua");

      // A screen that is NOT day-scoped keeps its contract title VERBATIM even
      // when a date travels with the request: its rows do not depend on the day,
      // so attaching one would be a claim the payload does not make.
      const debt = await (await drill(s.base, `?drill_id=unpaid_invoices&date=${D_PREV}`)).json();
      assert.equal(debt.title, "HĐ chưa trả");
      const stock = await (await drill(s.base, `?drill_id=stock_low&date=${D_PREV}`)).json();
      assert.equal(stock.title, "Tồn kho nóng");
    } finally {
      await s.close();
    }
  });
});

test("D4: the day word is derived from the SHOP's clock (the title and the rows can never name different days)", async () => {
  const { drillDayWord } = await import("../src/drill-views.mjs");
  assert.equal(drillDayWord("2026-09-25", "2026-09-25"), "hôm nay");
  assert.equal(drillDayWord("2026-09-24", "2026-09-25"), "hôm qua");
  assert.equal(drillDayWord("2026-09-14", "2026-09-25"), "ngày 2026-09-14");
  // Crossing a month/year boundary must not skip a day.
  assert.equal(drillDayWord("2026-08-31", "2026-09-01"), "hôm qua");
  assert.equal(drillDayWord("2025-12-31", "2026-01-01"), "hôm qua");
  // An unknown "today" must never be guessed as hôm nay.
  assert.equal(drillDayWord("2026-09-24", null), "ngày 2026-09-24");
});

test("P4-4 static: the drill view has no write surface and no classifier, and the route never runs /execute", () => {
  const viewPath = fileURLToPath(new URL("../src/drill-views.mjs", import.meta.url));
  const view = readFileSync(viewPath, "utf8");
  for (const forbidden of ["callWriteTool", "runExecute", "safety-gateway", "executeProposal", "runPipeline"]) {
    assert.equal(view.includes(forbidden), false, `drill-views.mjs must not reference ${forbidden}`);
  }
  // The route must not send the id through the NLP path: §4.4 forbids free text
  // as the DEFAULT way to pick a capability. Sliced to the drill block so this
  // cannot be satisfied by an unrelated part of the file.
  const src = readFileSync(fileURLToPath(new URL("../src/http-ask.mjs", import.meta.url)), "utf8");
  const start = src.indexOf('path === "/read/drill"');
  assert.ok(start > 0, "the drill route must exist");
  const nextRoute = src.indexOf('path === "/ocr"', start);
  const block = src.slice(start, nextRoute > 0 ? nextRoute : undefined);
  for (const forbidden of ["routeIntent", "answerQuestion", "classifyIntent"]) {
    assert.equal(block.includes(forbidden), false, `the drill route must not call ${forbidden}`);
  }
  assert.match(block, /authorize\(drillRef\.drill\.capability/, "authorization must run against the CONTRACT's capability");
  assert.match(block, /rateLimiter\.chargeUser\("read"/, "the READ bucket must be charged");
});

// Authorization for this route lives in its own file (p44-read-drill-authz.test.mjs):
// proving it needs a TEMP CONTRACT loaded before import, i.e. its own process —
// the same reason the summary's authz contract has its own file.
