/**
 * next8 / Phase 7 — PURCHASE VERTICAL: the whole chain against the REAL ask
 * server, the REAL MCP client and the mock ERPNext (the same posture as the
 * Phase 6 sales suite — what is pinned here is the CHAIN, not a helper):
 *
 *   propose (/purchase/propose) → confirm (/execute) → ONE draft Purchase
 *   Invoice (+ at most ONE advance Payment Entry), covering plan1_final_v2
 *   §31 / phase-07 §5's rows:
 *     multiple items · qty/uom · the BUYING price (never the selling price) ·
 *     cash · bank · cash+bank refused · partial payment · payable remainder ·
 *     account per method · account-type mismatch refused · supplier/company
 *     scope · a missing buying price is a QUESTION.
 *
 * Falsify pins (phase-07 §7): F1 partial allocation by supplier invoice · F2
 * party_type from a name · F3 direction Receive for a supplier · F4 credit as
 * money in · F5 cash fallback for a bank intent / company scope dropped · F6
 * two methods in one PE.
 *
 * Falsify method: mutate the SKILL/MODULE bytes, expect the named tests RED,
 * restore byte-identical (done interactively in the session, documented in
 * phase7-result.md) — this file keeps the assertions the mutations must break.
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
// The purchase builder needs a default warehouse for the stock-warning read.
process.env.COPILOT_DEFAULT_WAREHOUSE = "Kho chính";
delete process.env.COPILOT_COMPANY; // resolveSalesCompany falls to the single-company mock

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

import { buildHandoff, handoffStore, SLOT_STATES } from "../src/business-handoff.mjs";
import { routeIntent } from "../src/router.mjs";

const COMPANY = "Demo Feed Co";
const SUP = "SUP-HATIEN";
const CASH_ACC = "1110 - Cash - DFC";
const BANK_ACC = "1120 - Bank - DFC";
const PAYABLE = "2110 - Payable - DFC";

async function withServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "next8-purchase-"));
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
          invoices: Array.isArray(raw.purchase_invoice_drafts) ? raw.purchase_invoice_drafts : [],
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

function purchaseTicket() {
  const handoff = buildHandoff({
    capability: "purchase_invoice.create",
    principalId: "local",
    conversationId: null,
    question: "nhập hàng cho nhà cung cấp",
    prefill: { supplier: { state: SLOT_STATES.RESOLVED, id: SUP, label: "Hà Tiên" } },
  });
  handoffStore.put(handoff, { principalId: "local", conversationId: null });
  return handoff;
}

/** CAM-HEO-25KG: 295.000/Bao on Standard Buying (the mock's real buying row). */
const items = (over = {}) => [{ item_id: "CAM-HEO-25KG", uom: "Bao", qty: 10, ...over }];

const draft = (over = {}) => ({
  supplier_id: SUP,
  items: items(),
  payment_methods: [],
  ...over,
});

const propose = (base, values) =>
  post(base, "/purchase/propose", { handoff_id: purchaseTicket().handoff_id, values });

const execute = (base, proposal, commandId) =>
  post(base, "/execute", { command_id: commandId ?? randomUUID(), proposal });

// ────────────────────────────────────────────────────────────────────────────
// §31 — the matrix rows, one test each
// ────────────────────────────────────────────────────────────────────────────

test("§31 routing: 'nhập hàng' opens the PURCHASE screen; 'nhận hàng' keeps the receipt", () => {
  assert.equal(routeIntent("nhập hàng cho Hà Tiên")?.capability, "purchase_invoice.create");
  assert.equal(routeIntent("nhập hàng từ Hà Tiên 10 bao cám heo")?.capability, "purchase_invoice.create");
  assert.equal(routeIntent("purchase 5 bao cám heo")?.capability, "purchase_invoice.create");
  assert.equal(routeIntent("nhận hàng từ Hà Tiên")?.capability, "purchase_receipt.create");
  assert.equal(routeIntent("nhận đơn PUR-ORD-2026-00001")?.capability, "purchase_receipt.create");
  // A QUESTION keeps the READ behaviour (never opens the purchase card).
  assert.notEqual(routeIntent("nhập hàng cám heo tuần này bao nhiêu")?.capability, "purchase_invoice.create");
});

