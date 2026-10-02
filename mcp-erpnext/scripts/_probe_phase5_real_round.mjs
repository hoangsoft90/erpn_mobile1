/**
 * _probe_phase5_real_round.mjs — Phase 5 §5, the ONE controlled REAL round.
 *
 * NOT part of the suite and never committed (leading `_probe_`, same rule as the
 * Flutter probes). It exists to run the REAL chain against the REAL ERPNext:
 *
 *   handoff (server ticket) → POST /collect/propose → POST /execute (ONE call)
 *   ⇒ ONE Payment Entry DRAFT (docstatus 0).
 *
 * It is deliberately incapable of two things:
 *   - SUBMIT: nothing here calls a submit path (grep this file: no submit code),
 *     and the server freezes submitNow=false for a screen-made proposal.
 *   - A SECOND write: `/execute` is called exactly once, with ONE command_id.
 *
 * The owner authorised exactly this, in writing, in the current session:
 * customer/invoice/amount ≤ 100.000đ, draft only, cleanup by hand afterwards.
 *
 * Usage:  node scripts/_probe_phase5_real_round.mjs
 * Exit:   0 = draft created (name printed) · 2 = not configured / not REAL
 *         · 1 = a refusal (nothing to clean up if no doc name was printed)
 */

process.chdir(new URL("..", import.meta.url).pathname);

const { readFileSync, existsSync } = await import("node:fs");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const path = await import("node:path");
const { randomUUID } = await import("node:crypto");

// ── 1. .env (key NAMES only are ever printed) ───────────────────────────────
const ENV_KEYS = ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET", "COPILOT_COMPANY"];
const envPath = path.resolve("..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (!ENV_KEYS.includes(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}
// A mock run must be impossible by accident.
delete process.env.COPILOT_MOCK_OK;
// Loopback bind + no ASK_* ⇒ principal "local" (the same shape the suites use).
delete process.env.ASK_USER;
delete process.env.ASK_PASSWORD;
delete process.env.ASK_ALLOW_PUBLIC;

const missing = ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"].filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`ABORT: REAL round needs all three — missing: ${missing.join(", ")}`);
  process.exit(2);
}

// ── 2. THE round's fixed inputs (chosen from the live site, see result89) ───
const COMPANY = process.env.COPILOT_COMPANY || "Minh Phát Cám & VLXD";
// "lan" is one of the rows the propose route can actually see (the customer
// master read is capped at 100 rows — see finding F-P5-1); it holds TWO open
// invoices, so one draft proves the multi-reference write on real data.
const CUSTOMER = "lan";
const ALLOCATIONS = [
  { invoice_id: "ACC-SINV-2026-01288", allocated_amount: 50_000 }, // 320.000, untouched by drafts
  { invoice_id: "ACC-SINV-2026-01285", allocated_amount: 30_000 }, // 84.000, 30.000 still covered by drafts
];
const AMOUNT = 80_000; // Σ allocations, ≤ 100.000đ per the owner's authorisation
const MODE = "bank_transfer"; // §6.2 — must resolve paid_to to the BANK ledger

// ── 3. boot the REAL ask server (real MCP client, real store, real queue) ───
const dir = mkdtempSync(path.join(tmpdir(), "phase5-real-"));
const { createAskServer } = await import("../src/http-ask.mjs");
const { erpTargetLabel } = await import("../src/copilot-server.mjs");
const { IdempotencyStore } = await import("../src/idempotency.mjs");
const { JobQueue, jobQueueConfig } = await import("../src/job-queue.mjs");
const { buildHandoff, handoffStore, SLOT_STATES } = await import("../src/business-handoff.mjs");

console.log(`env    : ${ENV_KEYS.filter((k) => process.env[k]).map((k) => `${k}=set`).join(" · ")}`);
console.log(`target : ${erpTargetLabel(process.env)} (host ${new URL(process.env.ERPNEXT_URL).host})`);
if (erpTargetLabel(process.env) !== "REAL") {
  console.error("ABORT: erp_target is not REAL");
  process.exit(2);
}

handoffStore.clear();
const server = createAskServer({
  port: 0,
  host: "127.0.0.1",
  env: process.env,
  idemStore: new IdempotencyStore(dir),
  jobs: new JobQueue({ config: { ...jobQueueConfig(), dir } }),
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (route, body) => {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// ── 4. the ticket the screen would have opened ──────────────────────────────
const handoff = buildHandoff({
  capability: "payment.create",
  principalId: "local",
  conversationId: null,
  question: "thu tiền cho Anh Ba",
  prefill: { customer: { state: SLOT_STATES.RESOLVED, id: CUSTOMER, label: CUSTOMER } },
});
handoffStore.put(handoff, { principalId: "local", conversationId: null });
console.log(`\nhandoff: ${handoff.handoff_id}`);

// ── 5. propose (READ + server arithmetic; no document exists yet) ───────────
const proposed = await post("/collect/propose", {
  handoff_id: handoff.handoff_id,
  values: {
    customer_id: CUSTOMER,
    allocations: ALLOCATIONS,
    payment_methods: [{ mode: MODE, amount: AMOUNT }],
  },
});
console.log(`\n── /collect/propose → ${proposed.status} ──`);
console.log(JSON.stringify(proposed.body, null, 2).slice(0, 4000));
if (proposed.status !== 200) {
  console.error("\nSTOP: propose refused — NOTHING was written.");
  server.close();
  process.exit(1);
}

// ── 6. ONE execute. This is the only write in the whole phase. ──────────────
const commandId = randomUUID();
const executed = await post("/execute", { command_id: commandId, proposal: proposed.body.proposal });
console.log(`\n── /execute → ${executed.status} (command_id ${commandId}) ──`);
console.log(JSON.stringify(executed.body, null, 2).slice(0, 4000));
server.close();

const doc = executed.body?.result?.erpnext_doc ?? null;
if (executed.status !== 200 || !doc) {
  console.error("\nSTOP: execute did not return a document name — check the site for a stray draft BEFORE retrying.");
  process.exit(1);
}
console.log(`\nDRAFT CREATED ON THE REAL SITE: ${doc}`);
console.log(`company=${COMPANY} · customer=${CUSTOMER} · amount=${AMOUNT} · mode=${MODE}`);
console.log(`command_id=${commandId}`);
console.log("→ re-read the mapping, then DELETE this one draft (Phase 5 §5 step 4-5).");
