/**
 * P9-C — `payment.create` learns the PAY direction (chi tiền NCC), plan
 * `.plan/next1/p9_prompts.md` P9-C + user decision 2026-09-23.
 *
 * What this file proves, in the order the risk appears:
 *
 *  1. §0 MEASURED MISROUTE, closed: before this phase, Phase 1's synonym map
 *     rewrote BOTH "thu tiền" and "trả tiền" to the one label "payment", and
 *     `payment-write.mjs` was hardcoded Receive/Customer/Sales Invoice — so a
 *     pay-out order reached the COLLECT path. The direction now comes from which
 *     master list holds the party, never from the sentence and never from the
 *     request body.
 *  2. THE SENTENCE CANNOT FLIP THE DATA: an unambiguous verb conflicting with the
 *     master-derived direction refuses (PAYMENT_DIRECTION_CONFLICT) — "thu tiền
 *     của Hà Tiên" does not become a pay-out just because Hà Tiên is a supplier.
 *  3. NO PARTY ⇒ NO CARD, with the reason spelled out for store EXPENSES
 *     ("chi xăng 200 nghìn") — a Payment Entry always needs a party and a
 *     Journal Entry is out of scope, so that is a refusal, not a guessed doc.
 *  4. FALSE WRITES: no confirm ⇒ 0; duplicate command_id ⇒ ONE doc; a crafted
 *     `kind: "supplier"` on a customer id ⇒ refused before any write.
 *  5. REGRESSION: the Receive path is untouched (same fields, same accounts) and
 *     the pay-history question stays a READ.
 *  6. FIXED FALSE POSITIVE (measured 2026-09-24): a 2-character span taken from
 *     an ordinary VERB ("xử lý" → "lý") must not resolve a supplier whose name
 *     merely CONTAINS it — that turned a legitimate pay-out into
 *     PAYMENT_DIRECTION_AMBIGUOUS. The residual exact-2-character case is pinned
 *     as a known trade-off, not left implicit.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");

import { __contract, executableWriteActions, getCapability, writeDoctypes } from "../src/capability-contract.mjs";
import {
  buildPaymentProposal,
  verbDirection,
  shopDay,
  verifyWrittenPayment,
  DRAFT_PAYMENT_LOOKUP_LIMIT,
  listOpenDraftPaymentEntries,
  getPaymentEntryDoc,
} from "../src/skills/payment-write.mjs";
import { listUnpaidInvoices } from "../src/skills/sales.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";
import { routeIntent } from "../src/router.mjs";

/* --------------------------------------------------------------- fixtures -- */

const SUPPLIER = { name: "SUP-HATIEN", supplier_name: "Hà Tiên" };
const CUSTOMER = { name: "CUST-00001", customer_name: "Nguyễn Thị Lan" };

/** Mirrors the mock's PAYABLE_INVOICES: one settled row that must never be targeted. */
const PIS = [
  { name: "PINV-0001", supplier: "SUP-HATIEN", posting_date: "2026-09-02", grand_total: 12_000_000, outstanding_amount: 5_000_000 },
  { name: "PINV-0002", supplier: "SUP-HATIEN", posting_date: "2026-09-07", grand_total: 3_000_000, outstanding_amount: 0 },
];
const SIS = [
  { name: "SINV-0001", customer: "CUST-00001", posting_date: "2026-09-01", grand_total: 10_500_000, outstanding_amount: 2_500_000 },
];

/**
 * A skills bag with the reads the builder uses + a write spy that never fires.
 *
 * P9-D added two reads to the builder (`listOpenDraftPaymentEntries` for the
 * open-DRAFT Payment Entries of one party, `getPaymentEntryDoc` for each one's
 * `references`). They are stubbed HERE, defaulting to "no drafts", because every
 * builder test must exercise the real cover maths — passing `drafts` + `docs` is
 * how a test plants a live draft.
 */
function fakeSkills({ invoices = PIS, salesInvoices = SIS, counts, drafts = [], docs = {} } = {}) {
  const spy = counts ?? { reads: 0, writes: 0 };
  return {
    spy,
    listOpenPurchaseInvoices: async () => {
      spy.reads += 1;
      return { data: { doctype: "Purchase Invoice", data: invoices } };
    },
    listUnpaidInvoices: async () => {
      spy.reads += 1;
      return { data: { doctype: "Sales Invoice", data: salesInvoices } };
    },
    listOpenDraftPaymentEntries: async () => {
      spy.draftReads = (spy.draftReads ?? 0) + 1;
      return { data: { doctype: "Payment Entry", data: drafts } };
    },
    getPaymentEntryDoc: async (name) => {
      spy.docReads = (spy.docReads ?? 0) + 1;
      if (!docs[name]) throw new Error(`unexpected draft read: ${name}`);
      return { data: { data: docs[name] } };
    },
    callWriteTool: async () => {
      spy.writes += 1;
      throw new Error("the builder must never write");
    },
  };
}

/** P9-D — a live DRAFT Payment Entry row as `erpnext_doc_list` returns it. */
function draftRow({ name = "PE-M901", party = "CUST-00001", payment_type = "Receive", paid_amount = 1_000_000 } = {}) {
  return { name, docstatus: 0, party, payment_type, paid_amount, reference_no: "cmd-draft-1" };
}

/** P9-D — the same draft as `erpnext_doc_get` returns it (with its allocations). */
function draftDoc({ name = "PE-M901", invoice = "SINV-0001", allocated = 1_000_000, doctype = "Sales Invoice" } = {}) {
  return { name, docstatus: 0, references: [{ reference_doctype: doctype, reference_name: invoice, allocated_amount: allocated }] };
}

async function refusal(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err?.code, code, `expected ${code}, got ${err?.code}: ${err?.message}`);
    assert.ok(String(err?.message ?? "").length > 0, "a refusal must explain itself");
    return true;
  });
}

/* ---------------------------------------------- 1. contract + write path -- */

