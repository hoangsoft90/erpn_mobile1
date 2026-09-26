/**
 * A1 — UX-READ drill-down (plan3 Trụ A). Two halves:
 *
 *  1. UNIT — the contract's `ui_screens` table, the structured UI intent an
 *     answer carries, and `readScreen()` against a fake ERPNext: bounded list,
 *     fresh read, entity id NOT trusted from the client, and provably no write
 *     call on the path.
 *  2. E2E over HTTP — /ask answers with a `ui` block, then POST /read/list
 *     serves that screen from a real (mock) ERPNext read.
 *
 * The authz half lives in a1-read-authz.test.mjs: it needs its own process,
 * because the capability contract is loaded once per process.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Hermetic: a shell that sourced .env would otherwise make createAskServer()
// resolve the REAL ERPNext target (and its ASK_USER breaks the loopback bind
// policy). Same rule as http-ask.test.mjs.
for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");

const { validateContract, __contract, listUiScreens, getUiScreen, clampUiLimit } =
  await import("../src/capability-contract.mjs");
const { uiIntentForAction, readScreen, declaredScreenIds, READ_VIEW_CODES } =
  await import("../src/read-views.mjs");

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function customers() {
  return [
    { name: "CUST-00001", customer_name: "Nguyễn Thị Lan", disabled: 0 },
    { name: "CUST-00002", customer_name: "Trần Văn Hai", disabled: 0 },
  ];
}

/** N unpaid invoices for one customer, oldest first (ERPNext list order). */
function invoices(n, customer = "CUST-00001") {
  return Array.from({ length: n }, (_, i) => ({
    name: `SINV-${String(i + 1).padStart(4, "0")}`,
    customer,
    posting_date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
    grand_total: 1_000_000 + i,
    outstanding_amount: 1_000_000 + i,
    docstatus: 1,
  }));
}

/**
 * Fake MCP client with the REAL handler shapes. It also exposes callWriteTool
 * so a leaked write would be visible instead of silently missing.
 */
