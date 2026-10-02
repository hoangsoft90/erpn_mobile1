/**
 * next8 / Phase 6 — SALES VERTICAL: the whole chain against the REAL ask
 * server, the REAL MCP client and the mock ERPNext (the same posture as the
 * Phase 4 execute suite — what is pinned here is the chain, not a helper):
 *
 *   propose (/sales/propose) → confirm (/execute) → ONE draft Sales Invoice
 *   (+ at most ONE advance Payment Entry), with plan1_final_v2 §30's rows:
 *     multiple items · qty/uom · price (ERPNext's, never the client's) ·
 *     line discount · order discount · cash · bank · cash+bank refused ·
 *     partial payment · credit remainder · account per method · account-type
 *     mismatch refused · bank-transfer pending lifecycle.
 *
 * Falsify pins (phase-06 §7): F1 two layers merged · F2 credit as money in ·
 * F3 "đã nhận tiền" on a draft · F4 two methods in one command · F5 cash
 * fallback for a bank intent · F6 client-authoritative totals.
 *
 * Falsify method: mutate the SKILL/MODULE bytes, expect the named tests RED,
 * restore byte-identical (done interactively in the session, documented in
 * phase6-result.md) — this file keeps the assertions the mutations must break.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
process.env.COPILOT_MOCK_OK = "1";
// The sales builder needs a default warehouse for the stock-warning read.
process.env.COPILOT_DEFAULT_WAREHOUSE = "Kho chính";
delete process.env.COPILOT_COMPANY; // resolveSalesCompany falls to the single-company mock

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

import { buildHandoff, handoffStore, SLOT_STATES } from "../src/business-handoff.mjs";

const COMPANY = "Demo Feed Co";
const LAN = "CUST-00001";
const CASH_ACC = "1110 - Cash - DFC";
const BANK_ACC = "1120 - Bank - DFC";

async function withServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "next8-sales-"));
  const previousState = process.env.MOCK_ERP_STATE;
  let server = null;
  const { createAskServer } = await import("../src/http-ask.mjs");
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const { JobQueue, jobQueueConfig } = await import("../src/job-queue.mjs");
  try {
    process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
    handoffStore.clear();
    server = createAskServer({
      port: 0,
      host: "127.0.0.1",
      env: process.env,
      idemStore: new IdempotencyStore(dir),
      jobs: new JobQueue({ config: { ...jobQueueConfig(), dir } }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({
      base: `http://127.0.0.1:${server.address().port}`,
      ledger: () => {
        const file = process.env.MOCK_ERP_STATE;
        if (!existsSync(file)) return { payments: [], invoices: [] };
        const raw = JSON.parse(readFileSync(file, "utf8"));
        return {
          payments: Array.isArray(raw.payments) ? raw.payments : [],
          invoices: Array.isArray(raw.sales_invoices) ? raw.sales_invoices : [],
        };
      },
    });
  } finally {
    server?.close();
    handoffStore.clear();
    if (previousState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = async (base, route, body) => {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

function salesTicket() {
  const handoff = buildHandoff({
    capability: "sales.create",
    principalId: "local",
    conversationId: null,
    question: "bán hàng cho khách",
    prefill: { customer: { state: SLOT_STATES.RESOLVED, id: LAN, label: "Nguyễn Thị Lan" } },
  });
  handoffStore.put(handoff, { principalId: "local", conversationId: null });
  return handoff;
}

/** CAM-HEO-25KG: 305.000/Bao on Standard Selling (the mock's real price row). */
const items = (over = {}) => [
  { item_id: "CAM-HEO-25KG", uom: "Bao", qty: 10, line_discount: 0, ...over },
];

const draft = (over = {}) => ({
  customer_id: LAN,
  items: items(),
  order_discount_vnd: 0,
  payment_methods: [],
  ...over,
});

const propose = (base, values) =>
  post(base, "/sales/propose", { handoff_id: salesTicket().handoff_id, values });

const execute = (base, proposal, commandId) =>
  post(base, "/execute", { command_id: commandId ?? randomUUID(), proposal });

// ────────────────────────────────────────────────────────────────────────────
// §30 — the matrix rows, one test each
// ────────────────────────────────────────────────────────────────────────────

