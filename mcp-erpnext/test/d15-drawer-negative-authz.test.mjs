/**
 * D1.5 — the drawer's negative permission test (drawer-plan-final §4).
 *
 * The plan demands: "user không được Customer X → list không chứa X", and
 * forbids bypassing permissions with a report/SQL that ignores them. What the
 * drawer actually has TODAY is a permission boundary (authorize() runs BEFORE
 * any ERP read, per capability) and NO row-level filter: the copilot talks to
 * ERPNext through ONE API key, so ERPNext's own User Permission (Customer)
 * filtering can never see a per-end-user identity — there is nothing to derive
 * "which customer rows this user may see" from.
 *
 * So this file proves the boundary that EXISTS, end to end, and nothing more:
 *
 *   1. TEMP CONTRACT: the real one with the two drawer debt capabilities
 *      (`customer.balance` — owner of receivable_customers/overdue_top — and
 *      `invoice.lookup` — owner of unpaid_invoices) required to hold
 *      "Accounts User". READ capabilities declare no permission today, and
 *      without this seam the negative test would be untestable (the exact seam
 *      p44-read-drill-authz.test.mjs established for receipts_today). Needs its
 *      own process because the contract is loaded once per module load.
 *
 *   2. THE PAIR on one rigged env (MOCK_ERP_FAIL_GLOBAL_DEFAULTS=1, no pinned
 *      company): a denied account gets 403 while an allowed one gets 503. The
 *      only difference between the two requests is the permission — so the 403
 *      means the ERP read never happened. No permission ⇒ NO rows at all (no
 *      `rows`, no `summary_lines`) on BOTH drawer debts and HĐ chưa trả.
 *
 *   3. THE CONTROL: the same requests succeed for an account that DOES hold
 *      the permission, and the served lists are the fixture's lists — nobody
 *      is dropped by an accident of the path.
 *
 *   4. THE NO-GO, recorded not faked: customer-level row filtering
 *      (ERPNext User Permission per Customer) is NOT implemented end to end —
 *      one shared API key ⇒ no per-user identity reaches the ERP layer. That is
 *      a NO-GO for the §4 bullet "user hạn chế không thấy Customer X", stated
 *      here as an explicit skip with the reason; the plan's alternative
 *      ("không fake PASS") is exactly what this avoids.
 */

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
delete process.env.COPILOT_COMPANY;
delete process.env.COPILOT_USERS;
process.env.COPILOT_MOCK_OK = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const dir = mkdtempSync(path.join(tmpdir(), "d15-contract-"));
const contractPath = path.join(dir, "capabilities.json");
const contract = JSON.parse(readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));
contract.capabilities["customer.balance"].authorization.permissions = ["Accounts User"];
contract.capabilities["invoice.lookup"].authorization.permissions = ["Accounts User"];
writeFileSync(contractPath, JSON.stringify(contract, null, 2), "utf8");
process.env.ERPN_CAPABILITY_CONTRACT = contractPath;

const D = "2026-09-21";
const COMPANY = "Minh Phát Cám & VLXD";
const CUST_X = "Chị Lan";
const CUST_Y = "Anh Bảy";

