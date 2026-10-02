/**
 * next7 / C1 — `sales.summary` ("Báo cáo doanh thu hôm nay").
 *
 * The gate this file closes is C0 (`openspec/changes/next7-c0-si-measurement`,
 * `.plan/next7/C0-result.md`, plan_final §5): every filter and field of the day's
 * revenue number is MEASURED on the real site, never guessed:
 *
 *   net = Σ SI submitted (docstatus=1)  INCLUDING returns, which are ALREADY
 *         NEGATIVE in the database (C0 §2 — no `abs`, no re-signing)
 *   out =  cancelled (docstatus 2), drafts (docstatus 0), Payment Entries
 *         (money COLLECTED is not money SOLD — C0 §6.3)
 *
 * What this file proves:
 *
 *   A. ROUTING   — "doanh thu" phrases land on sales.summary, by keyword AND by
 *                  capability id, and the capability is no longer a stub.
 *   B. CONTRACT  — READ, company-scoped, no write executor.
 *   C. NET FILTER — normal + return + cancelled + draft in ONE day: only the
 *                  submitted rows count, and the return pulls the number DOWN.
 *   D. DRIFT     — `abs(sales.summary − drawer block) == 0` and the drill's own
 *                  rows sum to the block above them (the exact disagreement C0
 *                  found, now impossible because both read the same function).
 *   E. EMPTY/ERR — an empty day is a REAL zero; an unreadable ERPNext THROWS
 *                  (never a fabricated 0 — plan_final §5.4).
 *
 * The ERP double here PROJECTS the requested `fields`, unlike the shared mock:
 * C0 measured that the REAL tool returns only what was asked for, which is why
 * the old dead `!r.is_return` guard existed. A double that hands back every
 * field cannot see that class of bug, so this one does not.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { routeIntent, routeByCapability } from "../src/router.mjs";
import { getCapability, isStub } from "../src/capability-contract.mjs";
import { getDailySummary, getSalesSummary, readDayDrill, vnDay } from "../src/skills/ops-summary.mjs";

const D = "2026-09-21";
const D2 = "2026-09-20";
const COMPANY = "Minh Phát Cám & VLXD";
const CASH = "1110 - Tiền mặt - MP";

/** The C0 shape, one day: normal + return + cancelled + draft together (C8). */
const SI = [
  { name: "INV-N1", docstatus: 1, status: "Paid", grand_total: 10_000_000, outstanding_amount: 0, posting_date: D, company: COMPANY },
  { name: "INV-N2", docstatus: 1, status: "Unpaid", grand_total: 5_000_000, outstanding_amount: 5_000_000, posting_date: D, company: COMPANY },
  // A return: NEGATIVE grand_total, exactly as the real site stores it (C0 §2).
  { name: "INV-R1", docstatus: 1, status: "Return", is_return: 1, grand_total: -3_000_000, outstanding_amount: 0, posting_date: D, company: COMPANY },
  // Cancelled (docstatus 2) — never revenue.
  { name: "INV-C1", docstatus: 2, status: "Cancelled", grand_total: 7_000_000, outstanding_amount: 0, posting_date: D, company: COMPANY },
  // Draft — never revenue (it is not posted at all).
  { name: "INV-D1", docstatus: 0, status: "Draft", grand_total: 1_000_000, outstanding_amount: 1_000_000, posting_date: D, company: COMPANY },
  // Another company's invoice on the same day: must never be counted here.
  { name: "INV-X1", docstatus: 1, status: "Paid", grand_total: 99_000_000, outstanding_amount: 0, posting_date: D, company: "Công ty khác" },
  // A day with NO return, for the "a return lowers net" comparison.
  { name: "INV-N3", docstatus: 1, status: "Paid", grand_total: 4_000_000, outstanding_amount: 0, posting_date: D2, company: COMPANY },
];

const NET = 10_000_000 + 5_000_000 - 3_000_000; // 12.000.000 — return already negative
const WITHOUT_RETURN = 15_000_000;

/** One day's NET, derived from the array so the expectation cannot drift. */
function netOf(day) {
  return SI.filter((r) => r.docstatus === 1 && r.status !== "Cancelled" && r.posting_date === day && r.company === COMPANY)
    .reduce((s, r) => s + r.grand_total, 0);
}

/**
 * An ERPNext double that behaves like the REAL tool in the two ways this
 * capability depends on: it applies `filters`, and it returns ONLY the fields
 * that were requested. Anything not asked for comes back `undefined` — which is
 * precisely how the old return-guard became dead code on the site.
 */