test("§31 multiple items + qty/uom + price: propose resolves EVERY line's BUYING price from ERPNext", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      items: [
        { item_id: "CAM-HEO-25KG", uom: "Bao", qty: 2 },
        { item_id: "CAM-GA-10KG", uom: "Bao", qty: 3 },
      ],
    }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const lines = p.body.proposal.params.items;
    assert.equal(lines.length, 2);
    assert.equal(lines[0].unit_price, 295_000, "the BUYING price is ERPNext's, not the client's");
    assert.equal(lines[1].unit_price, 240_000);
    assert.equal(p.body.summary.total_vnd, 2 * 295_000 + 3 * 240_000);
  });
});

test("§31 price: the BUYING price wins over the selling price (795.000 ≠ 305.000)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({ items: [{ item_id: "CAM-HEO-25KG", uom: "Bao", qty: 1 }] }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.proposal.params.items[0].unit_price, 295_000);
    assert.notEqual(p.body.proposal.params.items[0].unit_price, 305_000, "the SELLING price must never price a purchase");
    assert.equal(p.body.price_list, "Standard Buying");
  });
});

test("§31 price: a client-sent unit_price is IGNORED (server-authoritative, falsify F6)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({ items: [{ item_id: "CAM-HEO-25KG", uom: "Bao", qty: 1, unit_price: 1 }] }));
    assert.equal(p.status, 200);
    assert.equal(p.body.proposal.params.items[0].unit_price, 295_000, "the client's 1đ price must not win");
  });
});

test("§31 price: a SELLING-only item is a QUESTION, never the shop's selling price", async () => {
  // P1F has a SELLING price (Kg) but NO buying price ⇒ the purchase must ASK,
  // never fall back to the selling table (the mirror of the Phase 6 bug).
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({ items: [{ item_id: "P1F-ACCEPT Livestock Item", uom: "Bao", qty: 1 }] }));
    assert.equal(p.status, 422, JSON.stringify(p.body));
    assert.equal(p.body.code, "PURCHASE_PRICE_MISSING");
    assert.match(p.body.reason, /không tự đặt giá/);
  });
});

test("§31 price: a BUYING-only item IS priced (the buying filter works both ways)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({ items: [{ item_id: "BUYONLY-CAM-25KG", uom: "Bao", qty: 1 }] }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.proposal.params.items[0].unit_price, 111_000);
  });
});

test("§31 price: the list is resolved from the SINGLE `Buying Settings`, never the failing LIST read", async () => {
  // Mirror of the real site (phase7-audit §2): `Buying Settings` is a Single, so
  // the mock's LIST handler THROWS for it; the builder must read via doc_get.
  await withServer(async ({ base }) => {
    const p = await propose(base, draft());
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.price_list, "Standard Buying");
    assert.equal(p.body.proposal.params.items[0].unit_price, 295_000);
  });
});

test("§31 payable remainder: credit = purchase_total − paid, a NUMBER (falsify F4)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({ payment_methods: [{ mode: "cash", amount: 1_000_000 }] }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.proposal.params.estimated_total_vnd, 2_950_000);
    assert.equal(p.body.proposal.params.paid_vnd, 1_000_000);
    assert.equal(p.body.proposal.params.credit_vnd, 1_950_000);
    assert.equal(p.body.proposal.params.payment_methods.length, 1);
    assert.ok(!p.body.proposal.params.payment_methods.some((m) => m.mode === "credit"));
    assert.equal(p.body.summary.outstanding_after_vnd, 1_950_000);
  });
});