test("§30 multiple items + qty/uom + price: propose resolves EVERY line's price from ERPNext", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      items: [
        { item_id: "CAM-HEO-25KG", uom: "Bao", qty: 2, line_discount: 0 },
        { item_id: "CAM-GA-10KG", uom: "Bao", qty: 3, line_discount: 0 },
      ],
    }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const lines = p.body.proposal.params.items;
    assert.equal(lines.length, 2);
    assert.equal(lines[0].unit_price, 305_000, "the price is ERPNext's Item Price, not the client's");
    assert.equal(lines[1].unit_price, 250_000);
    assert.equal(p.body.summary.total_vnd, 2 * 305_000 + 3 * 250_000);
    assert.equal(p.body.summary.line_discount_vnd, 0);
    assert.equal(p.body.summary.order_discount_vnd, 0);
  });
});

test("§30 price: a client-sent unit_price is IGNORED (server-authoritative, falsify F6)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      items: [{ item_id: "CAM-HEO-25KG", uom: "Bao", qty: 1, unit_price: 1, line_discount: 0 }],
    }));
    assert.equal(p.status, 200);
    assert.equal(p.body.proposal.params.items[0].unit_price, 305_000, "the client's 1đ price must not win");
  });
});

test("§30 price: an item ERPNext has NO price for is a QUESTION, never a zero", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      items: [{ item_id: "P1F-ACCEPT Livestock Item", uom: "Bao", qty: 1 }],
    }));
    // The mock's P1F row only has a Kg price; Bao has none (and standard_rate 0
    // must never be the fallback — audit §3).
    assert.equal(p.status, 422);
    assert.equal(p.body.code, "SALES_PRICE_MISSING");
    assert.match(p.body.reason, /không tự đặt giá/);
  });
});

test("§30 price: the list is resolved from the SINGLE `Selling Settings`, never from the failing LIST read", async () => {
  // MEASURED on the real site (2026-09-30): `Selling Settings` is a Single, so
  // `erpnext_doc_list` answers HTTP 500 (`MySQLdb.ProgrammingError: ('DocType',
  // 'Selling Settings')`) while `erpnext_doc_get` answers 200. The mock's list
  // handler THROWS for that doctype now (mirroring the site) — so this passes
  // only if the builder read the Single. 305.000 lives ONLY on the Standard
  // Selling row, so a wrong/absent price list cannot accidentally satisfy it.
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      items: [{ item_id: "CAM-HEO-25KG", uom: "Bao", qty: 1, line_discount: 0 }],
    }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.price_list, "Standard Selling");
    assert.equal(p.body.proposal.params.items[0].unit_price, 305_000);
  });
});

test("§30 price: a BUYING-only Item Price is a QUESTION, never the shop's own cost", async () => {
  // The real site stores both sides on one table (CAM-HEO-25KG: 295.000 buying
  // vs 320.000 selling). `priceForLine` falls back to its first row when nothing
  // matches a price list, so an unfiltered read billed the SALE at the COST.
  // BUYONLY-CAM-25KG has ONLY a Standard Buying row ⇒ the sale must ASK.
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      items: [{ item_id: "BUYONLY-CAM-25KG", uom: "Bao", qty: 1, line_discount: 0 }],
    }));
    assert.equal(p.status, 422, JSON.stringify(p.body));
    assert.equal(p.body.code, "SALES_PRICE_MISSING");
    assert.match(p.body.reason, /không tự đặt giá/);
  });
});

test("§30 line discount + order discount: BOTH layers applied, values kept APART (falsify F1)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      items: [{ item_id: "CAM-HEO-25KG", uom: "Bao", qty: 10, line_discount: 100_000 }],
      order_discount_vnd: 200_000,
    }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const s = p.body.summary;
    // 10×305.000 − 100.000 (line) = 2.950.000 → − 200.000 (order) = 2.750.000
    assert.equal(s.subtotal_vnd, 2_950_000);
    assert.equal(s.line_discount_vnd, 100_000);
    assert.equal(s.order_discount_vnd, 200_000);
    assert.equal(s.total_vnd, 2_750_000);
    // The LINE discount is NOT folded into the order discount anywhere:
    assert.notEqual(s.order_discount_vnd, 300_000, "the two layers must never merge (plan §12.2)");
  });
});

