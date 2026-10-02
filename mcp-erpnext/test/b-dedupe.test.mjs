/**
 * next3/B — BUSINESS DOCUMENT DEDUPE (`business_doc_key`).
 *
 * The failure this phase closes, stated as the shop would see it: the same tờ
 * hóa đơn (same số HĐ + ngày + MST) reaches the copilot TWICE — re-sent, re-read
 * from the phone, or asked again in different words — and the shop ends up with
 * TWO draft purchase orders for ONE invoice. `custom_ai_action_id` cannot see it
 * (two commands ⇒ two action ids) and `business_dedup` was never meant to (it
 * warns inside a 15-minute window and never blocks).
 *
 * What has to hold, in the order the risk appears:
 *
 *  1. THE KEY IS THE DOCUMENT'S, not the request's: an MST written with
 *     separators is the same MST, an invoice number is NEVER zero-stripped, and
 *     no money is part of the identity (a corrected total must not break it).
 *  2. A HALF-IDENTITY REFUSES, out loud, at the /ask boundary — silently
 *     dropping it would leave the user believing the guard was on.
 *  3. THE SAME INVOICE TWICE ⇒ ONE DRAFT, and the refusal NAMES the existing
 *     document and says a retry cannot help.
 *  4. A DIFFERENT INVOICE, OR NO INVOICE AT ALL, IS NOT BLOCKED: a shop that buys
 *     from the same supplier every week must keep working, and the typed (voice)
 *     path keeps the exact behaviour it had before this phase.
 *  5. THE SITE WITHOUT THE COLUMN REFUSES THE KEYED WRITE (it cannot dedupe, and
 *     writing anyway is how the duplicate comes back) — while ordinary typed
 *     purchase orders on that same site still work.
 *  6. THE VALUE IS VERIFIED ON READ-BACK: a dropped key is a silent loss of the
 *     guard for every later send, so it must not be reported as success.
 *  7. THE MONEY PATH IS UNTOUCHED (payment declares no document identity).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";
import { businessDocKeyPolicy, declaredDocumentKinds } from "../src/capability-contract.mjs";
import {
  businessDocKey,
  businessDocKeyParts,
  normalizeInvoiceNo,
  normalizeTaxId,
  strictYmd,
  validateSourceDocument,
} from "../src/business-doc-key.mjs";
import {
  buildPurchaseOrderProposal,
  verifyWrittenPurchaseOrder,
} from "../src/skills/purchase-order-write.mjs";

/* --------------------------------------------------------------- fixtures -- */

/** Same values as src/mock-server.mjs on purpose (a catalogue of its own would
 *  prove the builder works against data ERPNext never returns). */
const ITEM_ROWS = [
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
];
const BUYING_PRICES = [
  { name: "IPB1", item_code: "CAM-HEO-25KG", uom: "Bao", price_list: "Standard Buying", price_list_rate: 295_000, buying: 1 },
];
const UOM_NAMES = ["Bao", "Tấn", "Kg", "Xe", "Thung", "Viên", "Mét", "m3"];
const UOM_FACTORS = [
  { name: "F1", from_uom: "Tấn", to_uom: "Kg", value: 1000 },
  { name: "F2", from_uom: "Bao", to_uom: "Kg", value: 25 },
];

function fakeSkills() {
  return {
    findItem: async () => ({ data: { doctype: "Item", count: ITEM_ROWS.length, data: ITEM_ROWS } }),
    listUoms: async () => ({ data: { doctype: "UOM", data: UOM_NAMES } }),
    listUomFactors: async () => ({ data: { doctype: "UOM Conversion Factor", data: UOM_FACTORS } }),
    listItemPrices: async () => ({ data: { doctype: "Item Price", data: BUYING_PRICES } }),
    getItemWarehouseHints: async (code) => ({
      item_code: code,
      is_stock_item: true,
      warehouse: "Kho Cám - DFC",
      options: [],
      ambiguous: false,
    }),
  };
}

