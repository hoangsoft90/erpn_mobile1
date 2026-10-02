/**
 * next8 / Phase 3 — COLLECT: server validation + authoritative proposal.
 *
 * Pure-module suite (no server, no ERPNext, no NLP) pinning the money rules the
 * owner lock §6.1–6.5 fixes, plus the Phase 3 fixes measured in Phase 0:
 *   §5.1 READ: complete read + offset (the tool has no page 2); company scope;
 *             credit notes kept; `status` asked for;
 *   §5.2 draft-cover scoped to the company (a foreign company's draft must not
 *        lower this company's remainder);
 *   §5.3 builder: one reference row per allocation, explicit `unallocated_amount`,
 *        `paid_amount` = Σ allocated + unallocated;
 *   §5.4 the eight checks, each with its code + Vietnamese copy;
 *   §5.5 no more 422 for two valid invoices; the executor now WRITES a
 *        multi-reference proposal (Phase 4) — binding every allocation by the ID
 *        in `params.allocations[]`, never by a display name or `params.invoice`.
 */

import test from "node:test";
import assert from "node:assert/strict";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
process.env.COPILOT_MOCK_OK = "1";

import { listOpenSalesInvoices } from "../src/skills/sales.mjs";
import { PAYMENT_MODES } from "../src/transaction-draft.mjs";
import {
  buildCollectProposal,
  buildPaymentEntryData,
  channelOfMode,
  executePaymentProposal,
  listOpenDraftPaymentEntries,
  openDraftCover,
  resolvePaymentAccounts,
} from "../src/skills/payment-write.mjs";

const COMPANY = "Demo Feed Co";
const OTHER_COMPANY = "Other Co";

// ─────────────────────────────────────────────────────────────────────────────
// §5.1 — READ hoá đơn
// ─────────────────────────────────────────────────────────────────────────────
function siMcp(rows, { capture } = {}) {
  return {
    async callTool(tool, args) {
      assert.equal(tool, "erpnext_doc_list", `READ must use erpnext_doc_list, got ${tool}`);
      capture?.push(args);
      const filtered = rows.filter((r) =>
        (args.filters ?? []).every(([f, op, v]) => {
          assert.equal(op, "=", "the mock only serves = filters");
          return String(r[f] ?? "") === String(v ?? "");
        }),
      );
      const lim = args.limit ?? 20;
      return { data: { doctype: "Sales Invoice", count: filtered.length, data: lim === 0 ? filtered : filtered.slice(0, lim) } };
    },
  };
}

const siRow = (name, over = {}) => ({
  name,
  customer: "CUST-00001",
  company: COMPANY,
  posting_date: "2026-09-01",
  grand_total: 1_000_000,
  outstanding_amount: 1_000_000,
  docstatus: 1,
  ...over,
});

test("§5.1(a) only the resolved company's invoices are read (no silent widening)", async () => {
  const rows = [
    siRow("SINV-MINE"),
    siRow("SINV-OTHER", { company: OTHER_COMPANY }),
  ];
  const res = await listOpenSalesInvoices(siMcp(rows), { customerId: "CUST-00001", company: COMPANY });
  const names = res.data.data.map((r) => r.name);
  assert.deepEqual(names, ["SINV-MINE"], "another tenant's invoice must not appear");
});

test("§5.1: a credit note (negative outstanding) is KEPT as an open document", async () => {
  const rows = [siRow("SINV-CREDIT", { outstanding_amount: -320_000, is_return: 1 })];
  const res = await listOpenSalesInvoices(siMcp(rows), { customerId: "CUST-00001", company: COMPANY });
  assert.equal(res.data.data.length, 1);
  assert.equal(res.data.data[0].name, "SINV-CREDIT");
});

test("§5.1: a complete read asks the tool for `status` and no limit", async () => {
  const captured = [];
  await listOpenSalesInvoices(siMcp([siRow("SINV-A")], { capture: captured }), {
    customerId: "CUST-00001",
    company: COMPANY,
    complete: true,
  });
  assert.ok(captured[0].fields.includes("status"), "the read must carry `status`");
  assert.equal(captured[0].limit, 0, "a complete read asks for `limit: 0` (no limit)");
});

