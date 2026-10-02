/**
 * next9 — measure the FIXTURE-dependent cases before pinning them in the
 * regression test (prompt-1 §5 Test D, §8 Test G).
 *
 * Both need master rows the mock does not ship, and both are injected the way
 * the mock itself documents them (the state file read at import time):
 *   customers_created: two rows sharing a name  → an AMBIGUOUS match
 *   suppliers_created: "Minh Phát"              → a supplier the fixtures lack
 *
 * Read-only: no /execute, no WRITE. Prints the raw fields the test will assert.
 * Run: node scripts/probe-next9-fixtures.mjs
 */
process.env.COPILOT_MOCK_OK = process.env.COPILOT_MOCK_OK ?? "1";

const REPO = new URL("..", import.meta.url).pathname;
process.chdir(REPO);

const { spawn } = await import("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const path = await import("node:path");

const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
  cwd: path.resolve(REPO, ".."),
  stdio: ["ignore", "pipe", "inherit"],
});
const nlpPort = await new Promise((resolve, reject) => {
  child.stdout.on("data", (d) => {
    const m = String(d).match(/"port":\s*(\d+)/);
    if (m) resolve(Number(m[1]));
  });
  setTimeout(() => reject(new Error("nlp: no ready line in 5s")), 5000);
});

const dir = mkdtempSync(path.join(tmpdir(), "next9-fixtures-"));
const statePath = path.join(dir, "mock-erp.json");
writeFileSync(
  statePath,
  JSON.stringify({
    customers_created: [
      { doctype: "Customer", name: "CUST-AMB-A", customer_name: "Nguyễn Văn A", customer_group: null, disabled: 0, docstatus: 0 },
      { doctype: "Customer", name: "CUST-AMB-B", customer_name: "Nguyễn Văn A", customer_group: null, disabled: 0, docstatus: 0 },
    ],
    suppliers_created: [{ name: "SUP-MINH-PHAT", supplier_name: "Minh Phát", supplier_group: "Vật liệu", supplier_type: "Company", disabled: 0 }],
  }),
);
process.env.MOCK_ERP_STATE = statePath;

const { __setNlpServicePortForTest, __sessionContext, __resetSessionContext } =
  await import("../src/copilot-server.mjs");
/** The store's own Map — the probe asserts the SEED took effect (a vacuous
 * cross-type test would otherwise pass by never seeding anything). */
const ctxEntries = () => Object.fromEntries([...__sessionContext().entries.entries()]);
__setNlpServicePortForTest(nlpPort);

const { createAskServer } = await import("../src/http-ask.mjs");
const { IdempotencyStore } = await import("../src/idempotency.mjs");
const server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: new IdempotencyStore(dir) });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const ask = async (text) => {
  const r = await fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await r.json();
  const res = body.result ?? body;
  return {
    status: r.status,
    entity_state: res.entity?.state ?? null,
    error_code: res.error_code ?? null,
    ambiguous: res.ambiguous ?? null,
    candidates: res.candidates ?? null,
    proposal_entity: res.proposal?.entity?.id ?? null,
    customer: res.customer?.id ?? res.customer ?? null,
    supplier: res.supplier?.id ?? res.supplier ?? null,
    rows: (res.rows ?? []).map((x) => x?.name ?? x?.id ?? x),
    action: res.proposal?.action ?? res.answer != null ? "answer" : null,
  };
};

const show = (label, out) => console.log(`\n### ${label}\n${JSON.stringify(out, null, 2)}`);

// ── C: absent entity (measured so the test pins the real refusal code) ────────
__resetSessionContext();
await ask("công nợ của Nguyễn Thị Lan");
show("C1 with Lan context \"thu tiền Không Có Ai Tên Này 10000\"", await ask("thu tiền Không Có Ai Tên Này 10000"));

// ── D: ambiguous customer (two rows, one name) ────────────────────────────────
__resetSessionContext();
show("D0 baseline (no context) \"thu tiền Nguyễn Văn A 10000\"", await ask("thu tiền Nguyễn Văn A 10000"));
await ask("công nợ của Nguyễn Thị Lan");
show("D1 with Lan context \"thu tiền Nguyễn Văn A 10000\"", await ask("thu tiền Nguyễn Văn A 10000"));

// ── G: cross entity type ─────────────────────────────────────────────────────
__resetSessionContext();
await ask("công nợ của Nguyễn Thị Lan");
show("G0 customer context → \"thông tin nhà cung cấp Minh Phát\"", await ask("thông tin nhà cung cấp Minh Phát"));
console.log("\n[seed] entries =", JSON.stringify(ctxEntries()));
show("G1 customer context → \"đặt hàng NCC Minh Phát\"", await ask("đặt hàng NCC Minh Phát"));

// reverse: seed a SUPPLIER context, then a customer WRITE
__resetSessionContext();
for (const t of [
  "thông tin nhà cung cấp Minh Phát",
  "nhà cung cấp Minh Phát",
  "mua hàng của Minh Phát",
  "công nợ nhà cung cấp Minh Phát",
]) {
  const r = await ask(t);
  console.log(`\n[seed attempt] "${t}" →`, JSON.stringify(r));
  const seeded = Object.entries(ctxEntries()).some(([k]) => k.endsWith("\u0000supplier"));
  if (seeded) {
    console.log("[seed] entries =", JSON.stringify(ctxEntries()));
    break;
  }
}
show("G2 supplier context → \"thu tiền Nguyễn Thị Lan 10000\"", await ask("thu tiền Nguyễn Thị Lan 10000"));

server.close();
child.kill();
rmSync(dir, { recursive: true, force: true });
