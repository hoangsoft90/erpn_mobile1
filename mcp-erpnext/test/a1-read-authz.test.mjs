/**
 * A1 — the drill-down is behind the SAME authorization boundary as /ask.
 *
 * This file needs its own process: the capability contract is loaded once per
 * module load, so `ERPN_CAPABILITY_CONTRACT` has to be set BEFORE the import
 * below. The temp contract is the real one with `customer.balance` required to
 * hold "Accounts User" — READ capabilities declare no permission today, and
 * without this seam "the endpoint calls authorize()" would be an untestable
 * claim.
 *
 * The control matters as much as the refusal: the same request must succeed for
 * an account that DOES hold the permission, otherwise the 403 could be caused by
 * anything else on the path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const dir = mkdtempSync(path.join(tmpdir(), "a1-contract-"));
const contractPath = path.join(dir, "capabilities.json");
const contract = JSON.parse(readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));
contract.capabilities["customer.balance"].authorization.permissions = ["Accounts User"];
writeFileSync(contractPath, JSON.stringify(contract, null, 2), "utf8");
process.env.ERPN_CAPABILITY_CONTRACT = contractPath;

test("A1: /read/list enforces the screen capability's authorization (refuse, then control)", async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { getCapability } = await import("../src/capability-contract.mjs");
  assert.deepEqual(
    getCapability("customer.balance").authorization.permissions,
    ["Accounts User"],
    "the temp contract is really the one loaded",
  );

  const { createAskServer } = await import("../src/http-ask.mjs");

  const start = async (principal) => {
    const server = createAskServer({ port: 0, host: "127.0.0.1", principal });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
  };
  const post = (base, body) =>
    fetch(`${base}/read/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // 1. An account WITHOUT the permission: refused, and nothing is read.
  const denied = await start({ user_id: "shop-denied", permissions: [], companies: [] });
  try {
    const res = await post(`http://127.0.0.1:${denied.address().port}`, {
      screen: "customer_account",
      entity_id: "CUST-00001",
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "AUTHORIZATION_DENIED");
    assert.match(body.error, /shop-denied/);
    assert.equal("rows" in body, false, "a denied account gets no document list");
  } finally {
    await new Promise((resolve) => denied.close(resolve));
  }

  // 2. The control: the SAME screen works for an account that holds it.
  const allowed = await start({ user_id: "shop-allowed", permissions: ["Accounts User"], companies: [] });
  try {
    const res = await post(`http://127.0.0.1:${allowed.address().port}`, {
      screen: "customer_account",
      entity_id: "CUST-00001",
    });
    assert.equal(res.status, 200, "the 403 above came from the permission, not from the route");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.entity.id, "CUST-00001");
  } finally {
    await new Promise((resolve) => allowed.close(resolve));
  }
});