test("§5.1(c) a customer with more invoices than the screen shows reports the REAL total", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => siRow(`SINV-${String(i).padStart(3, "0")}`));
  const res = await listOpenSalesInvoices(siMcp(rows), {
    customerId: "CUST-00001",
    company: COMPANY,
    cap: 10,
    complete: true,
  });
  assert.equal(res.data.count, 10, "the page holds ten");
  assert.equal(res.data.matched, 25, "the total is the truth, not the page");
  assert.equal(res.data.truncated, true, "a bounded page says so");
});

test("§5.1(d) 179 invoices are read whole and an offset selects a later slice", async () => {
  const rows = Array.from({ length: 179 }, (_, i) => siRow(`SINV-${String(i).padStart(3, "0")}`));
  const first = await listOpenSalesInvoices(siMcp(rows), { customerId: "CUST-00001", company: COMPANY, cap: 10, complete: true });
  const later = await listOpenSalesInvoices(siMcp(rows), {
    customerId: "CUST-00001",
    company: COMPANY,
    cap: 10,
    complete: true,
    offset: 170,
  });
  assert.equal(first.data.matched, 179, "all 179 are read (no silent cut at 100)");
  assert.equal(later.data.matched, 179, "the matched total does not change with the offset");
  assert.equal(later.data.count, 9, "the last page holds the remaining nine");
  assert.equal(later.data.offset, 170);
  assert.equal(later.data.truncated, false, "the last page is not truncated");
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.2 — draft-cover scoped to the company
// ─────────────────────────────────────────────────────────────────────────────
function peerMcp(rows, docs = {}) {
  return {
    async callTool(tool, args) {
      assert.equal(tool, "erpnext_doc_list");
      const filtered = rows.filter((r) =>
        (args.filters ?? []).every(([f, op, v]) => String(r[f] ?? "") === String(v ?? "")),
      );
      // carry the shape the cover reader unwraps
      return { data: { doctype: "Payment Entry", count: filtered.length, data: filtered } };
    },
  };
}

const receptionDoc = (name, invoice, amount, company = COMPANY) => ({
  name,
  docstatus: 0,
  party: "CUST-00001",
  payment_type: "Receive",
  company,
});

test("§5.2 a draft of ANOTHER company does not lower this company's remainder", async () => {
  const rows = [receptionDoc("PE-OTHER", null, null, OTHER_COMPANY)];
  const res = await listOpenDraftPaymentEntries(peerMcp(rows), "CUST-00001", { company: COMPANY });
  assert.equal(res.data.data.length, 0, "the foreign-company draft is filtered out");
  const unscoped = await listOpenDraftPaymentEntries(peerMcp(rows), "CUST-00001");
  assert.equal(unscoped.data.data.length, 1, "without a company the historical behaviour is unchanged");
});

test("§5.2 openDraftCover counts same-company drafts and ignores the other company's", async () => {
  const docs = {
    "PE-MINE": [{ reference_doctype: "Sales Invoice", reference_name: "SINV-0001", allocated_amount: 1_000_000 }],
    "PE-OTHER": [{ reference_doctype: "Sales Invoice", reference_name: "SINV-0001", allocated_amount: 900_000 }],
  };
  const reads = {
    listOpenDraftPaymentEntries: async (pid, opts) => {
      const all = [receptionDoc("PE-MINE"), receptionDoc("PE-OTHER", null, null, OTHER_COMPANY)];
      return { data: { data: all.filter((d) => !opts?.company || d.company === opts.company) } };
    },
    getPaymentEntryDoc: async (n) => ({ data: docs[n] ? { name: n, references: docs[n] } : { name: n, references: [] } }),
  };
  const scoped = await openDraftCover(reads, "CUST-00001", "receive", { company: COMPANY });
  assert.equal(scoped.drawn.get("SINV-0001"), 1_000_000, "only this company's draft covers the invoice");
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.3/§5.5 — buildCollectProposal
// ─────────────────────────────────────────────────────────────────────────────
function skillsBag({ invoices = [], drafts = [], docs = {} } = {}) {
  return {
    listUnpaidInvoices: async () => ({ data: { doctype: "Sales Invoice", data: invoices } }),
    listOpenDraftPaymentEntries: async () => ({ data: { doctype: "Payment Entry", data: drafts } }),
    getPaymentEntryDoc: async (n) => ({ data: { name: n, references: docs[n] ?? [] } }),
  };
}

const CUSTOMER = { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" };
const twoInvoices = () => [
  { name: "SINV-A", posting_date: "2026-09-01", grand_total: 2_000_000, outstanding_amount: 1_000_000 },
  { name: "SINV-B", posting_date: "2026-09-05", grand_total: 500_000, outstanding_amount: 500_000 },
];

test("§5.5 two valid invoices produce one proposal with two allocations (no 422)", async () => {
  const built = await buildCollectProposal(skillsBag({ invoices: twoInvoices() }), {
    customer: CUSTOMER,
    allocations: [
      { invoice_id: "SINV-A", allocated_amount: 700_000 },
      { invoice_id: "SINV-B", allocated_amount: 500_000 },
    ],
    method: { mode: "cash", amount: 1_200_000, account_id: "1110 - Cash - DFC" },
    company: COMPANY,
    handoffId: "h-1",
  });
  assert.equal(built.proposal.params.allocations.length, 2);
  assert.equal(built.proposal.params.amount_vnd, 1_200_000);
  assert.equal(built.proposal.params.unallocated_vnd, 0);
  assert.equal(built.proposal.params.payment_methods.length, 1, "lock §6.1: exactly one method");
  assert.equal(built.proposal.handoff_id, "h-1", "the ticket id travels on the proposal");
  assert.equal(built.proposal.risk, "HIGH");
});

test("§5.5(c) a mismatch between allocations and the payment total is refused", async () => {
  await assert.rejects(
    buildCollectProposal(skillsBag({ invoices: twoInvoices() }), {
      customer: CUSTOMER,
      allocations: [
        { invoice_id: "SINV-A", allocated_amount: 700_000 },
        { invoice_id: "SINV-B", allocated_amount: 500_000 },
      ],
      method: { mode: "cash", amount: 1_000_000 },
      company: COMPANY,
    }),
    (err) => err.code === "ALLOCATION_TOTAL_MISMATCH",
  );
});

test("§5.5 an advance (nothing open) is legal with an empty allocation list + unallocated", async () => {
  const built = await buildCollectProposal(skillsBag({ invoices: [] }), {
    customer: CUSTOMER,
    allocations: [],
    method: { mode: "cash", amount: 300_000 },
    company: COMPANY,
  });
  assert.equal(built.proposal.params.allocations.length, 0);
  assert.equal(built.proposal.params.unallocated_vnd, 300_000);
  assert.equal(built.proposal.params.amount_vnd, 300_000);
});

test("§5.4 #4 an allocation over the live remainder is refused", async () => {
  await assert.rejects(
    buildCollectProposal(skillsBag({ invoices: twoInvoices() }), {
      customer: CUSTOMER,
      allocations: [{ invoice_id: "SINV-A", allocated_amount: 2_000_000 }],
      method: { mode: "cash", amount: 2_000_000 },
      company: COMPANY,
    }),
    (err) => err.code === "INSUFFICIENT_OUTSTANDING" && /vượt quá/.test(err.message),
  );
});

test("§5.4 #4 the same invoice twice is a DUPLICATE_ALLOCATION", async () => {
  await assert.rejects(
    buildCollectProposal(skillsBag({ invoices: twoInvoices() }), {
      customer: CUSTOMER,
      allocations: [
        { invoice_id: "SINV-A", allocated_amount: 400_000 },
        { invoice_id: "SINV-A", allocated_amount: 400_000 },
      ],
      method: { mode: "cash", amount: 800_000 },
      company: COMPANY,
    }),
    (err) => err.code === "DUPLICATE_ALLOCATION",
  );
});

test("§5.4 #3 an invoice fully covered by an open draft is INVOICE_ALREADY_PAID", async () => {
  const docs = { "PE-M": [{ reference_doctype: "Sales Invoice", reference_name: "SINV-A", allocated_amount: 1_000_000 }] };
  await assert.rejects(
    buildCollectProposal(
      skillsBag({ invoices: [twoInvoices()[0]], drafts: [receptionDoc("PE-M")], docs }),
      {
        customer: CUSTOMER,
        allocations: [{ invoice_id: "SINV-A", allocated_amount: 100_000 }],
        method: { mode: "cash", amount: 100_000 },
        company: COMPANY,
      },
    ),
    (err) => err.code === "INVOICE_ALREADY_PAID" && /NHÁP/.test(err.message),
  );
});

test("§5.4 #2 an invoice of another customer is NO_MATCH", async () => {
  await assert.rejects(
    buildCollectProposal(skillsBag({ invoices: twoInvoices() }), {
      customer: CUSTOMER,
      allocations: [{ invoice_id: "SINV-NOT-MINE", allocated_amount: 100_000 }],
      method: { mode: "cash", amount: 100_000 },
      company: COMPANY,
    }),
    (err) => err.code === "NO_MATCH",
  );
});

test("§5.4 #5 open invoices with an empty allocation list is MISSING_REQUIRED_FIELD", async () => {
  await assert.rejects(
    buildCollectProposal(skillsBag({ invoices: twoInvoices() }), {
      customer: CUSTOMER,
      allocations: [],
      method: { mode: "cash", amount: 100_000 },
      company: COMPANY,
    }),
    (err) => err.code === "MISSING_REQUIRED_FIELD" && /không tự chọn/.test(err.message),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.3 — buildPaymentEntryData: one reference per allocation, explicit unallocated
// ─────────────────────────────────────────────────────────────────────────────
test("§5.3 a payment entry carries one reference row per allocation and a zero difference", () => {
  const data = buildPaymentEntryData({
    direction: "receive",
    partyId: "CUST-00001",
    paid: 1_300_000,
    commandId: "cmd-1",
    actionId: "act-1",
    mode: "cash",
    company: COMPANY,
    paidFrom: "1310 - Debtors - DFC",
    paidTo: "1110 - Cash - DFC",
    postingDate: "2026-09-30",
    references: [
      { reference_name: "SINV-A", total_amount: 2_000_000, outstanding_amount: 1_000_000, allocated_amount: 700_000 },
      { reference_name: "SINV-B", total_amount: 500_000, outstanding_amount: 500_000, allocated_amount: 500_000 },
    ],
    unallocated: 100_000,
  });
  assert.equal(data.references.length, 2, "one row per allocation");
  assert.equal(data.paid_amount, 1_300_000, "Σ allocated + unallocated");
  assert.equal(data.received_amount, 1_300_000);
  assert.equal(data.unallocated_amount, 100_000, "the unallocated part is written explicitly");
});

test("§5.3 an advance has no reference row and the whole amount is unallocated", () => {
  const data = buildPaymentEntryData({
    direction: "receive",
    partyId: "CUST-00001",
    paid: 300_000,
    commandId: "cmd-2",
    actionId: "act-2",
    mode: "cash",
    company: COMPANY,
    paidFrom: "1310 - Debtors - DFC",
    paidTo: "1110 - Cash - DFC",
    postingDate: "2026-09-30",
    references: [],
    unallocated: 300_000,
  });
  assert.equal(data.references.length, 0);
  assert.equal(data.unallocated_amount, 300_000);
  assert.equal(data.paid_amount, 300_000);
});

test("§5.3 the single-invoice shorthand still produces exactly one row (chat unchanged)", () => {
  const data = buildPaymentEntryData({
    direction: "receive",
    customerId: "CUST-00001",
    paid: 500_000,
    commandId: "cmd-3",
    actionId: "act-3",
    mode: "Tiền mặt",
    invoice: "SINV-0001",
    invoiceTotal: 2_500_000,
    invoiceOutstanding: 2_500_000,
    company: COMPANY,
    paidFrom: "1310 - Debtors - DFC",
    paidTo: "1110 - Cash - DFC",
    postingDate: "2026-09-30",
  });
  assert.equal(data.references.length, 1);
  assert.equal(data.references[0].reference_name, "SINV-0001");
  assert.equal(data.paid_amount, 500_000);
  assert.equal(data.unallocated_amount, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.3/§5.4 #7 — resolvePaymentAccounts (owner lock §6.2)
// ─────────────────────────────────────────────────────────────────────────────
function accountMcp({ defaults = { cash: "1110 - Cash - DFC", bank: "1120 - Bank - DFC" }, accounts } = {}) {
  const ACC = accounts ?? [
    { name: "1000 - Cash - DFC", is_group: 1, account_type: null, company: COMPANY },
    { name: "1110 - Cash - DFC", is_group: 0, account_type: "Cash", company: COMPANY },
    { name: "1120 - Bank - DFC", is_group: 0, account_type: "Bank", company: COMPANY },
    { name: "9999 - Other Co Cash", is_group: 0, account_type: "Cash", company: OTHER_COMPANY },
  ];
  return {
    async callTool(tool, args) {
      if (tool === "erpnext_doc_get" && args.doctype === "Sales Invoice") {
        return { data: { name: args.name, company: COMPANY, debit_to: "1310 - Debtors - DFC" } };
      }
      if (tool === "erpnext_doc_list" && args.doctype === "Mode of Payment") {
        return { data: [{ name: "Cash", enabled: 1, type: "Cash" }, { name: "Chuyển khoản", enabled: 1, type: "Bank" }] };
      }
      if (tool === "erpnext_account_list") {
        return { data: ACC };
      }
      if (tool === "erpnext_doc_get" && args.doctype === "Company") {
        return { data: { name: COMPANY, default_cash_account: defaults.cash, default_bank_account: defaults.bank } };
      }
      throw new Error(`unexpected tool ${tool} ${args?.doctype ?? ""}`);
    },
  };
}

test("§6.2 a cash method with no explicit account uses the company's CASH default", async () => {
  const out = await resolvePaymentAccounts(accountMcp(), { direction: "receive", invoice: "SINV-0001", mode: "Tiền mặt" });
  assert.equal(out.paidTo, "1110 - Cash - DFC");
  assert.equal(out.channel, "cash");
  assert.equal(out.account_type, "Cash");
});

test("§6.2 a bank method resolves to the BANK default, never the cash ledger", async () => {
  const out = await resolvePaymentAccounts(accountMcp(), { direction: "receive", invoice: "SINV-0001", mode: "Chuyển khoản" });
  assert.equal(out.paidTo, "1120 - Bank - DFC");
  assert.equal(out.channel, "bank_transfer");
});

test("§5.4 #7 a wrong-typed account is ACCOUNT_TYPE_MISMATCH, never substituted", async () => {
  await assert.rejects(
    resolvePaymentAccounts(accountMcp(), { direction: "receive", invoice: "SINV-0001", mode: "cash", account: "1120 - Bank - DFC" }),
    (err) => err.code === "ACCOUNT_TYPE_MISMATCH" && /không khớp/.test(err.message),
  );
});

test("§5.4 #7 an account of another company cannot be used", async () => {
  await assert.rejects(
    resolvePaymentAccounts(accountMcp(), { direction: "receive", invoice: "SINV-0001", mode: "cash", account: "9999 - Other Co Cash" }),
    (err) => err.code === "PAYMENT_ACCOUNT_UNRESOLVED",
  );
});

test("§6.2 with no explicit account and no matching default the answer is BLOCK", async () => {
  await assert.rejects(
    resolvePaymentAccounts(accountMcp({ defaults: { cash: null, bank: null } }), { direction: "receive", invoice: "SINV-0001", mode: "cash" }),
    (err) => err.code === "PAYMENT_ACCOUNT_UNRESOLVED",
  );
});

test("§6.2 a bank intent cannot be satisfied by a Cash-type account (the removed fallback)", async () => {
  // A site whose only money account is Cash: a bank intent must BLOCK, not post
  // into the cash ledger (the exact bug lock §6.2 names).
  const onlyCash = [{ name: "1110 - Cash - DFC", is_group: 0, account_type: "Cash", company: COMPANY }];
  await assert.rejects(
    resolvePaymentAccounts(accountMcp({ defaults: { cash: "1110 - Cash - DFC", bank: null }, accounts: onlyCash }), {
      direction: "receive",
      invoice: "SINV-0001",
      mode: "bank_transfer",
    }),
    (err) => err.code === "PAYMENT_ACCOUNT_UNRESOLVED",
  );
});

test("§6.1 every draft mode token has a money channel (the two tables cannot drift)", () => {
  // `transaction-draft.PAYMENT_MODES` decides which tokens a client may send;
  // `MONEY_CHANNELS` decides which ledger type pays for them. A token added to
  // one without the other would silently resolve to the OTHER channel's ledger
  // (the account branch falls through to bank) — that is a wrong-ledger write.
  for (const mode of PAYMENT_MODES) {
    assert.ok(channelOfMode(mode), `${mode} must map to a channel`);
  }
});

test("channelOfMode maps the draft tokens and the Vietnamese labels, and refuses the rest", () => {
  assert.equal(channelOfMode("cash"), "cash");
  assert.equal(channelOfMode("bank_transfer"), "bank_transfer");
  assert.equal(channelOfMode("Tiền mặt"), "cash");
  assert.equal(channelOfMode("Chuyển khoản"), "bank_transfer");
  assert.equal(channelOfMode("ví điện tử"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5.5 boundary — the executor binds every allocation BY ID (Phase 4)
// ─────────────────────────────────────────────────────────────────────────────
// The Phase 3 `PAYMENT_MULTI_REFERENCE_NOT_READY` refusal is gone (Phase 4 writes
// multi-reference receipts), but the boundary it protected has not moved: the
// executor must settle exactly the invoices the PROPOSAL carried, by their ids,
// and never fall back to `params.invoice` (a legacy single-anchor key that now
// travels with the FIRST allocation). A fallback there is F4's mutation — the
// name/key path re-binds a different invoice at the last moment.
test("§5.5 the executor reads its anchors by allocation ID, never by `params.invoice`", async () => {
  const mcp = {
    calls: [],
    async callTool(tool, args) {
      this.calls.push({ tool, args });
      // The legacy single-anchor list read answers "nothing open" — which the
      // allocation branch does not consult for its anchors (each is read by id).
      if (tool === "erpnext_sales_invoice_list") return { data: { doctype: "Sales Invoice", data: [] } };
      throw new Error("only the anchor reads are expected before this test stops");
    },
    async callWriteTool() {
      throw new Error("no write may happen once an anchor read failed");
    },
  };
  const proposal = {
    action: "create_payment_entry",
    entity: { kind: "customer", id: "CUST-00001" },
    params: {
      amount_vnd: 1_200_000,
      // A DISPLAY value, deliberately not a document name: reading this would be
      // the F4 bug (re-binding by a name the client sent).
      invoice: "TÊN-HIỂN-THỊ-KHÔNG-PHẢI-MÃ",
      allocations: [
        { invoice_id: "SINV-A", allocated_amount: 700_000 },
        { invoice_id: "SINV-B", allocated_amount: 500_000 },
      ],
    },
  };
  await assert.rejects(
    executePaymentProposal(mcp, proposal, "cmd-multi", { setReference() {}, complete() {} }),
    // The first anchor read throws, and an unreadable document is an outage —
    // never "the debt is gone".
    (err) => err.code === "PAYMENT_ERP_UNAVAILABLE",
  );
  const anchorReads = mcp.calls.filter((c) => c.tool === "erpnext_doc_get" && c.args?.doctype === "Sales Invoice");
  assert.equal(anchorReads.length, 1, "the FIRST allocation is the one read first");
  assert.equal(anchorReads[0].args.name, "SINV-A", "read by the id in allocations[]");
  assert.notEqual(anchorReads[0].args.name, proposal.params.invoice, "never by the legacy display key");
});
