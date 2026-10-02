/**
 * next8 / Phase 8 — CORPUS PIPELINE SWEEP (the "0 HTTP 500" gate).
 *
 * The router gate (`route-corpus.test.mjs`) proves the ROUTING decisions. This
 * file proves the NEXT layer: every one of the 280 audit sentences can travel the
 * REAL pipeline (`/ask` → Python normalizer → router → skills → ERPNext) without
 * an HTTP 5xx — the defect class the audit found exactly four times
 * (C2-124..127: "Lịch sử chi tiền của <NCC>").
 *
 * Posture is the one `http-ask.test.mjs` established for this repo: the real
 * Python bridge is spawned on an ephemeral port, ERPNext is the in-process MOCK
 * (no credentials, no LLM). Entity placeholders are substituted with the audit's
 * real names, exactly as the next10 probe did before measuring.
 *
 * DEFECT-1 (`party_type=Customer` hardcoded for a SUPPLIER ledger) is asserted
 * here as a PIN, not fixed here: it was already closed by 16c17fa (the
 * direction-aware `isPayHistory` branch) a day after the audit ran, and these
 * cases had no test watching them until now.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
process.env.COPILOT_MOCK_OK = "1";
process.env.COPILOT_RATE_LIMIT = "off";
process.env.LEARNING_LOG = "off";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const fixture = JSON.parse(readFileSync(path.join(HERE, "fixtures", "route-corpus.json"), "utf8"));

const aliasToName = new Map(
  Object.entries(fixture.entity_aliases).map(([alias, meta]) => [alias, meta.real_name]),
);
const substitute = (t) => String(t).replace(/\{\{([A-Z_]+)\}\}/g, (_, a) => aliasToName.get(a) ?? `«${a}»`);

/** Spawn the Python NLP bridge on an ephemeral port -> {child, port}. */
async function startNlpService() {
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
 * The corpus names come from the REAL site, so the mock has to know them or a
 * third of the sentences stop at MISSING_ENTITY and never reach the read paths
 * this sweep exists to exercise. Seed ONLY the names the mock does not already
 * carry, and skip `lan`: it is already reachable as a substring of the existing
 * `Nguyễn Thị Lan` row, and a second row containing it would make the name
 * AMBIGUOUS (picker) instead of resolved.
 */
const MOCK_KNOWN_NAMES = [
  "Nguyễn Thị Lan", "Trần Văn Hai",
  "Hà Tiên", "Hà Tiên 2", "Anh Bảy", "Đại lý Cám Bình Dương",
];

function seedStateFile(dir) {
  const customers_created = [];
  const suppliers_created = [];
  for (const [alias, meta] of Object.entries(fixture.entity_aliases)) {
    const name = meta.real_name;
    if (MOCK_KNOWN_NAMES.includes(name) || name === "lan") continue;
    if (alias.startsWith("CUSTOMER")) {
      customers_created.push({
        doctype: "Customer", name, customer_name: name,
        customer_group: "Individual", territory: "Vietnam", disabled: 0,
      });
    } else if (alias.startsWith("SUPPLIER")) {
      suppliers_created.push({
        doctype: "Supplier", name, supplier_name: name,
        supplier_group: "Vật liệu", supplier_type: "Company", disabled: 0,
      });
    }
  }
  const file = path.join(dir, "mock-erp-seed.json");
  writeFileSync(file, JSON.stringify({ customers_created, suppliers_created }));
  return file;
}

/**
 * One sweep over the whole corpus: returns per-case observations.
 * Runs ONCE and is shared by the assertions below (280 pipeline calls are the
 * expensive part — each test must not pay for them again).
 */
async function sweep() {
  const nlp = await startNlpService();
  let server = null;
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    const mod = await import("../src/copilot-server.mjs");
    mod.__setNlpServicePortForTest(nlp.port);
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const { JobQueue, jobQueueConfig } = await import("../src/job-queue.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "route-corpus-"));
    // Seed BEFORE the server is built: the mock reads MOCK_ERP_STATE at import.
    process.env.MOCK_ERP_STATE = seedStateFile(dir);
    server = createAskServer({
      port: 0,
      host: "127.0.0.1",
      env: process.env,
      idemStore: new IdempotencyStore(dir),
      jobs: new JobQueue({ config: { ...jobQueueConfig(), dir } }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const out = [];
    for (const c of fixture.cases) {
      mod.__resetSessionContext();
      const res = await fetch(`${base}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: substitute(c.input) }),
      });
      const body = await res.json().catch(() => null);
      out.push({
        test_id: c.test_id,
        input: c.input,
        contract: c.contract,
        status: res.status,
        ok: body?.ok ?? null,
        error_code: body?.result?.error_code ?? null,
        group: body?.result?.routed?.group ?? null,
        capability: body?.result?.proposal?.capability ?? null,
        answer: typeof body?.result?.answer === "string" ? body.result.answer : null,
        entity: body?.result?.customer ?? body?.result?.supplier ?? null,
      });
    }
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MOCK_ERP_STATE;
    return out;
  } finally {
    server?.close();
    nlp.child?.kill();
  }
}

const observations = await sweep();
const byStatus = observations.reduce((acc, o) => {
  acc[o.status] = (acc[o.status] ?? 0) + 1;
  return acc;
}, {});

test("sweep: no corpus sentence reaches the pipeline as an HTTP 5xx", () => {
  console.log(`[sweep] ${observations.length} sentences · status ${JSON.stringify(byStatus)}`);
  const bad = observations.filter((o) => o.status >= 500);
  assert.deepEqual(
    bad.map((o) => `${o.test_id} HTTP ${o.status} ${JSON.stringify(o.input)}`),
    [],
    "the /ask surface returned a 5xx for a corpus sentence",
  );
  const errored = observations.filter((o) => o.error_code);
  console.log(
    `[sweep] error_code distribution: ${JSON.stringify(
      errored.reduce((acc, o) => { acc[o.error_code] = (acc[o.error_code] ?? 0) + 1; return acc; }, {}),
    )}`,
  );
});

test("DEFECT-1 pin: a SUPPLIER money-history question reads the SUPPLIER ledger, never money IN", () => {
  // The audit measured HTTP 500 here because the read hard-coded party_type=Customer
  // for a supplier ledger. Closed by 16c17fa; this pin is what keeps it closed.
  // The defect's signature on the MOCK is the DIRECTION, not a 500: with the wrong
  // party type the read finds no entries and the copy flips to "phiếu THU".
  const quartet = fixture.cases.filter((c) => c.test_id.startsWith("C2-12") && c.input.includes("chi tiền"));
  assert.equal(quartet.length, 4, "the audit's four supplier-history cases must stay in the corpus");
  for (const c of quartet) {
    const o = observations.find((x) => x.test_id === c.test_id);
    assert.equal(o.status, 200, `${c.test_id} must not 5xx`);
    assert.equal(o.error_code, null, `${c.test_id} error_code (supplier must resolve: seeded)`);
    assert.equal(o.group, "payment", `${c.test_id} routed group`);
    assert.match(o.answer ?? "", /phiếu chi/, `${c.test_id} must read the SUPPLIER ledger (phiếu chi)`);
    assert.doesNotMatch(o.answer ?? "", /phiếu thu/, `${c.test_id} must never fall back to money IN`);
    assert.ok(o.entity?.name, `${c.test_id} must name the supplier it read`);
  }
});

test("DEFECT-1 mirror: a CUSTOMER money-history question, WHEN it routes, stays money IN", () => {
  // CL-5 owns the routing of "Lịch sử thu của X" (today it is UNKNOWN_INTENT).
  // Until that cluster lands, this test pins the DIRECTION half only: whatever
  // the router decides, a customer ledger read can never come back as money OUT.
  const c = fixture.cases.find((x) => x.test_id === "C2-097");
  const o = observations.find((x) => x.test_id === c.test_id);
  assert.equal(o.status, 200);
  if (o.group === "payment") {
    assert.match(o.answer ?? "", /phiếu thu/, "the customer ledger question must stay money IN");
    assert.doesNotMatch(o.answer ?? "", /phiếu chi/, "a customer ledger may never be read as money OUT");
  } else {
    console.log(`[sweep] C2-097 not routed yet (${o.error_code}) — CL-5 owns this; direction pin still holds`);
  }
});