// A supplier that EXISTS in the mock (the create would otherwise fail as a
// LinkValidationError — a green test for the wrong reason).
const SUPPLIER = { name: "SUP-HATIEN", supplier_name: "Hà Tiên" };
const SENTENCE = "đặt mua 2 bao cám heo tăng trọng 25kg từ Hà Tiên";
const QTY = [{ value: 2, canonical_unit: "Bao", raw: "2 bao", start: 0, end: 5 }];

/** One tờ hóa đơn, as the file channel would hand it over. */
const sourceDoc = (over = {}) => ({
  kind: "purchase",
  source: "einvoice_xml",
  invoice_no: "0000049",
  invoice_form: "1",
  invoice_series: "1C25TAA",
  invoice_date: "2026-09-20",
  seller_tax_id: "0300000002",
  seller_name: "Đại lý Cám Bình Dương",
  ...over,
});

/** Build a PO proposal the way the pipeline does — through the real builder. */
async function poProposal({ sourceDocument = null, supplier = SUPPLIER } = {}) {
  const built = await buildPurchaseOrderProposal(
    fakeSkills(),
    { supplier, ambiguous: false, candidates: [] },
    { nlp: { text: SENTENCE, quantities: QTY }, text: SENTENCE, sourceDocument },
  );
  return built.proposal;
}

/**
 * Execute through the REAL Safety Gateway, with the mock site state in a temp
 * file: every execute opens a NEW client (a new mock process), so without the
 * shared state file this would prove only that one process remembers.
 */