test("§30 line discount: written as (price_list_rate = list, rate = net); ERPNext DERIVES the child discount", async () => {
  // Measured on the real site (2026-09-30): sending `discount_amount` on the
  // child row did nothing — ERPNext recomputes
  //   discount_amount = flt(price_list_rate × qty) − flt(rate × qty)
  // and kept `rate` as sent. So the FIRST layer must travel as the pair
  // (list rate, net rate). 10×305.000 − 100.000 = 2.950.000 ⇒ net rate 295.000.
  await withServer(async ({ base, ledger }) => {
    const p = await propose(base, draft({
      items: [{ item_id: "CAM-HEO-25KG", uom: "Bao", qty: 10, line_discount: 100_000 }],
      order_discount_vnd: 200_000,
    }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const confirmed = await execute(base, p.body.proposal, randomUUID());
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const si = ledger().invoices.find((i) => i.custom_ai_action_id === p.body.proposal.action_id);
    const line = si.items[0];
    assert.equal(line.price_list_rate, 305_000, "the LIST rate is what `price_list_rate` carries");
    assert.equal(line.rate, 295_000, "`rate` is the NET rate after the line discount");
    assert.equal(line.discount_amount, 100_000, "the child discount is DERIVED from the two");
    assert.equal(line.amount, 2_950_000);
    // The SECOND layer stays on the PARENT, apart from the line layer.
    assert.equal(si.discount_amount, 200_000);
    assert.equal(si.apply_discount_on, "Grand Total");
    assert.equal(si.grand_total, 2_750_000);
  });
});

test("§30 credit remainder: credit = grand_total − actual_paid, a NUMBER (falsify F2)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      payment_methods: [{ mode: "cash", amount: 1_000_000 }],
    }));
    assert.equal(p.status, 200);
    assert.equal(p.body.proposal.params.estimated_total_vnd, 3_050_000);
    assert.equal(p.body.proposal.params.collected_vnd, 1_000_000);
    // 3.050.000 − 1.000.000 = 2.050.000 — and `credit` is not a payment method:
    assert.equal(p.body.proposal.params.payment_methods.length, 1);
    assert.ok(!p.body.proposal.params.payment_methods.some((m) => m.mode === "credit"));
    assert.equal(p.body.summary.outstanding_after_vnd, 2_050_000);
  });
});

test("§30 cash: one method ⇒ the proposal carries exactly one method (§6.1)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      payment_methods: [{ mode: "cash", amount: 500_000 }],
    }));
    assert.equal(p.status, 200);
    assert.equal(p.body.proposal.params.payment_methods.length, 1);
    assert.equal(p.body.proposal.params.payment_methods[0].mode, "cash");
  });
});

test("§30 cash+bank: TWO methods in one command are REFUSED (falsify F4, §6.1)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      payment_methods: [
        { mode: "cash", amount: 200_000 },
        { mode: "bank_transfer", amount: 100_000 },
      ],
    }));
    assert.equal(p.status, 422);
    assert.equal(p.body.code, "PAYMENT_METHOD_COUNT_INVALID");
    assert.match(p.body.reason, /hai lần|một hình thức/);
  });
});

