/**
 * next8 / D3 — the selection contract is SHARED by every picker-backed kind.
 *
 * Pins plan_final_v3 §0 ("shared cho mọi entity picker") + §3 Rule C (bind exact
 * id) measured against the REAL pipeline (mock ERP + real Python NLP, same
 * discipline as next8-picker-safety.test.mjs):
 *
 *   T6-customer  the customer picker contract (D1 baseline) still binds the id
 *                on a WRITE — a pick on a payment route resolves CUST-00001.
 *   T7           select → READ công nợ answers about the bound id
 *                (`customer.id` IS the picked id).
 *   D3-inventory THE GAP: the inventory branch offered chips only under B1's
 *                PRIVATE `item_candidates` key and ignored pickedEntityId
 *                (probe P2a === P2b). Now: shared `candidates` chips + the pick
 *                narrows the answer to that item + stale id ⇒ ENTITY_PICK_STALE.
 *   D3-limit     the supplier READ picker obeys the D2 bound (10 + overflow).
 *
 * Falsify battery F1–F4 in scripts/falsify/next8-d3-shared.mjs (backup /tmp).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

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

async function withServer(opts = {}, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  const stateFile = opts?.stateFile ?? null;
  const nlp = await startNlpService();
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  const previousPort = process.env.NLP_SERVICE_PORT;
  let server = null;
  const hadState = process.env.MOCK_ERP_STATE !== undefined;
  const previousState = process.env.MOCK_ERP_STATE;
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    __setNlpServicePortForTest(nlp.port);
    if (stateFile) process.env.MOCK_ERP_STATE = stateFile;
    const { createAskServer } = await import("../src/http-ask.mjs");
    server = createAskServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({ base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server?.close();
    nlp.child.kill();
    __setNlpServicePortForTest(previousPort ?? "8787");
    if (hadState) process.env.MOCK_ERP_STATE = previousState;
    else delete process.env.MOCK_ERP_STATE;
  }
}

const askPost = (base, body) =>
  fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("D3 T6 — the customer picker pick on a WRITE binds the id (the D1 baseline, shared contract)", async () => {
  await withServer(async ({ base }) => {
    // "chị Lan" is a fuzzy single hit ⇒ the WRITE requires the picker first.
    const s1 = await askPost(base, { text: "thu tiền cho chị Lan 10000" });
    const s1Body = await s1.json();
    assert.equal(s1Body.ok, true);
    assert.equal(s1Body.result.error_code, "ENTITY_PICK_REQUIRED");
    assert.ok(s1Body.result.candidates?.length >= 1, "the picker is offered");

    // The pick: the SAME sentence with the picked id resolves the proposal.
    const s2 = await askPost(base, { text: "thu tiền cho chị Lan 10000", entity_id: "CUST-00001" });
    const s2Body = await s2.json();
    assert.equal(
      s2Body.result.proposal?.entity?.id,
      "CUST-00001",
      "Rule C: the proposal binds the picked id, never the name",
    );
    assert.equal(s2Body.result.proposal?.entity?.kind, "customer");
  });
});

test("D3 T7 — select → READ công nợ answers about the bound id", async () => {
  await withServer(async ({ base }) => {
    const res = await askPost(base, { text: "công nợ của chị Lan", entity_id: "CUST-00001" });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.error_code, undefined, JSON.stringify(body.result).slice(0, 300));
    assert.equal(
      body.result.customer?.id,
      "CUST-00001",
      "the READ consumed the picked id — the answer is about CUST-00001",
    );
  });
});

test("D3 — an ambiguous item question offers SHARED candidates (not only the private key)", async () => {
  await withServer(async ({ base }) => {
    const res = await askPost(base, { text: "tồn kho cám" });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(
      body.result.item_candidates?.length >= 2,
      "B1's private key stays (the existing pin)",
    );
    assert.ok(
      body.result.candidates?.length >= 2,
      "THE FIX: the same chips travel under the SHARED candidates key the client renders",
    );
  });
});

test("D3 — an item pick narrows the inventory answer to that item (the loop, pinned)", async () => {
  await withServer(async ({ base }) => {
    const s2 = await askPost(base, { text: "tồn kho cám", entity_id: "CAM-GA-10KG" });
    const s2Body = await s2.json();
    assert.equal(s2Body.ok, true);
    assert.equal(s2Body.result.error_code, undefined, JSON.stringify(s2Body.result).slice(0, 300));
    assert.ok(
      s2Body.result.rows?.every((r) => r.item_code === "CAM-GA-10KG"),
      `only the picked item's rows remain: ${JSON.stringify(s2Body.result.rows)}`,
    );
    assert.equal(
      s2Body.result.proposal?.entity?.id,
      "CAM-GA-10KG",
      "the proposal binds the picked item id",
    );
    assert.ok(
      !s2Body.result.answer?.some((l) => /khớp nhiều mặt hàng/.test(l)),
      "the ambiguity warning is gone once the pick resolved it",
    );
  });
});

test("D3 — an item id the fresh list does not hold is ENTITY_PICK_STALE, never a wrong item", async () => {
  await withServer(async ({ base }) => {
    const res = await askPost(base, { text: "tồn kho cám", entity_id: "CAM-GONE" });
    const body = await res.json();
    assert.equal(body.result.error_code, "ENTITY_PICK_STALE");
    assert.ok(body.result.uncertainty?.message, "the stale refusal carries Vietnamese copy");
    assert.ok(body.result.candidates?.length >= 2, "the fresh chips stand (chọn lại)");
    assert.deepEqual(body.result.rows ?? [], [], "no stock rows answered from a dead id");
  });
});

test("D3 — the supplier READ picker obeys the D2 bound (10 chips + overflow)", async () => {
  // 12 injected suppliers all matching "nha cung cap moi" ⇒ overflow on the
  // supplier READ branch, exactly like D2's T12 but for route.group "supplier".
  const dir = mkdtempSync(path.join(tmpdir(), "d3-overflow-"));
  const rows = Array.from({ length: 12 }, (_, i) => ({
    doctype: "Supplier",
    name: `SUP-NCC-${String(i + 1).padStart(2, "0")}`,
    supplier_name: `Nhà cung cấp mới ${String(i + 1).padStart(2, "0")}`,
    supplier_group: "Vật liệu",
    supplier_type: "Company",
    disabled: 0,
  }));
  const prevState = process.env.MOCK_ERP_STATE;
  process.env.MOCK_ERP_STATE = (() => {
    const file = path.join(dir, "overflow-suppliers.json");
    writeFileSync(file, JSON.stringify({ customers_created: [], suppliers_created: rows }));
    return file;
  })();
  try {
    await withServer(async ({ base }) => {
      const res = await askPost(base, { text: "nhà cung cấp mới" });
      const body = await res.json();
      assert.equal(body.result.error_code, "AMBIGUOUS_SUPPLIER");
      const chips = body.result.candidates ?? [];
      assert.equal(chips.length, 10, "the supplier READ picker is bounded at 10 too");
      assert.equal(body.result.picker_total, 12);
      assert.equal(body.result.picker_more, 2);
      assert.match(body.result.reason, /Còn 2 kết quả/);
    });
  } finally {
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
  }
});

test("D3 T8 pin — a supplier-WRITE answer binds the resolved supplier id (probe P1 evidence)", async () => {
  await withServer(async ({ base }) => {
    const res = await askPost(base, { text: "đặt mua cho Hà Tiên 3 bao cám heo" });
    const body = await res.json();
    assert.equal(body.result.proposal?.entity?.kind, "supplier");
    assert.equal(
      body.result.proposal?.entity?.id,
      "SUP-HATIEN",
      "Rule C on the supplier side: the id, not the display name, is what the proposal binds",
    );
    assert.equal(
      body.result.supplier?.id,
      "SUP-HATIEN",
      "the party travels under the key its kind names",
    );
  });
});
