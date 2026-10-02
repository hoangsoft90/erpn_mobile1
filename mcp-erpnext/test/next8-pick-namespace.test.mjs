/**
 * next8 / M1 — pick namespace guard (openspec/changes/next8-pick-namespace-guard).
 *
 * Pins the refusal REFINEMENT the second next8 review asked for (finding M1):
 * an id absent from the freshly-read list whose ERPNext series names a
 * DIFFERENT kind than the branch answering must refuse as
 * ENTITY_PICK_WRONG_KIND — not the stale reading (the entity is not stale,
 * it is the wrong kind). Guards pin what must NOT change:
 *
 *   U1  list-authority: an id PRESENT in the list resolves regardless of its
 *       series (the series check never overrides the fresh list).
 *   U2  same-kind absent id keeps ENTITY_PICK_INVALID at the helper (surfaces
 *       as ENTITY_PICK_STALE through the pipeline, unchanged D2 reading).
 *   U3  cross-kind absent id ⇒ ENTITY_PICK_WRONG_KIND (RED before the fix).
 *   U4  an unrecognisable series is never guessed (stays ENTITY_PICK_INVALID).
 *   T1  E2E supplier READ + entity_id CUST-00001 ⇒ ENTITY_PICK_WRONG_KIND
 *       (RED before the fix: answered ENTITY_PICK_STALE).
 *   T3  E2E guard: SUP-99999 keeps ENTITY_PICK_STALE.
 *   T4  E2E guard: a 140-char prefixless id keeps ENTITY_PICK_STALE.
 *   T5  E2E inventory + entity_id CUST-00001 ⇒ ENTITY_PICK_WRONG_KIND
 *       (RED before the fix: answered ENTITY_PICK_STALE).
 *
 * Runs against createAskServer() on an ephemeral port with the REAL Python
 * NLP service (mock ERPNext). Same hermetic env discipline as
 * next8-review-hardening.test.mjs (self-contained COPILOT_MOCK_OK opt-in).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
// Same opt-in discipline as p44/p42 suites: this file is also run directly
// (node --test), so it must not depend on `npm test` setting COPILOT_MOCK_OK.
process.env.COPILOT_MOCK_OK = "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ER = await import("../src/entity-resolution.mjs");

async function startNlpService() {
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

async function withServer(fn) {
  const nlp = await startNlpService();
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  const previousPort = process.env.NLP_SERVICE_PORT;
  let server = null;
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    __setNlpServicePortForTest(nlp.port);
    const { createAskServer } = await import("../src/http-ask.mjs");
    server = createAskServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({ base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server?.close();
    nlp.child.kill();
    __setNlpServicePortForTest(previousPort ?? "8787");
  }
}

const askPost = (base, body) =>
  fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ── Unit: the helpers' contract ──────────────────────────────────────────────

test("U1 — an id PRESENT in the list resolves regardless of its series (list is authority)", () => {
  // A supplier row whose id does not follow the SUP- series still resolves.
  const odd = [{ name: "ODD-1", supplier_name: "Lạ" }];
  const r1 = ER.pickRowFromCandidates(odd, "ODD-1", { idOf: ER.ENTITY_ACCESSORS.supplier.idOf, kind: "supplier" });
  assert.equal(r1.ok, true, "odd-series id present in the list resolves");
  assert.equal(r1.row.name, "ODD-1");

  // A row PRESENT with a CROSS-KIND series still resolves — the series check
  // never overrides the freshly-read list (the mutation guard for M1).
  const weird = [{ name: "CUST-00001", supplier_name: "Khách trùng series" }];
  const r2 = ER.pickRowFromCandidates(weird, "CUST-00001", { idOf: ER.ENTITY_ACCESSORS.supplier.idOf, kind: "supplier" });
  assert.equal(r2.ok, true, "a present id wins over its series");

  // Same law on the customer helper.
  const r3 = ER.pickFromCandidates([{ name: "SUP-HATIEN", customer_name: "Trùng series" }], "SUP-HATIEN");
  assert.equal(r3.ok, true, "customer helper: present id wins over its series");
});

test("U2 — a same-kind absent id keeps ENTITY_PICK_INVALID (stale reading unchanged)", () => {
  const suppliers = [{ name: "SUP-HATIEN", supplier_name: "Hà Tiên" }];
  const r = ER.pickRowFromCandidates(suppliers, "SUP-99999", { idOf: ER.ENTITY_ACCESSORS.supplier.idOf, kind: "supplier" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "ENTITY_PICK_INVALID", "same-kind absent stays the existing code");
  assert.notEqual(r.code, "ENTITY_PICK_WRONG_KIND");
});

test("U3 — a cross-kind absent id refuses as ENTITY_PICK_WRONG_KIND", () => {
  const suppliers = [{ name: "SUP-HATIEN", supplier_name: "Hà Tiên" }];
  const r1 = ER.pickRowFromCandidates(suppliers, "CUST-00001", { idOf: ER.ENTITY_ACCESSORS.supplier.idOf, kind: "supplier" });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "ENTITY_PICK_WRONG_KIND", "customer series into the supplier branch is named");
  assert.match(r1.error ?? "", /không phải/);

  const customers = [{ name: "CUST-00001", customer_name: "Lan" }];
  const r2 = ER.pickFromCandidates(customers, "SUP-HATIEN");
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "ENTITY_PICK_WRONG_KIND", "supplier series into the customer helper is named");

  const items = [{ name: "CAM-GA-10KG", item_code: "CAM-GA-10KG" }];
  const r3 = ER.pickRowFromCandidates(items, "SUP-HATIEN", { idOf: ER.ENTITY_ACCESSORS.item.idOf, kind: "item" });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, "ENTITY_PICK_WRONG_KIND", "supplier series into the item branch is named");

  // The series detector exists and names the kinds (no guessing beyond them).
  assert.equal(ER.pickIdKindSeries("SUP-HATIEN"), "supplier");
  assert.equal(ER.pickIdKindSeries("CUST-00001"), "customer");
  assert.equal(ER.pickIdKindSeries("CAM-GA-10KG"), "item");
  assert.equal(ER.pickIdKindSeries("X".repeat(140)), null);
  assert.equal(ER.pickIdKindSeries(null), null);
});

test("U4 — an unrecognisable series is never guessed (keeps ENTITY_PICK_INVALID)", () => {
  const suppliers = [{ name: "SUP-HATIEN", supplier_name: "Hà Tiên" }];
  const r = ER.pickRowFromCandidates(suppliers, "X".repeat(140), { idOf: ER.ENTITY_ACCESSORS.supplier.idOf, kind: "supplier" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "ENTITY_PICK_INVALID", "no series ⇒ no WRONG_KIND claim");
});

// ── E2E: the pipeline surfaces ───────────────────────────────────────────────

test("T1 — supplier READ + a customer-series id ⇒ ENTITY_PICK_WRONG_KIND (not STALE)", async () => {
  await withServer(async ({ base }) => {
    const s1 = await askPost(base, { text: "nhà cung cấp tiên" });
    const s1Body = await s1.json();
    assert.equal(s1Body.result.error_code, "AMBIGUOUS_SUPPLIER", "the picker is up");

    // A LIVE customer id (CUST-00001 exists in the mock) sent into the
    // supplier branch: the entity is not stale — it is the wrong kind.
    const s2 = await askPost(base, { text: "nhà cung cấp tiên", entity_id: "CUST-00001" });
    const s2Body = await s2.json();
    assert.equal(s2Body.ok, true);
    assert.equal(s2Body.result.error_code, "ENTITY_PICK_WRONG_KIND");
    assert.match(s2Body.result.reason, /loại khác/);
    assert.equal(s2Body.result.supplier ?? null, null, "no entity resolves from the cross-kind id");
  });
});

test("T3 — E2E guard: a same-kind absent supplier id keeps ENTITY_PICK_STALE", async () => {
  await withServer(async ({ base }) => {
    const res = await askPost(base, { text: "nhà cung cấp tiên", entity_id: "SUP-99999" });
    const body = await res.json();
    assert.equal(body.result.error_code, "ENTITY_PICK_STALE", "the D2 reading is unchanged");
    assert.ok(body.result.candidates?.length >= 2, "the fresh picker stands");
  });
});

test("T4 — E2E guard: a 140-char prefixless id keeps ENTITY_PICK_STALE", async () => {
  await withServer(async ({ base }) => {
    const res = await askPost(base, { text: "nhà cung cấp tiên", entity_id: "X".repeat(140) });
    const body = await res.json();
    assert.equal(body.result.error_code, "ENTITY_PICK_STALE", "no series ⇒ the guard does not fire");
  });
});

test("T5 — inventory + a customer-series id ⇒ ENTITY_PICK_WRONG_KIND (not STALE)", async () => {
  await withServer(async ({ base }) => {
    const res = await askPost(base, { text: "tồn kho cám", entity_id: "CUST-00001" });
    const body = await res.json();
    assert.equal(body.result.error_code, "ENTITY_PICK_WRONG_KIND");
    assert.match(body.result.reason, /loại khác/);
    assert.deepEqual(body.result.rows ?? [], [], "no stock rows answered from a cross-kind id");
    assert.ok(body.result.candidates?.length >= 2, "the fresh chips stand");
  });
});