test("D1.5: a denied account gets 403 and ZERO rows on every drawer debt view — the allowed one is the control", async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { getDrillScreen, getCapability } = await import("../src/capability-contract.mjs");
  // The ids really resolve to the capabilities the temp contract tightened —
  // otherwise this test could pass while authorizing nothing relevant.
  assert.equal(getDrillScreen("receivable_customers").capability, "customer.balance");
  assert.equal(getDrillScreen("overdue_top").capability, "customer.balance");
  assert.equal(getDrillScreen("unpaid_invoices").capability, "invoice.lookup");
  assert.deepEqual(getCapability("customer.balance").authorization.permissions, ["Accounts User"], "the temp contract is the one loaded");
  assert.deepEqual(getCapability("invoice.lookup").authorization.permissions, ["Accounts User"], "the temp contract is the one loaded");

  const { createAskServer } = await import("../src/http-ask.mjs");
  const start = async (principal) => {
    const server = createAskServer({ port: 0, host: "127.0.0.1", principal, env: { ...process.env } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  };
  const getDrill = (port, id) => fetch(`http://127.0.0.1:${port}/read/drill?drill_id=${id}&date=${D}`);

  process.env.MOCK_ERP_P4_FIXTURE = JSON.stringify({
    Company: [{ name: COMPANY, default_cash_account: null, default_bank_account: null, company: COMPANY }],
    Account: [],
    "GL Entry": [],
    "Sales Order": [],
    "Sales Invoice": [
      { name: "INV-A", docstatus: 1, status: "Unpaid", grand_total: 20_000_000, outstanding_amount: 20_000_000, due_date: D, posting_date: D, customer: CUST_X, company: COMPANY },
      { name: "INV-B", docstatus: 1, status: "Unpaid", grand_total: 5_000_000, outstanding_amount: 5_000_000, due_date: D, posting_date: D, customer: CUST_Y, company: COMPANY },
    ],
    "Payment Entry": [],
  });

  try {
    // ── 1. negative: no permission ⇒ 403 BEFORE any read, on ALL THREE views ──
    process.env.MOCK_ERP_FAIL_GLOBAL_DEFAULTS = "1";
    const denied = await start({ user_id: "shop-denied", permissions: [], companies: [], mode: "single_tenant" });
    try {
      for (const id of ["receivable_customers", "overdue_top", "unpaid_invoices"]) {
        const res = await getDrill(denied.port, id);
        assert.equal(res.status, 403, `${id}: denied account must be refused`);
        const body = await res.json();
        assert.equal(body.code, "AUTHORIZATION_DENIED");
        assert.match(body.error, /shop-denied/);
        assert.equal("rows" in body, false, `${id}: a denied account gets no rows at all`);
        assert.equal("summary_lines" in body, false, `${id}: a denied account gets no figures at all`);
      }
    } finally {
      await denied.close();
    }

    // ── 2. control on the SAME rigged env: allowed → the read DOES happen and
    // fails loudly (503), so step 1's 403 was about the permission, not the path.
    const allowed = await start({ user_id: "shop-allowed", permissions: ["Accounts User"], companies: [], mode: "single_tenant" });
    try {
      const res = await getDrill(allowed.port, "receivable_customers");
      assert.equal(res.status, 503, "allowed account reaches the rigged read");
      const body = await res.json();
      assert.equal(body.code, "ERP_UNAVAILABLE");
    } finally {
      await allowed.close();
    }

    // ── 3. read healthy again: the allowed account gets the FULL fixture list —
    // both customers present. (The row-level half of §4 is the NO-GO below;
    // this control only proves the permission grant itself serves data.)
    delete process.env.MOCK_ERP_FAIL_GLOBAL_DEFAULTS;
    const ok = await start({ user_id: "shop-allowed", permissions: ["Accounts User"], companies: [], mode: "single_tenant" });
    try {
      const body = await (await getDrill(ok.port, "receivable_customers")).json();
      assert.equal(body.total_documents, 2);
      assert.deepEqual(body.rows.map((r) => r.name), [CUST_X, CUST_Y], "the granted account sees the whole list — nothing dropped by accident");
      const inv = await (await getDrill(ok.port, "unpaid_invoices")).json();
      assert.deepEqual(inv.rows.map((r) => r.name), ["INV-A", "INV-B"]);
    } finally {
      await ok.close();
    }
  } finally {
    delete process.env.MOCK_ERP_P4_FIXTURE;
    delete process.env.MOCK_ERP_FAIL_GLOBAL_DEFAULTS;
  }
});

test("D1.5 NO-GO (recorded, not faked): per-customer row filtering (User Permission) has no end-to-end path", async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // §4's bullet "user hạn chế KHÔNG thấy Customer X" needs ERPNext to filter
  // rows per END USER. The copilot's ERP layer is ONE shared API key: whatever
  // the HTTP principal is, the ERPNext reads run as the same ERP user, so a
  // User Permission on that user would filter EVERY account identically (and a
  // client-side copy of the rule would be a fake boundary the server does not
  // enforce). Implementing it requires per-user ERP credentials — a scope
  // decision for the user, not a code change to slip into this phase.
  //
  // What IS enforced today (proven in the test above): capability-level
  // permission + company scope, checked server-side BEFORE any read, with no
  // bypass through a report (the drawer reads doc_list only — no SQL report
  // tool anywhere on the path).
  //
  // This "test" records the NO-GO so the result file can point at a red-or-green
  // line in the suite instead of a promise. It asserts the structural fact that
  // makes the NO-GO true, so a future change that ADDS a per-user ERP identity
  // makes this line stale and forces the row-level test to be written for real.
  const { readFileSync: rf } = await import("node:fs");
  const src = rf(fileURLToPath(new URL("../src/http-ask.mjs", import.meta.url)), "utf8");
  // The drill route resolves its principal from the HTTP edge only — no ERP-side
  // user identity travels into the read path (no session-user tool call there).
  const start = src.indexOf('path === "/read/drill"');
  assert.ok(start > 0);
  const block = src.slice(start, src.indexOf('path === "/ocr"', start));
  assert.equal(block.includes("session_user"), false, "no per-user ERP identity is resolved on the drill path — the NO-GO premise still holds");
});
