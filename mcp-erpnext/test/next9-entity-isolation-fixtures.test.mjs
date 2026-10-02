/**
 * next9 — entity isolation on INJECTED master data (prompt-1 §5 Test D, §8
 * Test G).
 *
 * Why a second file: the mock reads `MOCK_ERP_STATE` once, when it is imported.
 * Tests A/B/C/E/F/H need no extra master data, so they run in the plain fixture
 * process; D and G need rows the mock does not ship, so their state file has to
 * exist BEFORE the first import — which node gives us for free by running each
 * test FILE in its own process.
 *
 *   Test D — two customers share a name → the answer is AMBIGUOUS, never a pick
 *            (not the first, not the latest, not the debtor, not the context).
 *   Test G — remembered state must not cross entity types: a remembered customer
 *            must not answer a supplier request, and a remembered supplier must
 *            not answer a customer document.
 *
 * Measured against `scripts/probe-next9-fixtures.mjs` (same fixtures), so the
 * expectations below are recorded behaviour, not guesses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const LAN_ID = "CUST-00001";
const AMBIGUOUS_IDS = ["CUST-AMB-A", "CUST-AMB-B"];
const SUPPLIER_ID = "SUP-MINH-PHAT";

/** The injected master data: twin customers + a supplier the mock lacks. */
const FIXTURE_STATE = {
  customers_created: AMBIGUOUS_IDS.map((id) => ({
    doctype: "Customer",
    name: id,
    customer_name: "Nguyễn Văn A",
    customer_group: null,
    disabled: 0,
    docstatus: 0,
  })),
  suppliers_created: [
    { name: SUPPLIER_ID, supplier_name: "Minh Phát", supplier_group: "Vật liệu", supplier_type: "Company", disabled: 0 },
  ],
};

async function startNlpService() {
  const { spawn } = await import("node:child_process");
  const REPO = path.resolve(ROOT, "..");
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`nlp service exited early (${code})`)));
    setTimeout(() => reject(new Error("nlp service: no ready line in 5s")), 5000);
  });
  return { child, port };
}

/**
 * The state file MUST be written before the first dynamic import of the server
 * (the mock captures `MOCK_ERP_STATE` at import time) — that ordering is the
 * whole reason this helper exists instead of reusing the other file's.
 */