async function withGateway(fn, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "bdk-"));
  const prevState = process.env.MOCK_ERP_STATE;
  const prev = Object.entries(env).map(([k, v]) => [k, process.env[k], v]);
  process.env.MOCK_ERP_STATE = path.join(dir, "state.json");
  for (const [k, , v] of prev) process.env[k] = v;
  try {
    const { runExecute } = await import("../src/safety-gateway.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    return await fn({ runExecute, store: new IdempotencyStore(dir) });
  } finally {
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    for (const [k, was] of prev) {
      if (was === undefined) delete process.env[k];
      else process.env[k] = was;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the mock "site" holds right now. */
async function purchaseOrders() {
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await client.initialize();
    const res = await client.callTool("erpnext_doc_list", {
      doctype: "Purchase Order",
      fields: ["name", "supplier", "docstatus", "custom_business_doc_key"],
      limit: 20,
    });
    return res?.data?.data ?? [];
  } finally {
    await client.close().catch(() => {});
  }
}

/* ------------------------------------------- 1. the identity is the reality -- */

test("B-dedupe key: built from the DOCUMENT (kind + party + số HĐ + ngày), never from money", () => {
  const a = businessDocKey({ kind: "purchase", partyTaxId: "0300000002", invoiceNo: "0000049", invoiceDate: "2026-09-20" });
  assert.match(a, /^bdk_[0-9a-f]{32}$/);

  // Formatting of an MST is not identity: the site writes it both ways.
  assert.equal(normalizeTaxId("0300 000 002"), "0300000002");
  assert.equal(normalizeTaxId("0300000002-001"), "0300000002001");
  assert.equal(
    businessDocKey({ kind: "purchase", partyTaxId: "0300-000002", invoiceNo: "0000049", invoiceDate: "2026-09-20" }),
    a,
    "separators in the MST are formatting — same invoice",
  );

  // The NUMBER is exact: zero-padding is part of the number we were given, never
  // normalised away (that is how two different invoices would share one key).
  assert.equal(normalizeInvoiceNo("  1c25taa-0000049  "), "1C25TAA-0000049");
  assert.notEqual(
    businessDocKey({ kind: "purchase", partyTaxId: "0300000002", invoiceNo: "49", invoiceDate: "2026-09-20" }),
    a,
    "0000049 and 49 are different numbers as far as the document says",
  );

  // A different issuer, a different day, a different kind, a different party:
  // four ways this is a DIFFERENT document — each must move the key.
  const variants = [
    { partyTaxId: "0300000003" },
    { invoiceDate: "2026-09-21" },
    { kind: "sales" },
    { invoiceNo: "0000050" },
    { partyTaxId: null, partyId: "SUP-HATIEN" },
  ];
  for (const over of variants) {
    assert.notEqual(
      businessDocKey({ kind: "purchase", partyTaxId: "0300000002", invoiceNo: "0000049", invoiceDate: "2026-09-20", ...over }),
      a,
      `must not collide with ${JSON.stringify(over)}`,
    );
  }

  // Dates are real dates, not shapes.
  assert.equal(strictYmd("2026-02-30"), null);
  assert.equal(strictYmd("2026-9-20"), null);
  assert.equal(strictYmd("2026-09-20"), "2026-09-20");

  // A half-identity has NO key, and says which half is missing — the caller
  // refuses on null instead of writing a document nobody can dedupe.
  const half = businessDocKeyParts({ kind: "purchase", partyTaxId: "0300000002", invoiceNo: null, invoiceDate: "2026-09-20" });
  assert.equal(half.key, null);
  assert.deepEqual(half.missing, ["invoice_no"]);
});

test("B-dedupe boundary: a malformed source_document is REFUSED by name, never quietly dropped", () => {
  const kinds = ["purchase"];
  const ok = validateSourceDocument(sourceDoc(), { allowedKinds: kinds });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.invoice_no, "0000049");
  assert.equal(ok.value.seller_tax_id, "0300000002");
  // Only the identity travels: totals read off a file are display-only on every
  // path in this project, so they are not even carried into the proposal.
  assert.equal("total_vnd" in ok.value, false);
  assert.equal("net_total_vnd" in ok.value, false);
  // Untrusted text is bounded and stripped of controls (it travels in the
  // proposal snapshot and is echoed in refusal messages).
  const dirty = validateSourceDocument(sourceDoc({ seller_name: "x\u0000y\nz".repeat(200) }), { allowedKinds: kinds });
  assert.equal(dirty.value.seller_name.length <= 300, true);
  assert.equal(/[\u0000-\u001f]/.test(dirty.value.seller_name), false);

  // Separators INSIDE a number are kept exactly as written — never stripped.
  // Stripping them is how "0000049/2026" and "00000492026" would become one key.
  assert.equal(
    validateSourceDocument(sourceDoc({ invoice_no: "0000049/2026" }), { allowedKinds: kinds }).value.invoice_no,
    "0000049/2026",
  );

  const bad = [
    [null, "absent"],
    ["not-an-object", "shape"],
    [sourceDoc({ kind: "hoadon" }), "kind"],
    [sourceDoc({ invoice_no: "" }), "invoice_no"],
    [sourceDoc({ invoice_no: "0000 049" }), "invoice_no"],
    [sourceDoc({ invoice_no: "0000049\\u0000" }), "invoice_no"],
    [sourceDoc({ invoice_date: "20/09/2026" }), "invoice_date"],
    [sourceDoc({ invoice_date: "2026-02-30" }), "invoice_date"],
    [sourceDoc({ seller_tax_id: null }), "party"],
  ];
  for (const [raw, reason] of bad) {
    const verdict = validateSourceDocument(raw, { allowedKinds: kinds });
    assert.equal(verdict.ok, false, `${reason} must be refused`);
    assert.equal(verdict.code, "SOURCE_DOCUMENT_INVALID");
    assert.equal(verdict.reason, reason);
  }
  // A kind the sending channel does not offer is refused even though it is a
  // well-formed slug: the vocabulary is the contract's, not the client's.
  assert.equal(validateSourceDocument(sourceDoc({ kind: "sales" }), { allowedKinds: kinds }).reason, "kind");

  // …and at the /ask boundary the vocabulary is EVERY kind the contract declares
  // (`declaredDocumentKinds()`), so a well-formed identity from a camera reading
  // of a sales document is not turned into a 400: only `purchase` CONSUMES the
  // identity today, and an unconsumed identity is inert rather than an error.
  const declared = declaredDocumentKinds();
  assert.equal(declared.includes("purchase"), true);
  assert.equal(declared.includes("sales"), true);
  assert.equal(
    validateSourceDocument(sourceDoc({ kind: "sales" }), { allowedKinds: declared }).ok,
    true,
  );
  assert.equal(
    validateSourceDocument(sourceDoc({ kind: "hoa-don" }), { allowedKinds: declared }).reason,
    "kind",
    "a kind nobody declared is still refused",
  );
});

test("B-dedupe builder: the key + the identity travel in the proposal; a typed sentence is untouched", async () => {
  const keyed = await poProposal({ sourceDocument: sourceDoc() });
  assert.match(keyed.params.business_doc_key, /^bdk_[0-9a-f]{32}$/);
  assert.equal(keyed.params.source_document.invoice_no, "0000049");
  assert.match(keyed.summary, /0000049/, "the card says which tờ hóa đơn this draft is for");

  // The voice path keeps the EXACT params shape it had before this phase.
  const typed = await poProposal();
  assert.equal("business_doc_key" in typed.params, false);
  assert.equal("source_document" in typed.params, false);

  // An unusable identity is a builder refusal (a caller that is not the /ask
  // route — dsh, tests — cannot bypass the boundary' check).
  await assert.rejects(
    () => poProposal({ sourceDocument: sourceDoc({ invoice_no: null }) }),
    (err) => err.code === "PO_DOC_KEY_UNRESOLVED" && err.source_reason === "invoice_no",
  );
});

test("B-dedupe: the key is RE-DERIVED at execute, never trusted from the proposal", async () => {
  // (a) A channel that resolves a party but carries no MST: the key must follow
  //     the party the DOCUMENT names, not the supplier the SENTENCE resolved.
  const docSays = await poProposal({
    sourceDocument: sourceDoc({ seller_tax_id: null, party_id: "SUP-BINH-DUONG" }),
    supplier: SUPPLIER,
  });
  assert.equal(
    docSays.params.business_doc_key,
    businessDocKey({
      kind: "purchase",
      partyTaxId: null,
      partyId: "SUP-BINH-DUONG",
      invoiceNo: "0000049",
      invoiceDate: "2026-09-20",
    }),
    "the id the paper claims beats the supplier the sentence resolved",
  );

  await withGateway(async ({ runExecute, store }) => {
    const honest = await poProposal({ sourceDocument: sourceDoc() });
    const first = await runExecute({ command_id: randomUUID(), proposal: honest, store });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const storedKey = first.body.result.business_doc_key;

    // (b) A TAMPERED body — and this is not hypothetical: /execute re-parses the
    //     proposal from JSON, so the client hands back a fresh, mutable object.
    //     Planting ANOTHER invoice's key here would block that other invoice
    //     forever, which is exactly why the value is derived, not believed.
    const tampered = {
      ...(await poProposal({ sourceDocument: sourceDoc({ invoice_no: "0000999" }) })),
      // (a frozen `params` from buildProposal cannot be written to — a JSON
      // round-trip replaces it, which is precisely what the client does)
    };
    const verdict = await runExecute({
      command_id: randomUUID(),
      proposal: { ...tampered, params: { ...tampered.params, business_doc_key: storedKey } },
      store,
    });
    assert.equal(verdict.status, 500, JSON.stringify(verdict.body));
    assert.equal(verdict.body.code, "PO_DOC_KEY_UNRESOLVED");
    assert.match(String(verdict.body.error), /không khớp/);

    // (c) A key with no document fields behind it cannot be verified at all.
    const naked = await poProposal({ sourceDocument: sourceDoc({ invoice_no: "0000998" }) });
    const nakedVerdict = await runExecute({
      command_id: randomUUID(),
      proposal: { ...naked, params: Object.fromEntries(Object.entries(naked.params).filter(([k]) => k !== "source_document")) },
      store,
    });
    assert.equal(nakedVerdict.body.code, "PO_DOC_KEY_UNRESOLVED", JSON.stringify(nakedVerdict.body));

    assert.equal((await purchaseOrders()).length, 1, "only the honest proposal reached the site");
  });
});

/* ------------------------------------------------- 2. one invoice, one draft -- */

test("B-dedupe: the SAME invoice through two commands ⇒ ONE draft, and the refusal names it", async () => {
  await withGateway(async ({ runExecute, store }) => {
    const first = await runExecute({ command_id: randomUUID(), proposal: await poProposal({ sourceDocument: sourceDoc() }), store });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const docName = first.body.result.erpnext_doc;
    assert.match(first.body.result.business_doc_key, /^bdk_/);

    // A SECOND command (its own command_id AND its own action_id — that is the
    // whole point: nothing about the request is "the same", only the invoice is).
    const second = await runExecute({ command_id: randomUUID(), proposal: await poProposal({ sourceDocument: sourceDoc() }), store });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.code, "PO_DUPLICATE_DOC");
    assert.equal(second.body.existing_doc, docName);
    assert.match(second.body.error, /0000049/);
    // Terminal: a retry can only ever produce the duplicate, so the card must not
    // be told to retry.
    assert.equal(second.body.retry_same_command_id, undefined);

    const rows = await purchaseOrders();
    assert.equal(rows.length, 1, `exactly one draft for one invoice, got ${JSON.stringify(rows.map((r) => r.name))}`);
    assert.match(String(rows[0].custom_business_doc_key), /^bdk_/, "the key is stored on the document itself");
  });
});

