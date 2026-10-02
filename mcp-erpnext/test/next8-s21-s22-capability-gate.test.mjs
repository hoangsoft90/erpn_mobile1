/**
 * next8 / Phase 6 — follow-ups S21 + S22, run end-to-end against the REAL ask
 * server, the REAL NLP service and the mock ERPNext.
 *
 * What this file protects:
 *   S22 — a routed SALE sentence ("bán hàng cho <khách>") must reach the SALES
 *         screen from chat: `/ask` answers with a `business_handoff` whose
 *         `screen == "sales"` / `capability == "sales.create"`, and NO proposal
 *         (a free sale's lines/prices live on the screen, not in a sentence).
 *         A sales QUESTION ("bán được bao nhiêu…") must keep routing to the
 *         broad READ `sales` group and emit no ticket.
 *   S21 — the /collect/propose door is the exact twin of /sales/propose: a
 *         ticket whose own capability opens a DIFFERENT screen is refused with
 *         the same single STALE_HANDOFF answer, in both directions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
// The mock is opt-in EVERYWHERE (never a silent fallback).
process.env.COPILOT_MOCK_OK = "1";
// The sales path reads a default warehouse for its stock warning.
process.env.COPILOT_DEFAULT_WAREHOUSE = "Kho chính";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

import { buildHandoff, handoffStore, SLOT_STATES } from "../src/business-handoff.mjs";

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

async function withServer(fn) {
  const nlp = await startNlpService();
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  const previousPort = process.env.NLP_SERVICE_PORT;
  let server = null;
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    __setNlpServicePortForTest(nlp.port);
    handoffStore.clear();
    const { createAskServer } = await import("../src/http-ask.mjs");
    server = createAskServer({ port: 0, host: "127.0.0.1", env: process.env });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({ base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server?.close();
    nlp.child.kill();
    __setNlpServicePortForTest(previousPort ?? "8787");
    handoffStore.clear();
  }
}

const post = (base, route, body) =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

/** Store a ticket for a given capability and hand it back (the screen's entry). */
function ticketFor(capability, prefill, question) {
  const handoff = buildHandoff({
    capability,
    principalId: "local",
    conversationId: null,
    question,
    prefill,
  });
  handoffStore.put(handoff, { principalId: "local", conversationId: null });
  return handoff;
}

// ────────────────────────────────────────────────────────────────────────────
// S22 — the chat path that opens the sales screen
// ────────────────────────────────────────────────────────────────────────────

test("S22: a routed sale sentence hands the SALES screen a ticket and proposes nothing", async () => {
  await withServer(async ({ base }) => {
    // The exact owner-reported phrase. It used to be rewritten to "sale" by
    // the NLP synonym map BEFORE the router ran, so it fell through to the
    // broad READ `sales` group and the screen never opened. The synonym fix
    // (src/vietnamese_nlp/synonyms.py: "bán hàng" removed from the `sale`
    // group) keeps the phrase intact so `sales_write` matches. This pins the
    // full chain: sentence → ticket → sales screen.
    const res = await post(base, "/ask", { text: "bán hàng cho Nguyễn Thị Lan" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const result = res.body.result;

    // Chat never proposes a free sale: lines/prices/discounts are the screen's.
    assert.equal(result.proposal, null);
    assert.equal(result.error_code, undefined);

    const handoff = result.business_handoff;
    assert.ok(handoff, "a sale sentence must carry a handoff, not a dead end");
    assert.equal(handoff.type, "business_handoff");
    assert.equal(handoff.capability, "sales.create");
    assert.equal(handoff.screen, "sales");
    // The one slot a sentence CAN carry resolved; the rest stay MISSING.
    assert.equal(handoff.prefill.customer.state, SLOT_STATES.RESOLVED);
    assert.equal(handoff.prefill.customer.id, "CUST-00001");
    assert.equal(handoff.prefill.customer.label, "Nguyễn Thị Lan");
    assert.equal(handoff.prefill.items.state, SLOT_STATES.MISSING);
    assert.equal(handoff.prefill.order_discount.state, SLOT_STATES.MISSING);
    assert.equal(handoff.prefill.payment_methods.state, SLOT_STATES.MISSING);
    // No authoritative number ever travels in the ticket.
    assert.equal(/"(items|order_discount|payment_methods|amount|total)[a-z_]*"\s*:\s*\d/.test(JSON.stringify(handoff)), false);
  });
});

test("S22: a sales QUESTION still routes to the READ sales group (no ticket)", async () => {
  await withServer(async ({ base }) => {
    const res = await post(base, "/ask", { text: "bán được bao nhiêu hôm nay" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // A question about what was sold does not open a screen.
    assert.equal(res.body.result.business_handoff, undefined);
    assert.notEqual(res.body.result.routed?.group, "sales_write");
  });
});

test("S22-follow-up: 'tạo đơn cho …' opens the Sales Order write, not the READ sales group", async () => {
  await withServer(async ({ base }) => {
    // The synonym table used to rewrite "tạo đơn" to "sale" BEFORE the router, so
    // a COMMAND was answered with a document list. It now maps to `sales_order`.
    const res = await post(base, "/ask", { text: "tạo đơn cho Nguyễn Thị Lan 10 bao cám heo" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.routed?.group, "sales_order_write");
    // It is answered with an ORDER PROPOSAL, not a document list.
    assert.equal(typeof res.body.result.proposal?.action, "string");
    assert.match(res.body.result.answer ?? "", /ĐƠN NHÁP/);

    // A QUESTION the write group denies still falls through to a READ group
    // (the `sales_order` label contains "sale") instead of becoming a dead end.
    const q = await post(base, "/ask", { text: "lên đơn cho Nguyễn Thị Lan chưa" });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.notEqual(q.body.result.routed?.group, "sales_order_write");
    assert.equal(q.body.result.error_code, undefined);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// S21 — /collect/propose is the exact twin of /sales/propose
// ────────────────────────────────────────────────────────────────────────────

test("S21: a SALES ticket posted to /collect/propose is refused (one answer, no probing)", async () => {
  await withServer(async ({ base }) => {
    const salesTicket = ticketFor(
      "sales.create",
      { customer: { state: SLOT_STATES.RESOLVED, id: "CUST-00001", label: "Nguyễn Thị Lan" } },
      "bán hàng cho Nguyễn Thị Lan",
    );
    const res = await post(base, "/collect/propose", {
      handoff_id: salesTicket.handoff_id,
      values: { customer_id: "CUST-00001", allocations: [], payment_methods: [] },
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "STALE_HANDOFF");
  });
});

test("S20 twin: a COLLECT ticket posted to /sales/propose is refused", async () => {
  await withServer(async ({ base }) => {
    const collectTicket = ticketFor(
      "payment.create",
      { customer: { state: SLOT_STATES.RESOLVED, id: "CUST-00001", label: "Nguyễn Thị Lan" } },
      "thu tiền cho Nguyễn Thị Lan",
    );
    const res = await post(base, "/sales/propose", {
      handoff_id: collectTicket.handoff_id,
      values: { customer_id: "CUST-00001", items: [], payment_methods: [] },
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "STALE_HANDOFF");
  });
});