function fakeMcp({ rows = invoices(3), customerRows = customers() } = {}) {
  const state = { rows, customerRows, calls: [], writes: [] };
  return {
    get calls() {
      return state.calls;
    },
    get writes() {
      return state.writes;
    },
    set rows(next) {
      state.rows = next;
    },
    async callTool(tool, args) {
      state.calls.push({ tool, args });
      if (tool === "erpnext_customer_list") {
        return { data: { doctype: "Customer", count: state.customerRows.length, data: state.customerRows } };
      }
      if (tool === "erpnext_sales_invoice_list") {
        const mine = state.rows.filter((r) => r.customer === args.customer);
        return { data: { doctype: "Sales Invoice", count: mine.length, data: mine } };
      }
      throw new Error(`unexpected read tool ${tool}`);
    },
    async callWriteTool(tool, args) {
      state.writes.push({ tool, args });
      throw new Error("WRITE_REFUSED: the drill-down must never write");
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. contract + intent
// ─────────────────────────────────────────────────────────────────────────────

test("A1: the screen table is declared and validated by the contract", () => {
  const screens = listUiScreens();
  assert.deepEqual(Object.keys(screens), ["customer_account"]);
  const screen = getUiScreen("customer_account");
  assert.equal(screen.capability, "customer.balance");
  assert.deepEqual([...screen.offered_by].sort(), ["customer.balance", "invoice.lookup"]);
  assert.equal(screen.entity, "customer");
  assert.deepEqual(screen.limit, { default: 5, min: 5, max: 10 });
  // The clamp is policy, not a client choice.
  assert.deepEqual(
    [1, 4, 5, 7, 10, 99, undefined, "junk", NaN].map((v) => clampUiLimit(screen, v)),
    [5, 5, 5, 7, 10, 10, 5, 5, 5],
  );
});

test("A1: the contract REFUSES a screen that could write, is unknown, or has a broken limit", () => {
  const clone = () => JSON.parse(JSON.stringify(__contract));
  const cases = [
    ["offered_by names a WRITE capability", (c) => c.ui_screens.customer_account.offered_by.push("payment.create"), /only a READ answer may offer/],
    ["composed by a WRITE capability", (c) => (c.ui_screens.customer_account.capability = "payment.create"), /a drill-down reads, it never writes|is WRITE/],
    ["unknown capability", (c) => (c.ui_screens.customer_account.capability = "nope.nope"), /unknown capability/],
    ["offered_by misses its own capability", (c) => (c.ui_screens.customer_account.offered_by = ["invoice.lookup"]), /must include its own capability/],
    ["limit min > default", (c) => (c.ui_screens.customer_account.limit = { default: 3, min: 5, max: 10 }), /limit must satisfy/],
    ["limit not integers", (c) => (c.ui_screens.customer_account.limit = { default: 5, min: 5, max: 10.5 }), /must be an integer/],
    ["missing entity", (c) => delete c.ui_screens.customer_account.entity, /needs an entity kind/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const broken = clone();
    mutate(broken);
    assert.throws(() => validateContract(broken), pattern, `expected a refusal for: ${name}`);
  }
  // Removing the feature entirely is still a valid contract (no drill-down).
  const without = clone();
  delete without.ui_screens;
  assert.equal(validateContract(without), true);
  assert.deepEqual(declaredScreenIds(), ["customer_account"]);
});

test("A1: only a READ answer with a resolved entity id carries a UI intent", () => {
  const entity = { id: "CUST-00001", name: "Nguyễn Thị Lan" };
  const intent = uiIntentForAction({ action: "read_balance", entity });
  assert.deepEqual(intent, {
    screen: "customer_account",
    title: "Công nợ & chứng từ",
    entity: { kind: "customer", id: "CUST-00001", name: "Nguyễn Thị Lan" },
    limit: 5,
  });
  // invoice.lookup offers the SAME screen (a debt question and an invoice
  // question both open the customer's account view).
  assert.equal(uiIntentForAction({ action: "read_open_invoices", entity }).screen, "customer_account");
  // No screen declared for these — the client shows no button.
  assert.equal(uiIntentForAction({ action: "read_stock_balance", entity: { kind: "item", id: "CAM-HEO-25KG" } }), null);
  assert.equal(uiIntentForAction({ action: "read_payment_history", entity }), null);
  // WRITE actions never offer a drill-down.
  assert.equal(uiIntentForAction({ action: "create_payment_entry", entity }), null);
  // No entity id ⇒ nothing to open ⇒ no button (never re-guess on the client).
  assert.equal(uiIntentForAction({ action: "read_balance", entity: { id: null } }), null);
  assert.equal(uiIntentForAction({ action: "read_balance", entity: { id: "   " } }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. readScreen — the fresh, bounded READ
// ─────────────────────────────────────────────────────────────────────────────

test("A1: the screen returns a FRESH, bounded list + the balance from the same skill", async () => {
  const mcp = fakeMcp({ rows: invoices(12) });
  const view = await readScreen({ mcp, screenId: "customer_account", entityId: "CUST-00001" });

  assert.equal(view.screen, "customer_account");
  assert.equal(view.title, "Công nợ & chứng từ");
  assert.deepEqual(view.entity, { kind: "customer", id: "CUST-00001", name: "Nguyễn Thị Lan" });
  assert.equal(view.limit, 5, "default page size comes from the contract");
  assert.equal(view.rows.length, 5);
  assert.equal(view.total_documents, 12, "the screen must say HOW MANY exist, not hide the rest");
  assert.equal(view.truncated, true);
  assert.equal(view.summary.outstanding_vnd, 12_000_000 + (0 + 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11),
    "the balance covers the WHOLE debt, not just the visible page");
  assert.equal(view.summary.open_documents, 12);
  assert.deepEqual(view.rows[0], {
    name: "SINV-0001",
    date: "2026-09-01",
    outstanding_vnd: 1_000_000,
    total_vnd: 1_000_000,
    is_return: false,
  });

  // limit is asked for, clamped by the contract
  const wide = await readScreen({ mcp, screenId: "customer_account", entityId: "CUST-00001", limit: 999 });
  assert.equal(wide.limit, 10);
  assert.equal(wide.rows.length, 10);
  assert.equal(wide.truncated, true);
  const narrow = await readScreen({ mcp, screenId: "customer_account", entityId: "CUST-00001", limit: 1 });
  assert.equal(narrow.limit, 5, "the minimum exists so a screen is never uselessly short");

  // FRESH: the next call sees data that changed after the first one.
  mcp.rows = invoices(2);
  const after = await readScreen({ mcp, screenId: "customer_account", entityId: "CUST-00001" });
  assert.equal(after.total_documents, 2);
  assert.equal(after.truncated, false);
  assert.equal(after.summary.outstanding_vnd, 2_000_001);

  // and the whole drill-down never called a write tool
  assert.deepEqual(mcp.writes, []);
  assert.ok(!mcp.calls.some((c) => /doc_create|doc_submit/.test(c.tool)));

  // D0.5 §2.1 — the payload must name WHERE the money came from, and the route is
  // the only one that can know it: the app replaces every figure with a
  // "no provenance" panel when this field is missing or not REAL, so dropping it
  // here would silently blank a working screen.
  const withTarget = await readScreen({
    mcp,
    screenId: "customer_account",
    entityId: "CUST-00001",
    erpTarget: "REAL",
  });
  assert.equal(
    withTarget.erp_target,
    "REAL",
    "the route's erpTarget must travel with the payload verbatim",
  );
  assert.ok(
    "erp_target" in after,
    "a caller that passes no target still gets the field (null = unknown, never absent)",
  );
  assert.equal(after.erp_target, null);
});

test("A1: fully settled documents are excluded (same rule as the chat answer)", async () => {
  const rows = [
    ...invoices(2),
    { name: "SINV-0009", customer: "CUST-00001", posting_date: "2026-09-20", grand_total: 500_000, outstanding_amount: 0, docstatus: 1 },
  ];
  const view = await readScreen({ mcp: fakeMcp({ rows }), screenId: "customer_account", entityId: "CUST-00001" });
  assert.equal(view.total_documents, 2);
  assert.ok(!view.rows.some((r) => r.name === "SINV-0009"));
});

test("A1: an id the client invented is REFUSED — never trusted", async () => {
  const mcp = fakeMcp();
  await assert.rejects(
    readScreen({ mcp, screenId: "customer_account", entityId: "CUST-99999" }),
    (err) => err.code === READ_VIEW_CODES.ENTITY_NOT_FOUND,
  );
  // It refused BEFORE reading any document for that id.
  assert.ok(!mcp.calls.some((c) => c.tool === "erpnext_sales_invoice_list"));
});

test("A1: an undeclared screen and a missing entity id are refused, not guessed", async () => {
  const mcp = fakeMcp();
  await assert.rejects(
    readScreen({ mcp, screenId: "secret_ledger", entityId: "CUST-00001" }),
    (err) => err.code === READ_VIEW_CODES.UNKNOWN_SCREEN,
  );
  await assert.rejects(
    readScreen({ mcp, screenId: "", entityId: "CUST-00001" }),
    (err) => err.code === READ_VIEW_CODES.UNKNOWN_SCREEN,
  );
  await assert.rejects(
    readScreen({ mcp, screenId: "customer_account", entityId: "" }),
    (err) => err.code === READ_VIEW_CODES.MISSING_ENTITY,
  );
  assert.deepEqual(mcp.calls, [], "a refused screen must not touch ERPNext at all");
});

test("A1 (static): the drill-down module has no write surface to leak", () => {
  const src = readFileSync(path.join(ROOT, "src/read-views.mjs"), "utf8");
  for (const forbidden of [
    /callWriteTool/,
    /runExecute/,
    /safety-gateway/,
    /erpnext_doc_create/,
    /erpnext_doc_submit/,
    /skills\/payment-write/,
  ]) {
    assert.doesNotMatch(src, forbidden, `read-views.mjs must not reference ${forbidden}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. E2E over HTTP: /ask carries the intent, /read/list serves the screen
// ─────────────────────────────────────────────────────────────────────────────

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

test("A1 E2E: /ask offers the screen, /read/list serves it fresh (mock ERPNext)", async () => {
  const nlp = await startNlpService();
  let server = null;
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    const { createAskServer } = await import("../src/http-ask.mjs");
    server = createAskServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // A debt question answers AND offers the drill-down.
    const ask = await post("/ask", { text: "chị Lan còn nợ bao nhiêu" });
    assert.equal(ask.status, 200);
    const askBody = await ask.json();
    assert.equal(askBody.result.outstanding_vnd, 2_500_000);
    assert.deepEqual(askBody.result.ui, {
      screen: "customer_account",
      title: "Công nợ & chứng từ",
      entity: { kind: "customer", id: "CUST-00001", name: "Nguyễn Thị Lan" },
      limit: 5,
    });

    // An invoice question offers the SAME screen.
    const askInv = await post("/ask", { text: "hoá đơn chưa trả của chị Lan" });
    assert.equal((await askInv.json()).result.ui.screen, "customer_account");

    // Questions with no declared screen carry ui: null (the client shows no button).
    const askStock = await post("/ask", { text: "cám gà còn tồn kho bao nhiêu" });
    assert.equal((await askStock.json()).result.ui, null);
    const askPay = await post("/ask", { text: "thu tiền cho Nguyễn Thị Lan 10000" });
    const payBody = await askPay.json();
    assert.equal(payBody.result.proposal.action, "create_payment_entry");
    // A WRITE answer carries no `ui` block at all (absent, not null): the read
    // groups always say explicitly whether they offer a screen, while a card
    // payload has no UI block by design. The client treats both as "no button".
    assert.equal("ui" in payBody.result, false, "a WRITE card never offers a read drill-down");

    // The drill-down itself: fresh read of the REAL handler shape (mock ERPNext).
    const view = await post("/read/list", {
      screen: askBody.result.ui.screen,
      entity_id: askBody.result.ui.entity.id,
    });
    assert.equal(view.status, 200);
    const v = (await view.json()).result;
    assert.equal(v.entity.id, "CUST-00001");
    assert.equal(v.entity.name, "Nguyễn Thị Lan", "the name comes from the fresh read, not the client");
    assert.equal(v.summary.outstanding_vnd, 2_500_000, "same number the answer showed");
    assert.equal(v.summary.open_documents, 1);
    assert.equal(v.total_documents, 1);
    assert.equal(v.truncated, false);
    assert.deepEqual(v.rows, [
      { name: "SINV-0001", date: "2026-09-01", outstanding_vnd: 2_500_000, total_vnd: 10_500_000, is_return: false },
    ]);

    // Refusals: unknown screen, invented customer, missing fields.
    const unknown = await post("/read/list", { screen: "ledger", entity_id: "CUST-00001" });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, "UNKNOWN_READ_SCREEN");

    const invented = await post("/read/list", { screen: "customer_account", entity_id: "CUST-99999" });
    assert.equal(invented.status, 404);
    assert.equal((await invented.json()).code, "CUSTOMER_NOT_FOUND");

    const missing = await post("/read/list", { screen: "customer_account" });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, "MISSING_ENTITY_ID");

    const noBody = await post("/read/list", {});
    assert.equal(noBody.status, 400);
    assert.equal((await noBody.json()).code, "UNKNOWN_READ_SCREEN");

    // The drill-down path has no write endpoint: /execute is a different route
    // and this screen never calls it (proved by the unit test's write spy).
    const badJson = await fetch(`${base}/read/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).code, "BAD_REQUEST");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    nlp.child.kill();
  }
});