test("§31 cash+bank: TWO methods in one command are REFUSED (falsify F6, §6.1)", async () => {
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

test("§31 cash: one method ⇒ one draft PI + one advance PE, money OUT of the cash account", async () => {
  await withServer(async ({ base, ledger }) => {
    const p = await propose(base, draft({ payment_methods: [{ mode: "cash", amount: 500_000 }] }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const commandId = randomUUID();
    const confirmed = await execute(base, p.body.proposal, commandId);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

    // ONE draft Purchase Invoice…
    const invoices = ledger().invoices.filter((i) => i.custom_ai_action_id === p.body.proposal.action_id);
    assert.equal(invoices.length, 1, "exactly one Purchase Invoice");
    const pi = invoices[0];
    assert.equal(pi.docstatus, 0, "created as a DRAFT");
    assert.equal(pi.update_stock, 1, "the site's PIs receive stock on submit");
    assert.equal(pi.credit_to, PAYABLE, "credit_to comes from the Company payable default");
    assert.equal(pi.supplier, SUP);
    assert.equal(pi.grand_total, 2_950_000);
    assert.equal(pi.items[0].rate, 295_000);
    assert.equal(pi.items[0].price_list_rate, 295_000, "no discount: both rates are the buying price");

    // …plus ONE advance Payment Entry with NO allocation rows.
    const payments = ledger().payments.filter((x) => x.reference_no === `${commandId}:advance`);
    assert.equal(payments.length, 1, "exactly one advance Payment Entry");
    const pe = payments[0];
    assert.equal(pe.docstatus, 0);
    assert.equal(pe.payment_type, "Pay", "the direction is Pay, never Receive");
    assert.equal(pe.party_type, "Supplier");
    assert.equal(pe.party, SUP);
    assert.equal(pe.paid_amount, 500_000);
    assert.equal(pe.paid_from, CASH_ACC, "money leaves the cash account (paid_from)");
    assert.equal(pe.paid_to, PAYABLE, "and lands on the payable account (2110)");
    assert.equal(pe.unallocated_amount, 500_000, "the whole amount is an advance");
    assert.equal(pe.references.length, 0, "NO allocation into the DRAFT invoice (ERPNext refuses it)");

    // The copy never claims the invoice was settled, and no allocation exists.
    const flat = JSON.stringify(confirmed.body);
    assert.ok(!/đã thanh toán phiếu nhập|đã gạch nợ vào phiếu nhập/.test(flat), flat.slice(0, 400));
    assert.equal(/không gạch nợ/.test(confirmed.body.result.payment.allocation_note), true);
    assert.equal(confirmed.body.result.direction, "pay");
    assert.equal(confirmed.body.result.credit_vnd, 2_450_000);
  });
});

test("§31 bank: a bank intent resolves the BANK account and the payable (falsify F5)", async () => {
  await withServer(async ({ base, ledger }) => {
    const p = await propose(base, draft({ payment_methods: [{ mode: "bank_transfer", amount: 1_000_000 }] }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const commandId = randomUUID();
    const confirmed = await execute(base, p.body.proposal, commandId);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const pe = ledger().payments.find((x) => x.reference_no === `${commandId}:advance`);
    assert.equal(pe.paid_from, BANK_ACC, "the bank channel resolves the BANK account (§6.2)");
    assert.equal(pe.paid_to, PAYABLE);
    assert.equal(pe.mode_of_payment, "Wire Transfer");
    assert.equal(pe.references.length, 0);
  });
});

test("§31 account-type mismatch: a cash account offered for a BANK intent is refused (§6.2)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, draft({
      payment_methods: [{ mode: "bank_transfer", amount: 100_000, account_id: CASH_ACC }],
    }));
    assert.equal(p.status, 422);
    assert.equal(p.body.code, "ACCOUNT_TYPE_MISMATCH");
    assert.match(p.body.reason, /đúng loại/);
  });
});

test("§31 partial payment + idempotency: double confirm ⇒ ONE PI + ONE advance PE", async () => {
  await withServer(async ({ base, ledger }) => {
    const p = await propose(base, draft({ payment_methods: [{ mode: "cash", amount: 295_000 }] }));
    assert.equal(p.status, 200);
    const commandId = randomUUID();
    const first = await execute(base, p.body.proposal, commandId);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await execute(base, p.body.proposal, commandId);
    assert.equal(second.status, 200);
    assert.equal(second.body.replay, true, "the second confirm replays the first result");
    assert.equal(ledger().invoices.filter((i) => i.custom_ai_action_id === p.body.proposal.action_id).length, 1);
    assert.equal(ledger().payments.filter((x) => x.reference_no === `${commandId}:advance`).length, 1);
  });
});