test("§30 bank: the collection rides the SAME command as the sale (owner decision A)", async () => {
  await withServer(async ({ base, ledger }) => {
    const p = await propose(base, draft({
      payment_methods: [{ mode: "bank_transfer", amount: 1_000_000 }],
    }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const commandId = randomUUID();
    const confirmed = await execute(base, p.body.proposal, commandId);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const result = confirmed.body.result;

    // ONE draft Sales Invoice…
    const invoices = ledger().invoices.filter((i) => i.custom_ai_action_id === p.body.proposal.action_id);
    assert.equal(invoices.length, 1, "exactly one Sales Invoice");
    const si = invoices[0];
    assert.equal(si.docstatus, 0, "created as a DRAFT");
    assert.equal(si.update_stock, 0, "a chat-made invoice never moves stock");
    assert.equal(si.debit_to, "1310 - Debtors - DFC", "debit_to comes from the Company default");
    assert.equal(si.items.length, 1);
    assert.equal(si.grand_total, 3_050_000);
    // §13 lifecycle: a BANK collection is "waiting for the money" ON the invoice.
    assert.equal(si.camvlxd_transfer_state, "pending");

    // …plus ONE advance Payment Entry with NO allocation rows (S1).
    const payments = ledger().payments.filter((x) => x.reference_no === `${commandId}:advance`);
    assert.equal(payments.length, 1, "exactly one advance Payment Entry");
    const pe = payments[0];
    assert.equal(pe.docstatus, 0);
    assert.equal(pe.party, LAN);
    assert.equal(pe.paid_amount, 1_000_000);
    assert.equal(pe.unallocated_amount, 1_000_000, "the whole amount is an advance");
    assert.equal(pe.references.length, 0, "NO allocation into the DRAFT invoice (ERPNext refuses it)");
    assert.equal(pe.paid_to, BANK_ACC, "the bank channel resolves the BANK account (§6.2)");
    assert.equal(pe.mode_of_payment, "Wire Transfer", "the MoP follows the channel (F-P5-2)");

    // The RESULT's copy never claims the invoice was settled (falsify F3).
    const flat = JSON.stringify(confirmed.body);
    assert.ok(!/đã nhận tiền|đã thanh toán hoá đơn|đã gạch nợ vào hoá đơn/.test(flat), flat.slice(0, 400));
    assert.equal(result.payment.allocation_note.match(/không gạch nợ/) !== null, true);
    assert.equal(result.transfer_state, "pending");
    assert.equal(result.credit_vnd, 2_050_000);
  });
});

test("§30 cash sale: NO transfer state, no pending-transfer copy", async () => {
  await withServer(async ({ base, ledger }) => {
    const p = await propose(base, draft({
      payment_methods: [{ mode: "cash", amount: 50_000 }],
    }));
    assert.equal(p.status, 200);
    const confirmed = await execute(base, p.body.proposal, randomUUID());
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const si = ledger().invoices.find((i) => i.custom_ai_action_id === p.body.proposal.action_id);
    assert.equal(si.camvlxd_transfer_state, undefined, "cash sets no transfer state");
    assert.equal(confirmed.body.result.transfer_state, null);
    assert.equal(confirmed.body.result.payment.paid_to, CASH_ACC, "cash resolves the CASH account (§6.2)");
  });
});

test("§30 account-type mismatch: a cash account offered for a BANK intent is refused (falsify F5)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      payment_methods: [{ mode: "bank_transfer", amount: 100_000, account_id: CASH_ACC }],
    }));
    assert.equal(p.status, 422);
    assert.equal(p.body.code, "ACCOUNT_TYPE_MISMATCH");
    assert.match(p.body.reason, /đúng loại/);
  });
});

test("§30 partial payment + idempotency: double confirm ⇒ ONE invoice + ONE advance PE", async () => {
  await withServer(async ({ base, ledger }) => {
    const p = await propose(base, draft({
      payment_methods: [{ mode: "cash", amount: 305_000 }],
    }));
    assert.equal(p.status, 200);
    const commandId = randomUUID();
    const first = await execute(base, p.body.proposal, commandId);
    assert.equal(first.status, 200);
    const second = await execute(base, p.body.proposal, commandId);
    assert.equal(second.status, 200);
    assert.equal(second.body.replay, true, "the second confirm replays the first result");
    const invoices = ledger().invoices.filter((i) => i.custom_ai_action_id === p.body.proposal.action_id);
    assert.equal(invoices.length, 1, "one Sales Invoice, never two");
    const payments = ledger().payments.filter((x) => x.reference_no === `${commandId}:advance`);
    assert.equal(payments.length, 1, "one advance PE, never two");
  });
});

test("stock: a short item WARNS but the sale still builds (never a silent block)", async () => {
  await withServer(async ({ base }) => {
    // CAM-GA-10KG has 40 in "Kho chính"; asking for 41 crosses the Bin row.
    const p = await propose(base, draft({
      items: [{ item_id: "CAM-GA-10KG", uom: "Bao", qty: 41 }],
    }));
    assert.equal(p.status, 200, "stock is a warning, not a gate");
    assert.ok(
      (p.body.warnings ?? []).some((w) => /tồn CAM-GA-10KG/.test(w) && /chỉ còn 40/.test(w)),
      JSON.stringify(p.body.warnings),
    );
  });
});

