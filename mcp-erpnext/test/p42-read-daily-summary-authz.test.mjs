/**
 * P4-2 — /read/daily-summary is behind the SAME authorization boundary as /ask,
 * and the boundary is checked BEFORE any ERPNext read.
 *
 * Needs its own process: the capability contract is loaded once per module load,
 * so `ERPN_CAPABILITY_CONTRACT` must be set BEFORE the import below. The temp
 * contract is the real one with `ops.daily_summary` required to hold
 * "Accounts User" — READ capabilities declare no permission today, and without
 * this seam "the route calls authorize()" would be an untestable claim.
 *
 * The ordering proof is a PAIR on one env: with the session-company read rigged
 * to fail (`MOCK_ERP_FAIL_GLOBAL_DEFAULTS=1`, no pinned company), a denied
 * account gets 403 while an allowed one gets 503. The only difference between
 * the two requests is the permission, so a 403 cannot be explained by a failing
 * read — it means the read never happened.
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

const dir = mkdtempSync(path.join(tmpdir(), "p42-contract-"));
const contractPath = path.join(dir, "capabilities.json");
const contract = JSON.parse(readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));
contract.capabilities["ops.daily_summary"].authorization.permissions = ["Accounts User"];
writeFileSync(contractPath, JSON.stringify(contract, null, 2), "utf8");
process.env.ERPN_CAPABILITY_CONTRACT = contractPath;

const D = "2026-09-21";
const COMPANY = "Minh Phát Cám & VLXD";

test("P4-2 authz: denied account gets 403 and ZERO ERPNext reads; the allowed one is the control", async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { getCapability } = await import("../src/capability-contract.mjs");
  assert.deepEqual(
    getCapability("ops.daily_summary").authorization.permissions,
    ["Accounts User"],
    "the temp contract is really the one loaded",
  );

  const { createAskServer } = await import("../src/http-ask.mjs");
  const start = async (principal) => {
    const server = createAskServer({ port: 0, host: "127.0.0.1", principal, env: { ...process.env } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  };
  const getDay = (port) => fetch(`http://127.0.0.1:${port}/read/daily-summary?date=${D}`);

  process.env.MOCK_ERP_P4_FIXTURE = JSON.stringify({
    Company: [{ name: COMPANY, default_cash_account: "1110 - Tiền mặt - MP", default_bank_account: null, company: COMPANY }],
    Account: [],
    "GL Entry": [],
    "Sales Order": [],
    "Sales Invoice": [],
    "Payment Entry": [],
  });

  try {
    // 1. No permission: refused, BEFORE the session-company read (which is rigged
    //    to fail here). A 503 would mean the read ran first.
    process.env.MOCK_ERP_FAIL_GLOBAL_DEFAULTS = "1";
    const denied = await start({ user_id: "shop-denied", permissions: [], companies: [], mode: "single_tenant" });
    try {
      const res = await getDay(denied.port);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "AUTHORIZATION_DENIED");
      assert.match(body.error, /shop-denied/);
      assert.equal("sales_invoices" in body, false, "a denied account gets no numbers");
    } finally {
      await denied.close();
    }

    // 2. The control on the SAME rigged env: allowed → the read DOES happen and
    //    fails loudly (503). So step 1's 403 is about permission, not about the
    //    read being broken.
    const allowed = await start({
      user_id: "shop-allowed",
      permissions: ["Accounts User"],
      companies: [],
      mode: "single_tenant",
    });
    try {
      const res = await getDay(allowed.port);
      assert.equal(res.status, 503, "allowed account reaches the rigged read");
      const body = await res.json();
      // The MCP layer's own TOOL_ERROR is reported as the spec's vocabulary for
      // "ERPNext could not be read"; the raw reason travels in `error`.
      assert.equal(body.code, "ERP_UNAVAILABLE");
      assert.match(body.error, /Global Defaults/);
    } finally {
      await allowed.close();
    }

    // 3. And with the read healthy again, the allowed account gets real numbers.
    delete process.env.MOCK_ERP_FAIL_GLOBAL_DEFAULTS;
    const working = await start({
      user_id: "shop-allowed",
      permissions: ["Accounts User"],
      companies: [],
      mode: "single_tenant",
    });
    try {
      const res = await getDay(working.port);
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.meta.company, COMPANY);
      assert.equal(body.meta.date, D);
    } finally {
      await working.close();
    }
  } finally {
    delete process.env.MOCK_ERP_P4_FIXTURE;
    delete process.env.MOCK_ERP_FAIL_GLOBAL_DEFAULTS;
  }
});
