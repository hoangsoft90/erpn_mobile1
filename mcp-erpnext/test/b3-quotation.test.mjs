/**
 * B3 (plan3_review3) — quotation.create, the third WRITE (pattern B2 rút gọn).
 *
 * What this file proves, in the order the risk appears:
 *
 *  1. DISAMBIGUATION vs SO — "báo giá" reaches the quotation capability and
 *     "đặt hàng" does NOT (and vice versa), and a QUESTION creates nothing: a
 *     sentence that asks about a price must never open a HIGH card.
 *  2. BUILDING — a quotation is built from the same source of truth as an order:
 *     the utterance decides item/quantity/unit, ERPNext decides everything else.
 *     The refusal taxonomy is the quotation's OWN (QT_*), so a copy-paste from
 *     the order path is visible instead of silently shared.
 *  3. PAYLOAD — the doctype's party shape is `quotation_to` + `party_name`: a
 *     payload carrying `customer` would create a document with no party.
 *  4. EXECUTING — draft only, verified by reading it back, once-only per
 *     command_id, and refusal (not a silent re-price) when the site moved.
 *  5. FALSE WRITES + REGRESSION — the remaining stub still cannot execute, the
 *     write gate still refuses an undeclared doctype, and the order/payment
 *     paths still work through the SAME gateway after the toolkit was shared.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { routeIntent } from "../src/router.mjs";
import { executableWriteActions, getCapability } from "../src/capability-contract.mjs";
import { buildProposal } from "../src/action-proposal.mjs";
import {
  buildQuotationData,
  buildQuotationProposal,
  executeQuotationProposal,
} from "../src/skills/quotation-write.mjs";
import { buildSalesOrderProposal } from "../src/skills/sales-order-write.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";

/* --------------------------------------------------------------- fixtures -- */

/** Same values as src/mock-server.mjs on purpose — a test catalogue of its own
 *  would prove the builder works against data ERPNext never returns. */