test("P9-C contract: payment.create declares the direction policy and the party slot", () => {
  const cap = getCapability("payment.create");
  assert.equal(cap.type, "WRITE");
  assert.equal(cap.risk.level, "HIGH");
  assert.equal(cap.risk.requires_confirmation, true);
  // The required slot is a resolved PARTY (either master), not a customer — the
  // same capability now records both directions.
  assert.deepEqual(cap.entities.required, ["party", "amount"]);
  assert.ok(cap.direction_policy, "the direction policy must be declared, not implied");
  assert.match(cap.direction_policy.rule, /Supplier ONLY => pay/);
  assert.match(cap.direction_policy.client_may_not_set, /executor ignores it/);
  for (const code of [
    "PAYMENT_DIRECTION_AMBIGUOUS",
    "PAYMENT_DIRECTION_CONFLICT",
    "PAYMENT_SUPPLIER_NO_OPEN_INVOICE",
    "PAYMENT_EXPENSE_WITHOUT_PARTY",
  ]) {
    assert.ok(cap.errors.includes(code), `${code} must be declared`);
  }
  assert.ok(writeDoctypes()["Payment Entry"], "Payment Entry stays the only write doctype here");
  assert.ok(executableWriteActions().includes("create_payment_entry"));
  // Direction is NOT a new capability: one capability still owns the action.
  assert.equal(
    Object.values(__contract.capabilities ?? __contract).filter(
      (c) => c && typeof c === "object" && c.proposal_action === "create_payment_entry",
    ).length,
    1,
  );
});

test("P9-C verb markers: only the UNAMBIGUOUS verbs carry a direction", () => {
  assert.equal(verbDirection("chi xăng 200 nghìn"), "pay");
  assert.equal(verbDirection("chi cho Hà Tiên 2 triệu"), "pay");
  assert.equal(verbDirection("thu tiền của Lan 2 triệu"), "receive");
  assert.equal(verbDirection("nhận tiền từ Lan"), "receive");
  // Deliberately null: in Vietnamese both are used for either direction, so they
  // must not constrain anything (that is what keeps the Receive path working).
  assert.equal(verbDirection("trả tiền NCC Hà Tiên 2 triệu"), null);
  assert.equal(verbDirection("thanh toán hóa đơn mua cho Hà Tiên"), null);
  // Words that merely start with "chi".
  assert.equal(verbDirection("chi tiết đơn hàng của Lan"), null);
  assert.equal(verbDirection("chi nhánh miền tây"), null);
});

/* ------------------------------------------------- 2. builder (proposal) -- */

test("P9-C builder: a SUPPLIER party builds a PAY proposal against the oldest open Purchase Invoice", async () => {
  const skills = fakeSkills();
  const built = await buildPaymentProposal(
    skills,
    { supplier: SUPPLIER, ambiguous: false, candidates: [] },
    { amount_vnd: 2_000_000, requireExplicitAmount: true },
  );
  assert.equal(built.proposal.entity.kind, "supplier", "the party kind is what the executor re-derives from");
  assert.equal(built.proposal.entity.id, "SUP-HATIEN");
  assert.equal(built.proposal.params.direction, "pay");
  assert.equal(built.proposal.params.invoice, "PINV-0001", "the SETTLED PINV-0002 must never be targeted");
  assert.equal(built.proposal.params.outstanding_vnd, 5_000_000);
  assert.equal(built.proposal.params.amount_vnd, 2_000_000);
  assert.equal(built.proposal.risk, "HIGH");
  assert.equal(built.proposal.need_confirm, true);
  assert.match(built.proposal.summary, /^Chi /);
  assert.equal(skills.spy.writes, 0, "building a proposal never writes");
});

test("P9-C builder: a CUSTOMER party still builds the Receive proposal it always did", async () => {
  const built = await buildPaymentProposal(
    fakeSkills(),
    { customer: CUSTOMER, ambiguous: false, candidates: [] },
    { amount_vnd: 2_500_000, requireExplicitAmount: true },
  );
  assert.equal(built.proposal.entity.kind, "customer");
  assert.equal(built.proposal.params.direction, "receive");
  assert.equal(built.proposal.params.invoice, "SINV-0001");
  assert.match(built.proposal.summary, /^Thu /);
});

test("P9-C builder: the sentence may CONTRADICT the data, never flip it", async () => {
  // Hà Tiên is a supplier ⇒ direction "pay"; the user said "thu tiền".
  await refusal(
    buildPaymentProposal(
      fakeSkills(),
      { supplier: SUPPLIER, ambiguous: false, candidates: [] },
      { amount_vnd: 2_000_000, requireExplicitAmount: true, raw_text: "thu tiền của Hà Tiên 2 triệu" },
    ),
    "PAYMENT_DIRECTION_CONFLICT",
  );
  // The agreeing case passes.
  const ok = await buildPaymentProposal(
    fakeSkills(),
    { supplier: SUPPLIER, ambiguous: false, candidates: [] },
    { amount_vnd: 2_000_000, requireExplicitAmount: true, raw_text: "chi cho Hà Tiên 2 triệu" },
  );
  assert.equal(ok.proposal.params.direction, "pay");
});

test("P9-C builder: a supplier with NO open invoice refuses instead of writing an advance", async () => {
  await refusal(
    buildPaymentProposal(
      fakeSkills({ invoices: [{ ...PIS[1] }] }), // only the settled row
      { supplier: SUPPLIER, ambiguous: false, candidates: [] },
      { amount_vnd: 1_000_000, requireExplicitAmount: true },
    ),
    "PAYMENT_SUPPLIER_NO_OPEN_INVOICE",
  );
});

test("P9-C builder: the pay path keeps the amount rules (no number ⇒ refuse; over-debt ⇒ clamp + warn)", async () => {
  await refusal(
    buildPaymentProposal(fakeSkills(), { supplier: SUPPLIER, ambiguous: false, candidates: [] }, { requireExplicitAmount: true }),
    "PAYMENT_AMOUNT_MISSING",
  );
  const built = await buildPaymentProposal(
    fakeSkills(),
    { supplier: SUPPLIER, ambiguous: false, candidates: [] },
    { amount_vnd: 9_000_000, requireExplicitAmount: true },
  );
  assert.equal(built.proposal.params.amount_vnd, 5_000_000, "clamped to the live outstanding");
  assert.equal(built.proposal.params.amount_source, "explicit");
  assert.ok(built.warnings.some((w) => /kẹp|vượt/.test(w)), JSON.stringify(built.warnings));
});