test("B-dedupe: a DIFFERENT invoice is never blocked — the key follows the document, not the resolution", async () => {
  await withGateway(async ({ runExecute, store }) => {
    const first = await runExecute({ command_id: randomUUID(), proposal: await poProposal({ sourceDocument: sourceDoc() }), store });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // (a) next invoice from the same issuer: number moved.
    const next = await runExecute({
      command_id: randomUUID(),
      proposal: await poProposal({ sourceDocument: sourceDoc({ invoice_no: "0000050" }) }),
      store,
    });
    assert.equal(next.status, 200, JSON.stringify(next.body));

    // (b) another issuer happens to use the same number and date.
    const other = await runExecute({
      command_id: randomUUID(),
      proposal: await poProposal({ sourceDocument: sourceDoc({ seller_tax_id: "0300000003" }) }),
      store,
    });
    assert.equal(other.status, 200, JSON.stringify(other.body));

    // (c) the SAME invoice resolved to a different ERPNext supplier is still the
    //     same invoice: the identity comes from the MST on the paper.
    const sameInvoice = await runExecute({
      command_id: randomUUID(),
      proposal: await poProposal({
        sourceDocument: sourceDoc(),
        supplier: { name: "SUP-BINH-DUONG", supplier_name: "Đại lý Cám Bình Dương" },
      }),
      store,
    });
    assert.equal(sameInvoice.status, 409, JSON.stringify(sameInvoice.body));
    assert.equal(sameInvoice.body.code, "PO_DUPLICATE_DOC");

    assert.equal((await purchaseOrders()).length, 3, "three genuinely different invoices ⇒ three drafts");
  });
});

