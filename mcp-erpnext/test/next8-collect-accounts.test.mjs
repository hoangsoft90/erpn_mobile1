/**
 * next8 Phase 2 (b) — POST /collect/accounts.
 *
 * The account picker's READ: the capability in the contract, the route's
 * ordering (throttle → authorize → resolve company SERVER-side → read), and
 * the honesty rules the owner locked for Phase 2:
 *   - accounts come from the SITE per account_type (Cash/Bank) — never from a
 *     hardcoded 1110 (owner lock §6.2);
 *   - group nodes and non-money leaves never appear (the mock fixture carries
 *     both, so a leak here is a real leak);
 *   - the company is the SERVER's resolution — a client claim that disagrees is
 *     a 403, and an unresolvable company is a 503, never "all accounts".
 * Everything runs against the MOCK server (COPILOT_MOCK_OK=1), the same way
 * the A1 E2E does — one fixture, both sides of the boundary.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { getCapability, getUiScreen } from "../src/capability-contract.mjs";
import { listMoneyAccounts, ACCOUNT_READ_CODES } from "../src/skills/accounts.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";

process.env.COPILOT_MOCK_OK = "1";

// ─────────────────────────────────────────────────────────────────────────────
// 1. The contract declares the capability
// ─────────────────────────────────────────────────────────────────────────────

test("collect.accounts: READ capability declared in the contract, company-scoped", () => {
  const cap = getCapability("collect.accounts");
  assert.ok(cap, "the capability must exist in capabilities.json");
  assert.equal(cap.type, "READ");
  assert.equal(cap.risk?.level, "READ");
  assert.equal(cap.risk?.requires_confirmation, false);
  assert.equal(cap.authorization?.scope?.company, "required", "an account list must name whose books it reads");
  assert.deepEqual(cap.triggers, [], "no keyword route: a screen calls it by id, the classifier never fires it");
  assert.equal(cap.proposal_action ?? null, null, "a READ list builds no proposal");
});

test("collect.accounts: no ui_screens/drill_screens entry — the collect screen composes it, /read/list does not serve it", () => {
  // The account list is NOT a drill-down screen: it has no entity, no offered_by,
  // and it must not appear as a screen id /read/list would serve.
  assert.equal(getUiScreen("collect_accounts"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The skill against the mock server (same dialect as the real 3.0.4 tool)
// ─────────────────────────────────────────────────────────────────────────────

test("accounts skill: company missing is refused BEFORE any tool call", async () => {
  let called = false;
  const spy = { callTool: async () => { called = true; return { data: { data: [] } }; } };
  const res = await listMoneyAccounts(spy, { company: null });
  assert.equal(res.ok, false);
  assert.equal(res.code, ACCOUNT_READ_CODES.COMPANY_REQUIRED);
  assert.equal(called, false, "no company ⇒ no read — never a cross-tenant account list");
});

test("accounts skill: only Cash/Bank leaves, group + non-money nodes excluded, defaults honoured only when genuinely that type's leaf", async () => {
  const mcp = createMcpClient({ serverScript: MOCK_SERVER });
  const res = await listMoneyAccounts(mcp, { company: "Demo Feed Co" });
  assert.ok(!("ok" in res) || res.ok !== false, "a successful read is the markUntrusted payload, not a refusal");
  // markUntrusted wraps the payload in `data` — unwrap like every route does.
  const v = res.data ?? res;
  assert.equal(v.company, "Demo Feed Co");
  // The mock fixture deliberately contains `1000 - Cash` (a GROUP) and
  // `1310 - Debtors` (an untyped leaf). Neither may appear.
  assert.deepEqual(v.cash, [
    { account: "1110 - Cash - DFC", label: "1110 - Cash", account_type: "Cash", company: "Demo Feed Co" },
  ]);
  assert.deepEqual(v.bank, [
    { account: "1120 - Bank - DFC", label: "1120 - Bank", account_type: "Bank", company: "Demo Feed Co" },
  ]);
  assert.deepEqual(v.defaults, { cash: "1110 - Cash - DFC", bank: "1120 - Bank - DFC" });
  assert.deepEqual(v.resolved, { Cash: true, Bank: true });
  await mcp.close();
});

test("accounts skill: wrong company reads nothing of the pinned one", async () => {
  const mcp = createMcpClient({ serverScript: MOCK_SERVER });
  const res = await listMoneyAccounts(mcp, { company: "Another Tenant Co" });
  const v = res.data ?? res;
  assert.deepEqual(v.cash, []);
  assert.deepEqual(v.bank, []);
  assert.deepEqual(v.defaults, { cash: null, bank: null }, "another company's defaults are not substitutes");
  assert.deepEqual(v.resolved, { Cash: false, Bank: false });
  await mcp.close();
});

test("accounts skill: a company without declared defaults gets nulls, never the other type's account", async () => {
  process.env.MOCK_ERP_NO_COMPANY_DEFAULTS = "1";
  try {
    const mcp = createMcpClient({ serverScript: MOCK_SERVER });
    const res = await listMoneyAccounts(mcp, { company: "Demo Feed Co" });
    const v = res.data ?? res;
    assert.deepEqual(v.defaults, { cash: null, bank: null });
    // The accounts themselves still resolve — only the defaults are gone.
    assert.deepEqual(v.resolved, { Cash: true, Bank: true });
    await mcp.close();
  } finally {
    delete process.env.MOCK_ERP_NO_COMPANY_DEFAULTS;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The HTTP route (real handler, mock ERPNext child)
// ─────────────────────────────────────────────────────────────────────────────

test("/collect/accounts: serves typed accounts for the SERVER-resolved company; claims that disagree are refused", async () => {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const server = createAskServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const r = await post("/collect/accounts", {});
    assert.equal(r.status, 200);
    const v = (await r.json()).result;
    assert.equal(v.company, "Demo Feed Co", "the company comes from the ERPNext session default (server-side)");
    assert.deepEqual(v.resolved, { Cash: true, Bank: true });
    assert.ok(v.cash.every((a) => a.account_type === "Cash" && a.company === v.company));
    assert.ok(v.bank.every((a) => a.account_type === "Bank" && a.company === v.company));
    assert.ok(!v.cash.some((a) => a.account.startsWith("1000")), "a group node never becomes a pickable account");
    assert.ok(![...v.cash, ...v.bank].some((a) => a.account.startsWith("1310")), "the receivable ledger is not a money account");

    // A client claiming another company is refused (403), not silently served
    // the pinned one — the same rule /read/list and /read/daily-summary follow.
    const claim = await post("/collect/accounts", { company: "Other Co" });
    assert.equal(claim.status, 403);
    assert.equal((await claim.json()).code, "COMPANY_SCOPE_MISMATCH");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("/collect/accounts: only POST is allowed, unknown company is a 503 that says what to configure", async () => {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const server = createAskServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    const wrongMethod = await fetch(`${base}/collect/accounts`, { method: "GET" });
    assert.equal(wrongMethod.status, 404, "the collect route is POST-only like its /read siblings");

    // A site with NO session default company: the route refuses (503) instead
    // of listing every tenant's accounts (the resolveReadCompany contract).
    process.env.MOCK_ERP_DEFAULT_COMPANY = "";
    try {
      const r = await fetch(`${base}/collect/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(r.status, 503);
      const body = await r.json();
      assert.equal(body.code, "COMPANY_UNRESOLVED");
      assert.match(body.error, /COPILOT_COMPANY/);
    } finally {
      delete process.env.MOCK_ERP_DEFAULT_COMPANY;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