function fakeErp({ failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    async callTool(tool, args) {
      calls.push({ tool, doctype: args?.doctype });
      if (failWith) throw new Error(failWith);
      const rows = {
        Company: [{ name: COMPANY, default_cash_account: CASH, default_bank_account: null, company: COMPANY }],
        Account: [{ name: CASH, account_type: "Cash", company: COMPANY }],
        "Sales Invoice": SI,
      }[args?.doctype] ?? [];
      const filtered = rows.filter((r) =>
        (args?.filters ?? []).every(([field, op, value]) => (op === "=" ? String(r[field]) === String(value) : true)),
      );
      const fields = args?.fields ?? null;
      const data = filtered.map((r) => (fields ? Object.fromEntries(fields.map((f) => [f, r[f]])) : { ...r }));
      return { data: { doctype: args?.doctype, count: data.length, data } };
    },
  };
}

/* ------------------------------------------------------------- A. routing */

test("C1 routing: 'báo cáo doanh thu' / 'doanh thu' resolve to sales.summary (keyword + id)", () => {
  for (const text of ["báo cáo doanh thu hôm nay", "doanh thu hôm nay", "doanh thu hôm nay bán được bao nhiêu", "hôm nay bán được bao nhiêu"]) {
    const hit = routeIntent(text);
    assert.ok(hit, `"${text}" must route`);
    assert.equal(hit.capability, "sales.summary", `"${text}" -> ${hit.capability}`);
    assert.equal(hit.group, "sales");
    assert.equal(hit.forbidden, false);
  }
});

test("C1 routing: the capability is implemented and reachable by id with a callable factory", () => {
  assert.equal(isStub("sales.summary"), false, "C1 implemented it — the stub flag is gone");
  const cap = getCapability("sales.summary");
  assert.equal(cap.status, undefined, "status:\"stub\" must be removed, not merely re-labelled");
  assert.equal(cap.skill, "skills/ops-summary.mjs#getSalesSummary");

  const byId = routeByCapability("sales.summary");
  assert.ok(byId, "a runnable capability must resolve (fail-closed check in routeByCapability)");
  assert.equal(byId.group, "sales");
  assert.equal(typeof byId.factory, "function");
  // The factory's bag is what the pipeline actually calls — a route whose group
  // resolves but whose bag lacks the function would only throw at call time.
  const bag = byId.factory({ callTool: async () => ({}) }, new Set());
  assert.equal(typeof bag.getSalesSummary, "function");
});

/* ------------------------------------------------------------ B. contract */

test("C1 contract: READ, no confirmation, company-scoped, and no write surface", () => {
  const cap = getCapability("sales.summary");
  assert.equal(cap.type, "READ");
  assert.equal(cap.risk.level, "READ");
  assert.equal(cap.risk.requires_confirmation, false);
  assert.equal(cap.authorization.scope.company, "required", "revenue is ONE company's books");
  assert.equal(cap.confirmation, null);
  assert.ok(!cap.execution?.write_doctype, "a READ must not declare a write doctype");
  assert.ok(cap.errors.includes("ERP_UNAVAILABLE"), "an outage must have its own code (no fake 0)");
});

/* ------------------------------------------------------- C. net filter (C7/C8) */

test("C1 net: normal + return + cancelled + draft in ONE day — only submitted counts, and the return lowers it", async () => {
  const s = await getSalesSummary(fakeErp(), { date: D, company: COMPANY, erpTarget: "MOCK" });
  assert.equal(s.net_vnd, NET);
  assert.equal(s.net_vnd, netOf(D), "expected number is derived from the fixture rows");
  // C7: the return really pulled the day DOWN (not "equal by luck").
  assert.ok(s.net_vnd < WITHOUT_RETURN, "a return must reduce the day's revenue");
  // C8: the filter kept exactly the submitted rows — cancelled, draft and the
  // OTHER company's invoice are all out.
  assert.equal(s.documents, 3);
  assert.equal(s.returns.count, 1);
  assert.equal(s.returns.amount_vnd, -3_000_000, "the return's own amount is negative as stored");
  assert.equal(s.currency, "VND");
  assert.equal(s.company, COMPANY);
  assert.equal(s.date, D);
  assert.equal(s.timezone, "Asia/Ho_Chi_Minh");
  assert.equal(s.erp_target, "MOCK");
});