test("B-dedupe: the voice path is NOT deduped — buying from one supplier twice is normal business", async () => {
  await withGateway(async ({ runExecute, store }) => {
    const first = await runExecute({ command_id: randomUUID(), proposal: await poProposal(), store });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await runExecute({ command_id: randomUUID(), proposal: await poProposal(), store });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal((await purchaseOrders()).length, 2, "two typed orders are two orders");
  });
});

/* ------------------------------------- 3. the site that cannot store the key -- */

test("B-dedupe: a site WITHOUT the column refuses the keyed write — and still accepts ordinary orders", async () => {
  await withGateway(
    async ({ runExecute, store }) => {
      const keyed = await runExecute({ command_id: randomUUID(), proposal: await poProposal({ sourceDocument: sourceDoc() }), store });
      // 500 on purpose, matching the correlation-field convention: a missing
      // column means the SITE is misconfigured (an operator's job), not a client
      // conflict. What matters is that NOTHING was written.
      assert.equal(keyed.status, 500, JSON.stringify(keyed.body));
      assert.equal(keyed.body.code, "PO_DOC_KEY_FIELD_MISSING");
      assert.match(keyed.body.error, /custom_business_doc_key/);
      assert.match(keyed.body.error, /migration/i);

      const typed = await runExecute({ command_id: randomUUID(), proposal: await poProposal(), store });
      assert.equal(typed.status, 200, JSON.stringify(typed.body));

      const rows = await purchaseOrders();
      assert.equal(rows.length, 1, "the keyed write was refused, the typed one landed");
      assert.equal(rows[0].custom_business_doc_key, undefined, "and nothing was written into a column that does not exist");
    },
    { MOCK_ERP_PO_NO_DOC_KEY_FIELD: "1" },
  );
});