test("customer: an invented customer id is refused (HINT-NOT-AUTHORITY)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, { ...draft(), customer_id: "CUST-9999" });
    assert.equal(p.status, 404);
    assert.equal(p.body.code, "NO_MATCH");
  });
});

test("execute: a PROPOSAL whose price drifted is refused, nothing written (falsify F6's gate)", async () => {
  await withServer(async ({ base, ledger }) => {
    const p = await propose(base, draft());
    assert.equal(p.status, 200);
    const proposal = JSON.parse(JSON.stringify(p.body.proposal));
    // Tamper the snapshot: the executor re-reads ERPNext and compares.
    proposal.params.items[0].unit_price = 999;
    const confirmed = await execute(base, proposal, randomUUID());
    assert.equal(confirmed.status, 409);
    assert.equal(confirmed.body.code, "PROPOSAL_VERSION_STALE");
    assert.equal(ledger().invoices.length, 0, "nothing was written");
  });
});

test("company scope (F7): several companies, nothing pinned, NO site default ⇒ REFUSE, never guess", async () => {
  // The resolution rule is the ONE the sibling collect route owns (§6.2/§5.4
  // row 7): config pin → ERPNext session default → refusal. A multi-company
  // site WITH a session default is therefore the normal case and proposes
  // against that default (the bank E2E above proves the default wins). What
  // must never happen is PICKING a row when nothing names a company: two
  // companies, no pin, no Default Company ⇒ COMPANY_SCOPE_REQUIRED with copy
  // naming what to configure — never a silent write into a guessed tenant.
  const previousCompanies = process.env.MOCK_ERP_COMPANIES;
  const previousDefault = process.env.MOCK_ERP_DEFAULT_COMPANY;
  process.env.MOCK_ERP_COMPANIES = "Demo Feed Co,Other Co";
  process.env.MOCK_ERP_DEFAULT_COMPANY = "";
  try {
    await withServer(async ({ base, ledger }) => {
      const p = await propose(base, draft());
      assert.equal(p.status, 503, JSON.stringify(p.body));
      assert.equal(p.body.code, "COMPANY_SCOPE_REQUIRED");
      assert.equal(p.body.proposal, null, "no proposal may be built without a company");
      assert.match(p.body.reason, /COPILOT_COMPANY/);
      assert.equal(ledger().invoices.length, 0, "nothing was written");
    });
  } finally {
    if (previousCompanies === undefined) delete process.env.MOCK_ERP_COMPANIES;
    else process.env.MOCK_ERP_COMPANIES = previousCompanies;
    if (previousDefault === undefined) delete process.env.MOCK_ERP_DEFAULT_COMPANY;
    else process.env.MOCK_ERP_DEFAULT_COMPANY = previousDefault;
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Falsify F1–F7 (phase-06 §7): the mutations are applied to the module bytes
// interactively and restored byte-identical (sha256 before/after, documented
// in phase6-result.md §5). This file carries the assertions each mutation
// must turn red.
// ────────────────────────────────────────────────────────────────────────────

test("falsify pin F1: merging the order discount into the lines turns the two-layer test red", async () => {
  // The pin lives in "§30 line discount + order discount" above: merge the
  // layers in computeSalesTotals ⇒ total_vnd becomes 2.950.000 and
  // order_discount_vnd no longer equals 200.000 ⇒ that test fails.
  const { computeSalesTotals } = await import("../src/skills/sales-write.mjs");
  const t = computeSalesTotals([{ qty: 10, unit_price: 305_000, line_discount: 100_000 }], 200_000);
  assert.equal(t.order_discount, 200_000, "the order layer stays a separate VALUE");
  assert.equal(t.total, 2_750_000, "the order layer is subtracted EXACTLY once");
  assert.equal(t.subtotal, 2_950_000, "the line layer lives in the subtotal only");
});

test("falsify pin F2: credit is a balance, never a channel in payment_methods", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({ payment_methods: [{ mode: "cash", amount: 1_000_000 }] }));
    assert.equal(p.status, 200);
    const methods = p.body.proposal.params.payment_methods;
    assert.equal(methods.length, 1, "credit must not appear as a second method");
    assert.equal(p.body.summary.outstanding_after_vnd, 2_050_000);
  });
});
