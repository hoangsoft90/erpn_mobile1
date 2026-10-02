/**
 * next8 Phase 2 — the two READ-only additions the collect screen needs
 * (owner decision 2026-09-29: extend Phase 2 with these reads, and fold the
 * lock §6.4 fix into this phase).
 *
 * What is pinned here, and why each one is a money rule rather than a detail:
 *
 *  1. COMPANY SCOPE (§6.4). The site is multi-company and holds invoices for the
 *     same customer under different companies. A read that ignores `company`
 *     reports another tenant's debt as if it were this shop's.
 *  2. NO SILENT TRUNCATION (§6.4). The read this replaces capped at 100 rows and
 *     said nothing; Phase 0 measured ONE customer with 179 open invoices, so the
 *     list was already short by 79 documents with no signal. A bounded read must
 *     PUBLISH that it is bounded.
 *  3. SEARCH BEYOND THE FIRST PAGE. The screen shows ≤10 rows; the user must
 *     still be able to reach invoice #11+.
 *  4. ACCOUNT TYPE (§6.2, UI half). The money accounts are read per account type
 *     so a "chuyển khoản" collection cannot be offered a cash account — the
 *     `1110` fallback bug. The server-side BLOCK stays in Phase 3; here the point
 *     is that the read does not invent or substitute an account.
 *  5. READ-ONLY. A new read path must not be able to reach a write tool.
 *
 * Hermetic: the ERPNEXT_ and ASK_ env prefixes are stripped so a shell that
 * sourced .env cannot point this at the real site (same rule as http-ask.test.mjs).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// No cap constant is imported on purpose: a skill group exports business
// FUNCTIONS only (router.test.mjs enforces it), so the default is pinned by
// BEHAVIOUR — the 179-invoice case Phase 0 measured must come back whole.
const { listOpenSalesInvoices } = await import("../src/skills/sales.mjs");
const { listUnpaidInvoices } = await import("../src/skills/customer.mjs");
const { listMoneyAccounts } = await import("../src/skills/accounts.mjs");

// ─────────────────────────────────────────────────────────────────────────────
// fixtures + fake client
// ─────────────────────────────────────────────────────────────────────────────

const COMPANY = "Minh Phát Cám & VLXD";
const OTHER_COMPANY = "SANLOAN";

/** `n` open invoices for one customer, in one company. */
function invoices(n, { customer = "CUST-00001", company = COMPANY, start = 1 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    name: `SINV-${String(start + i).padStart(4, "0")}`,
    customer,
    company,
    posting_date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
    grand_total: 1_000_000 + i,
    outstanding_amount: 1_000_000 + i,
    docstatus: 1,
  }));
}

/**
 * Fake ERPNext that answers the REAL tools this read may use. `=` only, on the
 * doc_list path, is deliberate: it mirrors what the mock (and the site's own
 * filter dialect) accepts, so a skill that grew a filter the site cannot serve
 * would fail here instead of only in production.
 */