test("P9-C builder: no party at all refuses (neither master held the name)", async () => {
  await refusal(
    buildPaymentProposal(fakeSkills(), { ambiguous: false, candidates: [] }, { amount_vnd: 1_000_000 }),
    "PAYMENT_CUSTOMER_UNRESOLVED",
  );
});

/* --------------------------------------------------------------- 3. routing -- */

test("P9-C routing: pay commands reach payment.create; pay-history questions stay READS", () => {
  // routeIntent takes the NORMALIZED text (Phase 1 output) — this is the seam the
  // pipeline calls it through, so the fixtures below are the post-synonym forms.
  const COMMANDS = [
    "payment NCC Hà Tiên 2 triệu", // "trả tiền NCC Hà Tiên 2 triệu"
    "payment hóa đơn mua cho Hà Tiên 2 triệu", // "thanh toán hóa đơn mua …"
    "chi xăng 200 nghìn",
    "chi tiền mặt 500 nghìn",
    "chi 2 triệu trả NCC Hà Tiên",
    "payment của Lan 2 triệu", // "thu tiền của Lan 2 triệu"
  ];
  for (const t of COMMANDS) {
    const hit = routeIntent(t);
    assert.equal(hit?.capability, "payment.create", `${t} → ${hit?.capability}`);
    assert.equal(hit?.group, "payment_write", t);
  }
  // A QUESTION about money already paid out is a READ — it must not build a card.
  for (const t of ["đã chi cho Hà Tiên bao nhiêu", "lịch sử chi tiền của Hà Tiên", "đã trả cho Lan gần nhất"]) {
    const hit = routeIntent(t);
    assert.equal(hit?.capability, "payment.history", `${t} → ${hit?.capability}`);
    assert.notEqual(hit?.group, "payment_write", `"${t}" must not open a card`);
  }
  // The new "chi " keyword must not swallow words that merely start with it.
  for (const t of ["chi tiết đơn hàng của Lan", "chi nhánh miền tây"]) {
    assert.notEqual(routeIntent(t)?.capability, "payment.create", `"${t}" must not open a card`);
  }
  // startsWith + notIf travel together: without the deny-list the write group
  // would catch its own history questions.
  const routingList = (__contract?.routing ?? []).routing ?? __contract?.routing ?? [];
  const g = routingList.find((x) => x.group === "payment_write");
  assert.equal(g.startsWith, true);
  assert.match(g.notIf, /bao nhiêu|chi tiết/);
});

/* ------------------------------------------------ 4. executor + no-write -- */

function stateRows(key) {
  const file = process.env.MOCK_ERP_STATE;
  if (!file || !existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8"))[key] ?? [];
  } catch {
    return [];
  }
}

/**
 * Payments written by THIS run. The mock's ledger is seeded with PE-0001 (a
 * fixture row), and `saveState()` persists the whole array — so "how many rows"
 * is only a valid write-count if the seed is filtered out. (Cost me one red
 * suite: the seeded row made posting_date/payment_type assertions read the
 * fixture instead of the document under test.)
 */
function writtenPayments() {
  return stateRows("payments").filter((r) => /^PE-M/.test(String(r.name ?? "")));
}