async function withServer(fn) {
  const nlp = await startNlpService();
  const dir = mkdtempSync(path.join(tmpdir(), "next9-fx-"));
  writeFileSync(path.join(dir, "mock-erp.json"), JSON.stringify(FIXTURE_STATE));
  const previousPort = process.env.NLP_SERVICE_PORT;
  const previousState = process.env.MOCK_ERP_STATE;
  let server = null;
  const { __setNlpServicePortForTest, __resetSessionContext, __sessionContext } =
    await import("../src/copilot-server.mjs");
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
    __setNlpServicePortForTest(nlp.port);
    __resetSessionContext();
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: new IdempotencyStore(dir) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({
      base: `http://127.0.0.1:${server.address().port}`,
      resetSessionContext: __resetSessionContext,
      contextEntries: () => [...__sessionContext().entries.keys()],
    });
  } finally {
    server?.close();
    nlp.child.kill();
    __setNlpServicePortForTest(previousPort ?? "8787");
    if (previousPort === undefined) delete process.env.NLP_SERVICE_PORT;
    if (previousState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
}

const ask = async (base, text) => {
  const r = await fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return { status: r.status, body: await r.json() };
};

const result = (r) => r.body?.result ?? {};

const boundPartyId = (r) => {
  const res = result(r);
  const c = res.customer;
  return res.proposal?.entity?.id ?? (c && typeof c === "object" ? (c.id ?? c.name ?? null) : (c ?? null));
};

const candidateIds = (r) => (result(r).candidates ?? []).map((c) => c?.id ?? c?.name ?? c);

test("next9 Test D — an ambiguous name is refused, never auto-picked", async () => {
  await withServer(async ({ base }) => {
    // Baseline: no context at all.
    const d0 = await ask(base, "thu tiền Nguyễn Văn A 10000");
    assert.equal(d0.status, 200);
    assert.equal(result(d0).entity?.state, "AMBIGUOUS_MATCH", `expected ambiguity: ${JSON.stringify(result(d0))}`);
    assert.equal(result(d0).error_code, "AMBIGUOUS_ENTITY");
    assert.equal(result(d0).proposal, null, "an ambiguous party must never be proposed");
    assert.equal(boundPartyId(d0), null, "and never bound");
    for (const id of AMBIGUOUS_IDS) {
      assert.ok(candidateIds(d0).includes(id), `both twins must be OFFERED, not chosen (missing ${id})`);
    }

    // With a DIFFERENT customer remembered — the context must not break the tie.
    await ask(base, "công nợ của Nguyễn Thị Lan");
    const d1 = await ask(base, "thu tiền Nguyễn Văn A 10000");
    assert.equal(d1.status, 200);
    assert.equal(result(d1).entity?.state, "AMBIGUOUS_MATCH", `context must not resolve the ambiguity: ${JSON.stringify(result(d1))}`);
    assert.equal(result(d1).error_code, "AMBIGUOUS_ENTITY");
    assert.equal(result(d1).proposal, null);
    assert.equal(boundPartyId(d1), null, "the remembered customer must not be substituted either");
    for (const id of AMBIGUOUS_IDS) {
      assert.ok(candidateIds(d1).includes(id), `both twins are still offered (missing ${id})`);
    }
  });
});

test("next9 Test G — remembered state never crosses entity types", async () => {
  await withServer(async ({ base, contextEntries }) => {
    // ── G1: a remembered CUSTOMER while asking about a SUPPLIER ───────────────
    await ask(base, "công nợ của Nguyễn Thị Lan");
    assert.ok(
      contextEntries().some((k) => k.endsWith("\u0000customer")),
      "setup assertion: the customer context must exist",
    );

    const g1 = await ask(base, "thông tin nhà cung cấp Minh Phát");
    assert.equal(result(g1).supplier?.id ?? result(g1).supplier, SUPPLIER_ID, `expected the supplier: ${JSON.stringify(result(g1))}`);
    // The read's own proposal entity must be the SUPPLIER — the remembered
    // customer must not be the bound party of a supplier request (asserted by
    // kind: this helper is generic and would have returned the supplier id).
    assert.equal(result(g1).proposal?.entity?.kind, "supplier", "the bound entity must be the supplier kind");
    assert.equal(result(g1).customer ?? null, null, "no customer may be attached to a supplier request");
    assert.equal(
      JSON.stringify(result(g1)).includes(LAN_ID),
      false,
      "the remembered customer id must not appear in a supplier answer",
    );

    // A write sentence for a supplier, still with the customer remembered: no
    // customer may leak in (measured: refused for its own reason, proposal null).
    const g1b = await ask(base, "đặt hàng NCC Minh Phát");
    assert.equal(boundPartyId(g1b), null, `no customer may leak into a purchase request: ${JSON.stringify(result(g1b))}`);
    assert.equal(result(g1b).proposal, null);

    // ── G2: a remembered SUPPLIER while writing a CUSTOMER document ───────────
    const seed = await ask(base, "thông tin nhà cung cấp Minh Phát");
    assert.equal(seed.status, 200);
    assert.ok(
      contextEntries().some((k) => k.endsWith("\u0000supplier")),
      "setup assertion: the supplier context must exist",
    );

    const g2 = await ask(base, "thu tiền Nguyễn Thị Lan 10000");
    assert.equal(boundPartyId(g2), LAN_ID, `expected the named customer: ${JSON.stringify(result(g2))}`);
    assert.equal(result(g2).supplier ?? null, null, "the remembered supplier must not appear");
    assert.equal(
      JSON.stringify(result(g2)).includes(SUPPLIER_ID),
      false,
      "and it must not be mentioned anywhere in the answer",
    );
  });
});