test("§31 credit (pay nothing): a purchase with no payment writes ONE PI and no PE", async () => {
  await withServer(async ({ base, ledger }) => {
    const p = await propose(base, draft());
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const commandId = randomUUID();
    const confirmed = await execute(base, p.body.proposal, commandId);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(ledger().invoices.length, 1);
    const advances = ledger().payments.filter((x) => String(x.reference_no ?? "").includes(commandId));
    assert.equal(advances.length, 0, "no payment ⇒ no Payment Entry");
    assert.equal(confirmed.body.result.credit_vnd, 2_950_000, "the whole purchase is owed");
  });
});

test("supplier: an invented supplier id is refused (HINT-NOT-AUTHORITY)", async () => {
  await withServer(async ({ base }) => {
    const p = await propose(base, { ...draft(), supplier_id: "SUP-9999" });
    assert.equal(p.status, 404);
    assert.equal(p.body.code, "NO_MATCH");
  });
});

test("execute: a proposal whose BUYING price drifted is refused, nothing written", async () => {
  await withServer(async ({ base, ledger }) => {
    const p = await propose(base, draft());
    assert.equal(p.status, 200);
    const proposal = JSON.parse(JSON.stringify(p.body.proposal));
    proposal.params.items[0].unit_price = 999; // tamper the snapshot
    const confirmed = await execute(base, proposal, randomUUID());
    assert.equal(confirmed.status, 409);
    assert.equal(confirmed.body.code, "PROPOSAL_VERSION_STALE");
    assert.equal(ledger().invoices.length, 0, "nothing was written");
  });
});

test("company scope (F5): several companies, nothing pinned, NO site default ⇒ REFUSE, never guess", async () => {
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
// Falsify F1–F6 (phase-07 §7): the mutations are applied to the module bytes
// interactively and restored byte-identical (sha256 before/after, documented
// in phase7-result.md §5). This file carries the assertions each mutation
// must turn red.
// ────────────────────────────────────────────────────────────────────────────

test("falsify pin F1: there is NO partial-allocation-by-supplier-invoice path", async () => {
  // The purchase skill must expose NO allocation helper at all (plan §14):
  // a partial allocation would need a "split the payment across PI(s)" function
  // — its absence IS the pin. The advance PE carries `references: []` and
  // `unallocated_amount = paid` (proved by the cash/bank tests above).
  const mod = await import("../src/skills/purchase-invoice-write.mjs");
  const names = Object.keys(mod);
  assert.ok(!names.some((n) => /allocat|oldest|fifo|split/i.test(n)), `no allocation API may exist: ${names.join(",")}`);
});

test("falsify pin F3: a supplier payment is Pay, never Receive; payable is 2110-derived", async () => {
  const { DIRECTION_SPEC } = await import("../src/skills/payment-write.mjs");
  assert.equal(DIRECTION_SPEC.pay.payment_type, "Pay");
  assert.equal(DIRECTION_SPEC.pay.party_type, "Supplier");
  assert.equal(DIRECTION_SPEC.pay.anchor_account_type, "Payable");
});

test("falsify pin F4: computePurchaseTotals has no discount layer; credit is a separate number", async () => {
  const { computePurchaseTotals } = await import("../src/skills/purchase-invoice-write.mjs");
  const t = computePurchaseTotals([{ qty: 10, unit_price: 295_000 }]);
  assert.equal(t.subtotal, 2_950_000);
  assert.equal(t.total, 2_950_000, "purchase_total = Σ(qty × unit_price): plan §14 has NO discount");
  assert.equal(t.order_discount, undefined, "no order-discount layer exists for a purchase");
});