test("B-dedupe verify: a key that does not read back is NOT a success", async () => {
  // The site accepted the create but dropped the value (a field added, then
  // removed; a payload path that lost it). A dropped key is silent loss of the
  // guard for every later send, so the read-back has to refuse the write.
  const fakeClient = {
    callTool: async () => ({
      data: { name: "PO-M001", supplier: "SUP-HATIEN", docstatus: 0, items: [{ item_code: "CAM-HEO-25KG", qty: 2, rate: 295_000, uom: "Bao" }] },
    }),
  };
  await assert.rejects(
    () =>
      verifyWrittenPurchaseOrder(fakeClient, "PO-M001", {
        supplierId: "SUP-HATIEN",
        lines: [{ item_code: "CAM-HEO-25KG", qty: 2, rate: 295_000, uom: "Bao" }],
        actionId: null,
        businessDocKey: "bdk_0123456789abcdef0123456789abcdef",
      }),
    (err) => err.code === "PO_WRITE_UNVERIFIED" && /custom_business_doc_key/.test(err.message),
  );
});

/* ---------------------------------------------------- 4. the money path ----- */

test("B-dedupe scope: only the purchase path declares a document identity", () => {
  assert.equal(businessDocKeyPolicy("purchase_order.create")?.field, "custom_business_doc_key");
  for (const id of ["payment.create", "sales_order.create", "quotation.create", "customer.create", "sales_invoice.create"]) {
    assert.equal(businessDocKeyPolicy(id), null, `${id} must have NO document-identity layer`);
  }
  // The advisory layer it sits beside is still declared and still non-blocking —
  // this phase ADDS a guard, it does not replace the 15-minute warning.
  assert.equal(businessDocKeyPolicy("purchase_order.create")?.on_missing_field, "refuse");
});

/* ------------------------------------------- 5. the /ask boundary (HTTP) ----- */

test("B-dedupe /ask: a malformed source_document is a 400 naming the field — and no pipeline runs", async () => {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "bdk-ask-"));
  const server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: new IdempotencyStore(dir) });
  try {
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const post = async (body) => {
      const r = await fetch(`http://127.0.0.1:${port}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };

    const bad = await post({ text: "đặt mua 2 bao cám heo", source_document: { kind: "purchase", invoice_no: "" } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, "SOURCE_DOCUMENT_INVALID");
    assert.equal(bad.body.reason, "invoice_no");

    // A kind nobody declared is refused too — the vocabulary is the contract's,
    // so a client cannot invent one and be silently ignored.
    const wrongKind = await post({ text: "đặt mua 2 bao cám heo", source_document: sourceDoc({ kind: "whatever" }) });
    assert.equal(wrongKind.status, 400, JSON.stringify(wrongKind.body));
    assert.equal(wrongKind.body.reason, "kind");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
