/**
 * P4-4 — /read/drill sits behind the SAME authorization boundary as /ask, and
 * the check runs BEFORE any ERPNext read.
 *
 * Needs its own process: the capability contract is loaded once per module load,
 * so `ERPN_CAPABILITY_CONTRACT` must be set BEFORE the import below. The temp
 * contract is the real one with the capability behind `receipts_today` required
 * to hold "Accounts User" — READ capabilities declare no permission today, and
 * without this seam "the route authorizes the drill's own capability" would be
 * an untestable claim.
 *
 * The ordering proof is a PAIR on one env: with the session-company read rigged
 * to fail (`MOCK_ERP_FAIL_GLOBAL_DEFAULTS=1`, no pinned company), a denied
 * account gets 403 while an allowed one gets 503. The only difference between the
 * two requests is the permission — so the 403 means the ERP read never happened,
 * not that it failed. This also pins that a drill is authorized against the
 * capability the CONTRACT names for that id (payment.history here), not against
 * some generic read permission.
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

const dir = mkdtempSync(path.join(tmpdir(), "p44-contract-"));
const contractPath = path.join(dir, "capabilities.json");
const contract = JSON.parse(readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));
contract.capabilities["payment.history"].authorization.permissions = ["Accounts User"];
writeFileSync(contractPath, JSON.stringify(contract, null, 2), "utf8");
process.env.ERPN_CAPABILITY_CONTRACT = contractPath;

const D = "2026-09-21";
const COMPANY = "Minh Phát Cám & VLXD";

test("P4-4 authz: denied account gets 403 and ZERO ERPNext reads; the allowed one is the control", async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { getDrillScreen, getCapability } = await import("../src/capability-contract.mjs");
  // The id really resolves to the capability the temp contract tightened —
  // otherwise this test could pass while authorizing nothing relevant.
  assert.equal(getDrillScreen("receipts_today").capability, "payment.history");
  assert.deepEqual(getCapability("payment.history").authorization.permissions, ["Accounts User"], "the temp contract is the one loaded");

  const { createAskServer } = await import("../src/http-ask.mjs");
  const start = async (principal) => {
    const server = createAskServer({ port: 0, host: "127.0.0.1", principal, env: { ...process.env } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  };
  const getDrill = (port) => fetch(`http://127.0.0.1:${port}/read/drill?drill_id=receipts_today&date=${D}`);

  process.env.MOCK_ERP_P4_FIXTURE = JSON.stringify({
    Company: [{ name: COMPANY, default_cash_account: null, default_bank_account: null, company: COMPANY }],
    Account: [],
    "GL Entry": [],
    "Sales Order": [],
    "Sales Invoice": [],
    "Payment Entry": [],
  });

  try {
    // 1. No permission: refused, BEFORE the session-company read (rigged to
    //    fail). A 503 would mean the read ran first.
    process.env.MOCK_ERP_FAIL_GLOBAL_DEFAULTS = "1";
    const denied = await start({ user_id: "shop-denied", permissions: [], companies: [], mode: "single_tenant" });
    try {
      const res = await getDrill(denied.port);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "AUTHORIZATION_DENIED");
      assert.match(body.error, /shop-denied/);
      assert.equal("rows" in body, false, "a denied account gets no rows at all");
      assert.equal("summary_lines" in body, false);
    } finally {
      await denied.close();
    }

    // 2. Control on the SAME rigged env: allowed → the read DOES happen and
    //    fails loudly (503), so step 1's 403 was about permission.
    const allowed = await start({ user_id: "shop-allowed", permissions: ["Accounts User"], companies: [], mode: "single_tenant" });
    try {
      const res = await getDrill(allowed.port);
      assert.equal(res.status, 503, "allowed account reaches the rigged read");
      const body = await res.json();
      assert.equal(body.code, "ERP_UNAVAILABLE");
      assert.match(body.error, /Global Defaults/);
    } finally {
      await allowed.close();
    }

    // 3. Read healthy again: the allowed account gets rows (and no other
    //    capability's permission was needed to get them).
    delete process.env.MOCK_ERP_FAIL_GLOBAL_DEFAULTS;
    const ok = await start({ user_id: "shop-allowed", permissions: ["Accounts User"], companies: [], mode: "single_tenant" });
    try {
      const res = await getDrill(ok.port);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.drill, "receipts_today");
      // D4 — `receipts_today` is day-scoped, so the payload's title now NAMES
      // the day it read instead of being the contract string verbatim (which
      // was the pre-D4 rule this line used to encode). Asserted as a PROPERTY
      // (leads with the drill's own name, names the day) rather than by calling
      // the composition helper, which would make the assertion tautological.
      assert.ok(
        body.title.startsWith(getDrillScreen("receipts_today").title),
        `the title must lead with the drill's own name, got "${body.title}"`,
      );
      assert.match(body.title, new RegExp(D), "the title must name the day that was read");
      assert.deepEqual(body.rows, []);
      assert.equal(body.total_documents, 0);
      assert.equal(body.truncated, false);
    } finally {
      await ok.close();
    }
  } finally {
    delete process.env.MOCK_ERP_P4_FIXTURE;
    delete process.env.MOCK_ERP_FAIL_GLOBAL_DEFAULTS;
  }
});