test("C1 net: the field list is REAL — a double that projects fields still yields the returns breakdown", async () => {
  // The guard that would have caught C0's dead code: `is_return` must be ASKED
  // for. If the field list ever loses it, the projected row has no `is_return`
  // and this count drops to 0 — red, with the reason nameable.
  const mcp = fakeErp();
  const s = await getSalesSummary(mcp, { date: D, company: COMPANY });
  assert.equal(s.returns.count, 1);
  const invoiceCalls = mcp.calls.filter((c) => c.doctype === "Sales Invoice");
  assert.equal(invoiceCalls.length, 1, "one read per question — no second ERPNext round-trip");
});

/* ------------------------------------------------- D. drift (C3) */

test("C3: abs(sales.summary − drawer's sales_invoices block) == 0 on the same day/company", async () => {
  const day = await getDailySummary(fakeErp(), { date: D, company: COMPANY, erpTarget: "MOCK" });
  const chat = await getSalesSummary(fakeErp(), { date: D, company: COMPANY, erpTarget: "MOCK" });
  assert.equal(day.sales_invoices.amount, NET, "the drawer block is NET too");
  assert.equal(day.sales_invoices.count, 3);
  assert.equal(Math.abs(chat.net_vnd - day.sales_invoices.amount), 0);
});

test("C3: the invoices_today drill's own rows sum to the block above them (the drift C0 found)", async () => {
  const day = await getDailySummary(fakeErp(), { date: D, company: COMPANY });
  const drill = await readDayDrill(fakeErp(), { drillId: "invoices_today", date: D, company: COMPANY });
  const rowsSum = drill.rows.reduce((s, r) => s + r.amount_vnd, 0);
  assert.equal(rowsSum, day.sales_invoices.amount, "the list under the number must sum to it");
  assert.equal(rowsSum, NET);
  assert.equal(drill.rows.length, day.sales_invoices.count);
  // The return is one of the day's documents — and it SAYS so.
  const ret = drill.rows.find((r) => r.name === "INV-R1");
  assert.ok(ret, "a return is part of NET, so it appears in the drill");
  assert.equal(ret.amount_vnd, -3_000_000);
  assert.match(ret.note, /Trả hàng/);
  assert.equal(drill.rows.some((r) => r.name === "INV-C1"), false, "cancelled is in no row");
  assert.equal(drill.rows.some((r) => r.name === "INV-D1"), false, "a draft is not the day's revenue");
});

/* ------------------------------------------------------- E. empty vs error */

test("C4: an empty day is a REAL zero, said out loud", async () => {
  const s = await getSalesSummary(fakeErp(), { date: "2026-01-01", company: COMPANY });
  assert.equal(s.net_vnd, 0);
  assert.equal(s.documents, 0);
  assert.equal(s.returns.count, 0);
  // A real zero is a DIFFERENT shape from an outage: no throw, and `ok: true`.
  assert.equal(s.ok, true);
});

test("C5: an unreadable ERPNext THROWS — never a fabricated 0", async () => {
  await assert.rejects(
    () => getSalesSummary(fakeErp({ failWith: "tunnel down" }), { date: D, company: COMPANY }),
    /tunnel down/,
  );
});

test("C1: company and date are required — neither is ever guessed", async () => {
  await assert.rejects(() => getSalesSummary(fakeErp(), { date: D }), /COMPANY_UNRESOLVED/);
  await assert.rejects(() => getSalesSummary(fakeErp(), { date: "21/09/2026", company: COMPANY }), /OPS_DATE_REQUIRED/);
});

/* ------------------------------------------------------------- F. the day */

test("C1 §5.1: the day defaults to the SHOP's day (Asia/Ho_Chi_Minh), not the host's", async () => {
  // Same boundary case as the drawer route (P4-2) and the payment snapshot
  // (P5-2): 23:59 VN is 16:59Z, and 00:00 VN is 17:00Z on the PREVIOUS UTC day.
  assert.equal(vnDay(new Date("2026-09-21T16:59:00Z")), "2026-09-21");
  assert.equal(vnDay(new Date("2026-09-21T17:00:00Z")), "2026-09-22");
  assert.equal(vnDay(new Date("2026-09-21T17:30:00Z")), "2026-09-22");

  const { vnToday } = await import("../src/http-ask.mjs");
  for (const instant of [
    "2026-09-21T16:59:00Z",
    "2026-09-21T17:00:00Z",
    "2026-01-05T03:00:00Z",
    "2026-12-31T18:00:00Z",
  ]) {
    assert.equal(vnDay(new Date(instant)), vnToday(new Date(instant)), `vnDay and vnToday must agree at ${instant}`);
  }
  // And the default is actually wired: no date argument reads the VN day.
  const s = await getSalesSummary(fakeErp(), { company: COMPANY });
  assert.equal(s.date, vnDay());
});