function fakeMcp({ rows = invoices(3), accounts = [], companyDefaults = {} } = {}) {
  const state = { rows, accounts, companyDefaults, calls: [], writes: [] };
  return {
    get calls() {
      return state.calls;
    },
    get writes() {
      return state.writes;
    },
    async callTool(tool, args) {
      state.calls.push({ tool, args });
      if (tool === "erpnext_doc_list") {
        assert.equal(args.doctype, "Sales Invoice", "the open-invoice read must read Sales Invoice");
        const filters = args.filters ?? [];
        const rowsOut = state.rows.filter((row) =>
          filters.every(([field, op, value]) => {
            if (op !== "=") throw new Error(`fake supports only = (got ${op})`);
            return String(row[field] ?? "") === String(value ?? "");
          }),
        );
        return { data: { doctype: "Sales Invoice", count: rowsOut.length, data: rowsOut.slice(0, args.limit ?? 20) } };
      }
      if (tool === "erpnext_account_list") {
        const rowsOut = state.accounts.filter((a) => !args.company || a.company === args.company);
        return { data: { doctype: "Account", count: rowsOut.length, data: rowsOut } };
      }
      if (tool === "erpnext_doc_get") {
        assert.equal(args.doctype, "Company");
        return { data: { doctype: "Company", name: args.name, ...state.companyDefaults } };
      }
      throw new Error(`unexpected read tool ${tool}`);
    },
    async callWriteTool(tool, args) {
      state.writes.push({ tool, args });
      throw new Error("WRITE_REFUSED: the collect reads must never write");
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. company scope (§6.4)
// ─────────────────────────────────────────────────────────────────────────────

test("the open-invoice read keeps only the resolved company's invoices", async () => {
  const mcp = fakeMcp({
    rows: [...invoices(2), ...invoices(2, { company: OTHER_COMPANY, start: 90 })],
  });
  const read = await listOpenSalesInvoices(mcp, { customerId: "CUST-00001", company: COMPANY });

  assert.equal(read.data.data.length, 2);
  assert.ok(
    read.data.data.every((r) => r.company === COMPANY),
    "another company's invoice appeared in this company's list",
  );
  assert.ok(
    mcp.calls[0].args.filters.some(([f, op, v]) => f === "company" && op === "=" && v === COMPANY),
    "the company filter must be part of the QUERY, not a post-filter over every company's rows",
  );
});

test("only SUBMITTED invoices are open debt (a draft is not yet owed)", async () => {
  const mcp = fakeMcp({
    rows: [...invoices(2), { ...invoices(1, { start: 50 })[0], docstatus: 0 }],
  });
  const read = await listOpenSalesInvoices(mcp, { customerId: "CUST-00001", company: COMPANY });
  assert.equal(read.data.data.length, 2);
  assert.ok(mcp.calls[0].args.filters.some(([f, op, v]) => f === "docstatus" && op === "=" && v === "1"));
});

test("a settled invoice and a zero-outstanding row are not offered", async () => {
  const mcp = fakeMcp({
    rows: [
      { ...invoices(1)[0], outstanding_amount: 0 },
      { ...invoices(1, { start: 2 })[0], outstanding_amount: 2_500_000 },
    ],
  });
  const read = await listOpenSalesInvoices(mcp, { customerId: "CUST-00001", company: COMPANY });
  assert.deepEqual(read.data.data.map((r) => r.name), ["SINV-0002"]);
});

test("a credit note (negative outstanding) is still an open document", async () => {
  // result20's rule, kept: filtering `> 0` turns "còn nợ" into gross receivables.
  const mcp = fakeMcp({
    rows: [{ ...invoices(1)[0], outstanding_amount: -320_000, is_return: 1 }],
  });
  const read = await listOpenSalesInvoices(mcp, { customerId: "CUST-00001", company: COMPANY });
  assert.equal(read.data.data.length, 1);
});

test("no company given ⇒ the read says so instead of pretending it is scoped", async () => {
  const mcp = fakeMcp({ rows: [...invoices(1), ...invoices(1, { company: OTHER_COMPANY, start: 9 })] });
  const read = await listOpenSalesInvoices(mcp, { customerId: "CUST-00001" });
  assert.equal(read.data.company, null);
  assert.ok(
    !mcp.calls[0].args.filters.some(([f]) => f === "company"),
    "an unresolved company must not be replaced by a guess",
  );
  // The read is honest about it rather than silently returning both tenants.
  assert.equal(read.data.data.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. no silent truncation (§6.4)
// ─────────────────────────────────────────────────────────────────────────────

test("a read bounded by its own page REPORTS that it is bounded", async () => {
  // The failure this replaces was SILENT: a cap at 100 with nothing said. With an
  // explicit cap the payload must announce it, whatever the cap happens to be.
  const mcp = fakeMcp({ rows: invoices(40) });
  const read = await listOpenSalesInvoices(mcp, { customerId: "CUST-00001", company: COMPANY, cap: 25 });

  assert.equal(read.data.truncated, true, "a full page must be reported as truncated");
  assert.equal(read.data.scanned, 25);
  assert.ok(read.data.data.length <= 25);
});

test("a read that fits reports not-truncated and the real matched count", async () => {
  const mcp = fakeMcp({ rows: invoices(179) });
  const read = await listOpenSalesInvoices(mcp, { customerId: "CUST-00001", company: COMPANY });

  assert.equal(read.data.truncated, false);
  assert.equal(read.data.matched, 179, "179 open invoices must be countable, not capped at 100");
  assert.equal(read.data.data.length, 179);
});

test("the cap is a parameter, so a caller can read one invoice without the page", async () => {
  const mcp = fakeMcp({ rows: invoices(30) });
  const read = await listOpenSalesInvoices(mcp, { customerId: "CUST-00001", company: COMPANY, cap: 5 });
  assert.equal(read.data.data.length, 5);
  assert.equal(read.data.truncated, true);
  assert.equal(mcp.calls[0].args.limit, 5);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. search beyond the first page
// ─────────────────────────────────────────────────────────────────────────────

test("a search reaches an invoice that is not on the first page", async () => {
  const mcp = fakeMcp({ rows: invoices(179) });
  const read = await listOpenSalesInvoices(mcp, { customerId: "CUST-00001", company: COMPANY, query: "SINV-0175" });

  assert.deepEqual(read.data.data.map((r) => r.name), ["SINV-0175"]);
  assert.equal(read.data.matched, 1);
});

test("search is case-insensitive and matches a date fragment", async () => {
  const byName = await listOpenSalesInvoices(fakeMcp({ rows: invoices(3) }), {
    customerId: "CUST-00001",
    company: COMPANY,
    query: "sinv-0002",
  });
  assert.deepEqual(byName.data.data.map((r) => r.name), ["SINV-0002"]);

  const byDate = await listOpenSalesInvoices(fakeMcp({ rows: invoices(3) }), {
    customerId: "CUST-00001",
    company: COMPANY,
    query: "2026-09-03",
  });
  assert.deepEqual(byDate.data.data.map((r) => r.name), ["SINV-0003"]);
});

test("an empty search is not a filter (it must not empty the list)", async () => {
  const read = await listOpenSalesInvoices(fakeMcp({ rows: invoices(4) }), {
    customerId: "CUST-00001",
    company: COMPANY,
    query: "   ",
  });
  assert.equal(read.data.data.length, 4);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. one implementation (the twin must not drift)
// ─────────────────────────────────────────────────────────────────────────────

test("the legacy unpaid-invoice read returns the SAME rows as the new one", async () => {
  // Chat balance, the drill-down, the proposal builder and the collect screen
  // all read open invoices. Two implementations would eventually disagree about
  // what the shop is owed, so the old name delegates to the one reader.
  const rows = invoices(5);
  const scoped = await listOpenSalesInvoices(fakeMcp({ rows }), { customerId: "CUST-00001", company: COMPANY });
  const legacy = await listUnpaidInvoices(fakeMcp({ rows }), "CUST-00001", new Set(["CUST-00001"]));

  assert.deepEqual(legacy.data.data, scoped.data.data);
  assert.equal(legacy.data.count, 5, "the legacy shape keeps `count`");
});

test("the legacy read carries the live company when the caller knows it", async () => {
  const rows = [...invoices(1), ...invoices(1, { company: OTHER_COMPANY, start: 9 })];
  const scoped = await listUnpaidInvoices(fakeMcp({ rows }), "CUST-00001", new Set(["CUST-00001"]), {
    company: COMPANY,
  });
  assert.equal(scoped.data.data.length, 1);
  assert.equal(scoped.data.data[0].company, COMPANY);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. money accounts (§6.2, UI half)
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNTS = [
  { name: "1110 - Tiền mặt - MP", account_name: "Tiền mặt", account_type: "Cash", is_group: 0, company: COMPANY },
  { name: "1210 - ACB 110296868 - MP", account_name: "ACB 110296868", account_type: "Bank", is_group: 0, company: COMPANY },
  { name: "1310 - Phải thu khách hàng - MP", account_name: "Phải thu khách hàng", account_type: "Receivable", is_group: 0, company: COMPANY },
  { name: "1111 - Tiền mặt - SAN", account_name: "Tiền mặt", account_type: "Cash", is_group: 0, company: OTHER_COMPANY },
];

test("money accounts are read per account type, for the company only", async () => {
  const mcp = fakeMcp({ accounts: ACCOUNTS, companyDefaults: { default_cash_account: "1110 - Tiền mặt - MP", default_bank_account: "1210 - ACB 110296868 - MP" } });
  const out = await listMoneyAccounts(mcp, { company: COMPANY });

  assert.deepEqual(out.data.cash.map((a) => a.account), ["1110 - Tiền mặt - MP"]);
  assert.deepEqual(out.data.bank.map((a) => a.account), ["1210 - ACB 110296868 - MP"]);
  assert.equal(out.data.defaults.cash, "1110 - Tiền mặt - MP");
  assert.equal(out.data.defaults.bank, "1210 - ACB 110296868 - MP");
  assert.ok(
    !out.data.cash.some((a) => a.company === OTHER_COMPANY),
    "another company's account must not be offered",
  );
});

test("a group account is not a money account (only leaves receive money)", async () => {
  const mcp = fakeMcp({
    accounts: [
      ...ACCOUNTS,
      { name: "1100 - Tiền - MP", account_name: "Tiền", account_type: "Cash", is_group: 1, company: COMPANY },
    ],
  });
  const out = await listMoneyAccounts(mcp, { company: COMPANY });
  assert.deepEqual(out.data.cash.map((a) => a.account), ["1110 - Tiền mặt - MP"]);
});

test("an unresolved account type is reported, never substituted", async () => {
  // A company with cash but no bank account: "chuyển khoản" must be told there is
  // no bank account — NOT silently handed the cash account (the 1110 bug).
  const mcp = fakeMcp({ accounts: [ACCOUNTS[0]], companyDefaults: { default_cash_account: "1110 - Tiền mặt - MP" } });
  const out = await listMoneyAccounts(mcp, { company: COMPANY });

  assert.deepEqual(out.data.bank, []);
  assert.equal(out.data.defaults.bank, null, "a missing default is null, never the cash account");
  assert.equal(out.data.resolved.Bank, false);
  assert.equal(out.data.resolved.Cash, true);
});

test("without a company the read refuses instead of listing every company's accounts", async () => {
  const mcp = fakeMcp({ accounts: ACCOUNTS });
  const out = await listMoneyAccounts(mcp, {});
  assert.equal(out.ok, false);
  assert.equal(out.code, "COMPANY_REQUIRED");
  assert.equal(mcp.calls.length, 0, "an unresolvable company must not trigger a read");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. read-only tripwire
// ─────────────────────────────────────────────────────────────────────────────

test("TRIPWIRE: nothing in the collect reads can write", () => {
  const strip = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  for (const rel of ["src/skills/sales.mjs", "src/skills/accounts.mjs", "src/read-views.mjs"]) {
    const src = strip(readFileSync(path.join(ROOT, rel), "utf8"));
    for (const needle of ["callWriteTool", "/execute", "executePaymentProposal", "WRITE_EXECUTORS"]) {
      assert.ok(!src.includes(needle), `${rel} must not reference ${needle}`);
    }
  }
});