/** The full write path: /execute over HTTP → Safety Gateway → executor → mock. */
async function withExecuteServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "p9c-pay-"));
  const prevState = process.env.MOCK_ERP_STATE;
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  let server = null;
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const post = async (body) => {
      const r = await fetch(`http://127.0.0.1:${port}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    const pay = (
      await buildPaymentProposal(fakeSkills(), { supplier: SUPPLIER, ambiguous: false, candidates: [] }, {
        amount_vnd: 2_000_000,
        requireExplicitAmount: true,
      })
    ).proposal;
    const receive = (
      await buildPaymentProposal(fakeSkills(), { customer: CUSTOMER, ambiguous: false, candidates: [] }, {
        amount_vnd: 2_500_000,
        requireExplicitAmount: true,
      })
    ).proposal;
    return await fn({ post, store, pay, receive });
  } finally {
    server?.close();
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P9-C E2E /execute: a confirmed PAY writes ONE DRAFT Payment Entry, money account → payable", async () => {
  await withExecuteServer(async ({ post, pay }) => {
    const cid = randomUUID();
    const r = await post({ command_id: cid, proposal: pay });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.docstatus, 0, "a chat write is ALWAYS a draft");
    assert.equal(r.body.result.direction, "pay");
    assert.equal(r.body.result.party_kind, "supplier");
    assert.match(r.body.result.note, /NHÁP/);

    const rows = writtenPayments();
    assert.equal(rows.length, 1, "exactly one document");
    const doc = rows[0];
    assert.equal(doc.payment_type, "Pay", "the direction the misroute used to get wrong");
    assert.equal(doc.party_type, "Supplier");
    assert.equal(doc.party, "SUP-HATIEN");
    assert.equal(doc.paid_amount, 2_000_000);
    // Pay out: money LEAVES the cash account and SETTLES the payable — the sides
    // the recipes skill warns are easy to swap.
    assert.equal(doc.paid_from, "1110 - Cash - DFC");
    assert.equal(doc.paid_to, "2110 - Payable - DFC");
    assert.equal(doc.references.length, 1);
    assert.equal(doc.references[0].reference_doctype, "Purchase Invoice");
    assert.equal(doc.references[0].reference_name, "PINV-0001");
    assert.equal(doc.references[0].allocated_amount, 2_000_000);
    assert.equal(doc.docstatus, 0, "never submitted from chat");
    assert.equal(getCapability("payment.create").execution.allow_submit, true, "submit stays an explicit opt-in setting");
  });
});

test("P9-C verify: the read-back PROVES the direction — the other side of the same party id fails", async () => {
  // The direction only became a variable in P9-C, and `party` reads the SAME
  // string on both sides (the party id we sent), so before this the read-back
  // accepted a Receive for a pay-out whenever the amount matched: an ERPNext
  // that wrote the other side would have been reported as a clean write.
  const payDoc = {
    name: "PE-PAY-1",
    reference_no: "cmd-1",
    paid_amount: 2_000_000,
    party: "SUP-HATIEN",
    payment_type: "Pay",
    party_type: "Supplier",
  };
  const mcpOf = (doc) => ({ callTool: async () => ({ data: { data: doc } }) });
  const args = { commandId: "cmd-1", paid: 2_000_000, customerId: "SUP-HATIEN" };

  const ok = await verifyWrittenPayment(mcpOf(payDoc), "PE-PAY-1", { ...args, direction: "pay" });
  assert.equal(ok.name, "PE-PAY-1");

  await assert.rejects(
    () => verifyWrittenPayment(mcpOf(payDoc), "PE-PAY-1", { ...args, direction: "receive" }),
    (err) => err.code === "PAYMENT_WRITE_UNVERIFIED" && /payment_type=Pay/.test(err.message),
    "a document on the wrong side must not pass as verified",
  );
  // A caller that does not state a direction keeps the old behaviour (this is
  // an ADDED check, not a redefinition of the ones already asserting shape).
  const legacy = await verifyWrittenPayment(mcpOf(payDoc), "PE-PAY-1", args);
  assert.equal(legacy.name, "PE-PAY-1");
});

test("P9-C E2E /execute: a duplicate command_id REPLAYS — one document, one write", async () => {
  await withExecuteServer(async ({ post, pay }) => {
    const cid = randomUUID();
    const first = await post({ command_id: cid, proposal: pay });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await post({ command_id: cid, proposal: pay });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replay, true);
    assert.equal(again.body.result.erpnext_doc, first.body.result.erpnext_doc);
    assert.equal(writtenPayments().length, 1, "a second press never writes a second phiếu chi");
  });
});

test("P9-C E2E /execute CHAOS: a LOST RESPONSE after a pay-out reconciles instead of paying twice", async () => {
  await withExecuteServer(async ({ post, pay, store }) => {
    const cid = randomUUID();
    process.env.MOCK_ERP_FAIL_AFTER_WRITE = "1";
    let first;
    try {
      first = await post({ command_id: cid, proposal: pay });
    } finally {
      delete process.env.MOCK_ERP_FAIL_AFTER_WRITE;
    }
    assert.equal(first.status, 503, JSON.stringify(first.body));
    assert.equal(writtenPayments().length, 1, "it did land — only the response was lost");
    assert.equal(store.status(cid).status, "PENDING");

    const retry = await post({ command_id: cid, proposal: pay });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.reconciled, true, JSON.stringify(retry.body));
    assert.equal(retry.body.result.direction, "pay", "a reconciled pay-out must still say which way the money went");
    assert.equal(writtenPayments().length, 1, "NO second payment");
  });
});

test("P4 E2E /execute: submit_now ON + a LOST SUBMIT RESPONSE → 503 retry-same-id, then reconcile reports docstatus 1 with ONE PHIẾU THU", async () => {
  // PROMPT-4. The create side already reconciles (P9-C CHAOS above). This is its
  // submit-side twin: ERPNext APPLIES the submit but the reply is lost, so the
  // caller cannot assume "not submitted". The command must stay reconcile-able
  // and the retry must report the REAL docstatus from a fresh READ — never a
  // second Payment Entry, never a fabricated "draft".
  await withExecuteServer(async ({ post, store }) => {
    const cid = randomUUID();
    const receiveSubmit = (
      await buildPaymentProposal(fakeSkills(), { customer: CUSTOMER, ambiguous: false, candidates: [] }, {
        amount_vnd: 2_500_000,
        requireExplicitAmount: true,
        submit_now: true,
      })
    ).proposal;
    assert.equal(receiveSubmit.params.submit_now, true);

    process.env.MOCK_ERP_FAIL_SUBMIT_AFTER_WRITE = "1";
    let first;
    try {
      first = await post({ command_id: cid, proposal: receiveSubmit });
    } finally {
      delete process.env.MOCK_ERP_FAIL_SUBMIT_AFTER_WRITE;
    }
    assert.equal(first.status, 503, JSON.stringify(first.body));
    assert.equal(first.body.retry_same_command_id, true);
    assert.equal(store.status(cid).status, "PENDING", "unverified submit stays reconcile-able");
    const rows = writtenPayments();
    assert.equal(rows.length, 1, "the draft landed");
    assert.equal(rows[0].docstatus, 1, "ERPNext really DID submit it (only the reply was lost)");

    const retry = await post({ command_id: cid, proposal: receiveSubmit });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.reconciled, true, "the retry reconciled instead of re-writing");
    assert.equal(retry.body.result.docstatus, 1, "the retry reports ERPNext's REAL docstatus");
    assert.equal(retry.body.result.submit_ok, true, "a verified submit is reported as submitted");
    assert.equal(writtenPayments().length, 1, "NO second phiếu thu");
  });
});

test("P9-C false write: no confirm ⇒ 0 documents; and a crafted direction cannot pick the document", async () => {
  await withExecuteServer(async ({ post, pay, receive }) => {
    assert.equal(writtenPayments().length, 0);

    // (a) An expired card writes nothing.
    const stale = { ...pay, created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() };
    const r = await post({ command_id: randomUUID(), proposal: stale });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "PROPOSAL_EXPIRED");
    assert.equal(writtenPayments().length, 0);

    // (b) `params.direction` is advisory: a crafted "pay" on a CUSTOMER proposal
    // still writes a phiếu THU, because the executor re-derives from entity.kind.
    const crafted = { ...receive, params: { ...receive.params, direction: "pay" } };
    const r2 = await post({ command_id: randomUUID(), proposal: crafted });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.result.direction, "receive", "the request body does not choose the direction");
    assert.equal(writtenPayments()[0].payment_type, "Receive");

    // (c) A crafted `kind: "supplier"` on a customer id fails the master read
    // before anything is registered or written.
    const forged = { ...pay, entity: { kind: "supplier", id: "CUST-00001", name: "Nguyễn Thị Lan" } };
    const r3 = await post({ command_id: randomUUID(), proposal: forged });
    // 500 on purpose (the pinned convention for an unrecognised skill refusal at
    // execute time: a server-side failure, not a client conflict) — what matters
    // is that the CODE survives so the card can explain it, and that 0 rows were
    // written. A card that claims a direction the party master contradicts can
    // only come from a forged/stale client, never from our own builder.
    assert.equal(r3.status, 500, JSON.stringify(r3.body));
    assert.equal(r3.body.code, "PAYMENT_PARTY_NOT_SUPPLIER");
    assert.equal(writtenPayments().length, 1, "the forged card wrote nothing");
  });
});

test("P9-C regress: the Receive path writes exactly the document it always did", async () => {
  await withExecuteServer(async ({ post, receive }) => {
    const r = await post({ command_id: randomUUID(), proposal: receive });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.direction, "receive");
    const doc = writtenPayments()[0];
    assert.equal(doc.payment_type, "Receive");
    assert.equal(doc.party_type, "Customer");
    assert.equal(doc.party, "CUST-00001");
    assert.equal(doc.paid_from, "1310 - Debtors - DFC", "sides unchanged for Receive");
    assert.equal(doc.paid_to, "1110 - Cash - DFC");
    assert.equal(doc.references[0].reference_doctype, "Sales Invoice");
    assert.equal(doc.references[0].reference_name, "SINV-0001");
  });
});

test("P9-C executor: the shop day still comes from the snapshot (a pay-out does not shift days)", async () => {
  await withExecuteServer(async ({ post, pay }) => {
    const r = await post({ command_id: randomUUID(), proposal: pay });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(pay.params.posting_date, shopDay(), "frozen at proposal time, VN calendar day");
    assert.equal(writtenPayments()[0].posting_date, pay.params.posting_date);
  });
});

/* ------------------------------------------ 5. E2E /ask (wired pipeline) -- */

const MOCK_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));

async function startNlpService() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: path.join(REPO),
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

function startCopilot(port, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(REPO, "mcp-erpnext", "src", "copilot-server.mjs")], {
    env: { ...MOCK_ENV, NLP_SERVICE_PORT: String(port), ...extraEnv },
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
    child,
    request,
    async call(text, extraArgs = {}) {
      const res = await request("tools/call", { name: "copilot_ask", arguments: { text, ...extraArgs } });
      assert.equal(res.isError, undefined, `tool error: ${res.content?.[0]?.text}`);
      return res.structuredContent ?? JSON.parse(res.content[0].text);
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

test("P9-C E2E /ask: a pay-out order returns a PAY card + Vietnamese answer, and writes nothing", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { COPILOT_MOCK_OK: "1" });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });

    const out = await copilot.call("trả tiền NCC Hà Tiên 2 triệu");
    assert.equal(out.routed.group, "payment_write", JSON.stringify(out.routed));
    assert.equal(out.proposal?.action, "create_payment_entry", JSON.stringify(out.proposal));
    assert.equal(out.proposal.risk, "HIGH");
    assert.equal(out.proposal.params.direction, "pay");
    assert.equal(out.proposal.entity.kind, "supplier");
    assert.equal(out.proposal.params.invoice, "PINV-0001");
    assert.equal(out.proposal.params.amount_vnd, 2_000_000);
    assert.equal(out.proposal.params.submit_now, false);
    assert.equal(out.supplier.id, "SUP-HATIEN", "the party travels under the key its kind names");
    assert.equal(out.customer, undefined, "no customer key on a pay-out answer");
    assert.match(out.answer, /chi 2\.000\.000đ cho Hà Tiên/);
    assert.match(out.answer, /NHÁP/);
    assert.equal(Object.prototype.hasOwnProperty.call(out, "erpnext_doc"), false, "asking is not writing");

    // "chi cho <ncc>" is the same order said the other way.
    const chi = await copilot.call("chi cho Hà Tiên 1 triệu");
    assert.equal(chi.proposal?.params.direction, "pay", JSON.stringify(chi.proposal));
    assert.equal(chi.proposal.params.amount_vnd, 1_000_000);

    // STORE EXPENSE with no counterparty: refuse with the reason, never a card.
    const expense = await copilot.call("chi xăng 200 nghìn");
    assert.equal(expense.proposal, null, JSON.stringify(expense.proposal));
    assert.equal(expense.error_code, "PAYMENT_EXPENSE_WITHOUT_PARTY");
    assert.match(expense.reason, /nhà cung cấp/);

    // A “chi …” with a name in NEITHER master is treated as the expense case
    // (the verb is unambiguous), and explains itself rather than guessing.
    const chiNone = await copilot.call("chi cho công ty không tồn tại 1 triệu");
    assert.equal(chiNone.proposal, null, JSON.stringify(chiNone.proposal));
    assert.equal(chiNone.error_code, "PAYMENT_EXPENSE_WITHOUT_PARTY", JSON.stringify(chiNone));
    assert.match(chiNone.reason, /nhà cung cấp/);

    // …while an AMBIGUOUS verb with an unresolvable name is a plain "not found"
    // (neither master held it) — still an ASK, never a card.
    const none = await copilot.call("trả tiền cho công ty không tồn tại 1 triệu");
    assert.equal(none.proposal, null, JSON.stringify(none.proposal));
    assert.equal(none.error_code, "MISSING_ENTITY", JSON.stringify(none));
    assert.match(none.reason, /nhà cung cấp/);

    // Pay-HISTORY question stays a READ — it must never build a card.
    const hist = await copilot.call("lịch sử chi tiền của Hà Tiên");
    assert.equal(hist.routed.group, "payment", JSON.stringify(hist.routed));
    assert.equal(hist.proposal.action, "read_payment_history");
    assert.equal(hist.direction, "pay");
    assert.match(hist.answer, /phiếu chi/);

    // Receive still works, unchanged, on the same server (a FULL name is an
    // exact match; a partial one stays behind the §4.3 picker, below).
    const thu = await copilot.call("thu tiền cho Nguyễn Thị Lan 2 triệu");
    assert.equal(thu.proposal?.params.direction, "receive", JSON.stringify(thu.proposal));
    assert.equal(thu.proposal.entity.kind, "customer");
    assert.equal(thu.customer.id, "CUST-00001");
    assert.equal(thu.supplier, undefined, "no supplier key on a receive answer");
    assert.match(thu.answer, /thu 2\.000\.000đ từ Nguyễn Thị Lan/);
    assert.equal(thu.proposal.params.invoice, "SINV-0001", "the Sales Invoice side is untouched");

    // …and the WRITE guard from §4.3 still holds for a PARTIAL name — a fuzzy
    // single hit must not become a party id for a money write.
    const partial = await copilot.call("thu tiền cho Lan 2 triệu");
    assert.equal(partial.proposal, null, JSON.stringify(partial.proposal));
    assert.equal(partial.error_code, "ENTITY_PICK_REQUIRED");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("P9-C E2E /ask: a name that is BOTH a customer and a supplier refuses — the direction is never guessed", async () => {
  const nlp = await startNlpService();
  // The site state the guard exists for (plan3_review3 A.3.1: "anh vừa mua vừa bán").
  const copilot = startCopilot(nlp.port, { COPILOT_MOCK_OK: "1", MOCK_ERP_DUPLICATE_CUSTOMER: "Hà Tiên" });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("trả tiền NCC Hà Tiên 2 triệu");
    assert.equal(out.error_code, "PAYMENT_DIRECTION_AMBIGUOUS", JSON.stringify(out));
    assert.equal(out.proposal, null, "an ambiguous direction must never build a card");
    assert.match(out.reason, /hai sổ/);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("P9-C regression: a 2-character fragment of a VERB must not resolve a supplier (measured bug)", async () => {
  // MEASURED 2026-09-24 on the site's OWN data (A0 probe: MST 0300000002 →
  // "Đại lý Cám Bình Dương"), so this was live, not a fixture artefact.
  //
  // The substring pass asked `rowName.includes(fragment)` over EVERY token span of
  // the sentence, so "xử lý 500 nghìn cho nguyễn thị lan" yielded the span "lý"
  // (from the verb "xử lý") — and "đại lý cám bình dương".includes("lý") is TRUE.
  // `resolveSupplier` therefore returned a SUPPLIER for a sentence naming a
  // CUSTOMER, which flipped the direction guard to PAYMENT_DIRECTION_AMBIGUOUS
  // and refused a legitimate pay-out, claiming the name was in both books.
  const { resolveSupplier } = await import("../src/copilot-server.mjs");
  const { markUntrusted } = await import("../src/readonly-guard.mjs");
  const SUPPLIERS = [
    { name: "SUP-HATIEN", supplier_name: "Hà Tiên", disabled: 0 },
    { name: "SUP-BINH-DUONG", supplier_name: "Đại lý Cám Bình Dương", disabled: 0 },
  ];
  const skills = {
    findSupplier: async () =>
      markUntrusted("erpnext:erpnext_supplier_list", {
        doctype: "Supplier",
        count: SUPPLIERS.length,
        data: SUPPLIERS,
      }),
  };

  for (const text of ["xử lý cho nguyễn thị lan", "xử lý 500 nghìn cho nguyễn thị lan"]) {
    const r = await resolveSupplier(skills, text);
    assert.equal(
      r.supplier,
      null,
      `"${text}" must not resolve a supplier through the "lý" in "xử lý" (got ${r.supplier?.supplier_name})`,
    );
  }

  // Positive controls — the fix must not make the supplier book unmatchable, nor
  // hide the real "name in BOTH books" case the guard exists for (above).
  const exact = await resolveSupplier(skills, "trả tiền NCC Hà Tiên 2 triệu");
  assert.equal(exact.supplier?.name, "SUP-HATIEN", "an exact supplier name still resolves");
  const long = await resolveSupplier(skills, "trả tiền NCC Đại lý Cám Bình Dương");
  assert.equal(long.supplier?.name, "SUP-BINH-DUONG", "a >=3-character fragment still resolves");

  // Residual limitation, pinned so it is a KNOWN trade-off rather than a
  // surprise: a supplier named exactly "Lý" is still matched by the span "lý"
  // from the verb "xử lý", because that is the EXACT pass — a whole token span
  // equal to a 2-character name. Tightening that would break real short names,
  // so it is left refusing the wrong direction only in this narrow case.
  const shortName = [
    { name: "SUP-HATIEN", supplier_name: "Hà Tiên", disabled: 0 },
    { name: "SUP-LY", supplier_name: "Lý", disabled: 0 },
  ];
  const rShort = await resolveSupplier(
    {
      findSupplier: async () =>
        markUntrusted("erpnext:erpnext_supplier_list", { doctype: "Supplier", count: shortName.length, data: shortName }),
    },
    "xử lý cho nguyễn thị lan",
  );
  assert.equal(rShort.supplier?.supplier_name, "Lý", "documented residual: an exact 2-character name is still matchable");
});

test("P9-C safety: in the read-only AI mode (dsh) a pay-out order is BLOCKED before any skill runs", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { COPILOT_DSH_CONTEXT: "1" });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("trả tiền NCC Hà Tiên 2 triệu");
    assert.equal(out.error_code, "DSH_WRITE_BLOCKED", JSON.stringify(out));
    assert.equal(out.proposal, null, "the read-only mode never produces a write card");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

/* ==================================================================== */
/* 6. P9-D — a live DRAFT Payment Entry is money the invoice no longer  */
/*    needs, so a second /ask must not propose it again (plan          */
/*    `.plan/result-p9-C.md` §5; §0 of this task measured the gap).     */
/* ==================================================================== */

/** A skills bag wired to a REAL mock MCP client (not a stub). */
function realPaymentSkills(mcp) {
  return {
    listUnpaidInvoices: (cid) => listUnpaidInvoices(mcp, cid, new Set([CUSTOMER.name])),
    listOpenDraftPaymentEntries: (pid) => listOpenDraftPaymentEntries(mcp, pid),
    getPaymentEntryDoc: (n) => getPaymentEntryDoc(mcp, n),
  };
}

async function withMockClient(fn) {
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

const CUSTOMER_RESOLVED = { customer: CUSTOMER, ambiguous: false, candidates: [] };

/** The customer's own invoices, oldest first — the shape the builder reads. */
const TWO_SIS = [
  { name: "SINV-0001", customer: "CUST-00001", posting_date: "2026-09-01", outstanding_amount: 2_500_000 },
  { name: "SINV-0002", customer: "CUST-00001", posting_date: "2026-09-05", outstanding_amount: 320_000 },
];

/** One live DRAFT that covers `allocated` of `invoice`. */
function withDraft({ invoices = SIS, invoice = "SINV-0001", allocated = 1_000_000, row = {}, doc = {} } = {}) {
  return fakeSkills({
    salesInvoices: invoices,
    drafts: [draftRow(row)],
    docs: { [row.name ?? "PE-M901"]: draftDoc({ invoice, allocated, ...doc }) },
  });
}

test("P9-D builder: a live draft lowers the proposal to the REMAINDER and says so", async () => {
  const built = await buildPaymentProposal(withDraft({ allocated: 1_000_000 }), CUSTOMER_RESOLVED, {});

  // The number the card shows is the remainder, not the GL number...
  assert.equal(built.outstanding_vnd, 1_500_000);
  assert.equal(built.proposal.params.amount_vnd, 1_500_000, "the default offer is the remainder");
  // ...and the GL number is kept BESIDE it (audit + the drift compare).
  assert.equal(built.raw_outstanding_vnd, 2_500_000);
  assert.equal(built.proposal.params.raw_outstanding_vnd, 2_500_000);
  assert.equal(built.proposal.params.draft_cover_vnd, 1_000_000);
  assert.deepEqual(built.proposal.params.draft_cover_docs, ["PE-M901"]);

  // The user must be able to SEE why the number shrank, or the next call
  // "còn nợ 1.5 triệu?" is a mystery. Naming BOTH sides is what makes it
  // actionable: which document, and which draft to go submit/cancel.
  const warn = built.warnings.find((w) => /NHÁP/.test(w));
  assert.ok(warn, JSON.stringify(built.warnings));
  assert.match(warn, /PE-M901/);
  assert.match(warn, /SINV-0001/);
  assert.match(warn, /1000000đ/);
  assert.match(warn, /phần CÒN LẠI/);
});

test("P9-D builder: an explicit amount is clamped to the REMAINDER, not the GL number", async () => {
  const built = await buildPaymentProposal(withDraft({ allocated: 1_000_000 }), CUSTOMER_RESOLVED, {
    amount_vnd: 2_000_000,
    requireExplicitAmount: true,
  });
  assert.equal(built.proposal.params.amount_vnd, 1_500_000, "clamped to 2.500.000 − 1.000.000");
  assert.equal(built.proposal.params.amount_source, "explicit");
  const clamp = built.warnings.find((w) => /kẹp/.test(w));
  assert.ok(clamp, JSON.stringify(built.warnings));
  // The clamp must name BOTH numbers when a draft is involved — otherwise the
  // card says "vượt phần còn lại 1500000" while the user reads 2.500.000 on
  // ERPNext and thinks the app is wrong.
  assert.match(clamp, /1500000/);
  assert.match(clamp, /GL 2500000/);
  assert.match(clamp, /NHÁP/);

  // An amount that still fits the remainder is untouched.
  const fits = await buildPaymentProposal(withDraft({ allocated: 1_000_000 }), CUSTOMER_RESOLVED, {
    amount_vnd: 800_000,
    requireExplicitAmount: true,
  });
  assert.equal(fits.proposal.params.amount_vnd, 800_000);
  assert.equal(fits.warnings.some((w) => /kẹp/.test(w)), false, JSON.stringify(fits.warnings));
});

test("P9-D builder: a draft that covers the whole debt refuses, and names the draft", async () => {
  await refusal(
    buildPaymentProposal(withDraft({ allocated: 2_500_000 }), CUSTOMER_RESOLVED, { amount_vnd: 2_500_000, requireExplicitAmount: true }),
    "PAYMENT_DRAFT_COVERED",
  );
  // The message has to carry the document name: "submit or cancel WHICH one?"
  await assert.rejects(
    () => buildPaymentProposal(withDraft({ allocated: 2_500_000 }), CUSTOMER_RESOLVED, {}),
    (err) => {
      assert.equal(err.code, "PAYMENT_DRAFT_COVERED");
      assert.match(err.message, /PE-M901/);
      assert.match(err.message, /NHÁP/);
      return true;
    },
  );
});

test("P9-D builder: OVER-covered (drafts hold more than the invoice owes) also refuses", async () => {
  // Reachable on real data: a draft for 2.500.000 plus a second one for 500.000
  // leaves the invoice at −500.000. A negative remainder that came from DRAFTS
  // is a draft problem, not a credit note — the refusal must say so.
  await refusal(
    buildPaymentProposal(withDraft({ allocated: 3_000_000 }), CUSTOMER_RESOLVED, { amount_vnd: 500_000, requireExplicitAmount: true }),
    "PAYMENT_DRAFT_COVERED",
  );
  // The same negative remainder with NO draft is still the credit-note refusal —
  // the guard above must not swallow it (measured: it did, on the first cut).
  await assert.rejects(
    () =>
      buildPaymentProposal(
        fakeSkills({ salesInvoices: [{ name: "SINV-0004", customer: "CUST-00001", posting_date: "2026-09-09", outstanding_amount: -320_000, is_return: 1 }] }),
        CUSTOMER_RESOLVED,
        {},
      ),
    (err) => err.code === "PAYMENT_INVOICE_NOT_RECEIVABLE",
  );
});

test("P9-D builder: only the SAME direction counts as cover", async () => {
  // A Receive draft cannot cover a pay-out and vice versa. The direction filter
  // lives in openDraftCover (one party read, both directions), so it is pinned
  // here: a Pay draft for the same party id must change nothing.
  const wrongWay = fakeSkills({
    salesInvoices: SIS,
    drafts: [draftRow({ payment_type: "Pay" })],
    docs: {},
  });
  const built = await buildPaymentProposal(wrongWay, CUSTOMER_RESOLVED, {});
  assert.equal(built.outstanding_vnd, 2_500_000, "a pay-out draft is not cover for a receipt");
  assert.equal(built.proposal.params.draft_cover_vnd, 0);
  assert.deepEqual(built.proposal.params.draft_cover_docs, []);
  assert.equal(built.warnings.some((w) => /NHÁP/.test(w)), false);
  assert.equal(wrongWay.spy.docReads, undefined, "a filtered row must not even be read");
});

test("P9-D builder: a draft with no allocation (an advance) covers nothing", async () => {
  const skills = fakeSkills({
    salesInvoices: SIS,
    drafts: [draftRow()],
    docs: { "PE-M901": { name: "PE-M901", docstatus: 0, references: [] } },
  });
  const built = await buildPaymentProposal(skills, CUSTOMER_RESOLVED, {});
  assert.equal(built.outstanding_vnd, 2_500_000);
  assert.equal(built.proposal.params.draft_cover_vnd, 0);
  assert.equal(skills.spy.docReads, 1, "the document was read — it just claims no invoice");
});

test("P9-D builder: a pile of drafts is the shop's problem, not one more draft", async () => {
  // Same posture as delivery-write's DRAFT_NOTE_LOOKUP_LIMIT: at the cap the
  // lookup can no longer be trusted to have seen them all, so refuse.
  const drafts = Array.from({ length: DRAFT_PAYMENT_LOOKUP_LIMIT }, (_, i) => draftRow({ name: `PE-M90${i}` }));
  await refusal(buildPaymentProposal(fakeSkills({ drafts }), CUSTOMER_RESOLVED, {}), "PAYMENT_DRAFT_COVERED");
  // One below the cap still works (the boundary is the cap, not "many").
  const justUnder = await buildPaymentProposal(
    fakeSkills({
      drafts: drafts.slice(0, DRAFT_PAYMENT_LOOKUP_LIMIT - 1),
      docs: Object.fromEntries(drafts.slice(0, DRAFT_PAYMENT_LOOKUP_LIMIT - 1).map((d) => [d.name, draftDoc({ allocated: 100_000 })])),
    }),
    CUSTOMER_RESOLVED,
    {},
  );
  assert.equal(justUnder.outstanding_vnd, 2_500_000 - (DRAFT_PAYMENT_LOOKUP_LIMIT - 1) * 100_000);
});

test("P9-D builder: a failed draft read refuses (PAYMENT_ERP_UNAVAILABLE), it does not ignore the drafts", async () => {
  // Fail CLOSED: proceeding with "no drafts known" would re-propose money a
  // draft already holds — the exact bug this task closes.
  // (a) the LIST read fails ...
  await refusal(
    buildPaymentProposal(
      { ...withDraft({}), listOpenDraftPaymentEntries: async () => { throw new Error("mock: list died"); } },
      CUSTOMER_RESOLVED,
      {},
    ),
    "PAYMENT_ERP_UNAVAILABLE",
  );
  // (b) ... or the per-document read does (a row with no readable document).
  await refusal(
    buildPaymentProposal(
      fakeSkills({ salesInvoices: SIS, drafts: [draftRow()], docs: {} }),
      CUSTOMER_RESOLVED,
      {},
    ),
    "PAYMENT_ERP_UNAVAILABLE",
  );
});

test("P9-D wiring guard: a bag missing the draft reads fails as a MISSING READ, not an ERP outage", async () => {
  // P9-B's lesson (the reads ride the bag the BUILDER sees) turned into a named
  // failure: without this guard the TypeError inside the catch is relabelled
  // PAYMENT_ERP_UNAVAILABLE and the operator goes looking at ERPNext.
  const bare = { listUnpaidInvoices: async () => ({ data: { data: SIS } }) };
  await refusal(buildPaymentProposal(bare, CUSTOMER_RESOLVED, {}), "PAYMENT_SKILLS_INCOMPLETE");
  await refusal(
    buildPaymentProposal({ ...bare, listOpenDraftPaymentEntries: async () => ({ data: { data: [] } }) }, CUSTOMER_RESOLVED, {}),
    "PAYMENT_SKILLS_INCOMPLETE",
  );
});

test("P9-D E2E (real mock): a draft written from chat lowers the NEXT ask to the remainder, and a card built before it is refused", async () => {
  await withExecuteServer(async ({ post, receive }) => {
    // (1) BEFORE any draft: the whole debt is proposed, and nothing covers it.
    //     The mock's SUBMITTED fixture PE-0001 (CUST-00001, 8.000.000,
    //     docstatus 1) must NOT count — the GL already moved for it.
    const before = await withMockClient((client) => buildPaymentProposal(realPaymentSkills(client), CUSTOMER_RESOLVED, {}));
    assert.equal(before.outstanding_vnd, 2_500_000, "the §0 baseline");
    assert.equal(before.proposal.params.draft_cover_vnd, 0);
    assert.deepEqual(before.proposal.params.draft_cover_docs, [], "a SUBMITTED payment is not a draft");

    // (2) The user collects 1.000.000 of it — an ordinary draft write.
    const partial = { ...receive, params: { ...receive.params, amount_vnd: 1_000_000 } };
    const r = await post({ command_id: randomUUID(), proposal: partial });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(writtenPayments().length, 1, "one draft, written the ordinary way");

    // (3) THE GAP THIS TASK CLOSES: the same debt now reads as the remainder,
    //     with the draft named in the warning. (A fresh client, because each
    //     mock process holds its own fixtures and only the state FILE is shared.)
    const after = await withMockClient((client) => buildPaymentProposal(realPaymentSkills(client), CUSTOMER_RESOLVED, {}));
    assert.equal(after.outstanding_vnd, 1_500_000, "draft cover is subtracted from the proposal");
    assert.equal(after.raw_outstanding_vnd, 2_500_000, "raw GL is untouched — ERPNext lowers it only at SUBMIT");
    assert.equal(after.proposal.params.amount_vnd, 1_500_000);
    assert.equal(after.proposal.params.draft_cover_vnd, 1_000_000);
    assert.deepEqual(after.proposal.params.draft_cover_docs, [r.body.result.erpnext_doc]);
    assert.ok(
      after.warnings.some((w) => w.includes(r.body.result.erpnext_doc) && w.includes("SINV-0001") && /NHÁP/.test(w)),
      JSON.stringify(after.warnings),
    );

    // (4) A card built BEFORE the draft (snapshot = the raw 2.500.000) can no
    //     longer be confirmed: the effective ceiling moved, so the drift gate
    //     refuses instead of writing the same money twice.
    const stale = await post({ command_id: randomUUID(), proposal: receive });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    // The executor's generic PROPOSAL_STALE is classified by the gateway into the
    // P1 taxonomy code — the card re-confirms on fresh numbers either way.
    assert.equal(stale.body.code, "PROPOSAL_VERSION_STALE", JSON.stringify(stale.body));
    assert.match(JSON.stringify(stale.body.problems ?? []), /nợ lúc tạo đề xuất 2500000/);
    assert.equal(writtenPayments().length, 1, "a stale card never writes a second draft");
  });
});
