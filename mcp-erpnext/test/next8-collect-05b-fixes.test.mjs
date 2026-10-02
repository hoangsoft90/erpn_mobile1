/**
 * next8 / Phase 5b — the two defects Phase 5 MEASURED on the real site
 * (`result89.txt` §6), each pinned so it cannot come back:
 *
 *   F-P5-1  a customer past the first 100 rows of `erpnext_customer_list` could
 *           never be collected from — the read was capped at 100 while the shop
 *           has 134 customers, so `/collect/propose` answered `NO_MATCH`;
 *   F-P5-2  a `bank_transfer` intent was written with `mode_of_payment = "Cash"`
 *           because the Mode of Payment was chosen by NAME with no bank branch
 *           (`ACC-PAY-2026-00775`), and a label whose `type` contradicts the
 *           channel (F-P5-3: "Chuyển khoản" typed Cash) was silently renamed.
 *
 * Falsify: put `limit: 100` back in `skills/customer.mjs` ⇒ the F-P5-1 tests go
 * red; drop the channel branch in `resolveAccountPlan` ⇒ the F-P5-2 tests go red.
 */

import test from "node:test";
import assert from "node:assert/strict";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
process.env.COPILOT_MOCK_OK = "1";

import { findCustomer } from "../src/skills/customer.mjs";
import { resolvePaymentAccounts } from "../src/skills/payment-write.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// F-P5-1 — the customer master is read WHOLE
// ─────────────────────────────────────────────────────────────────────────────
/** A site whose customer master is bigger than one page (mirrors the real 134). */
function masterMcp(n) {
  const rows = Array.from({ length: n }, (_, i) => ({
    doctype: "Customer",
    name: `CUST-${String(i + 1).padStart(4, "0")}`,
    customer_name: `Khách ${i + 1}`,
    customer_group: "Individual",
    disabled: 0,
  }));
  const calls = [];
  return {
    calls,
    async callTool(tool, args) {
      calls.push({ tool, args });
      assert.equal(tool, "erpnext_customer_list");
      // Real 3.0.4 behaviour: a positive `limit` truncates, `0`/absent reads all.
      const lim = args?.limit ?? 20;
      const data = lim === 0 ? rows : rows.slice(0, lim);
      return { data: { doctype: "Customer", count: data.length, data } };
    },
  };
}

test("F-P5-1: the master read is not capped (limit 0 = read everything)", async () => {
  const mcp = masterMcp(134);
  await findCustomer(mcp, "", new Set());
  assert.equal(mcp.calls[0].args.limit, 0, "a silent 100-cap hides ~34 customers on the real site");
});

test("F-P5-1: a customer BEYOND the first 100 rows still resolves", async () => {
  const mcp = masterMcp(134);
  const knownIds = new Set();
  const res = await findCustomer(mcp, "", knownIds);
  const names = res.data.data.map((r) => r.name);
  assert.equal(names.length, 134, "every customer is returned, not one page");
  assert.ok(names.includes("CUST-0130"), "the 130th customer (past the old cap) must be resolvable");
  assert.ok(knownIds.has("CUST-0130"), "and its id is registered for later reads");
});

