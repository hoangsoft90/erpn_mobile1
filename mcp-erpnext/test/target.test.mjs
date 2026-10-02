/**
 * Unit tests for the ERPNext target switch (copilot-server.mjs).
 *
 * Contract (issue1_fix1 — mock is opt-in, never a silent fallback):
 *   - no ERPNEXT_* and no `COPILOT_MOCK_OK=1` -> THROW ERPNEXT_NOT_CONFIGURED
 *   - no ERPNEXT_* but `COPILOT_MOCK_OK=1`    -> fixture server (explicit opt-in)
 *   - all three ERPNEXT_*                     -> pinned real server binary
 *   - partial or malformed config             -> hard error
 *
 * The change from the old contract (`pickServerScript({}) === MOCK_SERVER`) is
 * a DELIBERATE behaviour change, not a test made to pass: a silent fixture
 * fallback is what manufactured real-looking customer data in issue1.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { erpTargetLabel, pickServerScript } from "../src/copilot-server.mjs";
import { MOCK_SERVER } from "../src/client.mjs";
import { realServerScript } from "../src/index.mjs";

test("no ERPNEXT_* and no COPILOT_MOCK_OK -> refuses with ERPNEXT_NOT_CONFIGURED", () => {
  assert.throws(() => pickServerScript({}), /ERPNEXT_NOT_CONFIGURED/);
});

test("explicit COPILOT_MOCK_OK=1 -> fixture server (the only way to reach it)", () => {
  assert.equal(pickServerScript({ COPILOT_MOCK_OK: "1" }), MOCK_SERVER);
});

test("COPILOT_MOCK_OK accepts exactly '1' — truthy lookalikes still refuse", () => {
  // A typo like `true`/`yes` must NOT be read as consent: this is the gate that
  // decides whether fabricated data may be served, so it stays strict.
  for (const value of ["true", "TRUE", "yes", "on", "0", "", " 1"]) {
    assert.throws(
      () => pickServerScript({ COPILOT_MOCK_OK: value }),
      /ERPNEXT_NOT_CONFIGURED/,
      `COPILOT_MOCK_OK=${JSON.stringify(value)} must not enable the fixture`,
    );
  }
});

test("all three ERPNEXT_* env -> pinned real server binary", () => {
  const script = pickServerScript({
    ERPNEXT_URL: "https://example.ngrok-free.dev",
    ERPNEXT_API_KEY: "k",
    ERPNEXT_API_SECRET: "s",
  });
  assert.equal(script, realServerScript());
  assert.ok(script.includes("@casys/mcp-erpnext"), script);
});

test("partial config -> hard error naming the missing vars", () => {
  assert.throws(
    () => pickServerScript({ ERPNEXT_URL: "https://x.dev" }),
    /PARTIAL_ERPNEXT_CONFIG.*ERPNEXT_API_KEY, ERPNEXT_API_SECRET/,
  );
  assert.throws(
    () => pickServerScript({ ERPNEXT_API_KEY: "k", ERPNEXT_API_SECRET: "s" }),
    /PARTIAL_ERPNEXT_CONFIG.*ERPNEXT_URL/,
  );
});

test("partial config is NOT rescued by COPILOT_MOCK_OK (half-configured != unconfigured)", () => {
  // A half-configured deployment is a mistake to surface, not a licence to run
  // on fixtures: the operator clearly intended real data.
  assert.throws(
    () => pickServerScript({ ERPNEXT_URL: "https://x.dev", COPILOT_MOCK_OK: "1" }),
    /PARTIAL_ERPNEXT_CONFIG/,
  );
});

test("malformed URL -> hard error, not silent mock fallback", () => {
  assert.throws(
    () => pickServerScript({ ERPNEXT_URL: "not a url", ERPNEXT_API_KEY: "k", ERPNEXT_API_SECRET: "s" }),
    /INVALID_ERPNEXT_URL/,
  );
});

test("non-http(s) protocol refused", () => {
  assert.throws(
    () => pickServerScript({ ERPNEXT_URL: "ftp://x.dev", ERPNEXT_API_KEY: "k", ERPNEXT_API_SECRET: "s" }),
    /INVALID_ERPNEXT_URL.*protocol/,
  );
});

// ───────────── erpTargetLabel — the SAME rule, for the app's footer ──────────
// The drawer prints REAL|MOCK next to money numbers, so the label has to be
// derived, not asserted by hand: these tests lock it to the switch that
// actually picks the server, on both sides.

test("erpTargetLabel says exactly what pickServerScript decided (both branches)", () => {
  const realEnv = {
    ERPNEXT_URL: "https://example.ngrok-free.dev",
    ERPNEXT_API_KEY: "k",
    ERPNEXT_API_SECRET: "s",
  };
  assert.equal(erpTargetLabel(realEnv), "REAL");
  assert.notEqual(pickServerScript(realEnv), MOCK_SERVER);

  const mockEnv = { COPILOT_MOCK_OK: "1" };
  assert.equal(erpTargetLabel(mockEnv), "MOCK");
  assert.equal(pickServerScript(mockEnv), MOCK_SERVER);
});

test("erpTargetLabel is presence-only, like the switch: unreachable still REAL", () => {
  // If this said MOCK for a dead host, the footer would tell the shop owner they
  // are looking at a rehearsal while the service is really pointed at ERPNext.
  assert.equal(erpTargetLabel({ ERPNEXT_URL: "http://127.0.0.1:1" }), "REAL");
  assert.equal(erpTargetLabel({ COPILOT_MOCK_OK: "1" }), "MOCK");
});

test("unreachable-but-configured host still resolves to REAL (connectivity is not the target switch)", () => {
  // 6b-2: "missing config" and "configured but unreachable" are DIFFERENT
  // faults. The switch decides by presence of config only, so an unreachable
  // host must NOT be answered from fixtures — it resolves to the real server
  // and the failure surfaces at call time (see mock-optin.test.mjs for the
  // live-call half of this proof).
  const script = pickServerScript({
    ERPNEXT_URL: "http://127.0.0.1:1",
    ERPNEXT_API_KEY: "k",
    ERPNEXT_API_SECRET: "s",
  });
  assert.equal(script, realServerScript());
  assert.notEqual(script, MOCK_SERVER);
});