const ITEM_ROWS = [
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
  { name: "CAM-GA-10KG", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", stock_uom: "Bao" },
];
const PRICE_ROWS = [
  { name: "IP1", item_code: "CAM-HEO-25KG", uom: "Bao", price_list: "Standard Selling", price_list_rate: 305_000, selling: 1 },
  { name: "IP2", item_code: "CAM-GA-10KG", uom: "Bao", price_list: "Standard Selling", price_list_rate: 250_000, selling: 1 },
];
const UOM_NAMES = ["Bao", "Tấn", "Kg", "Xe", "Thung", "Viên", "Mét", "m3"];
const UOM_FACTORS = [
  { name: "F1", from_uom: "Tấn", to_uom: "Kg", value: 1000 },
  { name: "F2", from_uom: "Bao", to_uom: "Kg", value: 25 },
];

function fakeSkills(over = {}) {
  return {
    findItem: async () => ({ data: { doctype: "Item", count: ITEM_ROWS.length, data: over.items ?? ITEM_ROWS } }),
    listUoms: async () => ({ data: { doctype: "UOM", data: over.uoms ?? UOM_NAMES } }),
    listUomFactors: async () => ({ data: { doctype: "UOM Conversion Factor", data: over.factors ?? UOM_FACTORS } }),
    listItemPrices: async () => ({ data: { doctype: "Item Price", data: over.prices ?? PRICE_ROWS } }),
  };
}

const CUSTOMER = { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" };
const nlp = (text, quantities) => ({ text, quantities });

/* -------------------------------------------------- 1. disambiguation vs SO -- */

test("B3 routing: báo giá reaches the QUOTATION, đặt hàng does not (and vice versa)", () => {
  for (const t of [
    "báo giá cho Nguyễn Thị Lan 10 bao cám heo",
    "báo giá 5 bao cám gà cho Lan",
    "xin báo giá cám heo cho Lan",
    "gửi báo giá cho anh Nam 3 bao cám",
  ]) {
    const hit = routeIntent(t);
    assert.equal(hit?.capability, "quotation.create", t);
    assert.equal(hit?.group, "quotation_write", t);
  }
  // The other direction: an ORDER is not a quotation.
  assert.equal(routeIntent("đặt hàng cho Nguyễn Thị Lan 10 bao cám heo")?.capability, "sales_order.create");
  assert.equal(routeIntent("đặt 5 bao cám gà cho Lan")?.capability, "sales_order.create");
  // ...and the third member of the confusion family is still its own stub.
  assert.equal(routeIntent("giao hàng cho anh Nam hôm nay")?.capability, "delivery.create");
});

test("B3 routing: a QUESTION never creates a quotation (deny-list, not luck)", () => {
  // The price question is the exact sentence plan3_review3 §528 wanted mapped to
  // Quotation. It is NOT: a question that opens a HIGH confirm card is the
  // failure mode B2's deny-list exists to prevent. It stays a READ/ASK.
  for (const question of [
    "báo giá cho anh Bảy 40 bao cám bao nhiêu",
    "báo giá cám heo bao nhiêu tiền",
    "xem báo giá của anh Nam",
    "kiểm tra báo giá hôm qua",
    "báo giá 40 bao cám chưa",
  ]) {
    const hit = routeIntent(question);
    assert.notEqual(hit?.capability, "quotation.create", `"${question}" must not create a document`);
  }
  // A MENTION of a past quotation is not a request for a new one either: the
  // group is sentence-initial (startsWith), so a sentence that only TALKS about
  // a quotation must not become a write ("hôm qua tôi gửi báo giá cho anh Nam").
  assert.notEqual(
    routeIntent("hôm qua tôi gửi báo giá cho anh Nam")?.capability,
    "quotation.create",
    "a past-tense mention is not a command",
  );
});

/* ------------------------------------------------------------- 2. building -- */

test("B3 builder: quantities from the utterance, prices ALWAYS from ERPNext", async () => {
  const built = await buildQuotationProposal(
    fakeSkills(),
    { customer: CUSTOMER, ambiguous: false, candidates: [] },
    {
      nlp: nlp("báo giá cho Lan 2 bao cám heo tăng trọng 25kg và 3 bao cám gà thịt 10kg", [
        { value: 2, canonical_unit: "Bao", raw: "2 bao", start: 0, end: 5 },
        { value: 3, canonical_unit: "Bao", raw: "3 bao", start: 0, end: 5 },
      ]),
    },
  );
  assert.equal(built.proposal.action, "create_quotation");
  assert.equal(built.proposal.risk, "HIGH");
  assert.equal(built.proposal.params.submit_now, false, "a quotation is never auto-submitted");
  // Prices are ERPNext's declared ones, not anything from the sentence.
  const heo = built.lines.find((l) => l.item_code === "CAM-HEO-25KG");
  const ga = built.lines.find((l) => l.item_code === "CAM-GA-10KG");
  assert.equal(heo.rate, 305_000);
  assert.equal(ga.rate, 250_000);
  assert.equal(built.proposal.params.estimated_total_vnd, 2 * 305_000 + 3 * 250_000);
  assert.equal(built.proposal.params.total_source, "qty_x_erpnext_rate");
});

test("B3 builder: an unresolvable line is an ASK with a QT_ code, never a guess", async () => {
  const build = (opts, over = {}) =>
    buildQuotationProposal(fakeSkills(over), { customer: CUSTOMER, ambiguous: false, candidates: [] }, opts);

  // No quantity for a named item.
  await assert.rejects(
    () => build({ nlp: nlp("báo giá cám heo tăng trọng 25kg cho Lan", []) }),
    (err) => err.code === "QT_QTY_MISSING",
  );
  // No price declared for that (item, uom) ⇒ ask, never invent one.
  await assert.rejects(
    () => build({ nlp: nlp("báo giá cho Lan 2 bao cám heo tăng trọng 25kg", [{ value: 2, canonical_unit: "Bao", raw: "2 bao", start: 0, end: 5 }]) }, { prices: [] }),
    (err) => err.code === "QT_PRICE_MISSING",
  );
  // No item named at all.
  await assert.rejects(
    () => build({ nlp: nlp("báo giá cho Lan nhé", []) }),
    (err) => err.code === "QT_ITEM_UNRESOLVED",
  );
  // Unknown customer ⇒ no document.
  await assert.rejects(
    () => buildQuotationProposal(fakeSkills(), { customer: null, ambiguous: true, candidates: ["A", "B"] }, { nlp: nlp("báo giá cho Lan 2 bao", []) }),
    (err) => err.code === "QT_CUSTOMER_UNRESOLVED",
  );
  // The taxonomy is the quotation's own: an SO_-prefixed code here would mean a
  // copy of the order path, not a quotation.
  const codes = getCapability("quotation.create").errors;
  assert.ok(codes.includes("QT_QTY_MISSING") && codes.includes("QT_PRICE_MISSING"));
  assert.equal(codes.some((c) => c.startsWith("SO_")), false);
});

test("B3 builder: a converted line carries the factor it is billed in — and NO invented chain", async () => {
  // The site's DIRECT factor (Tấn→Kg) applies to a Kg-stocked item...
  const built = await buildQuotationProposal(
    fakeSkills({
      items: [{ name: "KG-ITEM", item_code: "KG-ITEM", item_name: "Kg Item", stock_uom: "Kg" }],
      prices: [{ name: "IPX", item_code: "KG-ITEM", uom: "Tấn", price_list: "Standard Selling", price_list_rate: 21_000_000, selling: 1 }],
    }),
    { customer: CUSTOMER, ambiguous: false, candidates: [] },
    { nlp: nlp("báo giá cho Lan 1 tấn Kg Item", [{ value: 1, canonical_unit: "Tấn", raw: "1 tấn", start: 0, end: 6 }]) },
  );
  const line = built.lines[0];
  // B1's rule survives the copy: the factor is ON the line, with its display.
  assert.equal(line.conversion_factor, 1000);
  assert.equal(line.stock_uom, "Kg");
  assert.match(String(line.uom_display), /= ?1000/);
  // ...but a BAO-stocked item is NOT reachable from Tấn: the site has no direct
  // factor and B1 forbids chaining/inverting, so this ASKS rather than inventing
  // the "this many kg per tấn" arithmetic a naive implementation would produce.
  await assert.rejects(
    () => buildQuotationProposal(
      fakeSkills(),
      { customer: CUSTOMER, ambiguous: false, candidates: [] },
      { nlp: nlp("báo giá cho Lan 1 tấn cám heo tăng trọng 25kg", [{ value: 1, canonical_unit: "Tấn", raw: "1 tấn", start: 0, end: 6 }]) },
    ),
    (err) => err.code === "QT_UOM_UNRESOLVED",
  );
});

/* -------------------------------------------------------------- 3. payload -- */

test("B3 payload: the Quotation PARTY shape, and only the factor that was shown", () => {
  const data = buildQuotationData({
    customerId: "CUST-00001",
    lines: [
      { item_code: "A", qty: 2, uom: "Bao", rate: 100, conversion_factor: 25 },
      { item_code: "B", qty: 1, uom: "Bao", rate: 200, conversion_factor: null },
    ],
    company: "Demo Feed Co",
    transactionDate: "2026-09-20",
    actionId: "act_1",
    correlation: "custom_ai_action_id",
  });
  assert.equal(data.doctype, "Quotation");
  assert.equal(data.quotation_to, "Customer");
  assert.equal(data.party_name, "CUST-00001");
  // A Sales Order field on a Quotation would silently create a party-less doc.
  assert.equal("customer" in data, false);
  assert.equal(data.custom_ai_action_id, "act_1");
  assert.deepEqual(data.items[0], { item_code: "A", qty: 2, uom: "Bao", rate: 100, conversion_factor: 25 });
  assert.deepEqual(data.items[1], { item_code: "B", qty: 1, uom: "Bao", rate: 200 });
  assert.equal("docstatus" in data, false, "draft comes from ERPNext, never from the caller");
});

/* ------------------------------------------------------------ 4. executing -- */

const STORE_ENV_KEYS = [
  "MOCK_ERP_QT_NO_CORRELATION_FIELD",
  "MOCK_ERP_QT_DROP_LINE",
  "MOCK_ERP_FAIL_AFTER_WRITE",
  "MOCK_ERP_FAIL_WRITE",
  "MOCK_ERP_STATE",
];
function withEnv(vars, fn) {
  const saved = Object.fromEntries(STORE_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const DEFAULT_LINES = [
  { item_code: "CAM-HEO-25KG", item_name: "Cám heo", qty: 2, uom: "Bao", rate: 305_000, amount_vnd: 610_000, stock_uom: "Bao", conversion_factor: null },
];
function quotationProposal({ lines, customer = "CUST-00001", actionId = "act_b3_test" } = {}) {
  const useLines = lines ?? DEFAULT_LINES;
  return buildProposal({
    action: "create_quotation",
    risk: "HIGH",
    entity: { kind: "customer", id: customer, name: "Nguyễn Thị Lan" },
    params: {
      lines: useLines,
      line_count: useLines.length,
      estimated_total_vnd: useLines.reduce((s, l) => s + l.amount_vnd, 0),
      total_source: "qty_x_erpnext_rate",
      submit_now: false,
      offer: true,
    },
    summary: "Tạo báo giá NHÁP",
    extra: { action_id: actionId, warnings: [] },
  });
}

async function withGateway(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "b3-qt-"));
  try {
    const { runExecute } = await import("../src/safety-gateway.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    return await fn({ runExecute, store: new IdempotencyStore(dir) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("B3 gateway: a quotation is created as a DRAFT, verified by reading it back, and replayable", async () => {
  // A state file, so the fresh client below opens a NEW mock process that still
  // sees the document — the persistence a real site has by definition (without
  // it this test would prove only that the same process remembers).
  const dir = mkdtempSync(path.join(tmpdir(), "b3-qt-draft-"));
  process.env.MOCK_ERP_STATE = path.join(dir, "state.json");
  try {
  await withGateway(async ({ runExecute, store }) => {
    const commandId = randomUUID();
    const verdict = await runExecute({ command_id: commandId, proposal: quotationProposal(), store });
    assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
    const result = verdict.body.result;
    assert.match(result.erpnext_doc, /^QTN-M\d+$/);
    assert.equal(result.docstatus, 0, "draft only");
    assert.equal(result.customer, "CUST-00001");
    assert.equal(result.erpnext_total_vnd, 610_000);
    assert.equal(result.action_id, "act_b3_test");
    assert.match(result.note, /NHÁP/);

    // Same command_id ⇒ the stored result, not a second quotation.
    const replay = await runExecute({ command_id: commandId, proposal: quotationProposal(), store });
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.result.erpnext_doc, result.erpnext_doc);

    // The new quotation really is on the mock "site", exactly once.
    const client = createMcpClient({ serverScript: MOCK_SERVER });
    try {
      await client.initialize();
      const found = await client.callTool("erpnext_doc_list", {
        doctype: "Quotation",
        fields: ["name", "party_name", "docstatus"],
        limit: 20,
      });
      assert.equal(found.data.data.length, 1);
      assert.equal(found.data.data[0].party_name, "CUST-00001");
    } finally {
      await client.close().catch(() => {});
    }
  });
  } finally {
    delete process.env.MOCK_ERP_STATE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3 gateway: the SAME proposal under a NEW command_id is refused 409 with the existing document", async () => {
  // The mock "site" must REMEMBER the first quotation across the two calls (a
  // real ERPNext would): a fresh in-memory mock per call would hide the very
  // duplicate this test exists to catch.
  const dir = mkdtempSync(path.join(tmpdir(), "b3-qt-state-"));
  await withEnv({ MOCK_ERP_STATE: path.join(dir, "state.json") }, async () => {
    try {
      await withGateway(async ({ runExecute, store }) => {
        const first = await runExecute({ command_id: randomUUID(), proposal: quotationProposal(), store });
        assert.equal(first.status, 200, JSON.stringify(first.body));

        const second = await runExecute({ command_id: randomUUID(), proposal: quotationProposal(), store });
        // 409, not 500: a refusal that says WHICH document already exists is
        // actionable; a server error is not (B2 finding, re-pinned here).
        assert.equal(second.status, 409, JSON.stringify(second.body));
        assert.equal(second.body.code, "QT_DUPLICATE_ACTION");
        assert.equal(second.body.existing_doc, first.body.result.erpnext_doc);
        // Terminal and honest: a retry cannot help, and nothing new was written.
        assert.equal(second.body.retry_same_command_id, undefined);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("B3 gateway: no correlation field on the site ⇒ refuse BEFORE writing", async () => {
  await withEnv({ MOCK_ERP_QT_NO_CORRELATION_FIELD: "1" }, async () => {
    await withGateway(async ({ runExecute, store }) => {
      const verdict = await runExecute({ command_id: randomUUID(), proposal: quotationProposal(), store });
      assert.equal(verdict.status, 500, JSON.stringify(verdict.body));
      assert.equal(verdict.body.code, "QT_CORRELATION_FIELD_MISSING");
      assert.match(verdict.body.error, /custom_ai_action_id/);
      assert.match(verdict.body.error, /migration/i);
    });
  });
});

test("B3 gateway: a quotation that reads back wrong is NOT reported as success", async () => {
  await withEnv({ MOCK_ERP_QT_DROP_LINE: "1" }, async () => {
    await withGateway(async ({ runExecute, store }) => {
      const commandId = randomUUID();
      const verdict = await runExecute({ command_id: commandId, proposal: quotationProposal(), store });
      assert.equal(verdict.status, 503, JSON.stringify(verdict.body));
      assert.equal(verdict.body.retry_same_command_id, true);
      // It WAS created, so the command must stay PENDING (reconcilable) instead
      // of FAILED — FAILED is what pushes a user toward a second document.
      assert.equal(store.status(commandId).status, "PENDING");
    });
  });
});

test("B3 gateway: a quotation that may have landed keeps its intent locked", async () => {
  await withEnv({ MOCK_ERP_FAIL_AFTER_WRITE: "1" }, async () => {
    await withGateway(async ({ runExecute, store }) => {
      const first = randomUUID();
      const v1 = await runExecute({ command_id: first, proposal: quotationProposal(), store });
      assert.equal(v1.status, 503);
      const second = await runExecute({ command_id: randomUUID(), proposal: quotationProposal(), store });
      assert.equal(second.status, 409, JSON.stringify(second.body));
      assert.equal(second.body.code, "IDEMPOTENCY_INTENT_IN_FLIGHT");
      assert.equal(second.body.clash_command_id, first);
    });
  });
});

test("B3 gateway: the intent lock is keyed on the LINE SET, not just the customer", async () => {
  // A lost response leaves the first offer PENDING and locked. A second offer
  // for the same customer with DIFFERENT lines is a DIFFERENT intent (this is
  // what makes the lock usable: quoting 2 bao of heo must not be blocked because
  // a 5-bao-of-gà offer was interrupted).
  await withEnv({ MOCK_ERP_FAIL_AFTER_WRITE: "1" }, async () => {
    await withGateway(async ({ runExecute, store }) => {
      const first = randomUUID();
      const v1 = await runExecute({ command_id: first, proposal: quotationProposal(), store });
      assert.equal(v1.status, 503, JSON.stringify(v1.body));

      const other = quotationProposal({
        lines: [{
          item_code: "CAM-GA-10KG",
          item_name: "Cám gà",
          qty: 5,
          uom: "Bao",
          rate: 250_000,
          amount_vnd: 1_250_000,
          stock_uom: "Bao",
          conversion_factor: null,
        }],
      });
      const v2 = await runExecute({ command_id: randomUUID(), proposal: other, store });
      assert.notEqual(
        v2.body.code,
        "IDEMPOTENCY_INTENT_IN_FLIGHT",
        "different lines = a different offer; only the SAME intent may be locked out",
      );
      // It still ends as PENDING (its own lost response), never a silent success.
      assert.equal(v2.status, 503, JSON.stringify(v2.body));
      assert.equal(store.status(first).status, "PENDING");
    });
  });
});

test("B3 gateway: a moved price is a REFUSAL (PROPOSAL_STALE), never a silent re-price", async () => {
  await withGateway(async ({ runExecute, store }) => {
    const proposal = quotationProposal({
      lines: [{ ...DEFAULT_LINES[0], rate: 999, amount_vnd: 1998 }],
    });
    const verdict = await runExecute({ command_id: randomUUID(), proposal, store });
    assert.equal(verdict.status, 409, JSON.stringify(verdict.body));
    assert.equal(verdict.body.code, "PROPOSAL_VERSION_STALE");
    assert.match(verdict.body.problems.join(" "), /giá đổi 999/i);
  });
});

/* ------------------------------------------------- 4b. end-to-end pipeline -- */

/** Strip ERPNEXT_* so the child always talks to the in-memory mock. */
const MOCK_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));
const COPILOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "copilot-server.mjs");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function startNlpService() {
  const { spawn } = await import("node:child_process");
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

async function startCopilot(port) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...MOCK_ENV, NLP_SERVICE_PORT: String(port) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`MCP_ERROR ${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  });
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  return {
    request,
    async call(text) {
      const res = await request("tools/call", { name: "copilot_ask", arguments: { text } });
      assert.equal(res.isError, undefined, `tool error: ${res.content?.[0]?.text}`);
      return res.structuredContent ?? JSON.parse(res.content[0].text);
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

/**
 * The test that would have caught the B3 merge bug (a resolved-customer bag
 * passed in the wrong shape): the pipeline, not just the builder, must produce a
 * quotation proposal. Unit tests call the builder directly and cannot see it.
 */
test("B3 E2E: a quotation sentence produces a HIGH draft OFFER, and nothing is written", async () => {
  const nlp = await startNlpService();
  const copilot = await startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("báo giá cho Nguyễn Thị Lan 2 bao cám heo tăng trọng 25kg");
    assert.equal(out.routed.group, "quotation_write", JSON.stringify(out.routed));
    assert.equal(out.proposal?.action, "create_quotation", JSON.stringify(out.proposal));
    assert.equal(out.proposal.risk, "HIGH");
    assert.equal(out.proposal.entity.id, "CUST-00001");
    // Price from ERPNext, quantity from the sentence, draft-only.
    assert.equal(out.proposal.params.lines[0].rate, 305_000);
    assert.equal(out.proposal.params.lines[0].qty, 2);
    assert.equal(out.proposal.params.submit_now, false);
    // The answer says OFFER and NHÁP — the sentence and the card must agree.
    assert.match(out.answer, /BÁO GIÁ/);
    assert.match(out.answer, /NHÁP/);
    // Nothing is written by asking: no document exists on the mock site yet.
    const client = createMcpClient({ serverScript: MOCK_SERVER });
    try {
      await client.initialize();
      const found = await client.callTool("erpnext_doc_list", { doctype: "Quotation", fields: ["name"], limit: 5 });
      assert.equal(found.data.count, 0, "an ASK must not create a document");
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

/* ------------------------------------------- 5. false writes + regression --- */

test("B3 false write: an unimplemented action still has NO executor — nothing is written", async () => {
  await withGateway(async ({ runExecute, store }) => {
    // P9-A2 implemented delivery.create and P9-B the receipt — no stub WRITE
    // remains; the false-write guard runs on a STILL-fictional action instead.
    for (const [action, capability] of [["create_stock_entry", "stock_entry.create"]]) {
      const proposal = buildProposal({
        action,
        risk: "HIGH",
        entity: { kind: "customer", id: "CUST-00001", name: "Nguyễn Thị Lan" },
        params: {},
        summary: "should not exist",
      });
      const verdict = await runExecute({ command_id: randomUUID(), proposal, store });
      // A fictional action has no capability mapping at all, so the FIRST gate
      // refuses it with the "only these actions are executable" 400 (the
      // code-bearing EXECUTOR_NOT_REGISTERED refusal sits one gate deeper, for
      // an action whose capability IS declared but never wired).
      assert.equal(verdict.status, 400, `${capability}: ${JSON.stringify(verdict.body)}`);
      assert.match(String(verdict.body.error), /only .* proposals are executable/, JSON.stringify(verdict.body));
    }
    assert.equal(store.status(randomUUID()), null);
  });
});

test("B3 write gate: the client refuses a doctype the contract does not declare", async () => {
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();
    // Declared writable by the contract (quotation.create) ⇒ allowed.
    const ok = await client.callWriteTool("erpnext_doc_create", {
      doctype: "Quotation",
      data: {
        quotation_to: "Customer",
        party_name: "CUST-00001",
        company: "Demo Feed Co",
        items: [{ item_code: "CAM-HEO-25KG", qty: 1, uom: "Bao", rate: 305_000 }],
      },
    });
    assert.match(ok.data.data.name, /^QTN-M\d+$/);
    // A doctype nobody declared ⇒ refused in code, not by server luck.
    // P9-D moved the example to master data; M1 (2026-09-23, user decision (a)
    // — result64 §3.1) moved it BACK to Journal Entry: Customer IS declared
    // writable now (customer.create via the gateway). The undeclared-doctype
    // refusal in CODE is the invariant that stays.
    await assert.rejects(
      () => client.callWriteTool("erpnext_doc_create", { doctype: "Journal Entry", data: {} }),
      (err) => /WRITE_REFUSED/.test(String(err.message)),
    );
  } finally {
    await client.close().catch(() => {});
  }
});

test("B3 regression: the executable writes are the known set, and an ORDER still executes through the same gateway", async () => {
  // The shared toolkit (pairLines / priceForLine / company resolution) was made
  // configurable for the quotation; the order path must not have noticed.
  // B4 added the purchase document, P9-A2 the delivery note, P9-B the receipt,
  // P9-D the sales invoice, P9-E the stock write-off, P9-F the customer return,
  // M1 the customer create (2026-09-23, user decision (a) — result64 §3.1) —
  // stated here deliberately, so the write set can never grow without someone
  // reading this line (same tripwire style as the safety-gateway invariant).
  assert.deepEqual(executableWriteActions().sort(), [
    "create_customer",
    "create_delivery_note",
    "create_payment_entry",
    "create_purchase_order",
    "create_purchase_receipt",
    "create_quotation",
    "create_sales_invoice",
    "create_sales_order",
    "create_sales_return",
    "create_stock_adjustment",
  ]);
  // Phase 1 rewrites "thu tiền" -> `payment` BEFORE the router, so the real path
  // is the normalized form (measured: the raw "thu tiền ..." routes to nothing
  // at the keyword layer — the same raw-vs-normalized trap B2-result §6 records).
  assert.equal(routeIntent("payment cho chị Lan 500 nghìn")?.capability, "payment.create");
  assert.equal(routeIntent("thu tiền cho chị Lan 500 nghìn"), null, "raw form: not a keyword route");

  const built = await buildSalesOrderProposal(
    fakeSkills(),
    { customer: CUSTOMER, ambiguous: false, candidates: [] },
    { nlp: nlp("đặt hàng cho Lan 2 bao cám heo tăng trọng 25kg", [{ value: 2, canonical_unit: "Bao", raw: "2 bao", start: 0, end: 5 }]) },
  );
  assert.equal(built.proposal.action, "create_sales_order");
  // The SO path still reports its OWN codes (the default prefix was not lost).
  await assert.rejects(
    () => buildSalesOrderProposal(fakeSkills(), { customer: CUSTOMER, ambiguous: false, candidates: [] }, { nlp: nlp("đặt hàng cám heo tăng trọng 25kg", []) }),
    (err) => err.code === "SO_QTY_MISSING",
  );

  await withGateway(async ({ runExecute, store }) => {
    const verdict = await runExecute({ command_id: randomUUID(), proposal: built.proposal, store });
    assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
    assert.match(verdict.body.result.erpnext_doc, /^SO-M\d+$/);
  });
});