test("F-P5-1: the id the client sends is still only a HINT (an invented id resolves to nothing)", async () => {
  const mcp = masterMcp(134);
  const res = await findCustomer(mcp, "", new Set());
  // `/collect/propose` resolves with `rows.find(r => r.name === customerId)`; a
  // widened read must NOT make an id that is absent from the master resolvable.
  assert.equal(res.data.data.find((r) => r.name === "CUST-9999"), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 3 (review, 2026-09-30) — one master read per REQUEST, not per call site.
// The registry Set is what a request creates for itself, so it is also the memo
// key: same request ⇒ one read; new request ⇒ a genuinely fresh read.
// ─────────────────────────────────────────────────────────────────────────────

test("FINDING 3: two lookups in ONE request share a single master read", async () => {
  const mcp = masterMcp(134);
  const knownIds = new Set(); // one registry = one request

  const first = await findCustomer(mcp, "Khách 5", knownIds);
  const second = await findCustomer(mcp, "Khách 130", knownIds);

  assert.equal(mcp.calls.length, 1, "the whole master is fetched once per request");
  assert.ok(first.data.data.length >= 1, "the first lookup still filters");
  assert.equal(second.data.data[0].name, "CUST-0130", "and the second filters the SAME rows");
  assert.ok(knownIds.has("CUST-0130"), "the second call still registers the ids it returned");
});

test("FINDING 3: a NEW request reads ERPNext again — the memo cannot go stale", async () => {
  const mcp = masterMcp(134);
  await findCustomer(mcp, "", new Set());
  await findCustomer(mcp, "", new Set());
  assert.equal(mcp.calls.length, 2, "fresh per request is the HINT-NOT-AUTHORITY rule");
});

// ─────────────────────────────────────────────────────────────────────────────
// F-P5-2 — the Mode of Payment follows the CHANNEL; a label/type clash is spoken
// ─────────────────────────────────────────────────────────────────────────────
const COMPANY = "Minh Phát Cám & VLXD";
const CASH_ACC = "1110 - Tiền mặt - MP";
const BANK_ACC = "1210 - ACB 110296868 - MP";

/** The real site's Mode of Payment table (measured 2026-09-30), including the F-P5-3 clash. */
const SITE_MODES = [
  { name: "Bank Draft", enabled: 1, type: "Bank" },
  { name: "Cash", enabled: 1, type: "Cash" },
  { name: "Cheque", enabled: 1, type: "Bank" },
  { name: "Chuyển khoản", enabled: 1, type: "Cash" },
  { name: "Credit Card", enabled: 1, type: "Bank" },
  { name: "Wire Transfer", enabled: 1, type: "Bank" },
];
const typeOf = (name) => SITE_MODES.find((m) => m.name === name)?.type;

function siteMcp({ modes = SITE_MODES } = {}) {
  return {
    async callTool(tool, args) {
      if (tool === "erpnext_doc_get" && args.doctype === "Sales Invoice") {
        return { data: { name: args.name, company: COMPANY, debit_to: "1310 - Phải thu khách hàng - MP" } };
      }
      if (tool === "erpnext_doc_list" && args.doctype === "Mode of Payment") {
        return { data: modes };
      }
      if (tool === "erpnext_account_list") {
        return {
          data: [
            { name: "1000 - Tiền mặt - MP", is_group: 1, account_type: null, company: COMPANY },
            { name: CASH_ACC, is_group: 0, account_type: "Cash", company: COMPANY },
            { name: BANK_ACC, is_group: 0, account_type: "Bank", company: COMPANY },
          ],
        };
      }
      if (tool === "erpnext_doc_get" && args.doctype === "Company") {
        return { data: { name: COMPANY, default_cash_account: CASH_ACC, default_bank_account: BANK_ACC } };
      }
      throw new Error(`unexpected tool ${tool} ${args?.doctype ?? ""}`);
    },
  };
}

test("F-P5-2: a bank_transfer intent writes a BANK-typed Mode of Payment, never Cash", async () => {
  const out = await resolvePaymentAccounts(siteMcp(), {
    direction: "receive",
    invoice: "ACC-SINV-2026-01285",
    mode: "bank_transfer",
  });
  assert.equal(out.channel, "bank_transfer");
  assert.equal(out.paidTo, BANK_ACC, "the money account is still the bank default (§6.2)");
  assert.equal(out.mode, "Wire Transfer", "a bank-channel method is chosen deterministically");
  assert.equal(typeOf(out.mode), "Bank", "the chosen method must be Bank-typed");
  assert.notEqual(out.mode, "Cash");
  assert.notEqual(out.mode, "Chuyển khoản", "the Cash-typed label clash is never adopted");
});

test("F-P5-2: a cash intent still resolves the Cash method, never a bank one", async () => {
  const out = await resolvePaymentAccounts(siteMcp(), {
    direction: "receive",
    invoice: "ACC-SINV-2026-01285",
    mode: "cash",
  });
  assert.equal(out.channel, "cash");
  assert.equal(out.mode, "Cash");
  assert.equal(out.paidTo, CASH_ACC);
});

test("F-P5-2 / decision C: the shop's 'Chuyển khoản' (typed Cash) is SURFACED, not silently renamed", async () => {
  const out = await resolvePaymentAccounts(siteMcp(), {
    direction: "receive",
    invoice: "ACC-SINV-2026-01285",
    mode: "Chuyển khoản",
  });
  assert.equal(out.channel, "bank_transfer", "the user's own words decide the channel");
  assert.equal(typeOf(out.mode), "Bank");
  assert.match(out.mode_warning, /Chuyển khoản/, "the conflicting method is named");
  assert.match(out.mode_warning, /không khớp/, "and the mismatch is explained in Vietnamese");
});

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 2 (review, 2026-09-30) — the MIRROR case: the CHOSEN method's NAME reads
// like the other channel. The choice stays type-based (money account unchanged);
// what must not stay is the silence.
// ─────────────────────────────────────────────────────────────────────────────

const only = (name, type) => [{ name, enabled: 1, type }];

test("FINDING 2: a bank intent whose only bank-typed method is NAMED 'Cash' is spoken, not silent", async () => {
  const out = await resolvePaymentAccounts(siteMcp({ modes: only("Cash", "Bank") }), {
    direction: "receive",
    invoice: "ACC-SINV-2026-01285",
    mode: "bank_transfer",
  });
  assert.equal(out.mode, "Cash", "the type-based choice is unchanged (this site has no other Bank method)");
  assert.equal(out.paidTo, BANK_ACC, "and the money still lands in the BANK account (§6.2)");
  assert.match(out.mode_warning, /Cash/, "the misleading NAME is named");
  assert.match(out.mode_warning, /tiền mặt/, "and the channel the name reads as is spelled out");
  assert.match(out.mode_warning, /Bank/, "together with the type it is actually declared");
});

test("FINDING 2: the mirror — a cash intent landing on a Cash-typed method named 'Wire Transfer'", async () => {
  const out = await resolvePaymentAccounts(siteMcp({ modes: only("Wire Transfer", "Cash") }), {
    direction: "receive",
    invoice: "ACC-SINV-2026-01285",
    mode: "cash",
  });
  assert.equal(out.mode, "Wire Transfer");
  assert.equal(out.paidTo, CASH_ACC, "cash intent ⇒ the CASH ledger, whatever the method is called");
  assert.match(out.mode_warning, /chuyển khoản/, "the name reads like a transfer — that is what is reported");
});

test("FINDING 2: the real site's normal case stays warning-free (no new noise)", async () => {
  const bank = await resolvePaymentAccounts(siteMcp(), {
    direction: "receive",
    invoice: "ACC-SINV-2026-01285",
    mode: "bank_transfer",
  });
  assert.equal(bank.mode, "Wire Transfer");
  assert.equal(bank.mode_warning, undefined, "name and type agree ⇒ nothing to say");

  const cash = await resolvePaymentAccounts(siteMcp(), {
    direction: "receive",
    invoice: "ACC-SINV-2026-01285",
    mode: "cash",
  });
  assert.equal(cash.mode, "Cash");
  assert.equal(cash.mode_warning, undefined, "the cash path stays exactly as measured on the site");
});

test("F-P5-2: a label that genuinely matches a same-typed method passes through unchanged", async () => {
  const typed = SITE_MODES.map((m) => (m.name === "Chuyển khoản" ? { ...m, type: "Bank" } : m));
  const out = await resolvePaymentAccounts(siteMcp({ modes: typed }), {
    direction: "receive",
    invoice: "ACC-SINV-2026-01285",
    mode: "Chuyển khoản",
  });
  assert.equal(out.mode, "Chuyển khoản");
  assert.equal(out.paidTo, BANK_ACC);
  assert.equal(out.mode_warning, undefined, "no warning when the method's type agrees");
});
