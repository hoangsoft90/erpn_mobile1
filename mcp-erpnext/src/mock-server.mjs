/**
 * Mock MCP ERPNext server — line-delimited JSON-RPC 2.0 over stdio.
 *
 * Purpose (user decision 2026-09-13): complete the JSON-RPC request/response
 * correlation in createMcpClient WITHOUT real ERPNext credentials, using the
 * SAME response shapes the pinned @casys/mcp-erpnext 3.0.4 produces (verified
 * by reading its bundled source, see result4.txt §3):
 *
 *   tools/call result:
 *     { content: [{ type: "text", text: "<json>" }],
 *       structuredContent: {...}, isError?: false }
 *   handler payloads: erpnext_customer_list -> { doctype, count, data }
 *                     erpnext_customer_get  -> { data: {...} }
 *
 * Supports the 4 whitelisted Phase 2 read tools. Any other tool name gets a
 * JSON-RPC error response (method not found), exactly like a real server.
 * When REAL credentials arrive, the client only changes which binary it
 * spawns — this file is not imported by production code.
 */

import readline from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Optional persistence. The client spawns a FRESH mock process per request, so
 * without this every request would see an empty ledger — and a reconcile query
 * would answer "nothing was written" even after a real write. A real ERPNext
 * keeps its data, so the mock must too when a test needs that (reconcile /
 * crash-recovery paths): set MOCK_ERP_STATE=<file> to opt in.
 */
const STATE_FILE = process.env.MOCK_ERP_STATE;

/** Fake ERPNext data — shape mirrors real handler payloads. */
const DB = {
  "CUST-00001": {
    doctype: "Customer",
    name: "CUST-00001",
    customer_name: "Nguyễn Thị Lan",
    customer_group: "Individual",
    territory: "Vietnam",
    disabled: 0,
  },
  "CUST-00002": {
    doctype: "Customer",
    name: "CUST-00002",
    customer_name: "Trần Văn Hai",
    customer_group: "Individual",
    territory: "Vietnam",
    disabled: 0,
  },
};

/**
 * M1-site (2026-09-24) — the Customer classification masters + the Customer
 * field RULES, mirrored from what the real site MEASURED:
 *
 *  - `customer_type` is a Select, `reqd = 1`, with its own `default` — so a
 *    create that omits it still succeeds (Frappe fills the default) while an
 *    illegal value is rejected;
 *  - `customer_group` / `territory` are Link fields and are **NOT required** —
 *    a site with no safe group leaves them null;
 *  - a Link value that does not exist is a `LinkValidationError` (this is the
 *    exact failure the first version of `customer-create.mjs` hit on the real
 *    site by hardcoding `customer_group: "Múa"`).
 *
 * The mock mirrors RULES, not the shop's data: the leaf sets below are ERPNext's
 * own standard ones (the real site renames/replaces them). ERPNext validates
 * only that a Link doc EXISTS — not that it is a leaf — so the mock does the
 * same; preferring a leaf is the SKILL's own stricter rule (a customer filed
 * under a group NODE disappears from group-level reports).
 */
const CUSTOMER_DOCFIELDS = [
  { parent: "Customer", fieldname: "customer_name", fieldtype: "Data", options: null, default: null, reqd: 1 },
  { parent: "Customer", fieldname: "customer_type", fieldtype: "Select", options: "Company\nIndividual\nPartnership", default: "Company", reqd: 1 },
  { parent: "Customer", fieldname: "customer_group", fieldtype: "Link", options: "Customer Group", default: null, reqd: 0 },
  { parent: "Customer", fieldname: "territory", fieldtype: "Link", options: "Territory", default: null, reqd: 0 },
  { parent: "Customer", fieldname: "mobile_no", fieldtype: "Data", options: null, default: null, reqd: 0 },
  { parent: "Customer", fieldname: "tax_id", fieldtype: "Data", options: null, default: null, reqd: 0 },
];

const CUSTOMER_GROUPS = [
  { name: "All Customer Groups", is_group: 1, parent_customer_group: null },
  { name: "Commercial", is_group: 0, parent_customer_group: "All Customer Groups" },
  { name: "Government", is_group: 0, parent_customer_group: "All Customer Groups" },
  { name: "Individual", is_group: 0, parent_customer_group: "All Customer Groups" },
  { name: "Non Profit", is_group: 0, parent_customer_group: "All Customer Groups" },
];

const TERRITORIES = [
  { name: "All Territories", is_group: 1, parent_territory: null },
  { name: "Rest Of The World", is_group: 0, parent_territory: "All Territories" },
  { name: "Vietnam", is_group: 0, parent_territory: "All Territories" },
];

const INVOICES = [
  { name: "SINV-0001", customer: "CUST-00001", posting_date: "2026-09-01", grand_total: 10_500_000, outstanding_amount: 2_500_000, docstatus: 1 },
  { name: "SINV-0002", customer: "CUST-00001", posting_date: "2026-09-05", grand_total: 320_000, outstanding_amount: 0, docstatus: 1 },
  { name: "SINV-0003", customer: "CUST-00002", posting_date: "2026-09-08", grand_total: 7_500_000, outstanding_amount: 7_500_000, docstatus: 1 },
  // Credit note (is_return): outstanding is NEGATIVE. It must count toward
  // "còn nợ" (net receivable) — result20: the `> 0` filter dropped it and
  // overstated CUST-00002's balance by 320.000đ. Ground truth for the
  // regression test: CUST-00002 = 7.500.000 − 320.000 = 7.180.000đ / 2 chứng từ.
  { name: "SINV-0004", customer: "CUST-00002", posting_date: "2026-09-09", grand_total: -320_000, outstanding_amount: -320_000, docstatus: 1, is_return: 1 },
];

const STOCK = [
  { item_code: "CAM-HEO-25KG", warehouse: "Kho chính", actual_qty: 120, reserved_qty: 5, projected_qty: 115, valuation_rate: 8_200, stock_value: 984_000 },
  { item_code: "CAM-GA-10KG", warehouse: "Kho chính", actual_qty: 40, reserved_qty: 0, projected_qty: 40, valuation_rate: 9_500, stock_value: 380_000 },
];

const PAYMENTS = [
  { name: "PE-0001", party: "CUST-00001", posting_date: "2026-09-06", paid_amount: 8_000_000, received_amount: 8_000_000, docstatus: 1 },
];

function saveState() {
  if (!STATE_FILE) return;
  try {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({
        payments: PAYMENTS,
        sales_orders: SALES_ORDERS,
        quotations: QUOTATIONS,
        purchase_orders: PURCHASE_ORDERS,
        delivery_notes: DELIVERY_NOTES,
        purchase_receipts: PURCHASE_RECEIPTS,
        sales_invoices: SALES_INVOICES,
        stock_entries: STOCK_ENTRIES,
        customers_created: CUSTOMERS_CREATED,
      }),
      "utf8",
    );
  } catch {
    // A mock that cannot persist must not crash the request.
  }
}

/**
 * B2 — Sales Orders written through the mock. An order is a REAL multi-line
 * document, so the fixture holds a full line array and a computed total: a
 * verifier that only checked "a document exists" would pass on an empty order.
 *
 * DECLARED BEFORE the state-restore block below on purpose: that block pushes
 * restored orders into this array, and the declaration sitting after it made the
 * restore throw a TDZ ReferenceError that the block's own try/catch swallowed —
 * the mock then "remembered" nothing, and every reconcile test still passed
 * because payment restore happens first. Found by the B2 duplicate test, which
 * is the first one that needs an order to survive across two mock processes.
 */
const SALES_ORDERS = [];

/**
 * B3 — Quotations written through the mock. Declared HERE, before the restore
 * block below, for the exact reason spelled out above for SALES_ORDERS: a
 * declaration after the restore block makes the restore throw a TDZ
 * ReferenceError that the block's own try/catch swallows, and the mock then
 * "remembers" nothing across processes while every single-process test still
 * passes (found in B2 the hard way).
 */
const QUOTATIONS = [];

/**
 * B4 — Purchase Orders written through the mock. Declared HERE, before the
 * restore block below, for the same reason as SALES_ORDERS/QUOTATIONS: a
 * declaration placed after the restore makes the restore throw a TDZ
 * ReferenceError inside its own try/catch, so the mock silently "remembers"
 * nothing across processes while every single-process test still passes. (That
 * bug was found the hard way in B2; this array is born on the right side of the
 * block.)
 */
const PURCHASE_ORDERS = [];

/**
 * P9-A2 — Delivery Notes written through the mock. Declared on the SAME side of
 * the restore block as the orders (see the long note above): a declaration after
 * the restore makes the restore throw a TDZ ReferenceError its own try/catch
 * swallows, and the mock then remembers nothing while every single-process test
 * still passes.
 */
const DELIVERY_NOTES = [];

/**
 * P9-B — Purchase Receipts written through the mock. Declared on the SAME side
 * of the restore block as the other ledgers (the TDZ lesson lives on the
 * declaration-site comments above): a declaration after the restore would make
 * the restore throw inside its own try/catch and the mock would silently
 * remember nothing across processes while every single-process test passes.
 */
const PURCHASE_RECEIPTS = [];

/**
 * P9-D — Sales Invoices written through the mock. Declared on the SAME side of
 * the restore block as the other ledgers (the TDZ lesson is spelled out on the
 * declarations above): a declaration after the restore would make the restore
 * throw inside its own try/catch and the mock would silently remember nothing
 * across processes while every single-process test still passed.
 */
const SALES_INVOICES = [];

/**
 * P9-E — Stock Entries written through the mock. Declared on the SAME side of
 * the restore block as the other ledgers (the TDZ lesson is spelled out on the
 * declarations above): a declaration after the restore would make the restore
 * throw inside its own try/catch and the mock would silently remember nothing
 * across processes while every single-process test still passed.
 */
const STOCK_ENTRIES = [];

/**
 * M1 — Customers written through the mock. Master data created by the app
 * joins the SAME ledger convention as every write above: declared before the
 * restore block (the TDZ lesson), persisted in the state file, and readable by
 * name — the executor's read-back is what this exists for. The FIXTURE customers
 * (DB above) stay untouched: they are the site's own master data.
 */
const CUSTOMERS_CREATED = [];

if (STATE_FILE && existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (Array.isArray(saved.payments)) PAYMENTS.push(...saved.payments);
    if (Array.isArray(saved.sales_orders)) SALES_ORDERS.push(...saved.sales_orders);
    if (Array.isArray(saved.quotations)) QUOTATIONS.push(...saved.quotations);
    if (Array.isArray(saved.purchase_orders)) PURCHASE_ORDERS.push(...saved.purchase_orders);
    if (Array.isArray(saved.delivery_notes)) DELIVERY_NOTES.push(...saved.delivery_notes);
    if (Array.isArray(saved.purchase_receipts)) PURCHASE_RECEIPTS.push(...saved.purchase_receipts);
    if (Array.isArray(saved.sales_invoices)) SALES_INVOICES.push(...saved.sales_invoices);
    if (Array.isArray(saved.stock_entries)) STOCK_ENTRIES.push(...saved.stock_entries);
    if (Array.isArray(saved.customers_created)) CUSTOMERS_CREATED.push(...saved.customers_created);
  } catch {
    // ignore a torn/invalid state file — start from the fixtures
  }
}

/**
 * P9-A2 — Sales Orders that ALREADY EXIST on the site in a SUBMITTED state.
 *
 * The mock can only CREATE drafts (submitting is a separate decision, and the
 * order capability is draft-only), so a delivery-against-an-order path had
 * nothing to be tested against: every mock order was `docstatus: 0`, which
 * ERPNext refuses to deliver against. This env-declared fixture is the site's
 * "orders someone submitted on ERPNext" — same convention as
 * MOCK_ERP_P4_FIXTURE (ONE env JSON object, per-process).
 *
 * Keys mirror real ERPNext child rows: `delivered_qty` (so "what is still owed"
 * can be exercised), `so_detail`-worthy `name`, and `warehouse`.
 */
function submittedSalesOrders() {
  if (!process.env.MOCK_ERP_SO_FIXTURE) return [];
  try {
    const rows = JSON.parse(process.env.MOCK_ERP_SO_FIXTURE);
    return Array.isArray(rows) ? rows : [];
  } catch {
    throw new Error("MOCK_ERP_SO_FIXTURE is not valid JSON");
  }
}

/**
 * P9-F — Sales Invoices that ALREADY EXIST on the site in a SUBMITTED, NON-return
 * state — the originals a return links back to. Same convention as
 * submittedSalesOrders: the mock can only CREATE drafts, so "an invoice the shop
 * already submitted" is an env-declared fixture (ONE env JSON object,
 * per-process). Rows carry `items[]` with item_code/qty/rate/uom — the lines the
 * return builder reads.
 */
function submittedSalesInvoiceFixtures() {
  if (!process.env.MOCK_ERP_INV_FIXTURE) return [];
  try {
    const rows = JSON.parse(process.env.MOCK_ERP_INV_FIXTURE);
    return Array.isArray(rows) ? rows : [];
  } catch {
    throw new Error("MOCK_ERP_INV_FIXTURE is not valid JSON");
  }
}

/** Every Sales Invoice the mock knows: written-this-session + fixture originals. */
function allSalesInvoices() {
  return [...SALES_INVOICES, ...submittedSalesInvoiceFixtures(), ...INVOICES];
}

/** Every Sales Order the mock knows: the ones written this session + the fixture. */
function allSalesOrders() {
  return [...SALES_ORDERS, ...submittedSalesOrders()];
}

/**
 * P9-B — Purchase Orders that ALREADY EXIST on the site in a SUBMITTED state.
 * Same convention as submittedSalesOrders: the mock can only CREATE drafts,
 * so a receipt-against-an-order path needs the site's "submitted POs" as an
 * env-declared fixture (ONE env JSON object, per-process).
 *
 * Keys mirror real ERPNext child rows: `received_qty` AND `returned_qty` (so
 * "what is still owed" = qty − received − returned can be exercised — the
 * measured recipes §1171 lesson), `po_detail`-worthy `name`, `warehouse`.
 */
function submittedPurchaseOrders() {
  if (!process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE) return [];
  try {
    const rows = JSON.parse(process.env.MOCK_ERP_PO_SUBMITTED_FIXTURE);
    return Array.isArray(rows) ? rows : [];
  } catch {
    throw new Error("MOCK_ERP_PO_SUBMITTED_FIXTURE is not valid JSON");
  }
}

/** Every Purchase Order the mock knows: written this session + the fixture. */
function allPurchaseOrders() {
  return [...PURCHASE_ORDERS, ...submittedPurchaseOrders()];
}

/**
 * B2 — declared selling prices, per (item, uom). A Sales Order price may NEVER
 * come from the utterance, so the mock has to have real rows for the order path
 * to be testable at all. `uom` is part of the key exactly like real ERPNext.
 */
const ITEM_PRICES = [
  { name: "IP-CAM-HEO-BAO", item_code: "CAM-HEO-25KG", uom: "Bao", price_list: "Standard Selling", price_list_rate: 305_000, currency: "VND", buying: 0, selling: 1 },
  { name: "IP-CAM-GA-BAO", item_code: "CAM-GA-10KG", uom: "Bao", price_list: "Standard Selling", price_list_rate: 250_000, currency: "VND", buying: 0, selling: 1 },
  // Kg-stocked item: a price in the item's OWN unit only — "1 Tấn" has no
  // declared price, so the builder must ASK instead of converting a price.
  { name: "IP-P1F-KG", item_code: "P1F-ACCEPT Livestock Item", uom: "Kg", price_list: "Standard Selling", price_list_rate: 21_000, currency: "VND", buying: 0, selling: 1 },
  // B4 — the BUYING side, deliberately at DIFFERENT rates than the selling side
  // (verified live 2026-09-20: CAM-HEO-25KG is 295.000/bao buying against
  // 305.000/bao selling). A purchase path that reused the selling table would
  // still "find a price" and pass a naive test; it fails here instead.
  { name: "IP-CAM-HEO-BAO-BUY", item_code: "CAM-HEO-25KG", uom: "Bao", price_list: "Standard Buying", price_list_rate: 295_000, currency: "VND", buying: 1, selling: 0 },
  { name: "IP-CAM-GA-BAO-BUY", item_code: "CAM-GA-10KG", uom: "Bao", price_list: "Standard Buying", price_list_rate: 240_000, currency: "VND", buying: 1, selling: 0 },
  // P1F has NO buying price on purpose: the purchase path must ASK rather than
  // fall back to the selling price it can see (that fallback is the bug).
];

/**
 * Accounting fixtures for the REAL Payment Entry payload (Stage B).
 * Values mirror what the real ERPNext returns for `erpnext_doc_get` on a
 * Sales Invoice / Mode of Payment — the write path reads these at execute
 * time instead of hardcoding account names.
 */
const COMPANY = "Demo Feed Co";
/**
 * A2 (2026-09-24) — the warehouse a purchase line uses, mirroring a site whose
 * stock items DO declare `Item Default.default_warehouse`. The REAL site, as
 * measured today, does not: `MOCK_ERP_NO_ITEM_DEFAULT_WAREHOUSE` reproduces that
 * (and the PO path must then REFUSE, never pick a warehouse of its own).
 */
const DEFAULT_WAREHOUSE = "Stores - DFC";
const RECEIVABLE_ACCOUNT = "1310 - Debtors - DFC";
/**
 * P9-C — the payable ledger. Mirrors the real site's `2110 - Phải trả người bán`
 * (read live in the erpnext-rest-api-recipes skill): a pay-out reads this off the
 * Purchase Invoice's OWN `credit_to`, exactly the way a receipt reads `debit_to`
 * off the Sales Invoice — so nothing here is a hardcoded account name.
 */
const PAYABLE_ACCOUNT = "2110 - Payable - DFC";

/**
 * P9-C — open PURCHASE INVOICES: money the shop owes its suppliers. These are
 * the PAY-side anchors (a supplier payment allocates against one, the same way a
 * receipt allocates against a Sales Invoice). Declared HERE, after COMPANY, so
 * the fixture can name the real company/account constants instead of duplicating
 * their strings; read-only data (this path never creates one), so it needs no
 * state persistence.
 *
 * Deliberately mirrors the sales side's shape: one supplier with TWO invoices
 * (one of them settled — PINV-0002 must never be offered as a target), and
 * "Anh Bảy" (SUP-BAY) with a single small one. A supplier with NO open invoice
 * is the refusal case and needs no fixture of its own — say the name of a
 * supplier that has none, or ask about a settled one only.
 */
const PURCHASE_INVOICES = [
  { name: "PINV-0001", supplier: "SUP-HATIEN", posting_date: "2026-09-02", grand_total: 12_000_000, outstanding_amount: 5_000_000, company: COMPANY, credit_to: PAYABLE_ACCOUNT, docstatus: 1 },
  { name: "PINV-0002", supplier: "SUP-HATIEN", posting_date: "2026-09-07", grand_total: 3_000_000, outstanding_amount: 0, company: COMPANY, credit_to: PAYABLE_ACCOUNT, docstatus: 1 },
  { name: "PINV-0003", supplier: "SUP-HATIEN-2", posting_date: "2026-09-11", grand_total: 900_000, outstanding_amount: 900_000, company: COMPANY, credit_to: PAYABLE_ACCOUNT, docstatus: 1 },
  { name: "PINV-0004", supplier: "SUP-BAY", posting_date: "2026-09-10", grand_total: 1_500_000, outstanding_amount: 1_500_000, company: COMPANY, credit_to: PAYABLE_ACCOUNT, docstatus: 1 },
];
/**
 * Deliberately mirrors the real site: the Vietnamese label "Tiền mặt" is NOT
 * a stored Mode of Payment — only "Cash" / "Chuyển khoản" are. Anything that
 * hardcodes the label instead of resolving it fails here, exactly like ERPNext
 * rejected the write with LinkValidationError on 2026-09-16.
 */
const MODES = [
  { name: "Chuyển khoản", enabled: 1, type: "Cash" },
  { name: "Cash", enabled: 1, type: "Cash" },
  { name: "Wire Transfer", enabled: 1, type: "Bank" },
];
const MODE_ACCOUNTS = {
  Cash: "1110 - Cash - DFC",
  "Chuyển khoản": "1120 - Bank - DFC",
  "Wire Transfer": "1120 - Bank - DFC",
};

/** result9: the copilot inventory filter needs item_name — mirror the real tool's shape. */
const ITEMS = [
  // `stock_uom` is present on the real 3.0.4 item_list payload (verified live
  // 2026-09-20). `Item.uom` does NOT exist as a queryable field on that site
  // (HTTP 417), which is why B1 treats stock_uom as the item's default unit.
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao", is_stock_item: 1, standard_rate: 0 },
  { name: "CAM-GA-10KG", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", stock_uom: "Bao", is_stock_item: 1, standard_rate: 0 },
  // A Kg-stocked item — the one case where a DIRECT factor (Tấn→Kg) exists, so
  // the happy conversion path is testable without inventing ERPNext data.
  { name: "P1F-ACCEPT Livestock Item", item_code: "P1F-ACCEPT Livestock Item", item_name: "P1F-ACCEPT Livestock Item", stock_uom: "Kg", is_stock_item: 0, standard_rate: 0 },
];

/**
 * UOM names — deliberately mirrors the LIVE site's quirks (2026-09-20):
 * "Thung" has no diacritic (the Vietnamese word is "thùng"), and "Cây"/"Bó"/
 * "Tạ" do NOT exist. A resolver that invents nicer names must fail here.
 */
const UOMS = ["Bao", "Tấn", "Kg", "Xe", "Thung", "Viên", "Mét", "m3"];

/**
 * UOM Conversion Factor rows — the two the real site actually has, GLOBAL (the
 * real doctype has no `item_code` field at all). Deliberately NO Kg→Bao and no
 * Tấn→Bao: that absence is the behaviour under test (B1 must ASK, not invert).
 */
const UOM_FACTORS = [
  { name: "MAT-UOM-CNV-00237", from_uom: "Tấn", to_uom: "Kg", value: 1000, category: "Mass" },
  { name: "MAT-UOM-CNV-00236", from_uom: "Bao", to_uom: "Kg", value: 25, category: "Mass" },
];

/**
 * The companies on this site. One entry: "several companies, none pinned" is the
 * case the order path must REFUSE, and a test overlays it via env injection.
 */
const COMPANIES = process.env.MOCK_ERP_COMPANIES
  ? String(process.env.MOCK_ERP_COMPANIES).split(",").map((c) => c.trim()).filter(Boolean)
  : [COMPANY];

/**
 * B2 — the correlation field on Sales Order is what makes an order once-only.
 * A real site that has NOT run the migration has no such field: filtering by it
 * is a Frappe error and creating with it drops the key. Both halves are
 * simulated behind one opt-in flag, because a mock that always HAS the field
 * would make the executor's fail-closed check untestable.
 */
function soCorrelationAvailable() {
  return process.env.MOCK_ERP_SO_NO_CORRELATION_FIELD !== "1";
}

/** Same opt-in flag shape for the quotation path (B3). */
function qtCorrelationAvailable() {
  return process.env.MOCK_ERP_QT_NO_CORRELATION_FIELD !== "1";
}

/**
 * Same opt-in flag shape for the purchase path (B4). Its own flag rather than a
 * shared one: the executor must refuse with PO_CORRELATION_FIELD_MISSING when
 * PURCHASE ORDER lacks the field, and a test that flipped a shared flag could
 * not tell which path refused.
 */
function poCorrelationAvailable() {
  return process.env.MOCK_ERP_PO_NO_CORRELATION_FIELD !== "1";
}

/**
 * next3/B — the document-identity column, mirroring the contract's declaration.
 *
 * Its OWN flag again, and here the reason is concrete rather than theoretical:
 * the correlation field and the doc-key field arrive by two SEPARATE migrations,
 * so a site that has one and not the other is a real state the mock must be able
 * to represent (the executor refuses differently in each case).
 */
const DOC_KEY_FIELD = "custom_business_doc_key";
function poDocKeyAvailable() {
  return process.env.MOCK_ERP_PO_NO_DOC_KEY_FIELD !== "1";
}

/**
 * Same opt-in flag shape for the delivery path (P9-A2), with its OWN flag for
 * the same reason as the purchase path: the executor must refuse with
 * DN_CORRELATION_FIELD_MISSING when DELIVERY NOTE lacks the field, and a shared
 * flag could not tell which path refused.
 */
function dnCorrelationAvailable() {
  return process.env.MOCK_ERP_DN_NO_CORRELATION_FIELD !== "1";
}

/**
 * Same opt-in flag shape for the receiving path (P9-B), with its OWN flag for
 * the same reason as the purchase/delivery paths: the executor must refuse
 * with PR_CORRELATION_FIELD_MISSING when PURCHASE RECEIPT lacks the field,
 * and a shared flag could not tell which path refused.
 */
function prCorrelationAvailable() {
  return process.env.MOCK_ERP_PR_NO_CORRELATION_FIELD !== "1";
}

/**
 * Same opt-in flag shape for the invoice path (P9-D), with its OWN flag for the
 * same reason as the purchase/delivery/receipt paths: the executor must refuse
 * with SI_CORRELATION_FIELD_MISSING when SALES INVOICE lacks the field, and a
 * shared flag could not tell which path refused.
 */
function siCorrelationAvailable() {
  return process.env.MOCK_ERP_SI_NO_CORRELATION_FIELD !== "1";
}

/**
 * Same opt-in flag shape for the write-off path (P9-E), with its OWN flag for
 * the same reason as every path above: the executor must refuse with
 * SE_CORRELATION_FIELD_MISSING when STOCK ENTRY lacks the field, and a shared
 * flag could not tell which path refused.
 *
 * This one is not hypothetical: the migration script derives its doctype list
 * FROM THE CONTRACT, so Stock Entry only enters its scope now that this
 * capability exists — meaning a site that already ran the migration for the
 * other seven doctypes does NOT have the field here yet.
 */
function seCorrelationAvailable() {
  return process.env.MOCK_ERP_SE_NO_CORRELATION_FIELD !== "1";
}

/**
 * M1 — same opt-in flag shape for the customer-CREATE path, with its OWN flag:
 * the executor must refuse with CC_CORRELATION_FIELD_MISSING when CUSTOMER
 * lacks the field, and a shared flag could not tell which path refused (the
 * same reason every path above carries its own knob).
 */
function customerCorrelationAvailable() {
  return process.env.MOCK_ERP_CC_NO_CORRELATION_FIELD !== "1";
}

/** Every Customer the mock knows: the fixtures PLUS what this session wrote. */
function allCustomers() {
  return [...Object.values(DB), ...CUSTOMERS_CREATED];
}

/** Supplier master data (real payload shape: name, supplier_name, group, type, disabled).
 * A2 (e-invoice): `tax_id` mirrors the REAL site's shape — some suppliers have
 * an MST (measured 2026-09-23: 0300000002 → "Đại lý Cám Bình Dương"), many do
 * not. The e-invoice resolver must therefore pass on name when the master row
 * has no MST, and the nullability is what makes that path honest.
 */
const SUPPLIERS = [
  { name: "SUP-HATIEN", supplier_name: "Hà Tiên", supplier_group: "Vật liệu", supplier_type: "Company", disabled: 0 },
  { name: "SUP-HATIEN-2", supplier_name: "Hà Tiên 2", supplier_group: "Vật liệu", supplier_type: "Company", disabled: 0 },
  { name: "SUP-BAY", supplier_name: "Anh Bảy", supplier_group: "Vận chuyển", supplier_type: "Individual", disabled: 0 },
  // The ONE supplier whose tax id the e-invoice fixture carries — same MST the
  // real site has for "Đại lý Cám Bình Dương", so A2's fixture proves the match
  // by tax id on BOTH mock and real without inventing a second identity.
  { name: "SUP-BINH-DUONG", supplier_name: "Đại lý Cám Bình Dương", tax_id: "0300000002", supplier_group: "Vật liệu", supplier_type: "Company", disabled: 0 },
];

/**
 * B2 — create a Sales Order the way ERPNext would: the header needs the party
 * and the company, every line needs a real item, a real UOM and a positive
 * quantity/rate, and the total is COMPUTED BY THE SERVER (never sent by the
 * caller) — the same reason the real doctype recomputes it.
 *
 * Deliberately still NO dedupe on the correlation field: real ERPNext has no
 * unique constraint there, so a mock that deduped would hide exactly the
 * double-write bug this phase exists to prevent.
 */
function createSalesOrder(data) {
  for (const required of ["customer", "company"]) {
    if (!data[required]) throw new Error(`${required} is mandatory`);
  }
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) throw new Error("items cannot be empty");
  const lines = items.map((l) => {
    if (!l.item_code) throw new Error("items.item_code is mandatory");
    if (!ITEMS.some((i) => i.item_code === l.item_code)) {
      throw new Error(`LinkValidationError: Could not find Item ${l.item_code}`);
    }
    if (!UOMS.includes(l.uom)) {
      // The live site stores "Thung" (no diacritic) and has no "Thùng" — an
      // invented unit name must fail here exactly like it fails there.
      throw new Error(`LinkValidationError: Could not find UOM ${l.uom}`);
    }
    const qty = Number(l.qty);
    const rate = Number(l.rate);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("items.qty must be positive");
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("items.rate must be positive");
    const factor = Number(l.conversion_factor ?? 1);
    if (!Number.isFinite(factor) || factor <= 0) throw new Error("items.conversion_factor must be positive");
    return {
      item_code: l.item_code,
      qty,
      uom: l.uom,
      rate,
      conversion_factor: factor,
      stock_qty: qty * factor,
      amount: qty * rate,
      name: `SOI-M${String(SALES_ORDERS.length + 1).padStart(3, "0")}-${l.item_code}`,
    };
  });
  const net = lines.reduce((s, l) => s + l.amount, 0);
  // Taxes are ERPNext's business, not the caller's: the flag exists so the
  // "ERPNext total differs from our display estimate" path is testable (the code
  // reports the ERPNext number instead of overwriting it).
  const withTax = process.env.MOCK_ERP_SO_ADD_TAX === "1";
  const tax = withTax ? Math.round(net * 0.08) : 0;
  const doc = {
    doctype: "Sales Order",
    name: `SO-M${String(SALES_ORDERS.length + 1).padStart(3, "0")}`,
    customer: data.customer,
    company: data.company,
    transaction_date: data.transaction_date ?? new Date().toISOString().slice(0, 10),
    ...(data.delivery_date ? { delivery_date: data.delivery_date } : {}),
    items: lines,
    total: net,
    total_taxes_and_charges: tax,
    grand_total: net + tax,
    remarks: data.remarks,
    // A site that has not run the migration drops the key, exactly like ERPNext
    // ignores a field that is not in the doctype meta.
    ...(soCorrelationAvailable() && data.custom_ai_action_id != null
      ? { custom_ai_action_id: data.custom_ai_action_id }
      : {}),
    docstatus: 0, // created as DRAFT — submitting is a separate decision
  };
  // The nastiest create failure there is: the document EXISTS but is not what
  // was asked for. Opt-in only, and only for the order path — it is the state
  // the read-back verification exists to catch.
  if (process.env.MOCK_ERP_SO_DROP_LINE === "1") {
    doc.items = doc.items.slice(0, -1);
  }
  SALES_ORDERS.push(doc);
  saveState();
  if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
    throw new Error(
      "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
    );
  }
  return { data: doc, message: `Sales Order ${doc.name} created successfully` };
}

/**
 * B3 — create a Quotation the way ERPNext would.
 *
 * The party shape is the doctype's own: `quotation_to` names the linked
 * doctype and `party_name` holds the link value. A quotation sent with a bare
 * `customer` field would be created with NO party on the real site, so the mock
 * refuses it exactly like ERPNext refuses a missing mandatory link.
 *
 * Same as the order path: NO dedupe on the correlation field (real ERPNext has
 * no unique constraint there — a mock that deduped would hide the double-write
 * this phase exists to prevent).
 */
function createQuotation(data) {
  for (const required of ["party_name", "company"]) {
    if (!data[required]) throw new Error(`${required} is mandatory`);
  }
  if (String(data.quotation_to ?? "") !== "Customer") {
    throw new Error(`LinkValidationError: Quotation.quotation_to=${data.quotation_to} is not supported here`);
  }
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) throw new Error("items cannot be empty");
  const lines = items.map((l) => {
    if (!l.item_code) throw new Error("items.item_code is mandatory");
    if (!ITEMS.some((i) => i.item_code === l.item_code)) {
      throw new Error(`LinkValidationError: Could not find Item ${l.item_code}`);
    }
    if (!UOMS.includes(l.uom)) {
      throw new Error(`LinkValidationError: Could not find UOM ${l.uom}`);
    }
    const qty = Number(l.qty);
    const rate = Number(l.rate);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("items.qty must be positive");
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("items.rate must be positive");
    const factor = Number(l.conversion_factor ?? 1);
    if (!Number.isFinite(factor) || factor <= 0) throw new Error("items.conversion_factor must be positive");
    return {
      item_code: l.item_code,
      qty,
      uom: l.uom,
      rate,
      conversion_factor: factor,
      stock_qty: qty * factor,
      amount: qty * rate,
      name: `QTI-M${String(QUOTATIONS.length + 1).padStart(3, "0")}-${l.item_code}`,
    };
  });
  const net = lines.reduce((s, l) => s + l.amount, 0);
  const withTax = process.env.MOCK_ERP_QT_ADD_TAX === "1";
  const tax = withTax ? Math.round(net * 0.08) : 0;
  const doc = {
    doctype: "Quotation",
    name: `QTN-M${String(QUOTATIONS.length + 1).padStart(3, "0")}`,
    quotation_to: "Customer",
    party_name: data.party_name,
    company: data.company,
    transaction_date: data.transaction_date ?? new Date().toISOString().slice(0, 10),
    ...(data.valid_till ? { valid_till: data.valid_till } : {}),
    items: lines,
    total: net,
    total_taxes_and_charges: tax,
    grand_total: net + tax,
    remarks: data.remarks,
    ...(qtCorrelationAvailable() && data.custom_ai_action_id != null
      ? { custom_ai_action_id: data.custom_ai_action_id }
      : {}),
    docstatus: 0, // DRAFT — a quotation is an offer, not a booking
  };
  if (process.env.MOCK_ERP_QT_DROP_LINE === "1") {
    doc.items = doc.items.slice(0, -1);
  }
  QUOTATIONS.push(doc);
  saveState();
  if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
    throw new Error(
      "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
    );
  }
  return { data: doc, message: `Quotation ${doc.name} created successfully` };
}

/**
 * B4 — create a Purchase Order the way ERPNext would.
 *
 * The party is a bare `supplier` link (not a customer), the supplier must exist
 * in the master data (a real LinkValidationError otherwise), and every line
 * carries `schedule_date` — mandatory on Purchase Order Item in standard
 * ERPNext, so a payload that forgot it must fail here exactly like it fails
 * there. The total is COMPUTED BY THE SERVER, never sent by the caller.
 *
 * Same as the other write paths: NO dedupe on the correlation field (real
 * ERPNext has no unique constraint there; a mock that deduped would hide the
 * double-write these phases exist to prevent).
 */
function createPurchaseOrder(data) {
  for (const required of ["supplier", "company"]) {
    if (!data[required]) throw new Error(`${required} is mandatory`);
  }
  if (!SUPPLIERS.some((s) => s.name === data.supplier)) {
    // Real ERPNext: LinkValidationError when the supplier does not exist. This
    // is the check that keeps an invented supplier id out of a ledger.
    throw new Error(`LinkValidationError: Could not find Supplier ${data.supplier}`);
  }
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) throw new Error("items cannot be empty");
  const lines = items.map((l) => {
    if (!l.item_code) throw new Error("items.item_code is mandatory");
    if (!ITEMS.some((i) => i.item_code === l.item_code)) {
      throw new Error(`LinkValidationError: Could not find Item ${l.item_code}`);
    }
    if (!UOMS.includes(l.uom)) {
      throw new Error(`LinkValidationError: Could not find UOM ${l.uom}`);
    }
    if (!l.schedule_date) throw new Error("items.schedule_date is mandatory");
    const qty = Number(l.qty);
    const rate = Number(l.rate);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("items.qty must be positive");
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("items.rate must be positive");
    const factor = Number(l.conversion_factor ?? 1);
    if (!Number.isFinite(factor) || factor <= 0) throw new Error("items.conversion_factor must be positive");
    return {
      item_code: l.item_code,
      qty,
      uom: l.uom,
      rate,
      schedule_date: l.schedule_date,
      conversion_factor: factor,
      stock_qty: qty * factor,
      amount: qty * rate,
      name: `POI-M${String(PURCHASE_ORDERS.length + 1).padStart(3, "0")}-${l.item_code}`,
    };
  });
  const net = lines.reduce((s, l) => s + l.amount, 0);
  const withTax = process.env.MOCK_ERP_PO_ADD_TAX === "1";
  const tax = withTax ? Math.round(net * 0.08) : 0;
  const doc = {
    doctype: "Purchase Order",
    name: `PO-M${String(PURCHASE_ORDERS.length + 1).padStart(3, "0")}`,
    supplier: data.supplier,
    company: data.company,
    transaction_date: data.transaction_date ?? new Date().toISOString().slice(0, 10),
    items: lines,
    total: net,
    total_taxes_and_charges: tax,
    grand_total: net + tax,
    remarks: data.remarks,
    // A site that has not run the migration drops the key, exactly like ERPNext
    // ignores a field that is not in the doctype meta.
    ...(poCorrelationAvailable() && data.custom_ai_action_id != null
      ? { custom_ai_action_id: data.custom_ai_action_id }
      : {}),
    // same convention for the document-identity column (next3/B): absent field ⇒
    // the value is dropped, which is precisely the state the executor's read-back
    // is built to catch.
    ...(poDocKeyAvailable() && data[DOC_KEY_FIELD] != null ? { [DOC_KEY_FIELD]: data[DOC_KEY_FIELD] } : {}),
    docstatus: 0, // DRAFT — committing money to a supplier is a human decision
  };
  if (process.env.MOCK_ERP_PO_DROP_LINE === "1") {
    doc.items = doc.items.slice(0, -1);
  }
  PURCHASE_ORDERS.push(doc);
  saveState();
  if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
    throw new Error(
      "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
    );
  }
  return { data: doc, message: `Purchase Order ${doc.name} created successfully` };
}

/**
 * P9-A2 — create a Delivery Note the way ERPNext would.
 *
 * ERPNext's OWN validations are reproduced here, because a mock that accepts
 * more than the site is a mock that certifies writes the site would reject:
 *
 *  - every item must carry `against_sales_order`, and that order must EXIST and
 *    be SUBMITTED (a draft order cannot be delivered against — that is the
 *    whole reason DN_SO_NOT_SUBMITTED exists upstream);
 *  - `so_detail` must name a real child row of that order;
 *  - `qty` must be positive and must not exceed that row's pending quantity:
 *    `qty − delivered_qty`. ERPNext blocks over-delivery, so the mock does too —
 *    otherwise the executor's own re-check could never be seen to matter.
 *
 * A created note stays a DRAFT and does NOT touch `delivered_qty`: in ERPNext
 * only SUBMIT moves stock and advances what an order has delivered. That is the
 * single most important thing to mirror, because a mock that advanced it on
 * create would make "draft is harmless" look true for the wrong reason.
 */
function createDeliveryNote(data) {
  const customer = String(data.customer ?? "");
  if (!customer) throw new Error("customer is mandatory");
  if (!DB[customer]) throw new Error(`LinkValidationError: Could not find Customer ${customer}`);
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) throw new Error("items cannot be empty");

  const lines = items.map((l) => {
    const soName = String(l.against_sales_order ?? "");
    if (!soName) {
      throw new Error("against_sales_order is mandatory on a Delivery Note item (link it to the order it fulfils)");
    }
    const so = allSalesOrders().find((s) => s.name === soName);
    if (!so) throw new Error(`LinkValidationError: Could not find Sales Order ${soName}`);
    if (Number(so.docstatus) !== 1) {
      throw new Error(
        `ValidationError: Sales Order ${soName} is not submitted — a Delivery Note cannot be raised against a draft order`,
      );
    }
    if (String(so.customer ?? "") !== customer) {
      throw new Error(`ValidationError: Sales Order ${soName} belongs to ${so.customer}, not ${customer}`);
    }
    const soRow = (so.items ?? []).find((it) => String(it.name) === String(l.so_detail ?? ""))
      ?? (so.items ?? []).find((it) => String(it.item_code) === String(l.item_code));
    if (!soRow) throw new Error(`ValidationError: ${l.item_code} is not a line of Sales Order ${soName}`);
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("items.qty must be positive");
    const pending = Number(soRow.qty ?? 0) - Number(soRow.delivered_qty ?? 0);
    if (qty > pending + 1e-9) {
      throw new Error(
        `ValidationError: over-delivery on ${l.item_code} — ${qty} > ${pending} still pending on ${soName}`,
      );
    }
    return {
      name: `DNI-M${String(DELIVERY_NOTES.length + 1).padStart(3, "0")}-${l.item_code}`,
      item_code: l.item_code,
      item_name: soRow.item_name ?? l.item_code,
      qty,
      uom: l.uom ?? soRow.uom ?? soRow.stock_uom,
      ...(l.warehouse ? { warehouse: l.warehouse } : {}),
      against_sales_order: soName,
      so_detail: String(l.so_detail ?? soRow.name ?? ""),
      rate: soRow.rate ?? 0,
    };
  });

  const doc = {
    doctype: "Delivery Note",
    name: `DN-M${String(DELIVERY_NOTES.length + 1).padStart(3, "0")}`,
    customer,
    company: data.company,
    posting_date: data.posting_date ?? new Date().toISOString().slice(0, 10),
    items: lines,
    against_sales_order: lines[0]?.against_sales_order ?? null,
    remarks: data.remarks,
    // A site that has not run the migration drops the key, exactly like ERPNext
    // ignores a field that is not in the doctype meta — and the executor must
    // then report it instead of assuming the once-only guard held.
    ...(dnCorrelationAvailable() && data.custom_ai_action_id != null
      ? { custom_ai_action_id: data.custom_ai_action_id }
      : {}),
    docstatus: 0, // DRAFT — only submit moves stock, and chat never submits
  };
  if (process.env.MOCK_ERP_DN_DROP_LINE === "1") {
    doc.items = doc.items.slice(0, -1);
  }
  if (process.env.MOCK_ERP_DN_DRIFT_QTY === "1") {
    doc.items = doc.items.map((l) => ({ ...l, qty: Number(l.qty) + 1 }));
  }
  DELIVERY_NOTES.push(doc);
  saveState();
  if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
    throw new Error(
      "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
    );
  }
  return { data: doc, message: `Delivery Note ${doc.name} created successfully` };
}

/**
 * P9-B — create a Purchase Receipt the way ERPNext would.
 *
 * The site's OWN validations are reproduced, because a mock that accepts more
 * than the site certifies writes the site would reject:
 *
 *  - every item must carry `purchase_order`, and that order must EXIST and be
 *    SUBMITTED (the mirror of the DN's against_sales_order check);
 *  - `po_detail` must name a real child row of that order;
 *  - `qty` must be positive and must not exceed that row's pending
 *    (`qty − received_qty − returned_qty`) — ERPNext blocks over-receipt;
 *  - `rate` must equal the PO row's rate (measured live:
 *    validate_rate_with_reference_doc answers HTTP 417 "Đơn giá phải giống
 *    với Purchase Order" otherwise).
 *
 * A created receipt stays a DRAFT and does NOT touch `received_qty`: only
 * SUBMIT moves stock — a mock that advanced it on create would make "draft is
 * harmless" look true for the wrong reason (the exact DN-mock lesson).
 */
function createPurchaseReceipt(data) {
  const supplier = String(data.supplier ?? "");
  if (!supplier) throw new Error("supplier is mandatory");
  if (!SUPPLIERS.some((s) => s.name === supplier)) {
    throw new Error(`LinkValidationError: Could not find Supplier ${supplier}`);
  }
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) throw new Error("items cannot be empty");

  const lines = items.map((l) => {
    const poName = String(l.purchase_order ?? "");
    if (!poName) {
      throw new Error("purchase_order is mandatory on a Purchase Receipt item (link it to the order it fulfils)");
    }
    const po = allPurchaseOrders().find((p) => p.name === poName);
    if (!po) throw new Error(`LinkValidationError: Could not find Purchase Order ${poName}`);
    if (Number(po.docstatus) !== 1) {
      throw new Error(
        `ValidationError: Purchase Order ${poName} is not submitted — a Purchase Receipt cannot be raised against a draft order`,
      );
    }
    if (String(po.supplier ?? "") !== supplier) {
      throw new Error(`ValidationError: Purchase Order ${poName} belongs to ${po.supplier}, not ${supplier}`);
    }
    const poRow = (po.items ?? []).find((it) => String(it.name) === String(l.po_detail ?? ""))
      ?? (po.items ?? []).find((it) => String(it.item_code) === String(l.item_code));
    if (!poRow) throw new Error(`ValidationError: ${l.item_code} is not a line of Purchase Order ${poName}`);
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("items.qty must be positive");
    const pending =
      Number(poRow.qty ?? 0) - Number(poRow.received_qty ?? 0) - Number(poRow.returned_qty ?? 0);
    if (qty > pending + 1e-9) {
      throw new Error(
        `ValidationError: over-receipt on ${l.item_code} — ${qty} > ${pending} still pending on ${poName}`,
      );
    }
    const rate = Number(l.rate ?? poRow.rate ?? 0);
    if (Math.abs(rate - Number(poRow.rate ?? 0)) > 1e-9) {
      throw new Error(
        `ValidationError: Đơn giá phải giống với Purchase Order: ${poName} (${rate} / ${poRow.rate})`,
      );
    }
    return {
      name: `PRI-M${String(PURCHASE_RECEIPTS.length + 1).padStart(3, "0")}-${l.item_code}`,
      item_code: l.item_code,
      item_name: poRow.item_name ?? l.item_code,
      qty,
      rate,
      uom: l.uom ?? poRow.uom ?? poRow.stock_uom,
      ...(l.warehouse ? { warehouse: l.warehouse } : {}),
      purchase_order: poName,
      po_detail: String(l.po_detail ?? poRow.name ?? ""),
    };
  });

  const doc = {
    doctype: "Purchase Receipt",
    name: `PR-M${String(PURCHASE_RECEIPTS.length + 1).padStart(3, "0")}`,
    supplier,
    company: data.company,
    posting_date: data.posting_date ?? new Date().toISOString().slice(0, 10),
    items: lines,
    purchase_order: lines[0]?.purchase_order ?? null,
    remarks: data.remarks,
    // A site without the migration drops the key, exactly like ERPNext ignores
    // a field not in the doctype meta — the executor must report it instead of
    // assuming the once-only guard held.
    ...(prCorrelationAvailable() && data.custom_ai_action_id != null
      ? { custom_ai_action_id: data.custom_ai_action_id }
      : {}),
    docstatus: 0, // DRAFT — only submit moves stock, and chat never submits
  };
  if (process.env.MOCK_ERP_PR_DROP_LINE === "1") {
    doc.items = doc.items.slice(0, -1);
  }
  if (process.env.MOCK_ERP_PR_DRIFT_QTY === "1") {
    doc.items = doc.items.map((l) => ({ ...l, qty: Number(l.qty) + 1 }));
  }
  PURCHASE_RECEIPTS.push(doc);
  saveState();
  if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
    throw new Error(
      "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
    );
  }
  return { data: doc, message: `Purchase Receipt ${doc.name} created successfully` };
}

/**
/**
 * P9-F — create a Sales RETURN (is_return=1) the way the REAL site behaves
 * (shape measured 2026-09-23 on ACC-SINV-2026-00052 ← 00049 and -00007 ← -00006):
 *
 *  - `return_against` is MANDATORY and must point at a SUBMITTED, NON-return
 *    invoice (the site refuses returning into a return);
 *  - `update_stock` must come in as 1 — a return RECEIVES goods (the real site
 *    accepts it; MOCK_ERP_SR_FORCE_NOSTOCK simulates one that drops it so the
 *    read-back verification can be seen to matter);
 *  - every line's `qty` arrives NEGATIVE and the site stores it negative;
 *  - `rate` must EQUAL the original invoice line's rate (a return refunds at
 *    the SOLD price);
 *  - the absolute qty must not exceed what was SOLD on that line minus what
 *    previous SUBMITTED returns already received — ERPNext blocks returning
 *    more than was sold. (Open DRAFT returns are the SKILL's cover to compute,
 *    not the site's — the site only counts submitted ones at create time.)
 *  - a created return stays a DRAFT and does NOT touch stock or receivables —
 *    only SUBMIT books the SLE and the credit note.
 */
/**
 * M1 — create a Customer the way ERPNext would (master data, NOT a
 * transaction document):
 *
 *  - `customer_name` is MANDATORY and there is no draft state — the record is
 *    REAL the moment create returns (docstatus is fixed 0 forever; Customer has
 *    no submit in ERPNext — the mock mirrors that by not accepting one);
 *  - DELIBERATELY NO duplicate check: real ERPNext happily creates two
 *    customers with the same name/phone — the business-key dedup is the
 *    SKILL's pre-check, and a mock that deduped would make that pre-check
 *    look correct for the wrong reason (the same discipline as the
 *    reference_no rule on Payment Entry above);
 *  - a site without the correlation Custom Field drops the key, exactly like
 *    every other path — the executor must report it, not assume the guard held;
 *  - the CLASSIFICATION fields are validated the way the site does it
 *    (M1-site, 2026-09-24): a Link that does not exist is a LinkValidationError,
 *    a Select outside its own options is a ValidationError, and a reqd field
 *    left empty takes the site's OWN default. Without these rules the original
 *    bug (`customer_group: "Múa"` — a group the site never had) could not be
 *    reproduced by any test, which is why it shipped in the first place.
 */
function createCustomer(data) {
  const name = String(data.customer_name ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("customer_name is mandatory");
  const fieldOf = (fieldname) => CUSTOMER_DOCFIELDS.find((f) => f.fieldname === fieldname) ?? null;

  // Link fields: exist or refuse (the real failure mode). `null`/absent is legal
  // because both fields are NOT required on this doctype.
  for (const [fieldname, master, label] of [
    ["customer_group", CUSTOMER_GROUPS, "Customer Group"],
    ["territory", TERRITORIES, "Territory"],
  ]) {
    const value = data[fieldname] == null ? null : String(data[fieldname]).trim();
    if (value && !master.some((m) => m.name === value)) {
      throw new Error(`LinkValidationError: Could not find ${label}: ${value}`);
    }
  }
  // Select: only the site's own options; a reqd field left empty takes the
  // site's declared default (Frappe fills it on insert — measured on the real
  // site: `customer_type` is reqd with default "Company").
  const typeField = fieldOf("customer_type");
  const typeOptions = String(typeField?.options ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const sentType = data.customer_type == null ? "" : String(data.customer_type).trim();
  if (sentType && !typeOptions.includes(sentType)) {
    throw new Error(`ValidationError: ${sentType} is not a valid value for customer_type`);
  }
  const effectiveType = sentType || (typeField?.reqd === 1 && typeField?.default ? String(typeField.default) : "");

  const doc = {
    doctype: "Customer",
    name: `CUST-M${String(CUSTOMERS_CREATED.length + 1).padStart(3, "0")}`,
    customer_name: name,
    ...(effectiveType ? { customer_type: effectiveType } : {}),
    // Only what was SENT (or the site's own default) lands on the record: an
    // omitted classification stays a real `null`, never an invented value.
    customer_group: data.customer_group ?? null,
    territory: data.territory ?? null,
    disabled: 0,
    ...(data.mobile_no ? { mobile_no: String(data.mobile_no) } : {}),
    ...(data.tax_id ? { tax_id: String(data.tax_id) } : {}),
    ...(customerCorrelationAvailable() && data.custom_ai_action_id != null
      ? { custom_ai_action_id: data.custom_ai_action_id }
      : {}),
    remarks: data.remarks,
    docstatus: 0, // Customer never submits — master data has no draft/submit cycle
  };
  CUSTOMERS_CREATED.push(doc);
  saveState();
  if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
    throw new Error(
      "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
    );
  }
  return { data: doc, message: `Customer ${doc.name} created successfully` };
}

function createSalesReturn(data) {
  const customer = String(data.customer ?? "");
  if (!customer) throw new Error("customer is mandatory");
  if (!DB[customer]) throw new Error(`LinkValidationError: Could not find Customer ${customer}`);
  if (Number(data.is_return ?? 0) !== 1) {
    throw new Error("ValidationError: a Sales Return must carry is_return=1");
  }
  const against = String(data.return_against ?? "");
  if (!against) throw new Error("return_against is mandatory on a Sales Return");
  const original = allSalesInvoices().find((d) => d.name === against);
  if (!original) throw new Error(`LinkValidationError: Could not find Sales Invoice ${against}`);
  if (Number(original.docstatus) !== 1) {
    throw new Error(
      `ValidationError: Sales Invoice ${against} is not submitted — a return must link a SUBMITTED invoice`,
    );
  }
  if (Number(original.is_return ?? 0) === 1) {
    throw new Error("ValidationError: cannot return against a return (is_return=1)");
  }
  if (String(original.customer ?? "") !== customer) {
    throw new Error(
      `ValidationError: Sales Invoice ${against} belongs to ${original.customer}, not ${customer}`,
    );
  }
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) throw new Error("items cannot be empty");

  const lines = items.map((l) => {
    const code = String(l.item_code ?? "");
    const origLine = (original.items ?? []).find((it) => String(it.item_code) === code);
    if (!origLine) {
      throw new Error(`ValidationError: ${code} is not a line of Sales Invoice ${against}`);
    }
    const rate = Number(l.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("items.rate must be positive (a return line carries the INVOICE's price)");
    }
    if (Math.abs(rate - Number(origLine.rate ?? 0)) > 1e-9) {
      throw new Error(
        `ValidationError: Đơn giá phải giống với hoá đơn gốc ${against} (${rate} / ${origLine.rate})`,
      );
    }
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty >= 0) {
      throw new Error(`ValidationError: a return line qty must be NEGATIVE (got ${qty} for ${code})`);
    }
    const alreadyBack = INVOICES.filter(
      (d) => Number(d.is_return ?? 0) === 1 && String(d.return_against ?? "") === against,
    ).reduce(
      (sum, d) =>
        sum +
        (d.items ?? [])
          .filter((it) => String(it.item_code) === code)
          .reduce((s, it) => s + Math.abs(Number(it.qty) || 0), 0),
      0,
    );
    const wantBack = Math.abs(qty);
    if (wantBack - (Math.abs(Number(origLine.qty) || 0) - alreadyBack) > 1e-9) {
      throw new Error(
        `ValidationError: return exceeds sold on ${code} — ${wantBack} > ${Math.abs(Number(origLine.qty) || 0) - alreadyBack} still returnable on ${against}`,
      );
    }
    return {
      name: `SII-M${String(SALES_INVOICES.length + 1).padStart(3, "0")}-${code}`,
      item_code: code,
      item_name: origLine.item_name ?? code,
      qty,
      rate,
      amount: qty * rate,
      uom: l.uom ?? origLine.uom ?? null,
      return_against: against,
    };
  });

  if (Number(data.update_stock ?? 0) !== 1) {
    throw new Error("ValidationError: a Sales Return must carry update_stock=1 (the goods come back)");
  }

  const netTotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const doc = {
    doctype: "Sales Invoice",
    name: `SI-M${String(SALES_INVOICES.length + 1).padStart(3, "0")}`,
    customer,
    company: data.company,
    is_return: 1,
    return_against: against,
    update_stock: 1,
    items: lines,
    net_total: netTotal,
    grand_total: netTotal,
    remarks: data.remarks,
    ...(siCorrelationAvailable() && data.custom_ai_action_id != null
      ? { custom_ai_action_id: data.custom_ai_action_id }
      : {}),
    docstatus: 0, // DRAFT — a draft return moves NOTHING
  };
  if (process.env.MOCK_ERP_SR_FORCE_NOSTOCK === "1") {
    doc.update_stock = 0; // simulate a site that dropped the flag
  }
  SALES_INVOICES.push(doc);
  saveState();
  if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
    throw new Error(
      "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
    );
  }
  return { data: doc, message: `Sales Return ${doc.name} created successfully` };
}

/**
 * P9-D — create a Sales Invoice the way ERPNext would.
 *
 * The site's OWN validations are reproduced, because a mock that accepts more
 * than the site certifies writes the site would reject:
 *
 *  - every item must carry `sales_order` (the INVOICE link — `against_sales_order`
 *    belongs to a Delivery Note, measured in erpnext-rest-api-core §205), and
 *    that order must EXIST and be SUBMITTED;
 *  - `so_detail` must name a real child row of that order;
 *  - `rate` must EXIST and must EQUAL the order row's rate — the real site
 *    answers HTTP 417 "Đơn giá phải giống với Sales Order" otherwise (the same
 *    validate_rate_with_reference_doc seen live on the buying side, recipes
 *    §417). Without this rule the executor's own price re-check could never be
 *    seen to matter;
 *  - `qty` must be positive and must not exceed the row's still-billable
 *    quantity `qty − billed_amt / rate` — ERPNext blocks over-billing.
 *
 * A created invoice stays a DRAFT and does NOT touch the order's `billed_amt`:
 * in ERPNext only SUBMIT advances it. That is the single most important thing to
 * mirror for MONEY (the twin of the Delivery Note's delivered_qty rule) — a mock
 * that advanced it on create would make "a draft is harmless" look true for the
 * wrong reason.
 */
function createSalesInvoice(data) {
  const customer = String(data.customer ?? "");
  if (!customer) throw new Error("customer is mandatory");
  if (!DB[customer]) throw new Error(`LinkValidationError: Could not find Customer ${customer}`);
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) throw new Error("items cannot be empty");

  const lines = items.map((l) => {
    const soName = String(l.sales_order ?? "");
    if (!soName) {
      throw new Error("sales_order is mandatory on a Sales Invoice item (link it to the order it bills)");
    }
    const so = allSalesOrders().find((s) => s.name === soName);
    if (!so) throw new Error(`LinkValidationError: Could not find Sales Order ${soName}`);
    if (Number(so.docstatus) !== 1) {
      throw new Error(
        `ValidationError: Sales Order ${soName} is not submitted — a Sales Invoice cannot be raised against a draft order`,
      );
    }
    if (String(so.customer ?? "") !== customer) {
      throw new Error(`ValidationError: Sales Order ${soName} belongs to ${so.customer}, not ${customer}`);
    }
    const soRow = (so.items ?? []).find((it) => String(it.name) === String(l.so_detail ?? ""))
      ?? (so.items ?? []).find((it) => String(it.item_code) === String(l.item_code));
    if (!soRow) throw new Error(`ValidationError: ${l.item_code} is not a line of Sales Order ${soName}`);
    const rate = Number(l.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("items.rate must be positive (an invoice line carries the ORDER's price)");
    }
    if (Math.abs(rate - Number(soRow.rate ?? 0)) > 1e-9) {
      throw new Error(
        `ValidationError: Đơn giá phải giống với Sales Order: ${soName} (${rate} / ${soRow.rate})`,
      );
    }
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("items.qty must be positive");
    const billed = Number(soRow.billed_amt ?? 0) / (Number(soRow.rate) > 0 ? Number(soRow.rate) : 1);
    const pending = Number(soRow.qty ?? 0) - billed;
    if (qty > pending + 1e-9) {
      throw new Error(
        `ValidationError: over-billing on ${l.item_code} — ${qty} > ${pending} still billable on ${soName}`,
      );
    }
    return {
      name: `SII-M${String(SALES_INVOICES.length + 1).padStart(3, "0")}-${l.item_code}`,
      item_code: l.item_code,
      item_name: soRow.item_name ?? l.item_code,
      qty,
      rate,
      amount: qty * rate,
      uom: l.uom ?? soRow.uom ?? soRow.stock_uom,
      sales_order: soName,
      so_detail: String(l.so_detail ?? soRow.name ?? ""),
    };
  });

  const netTotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const doc = {
    doctype: "Sales Invoice",
    name: `SI-M${String(SALES_INVOICES.length + 1).padStart(3, "0")}`,
    customer,
    company: data.company,
    posting_date: data.posting_date ?? new Date().toISOString().slice(0, 10),
    // Stored as sent, so the executor's read-back can prove the flag survived.
    // The real site accepts 1 here; MOCK_ERP_SI_FORCE_STOCK simulates a site
    // that turns it ON despite being sent 0 — the state the verification exists
    // to catch, because a stock-updating invoice books revenue with no COGS
    // (recipes §1223, "GP ảo").
    update_stock: Number(data.update_stock ?? 0),
    items: lines,
    // No tax template in the mock, so net = grand. ERPNext would add its own
    // taxes here — which is exactly why the executor reports the DOCUMENT's
    // totals rather than our arithmetic.
    net_total: netTotal,
    grand_total: netTotal,
    remarks: data.remarks,
    ...(siCorrelationAvailable() && data.custom_ai_action_id != null
      ? { custom_ai_action_id: data.custom_ai_action_id }
      : {}),
    docstatus: 0, // DRAFT — only submit books revenue, and chat never submits
  };
  if (process.env.MOCK_ERP_SI_DROP_LINE === "1") {
    doc.items = doc.items.slice(0, -1);
  }
  if (process.env.MOCK_ERP_SI_DRIFT_RATE === "1") {
    doc.items = doc.items.map((l) => ({ ...l, rate: Number(l.rate) + 1_000 }));
  }
  if (process.env.MOCK_ERP_SI_FORCE_STOCK === "1") {
    doc.update_stock = 1;
  }
  SALES_INVOICES.push(doc);
  saveState();
  if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
    throw new Error(
      "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
    );
  }
  return { data: doc, message: `Sales Invoice ${doc.name} created successfully` };
}

/**
 * UOMs the site refuses to see a fraction of (measured 2026-09-23: `Bao` has
 * `must_be_whole_number = 1`; `Tấn`/`Kg`/`Thung` do not). Modelled because the
 * write-off path is the first one where a fraction is a REAL risk: "xuất hủy
 * nửa bao cám" is a sentence someone can say, and ERPNext would answer
 * "Quantity must be a whole number for UOM Bao" — a check the builder can only
 * make if something declares the rule.
 */
const WHOLE_NUMBER_UOMS = new Set(["Bao"]);

/**
 * P9-E — create a Stock Entry, honoring the constraints MEASURED on the real
 * site (probe 2026-09-23, `StockEntryDetail` DocField meta). Each one refuses
 * the same way the site refuses, so a payload that would fail against ERPNext
 * fails here instead of passing CI:
 *
 *   company                 reqd (the package's own tool omits it — the skill
 *                           adds it, and this is what proves it was needed)
 *   stock_entry_type        reqd; this mock only implements Material Issue
 *   items[].item_code/qty   reqd, qty > 0
 *   items[].uom             reqd, must be a real UOM on the site, and `Bao` must
 *                           be a WHOLE number
 *   items[].stock_uom       reqd=true (fetch_from Item.stock_uom) — accepted when
 *                           present and correct, and treated as the site's own
 *                           value when absent, exactly like a fetch_from field
 *   items[].conversion_factor  reqd=true and NOT fetched from anywhere ⇒ genuinely
 *                           mandatory (the reason the skill sends it explicitly)
 *   s_warehouse             reqd for Material Issue (where the goods leave from)
 *   t_warehouse             FORBIDDEN for Material Issue — a target warehouse would
 *                           mean this document MOVES goods instead of writing
 *                           them off, which is a different operation entirely
 *
 * A DRAFT moves nothing: STOCK is deliberately NOT touched here, because only a
 * submit writes a Stock Ledger Entry. That is the property the write-off path's
 * whole "NHÁP first" story rests on, and the mock must not quietly contradict it.
 */
function createStockEntry(data) {
  const company = String(data.company ?? "");
  if (!company) throw new Error("company is mandatory");
  // Measured 2026-09-23: DocField.naming_series on Stock Entry is reqd=1 with
  // default=null, so NOTHING fills it in — a create without it is refused. The
  // single declared option is the series; anything else is a Select violation.
  const namingSeries = String(data.naming_series ?? "");
  if (!namingSeries) throw new Error("naming_series is mandatory");
  if (namingSeries !== "MAT-STE-.YYYY.-") {
    throw new Error(`ValidationError: ${namingSeries} is not a valid naming series for Stock Entry`);
  }
  if (!COMPANIES.includes(company)) throw new Error(`LinkValidationError: Could not find Company ${company}`);
  const entryType = String(data.stock_entry_type ?? "");
  if (!entryType) throw new Error("stock_entry_type is mandatory");
  if (entryType !== "Material Issue") {
    throw new Error(
      `ValidationError: Stock Entry Type ${entryType} is not supported by this path (only Material Issue — a write-off leaves the warehouse)`,
    );
  }
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) throw new Error("items cannot be empty");

  const lines = items.map((l) => {
    const itemCode = String(l.item_code ?? "");
    const item = ITEMS.find((i) => i.item_code === itemCode || i.name === itemCode);
    if (!item) throw new Error(`LinkValidationError: Could not find Item ${itemCode}`);
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("items.qty must be positive");
    const uom = String(l.uom ?? "");
    if (!uom) throw new Error("items.uom is mandatory");
    if (!UOMS.includes(uom)) throw new Error(`LinkValidationError: Could not find UOM ${uom}`);
    if (WHOLE_NUMBER_UOMS.has(uom) && !Number.isInteger(qty)) {
      throw new Error(`ValidationError: Quantity must be a whole number for UOM ${uom}`);
    }
    const sWarehouse = String(l.s_warehouse ?? "");
    if (!sWarehouse) throw new Error("items.s_warehouse is mandatory for Material Issue");
    if (l.t_warehouse) {
      throw new Error("ValidationError: Material Issue must not carry t_warehouse (that would move goods, not write them off)");
    }
    // `stock_uom` is reqd but fetch_from Item.stock_uom: the site fills it, and a
    // payload that sends a DIFFERENT one is a data bug worth refusing (the line
    // would be counted in a unit the item is not stocked in).
    if (l.stock_uom != null && String(l.stock_uom) !== String(item.stock_uom ?? "")) {
      throw new Error(
        `ValidationError: stock_uom ${l.stock_uom} does not match Item ${itemCode} stock_uom ${item.stock_uom}`,
      );
    }
    // reqd, and nothing fetches it — the measured reason the skill sends it.
    if (l.conversion_factor == null || String(l.conversion_factor).trim() === "") {
      throw new Error("Row #1: conversion_factor is required");
    }
    const conversionFactor = Number(l.conversion_factor);
    if (!Number.isFinite(conversionFactor) || conversionFactor <= 0) {
      throw new Error("items.conversion_factor must be positive");
    }
    if (uom === String(item.stock_uom) && conversionFactor !== 1) {
      throw new Error(
        `ValidationError: conversion_factor must be 1 when uom equals stock_uom (${uom})`,
      );
    }
    return {
      name: `SED-M${String(STOCK_ENTRIES.length + 1).padStart(3, "0")}-${itemCode}`,
      item_code: itemCode,
      item_name: item.item_name ?? itemCode,
      qty,
      uom,
      stock_uom: item.stock_uom ?? null,
      conversion_factor: conversionFactor,
      s_warehouse: sWarehouse,
    };
  });

  const doc = {
    doctype: "Stock Entry",
    name: `MAT-STE-M${String(STOCK_ENTRIES.length + 1).padStart(3, "0")}`,
    company,
    stock_entry_type: entryType,
    naming_series: namingSeries,
    items: lines,
    remarks: data.remarks,
    ...(seCorrelationAvailable() && data.custom_ai_action_id != null
      ? { custom_ai_action_id: data.custom_ai_action_id }
      : {}),
    docstatus: 0, // DRAFT — only submit writes a Stock Ledger Entry
  };
  if (process.env.MOCK_ERP_SE_DROP_LINE === "1") {
    doc.items = doc.items.slice(0, -1);
  }
  if (process.env.MOCK_ERP_SE_DRIFT_QTY === "1") {
    doc.items = doc.items.map((l) => ({ ...l, qty: Number(l.qty) + 1 }));
  }
  if (process.env.MOCK_ERP_SE_FORCE_SUBMIT === "1") {
    // Simulates a site (or a future code path) that SUBMITS the document instead
    // of leaving it a draft. The verification exists to catch exactly this: a
    // submitted write-off has already moved real goods.
    doc.docstatus = 1;
  }
  STOCK_ENTRIES.push(doc);
  saveState();
  if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
    throw new Error(
      "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
    );
  }
  return { data: doc, message: `Stock Entry ${doc.name} created successfully` };
}

/** Handlers mirror the real 3.0.4 handlers' return shapes. */
const TOOLS = {
  /**
   * Phase 7 write — the REAL shape (verified in @casys 3.0.4 source: there is
   * no `erpnext_create_payment_entry`; the create tool is `erpnext_doc_create`
   * with {doctype, data}). One code path for mock and real server: the mock
   * must accept exactly what ERPNext accepts, or the tests prove nothing.
   */
  erpnext_doc_create: (args) => {
    // Fault injection for the "lost response / transient failure" path: the
    // real client cannot tell whether ERPNext wrote the document, which is the
    // exact ambiguity the resume+reconcile flow exists for. Opt-in only.
    if (process.env.MOCK_ERP_FAIL_WRITE) {
      throw new Error(`simulated ERPNext failure (MOCK_ERP_FAIL_WRITE=${process.env.MOCK_ERP_FAIL_WRITE})`);
    }
    if (args?.doctype === "Customer") return createCustomer(args?.data ?? {});
    if (args?.doctype === "Sales Order") return createSalesOrder(args?.data ?? {});
    if (args?.doctype === "Quotation") return createQuotation(args?.data ?? {});
    if (args?.doctype === "Purchase Order") return createPurchaseOrder(args?.data ?? {});
    if (args?.doctype === "Delivery Note") return createDeliveryNote(args?.data ?? {});
    if (args?.doctype === "Purchase Receipt") return createPurchaseReceipt(args?.data ?? {});
    if (args?.doctype === "Sales Invoice") {
      // NOTE: `data` is declared further down (Payment Entry path) — read the
      // flag off `args.data` here or the reference is a TDZ TypeError.
      if (Number(args?.data?.is_return ?? 0) === 1) return createSalesReturn(args?.data ?? {});
      return createSalesInvoice(args?.data ?? {});
    }
    if (args?.doctype === "Stock Entry") return createStockEntry(args?.data ?? {});
    if (args?.doctype !== "Payment Entry") {
      throw new Error(`mock does not create doctype ${args?.doctype}`);
    }
    const data = args?.data ?? {};
    const reference = String(data.reference_no ?? "");
    if (!reference) throw new Error("reference_no is required (idempotency key)");
    // NO reference_no dedupe here on purpose: real ERPNext has no unique
    // constraint on reference_no, so a mock that dedupes would hide exactly
    // the double-write bug this phase exists to prevent (hit for real on
    // 2026-09-16 — two Payment Entries, one command_id).
    for (const required of ["party", "paid_from", "paid_to", "company"]) {
      if (!data[required]) throw new Error(`${required} is mandatory`);
    }
    const paid = Number(data.paid_amount);
    if (!Number.isFinite(paid) || paid <= 0) throw new Error("paid_amount must be positive");
    const doc = {
      doctype: "Payment Entry",
      name: `PE-M${String(PAYMENTS.length + 1).padStart(3, "0")}`,
      payment_type: data.payment_type ?? "Receive",
      party_type: data.party_type ?? "Customer",
      party: data.party,
      posting_date: data.posting_date ?? new Date().toISOString().slice(0, 10),
      paid_amount: paid,
      received_amount: Number(data.received_amount ?? paid),
      paid_from: data.paid_from,
      paid_to: data.paid_to,
      company: data.company,
      mode_of_payment: data.mode_of_payment ?? "Tiền mặt",
      reference_no: reference,
      reference_date: data.reference_date,
      // P0 §10.4 — the correlation field is stored exactly like the real site
      // stores it once the Custom Field exists. A real ERPNext WITHOUT the
      // field simply drops the key, so the mock must be able to represent that
      // absence too (it is what the executor reports as correlation_field_missing).
      ...(data.custom_ai_action_id !== undefined && data.custom_ai_action_id !== null
        ? { custom_ai_action_id: data.custom_ai_action_id }
        : {}),
      references: data.references ?? [],
      docstatus: 0, // created as DRAFT — submitting is a separate decision
    };
    PAYMENTS.push(doc);
    saveState();
    // "ERPNext committed, the response never arrived" — the single most
    // dangerous real-world case, because the caller cannot tell whether the
    // write landed. The document IS in the ledger; only the reply is lost.
    if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
      throw new Error(
        "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
      );
    }
    return { data: doc, message: `Payment Entry ${doc.name} created successfully` };
  },
  /**
   * Generic submit — mirrors the REAL 3.0.4 handler (source line ~53741):
   * `erpnext_doc_submit` {doctype, name} → frappe.client.submit. A draft is
   * submitted (docstatus 0 → 1); submitting an already-submitted doc fails,
   * exactly like the real server. Optional fault injection for the
   * "draft written, submit failed" mid-transaction case (F7-2 policy).
   */
  erpnext_doc_submit: (args) => {
    if (process.env.MOCK_ERP_FAIL_SUBMIT) {
      throw new Error(
        `simulated submit failure (MOCK_ERP_FAIL_SUBMIT=${process.env.MOCK_ERP_FAIL_SUBMIT})`,
      );
    }
    if (args?.doctype !== "Payment Entry") {
      throw new Error(`mock doc_submit does not support doctype ${args?.doctype}`);
    }
    const pe = PAYMENTS.find((p) => p.name === String(args?.name ?? ""));
    if (!pe) throw new Error(`Payment Entry ${args?.name} not found`);
    if (pe.docstatus !== 0) {
      throw new Error(`Payment Entry ${pe.name} is not submittable (docstatus ${pe.docstatus})`);
    }
    pe.docstatus = 1;
    saveState();
    // PROMPT-4 fault injection: the submit APPLIED (docstatus is now 1) but the
    // reply never reached the caller — the one case where the executor cannot
    // assume "not submitted". Mirrors MOCK_ERP_FAIL_AFTER_WRITE on the create
    // path. Opt-in only, so it never affects an ordinary test.
    if (process.env.MOCK_ERP_FAIL_SUBMIT_AFTER_WRITE) {
      throw new Error(
        "simulated LOST RESPONSE after the draft was submitted (MOCK_ERP_FAIL_SUBMIT_AFTER_WRITE)",
      );
    }
    return { data: pe, message: `Payment Entry ${pe.name} submitted successfully` };
  },
  /**
   * Real-server list path: Payment Entry by reference_no (reconcile) and Mode
   * of Payment (the write path resolves the real mode document name).
   */
  erpnext_doc_list: (args) => {
    // ERPNext unreachable exactly when we need it to reconcile.
    if (process.env.MOCK_ERP_FAIL_LIST) {
      throw new Error("simulated ERPNext read failure (MOCK_ERP_FAIL_LIST)");
    }
    // D1 — per-doctype failure knobs: the drawer debt view reads Sales Invoice
    // (the money) and Payment Entry (the optional draft hint). Being able to
    // kill ONE of them is how the "hint is optional, the money is not" split
    // gets proven without entangling two doctypes' failures.
    if (process.env.MOCK_ERP_FAIL_SI_LIST && args?.doctype === "Sales Invoice") {
      throw new Error("simulated ERPNext read failure (MOCK_ERP_FAIL_SI_LIST)");
    }
    if (process.env.MOCK_ERP_FAIL_PE_LIST && args?.doctype === "Payment Entry") {
      throw new Error("simulated ERPNext read failure (MOCK_ERP_FAIL_PE_LIST)");
    }
    // D3 — a GENERIC per-doctype failure (`MOCK_ERP_FAIL_LIST_DOCTYPE="Sales Order"`),
    // because §3.4's `partial` is about ONE section of an aggregate failing while
    // the others still answer: killing the whole list (MOCK_ERP_FAIL_LIST) cannot
    // express that, and a named knob per doctype does not scale to the D3 set.
    if (process.env.MOCK_ERP_FAIL_LIST_DOCTYPE && args?.doctype === process.env.MOCK_ERP_FAIL_LIST_DOCTYPE) {
      throw new Error(`simulated ERPNext read failure (MOCK_ERP_FAIL_LIST_DOCTYPE=${args.doctype})`);
    }
    // P4-1 — the ops.daily_summary fixture: when MOCK_ERP_P4_FIXTURE is set,
    // every doc_list on the summary doctypes is served from that ONE env JSON
    // object (a per-test single source of truth — the same way the B4 gates
    // stay closed). Declared inline: the fixture is per-process, not state.
    const __FIXTURE__ = process.env.MOCK_ERP_P4_FIXTURE
      ? JSON.parse(process.env.MOCK_ERP_P4_FIXTURE)
      : null;
    // §7.6 — a doctype the ERPNext API user may not READ. Frappe answers with a
    // PermissionError (HTTP 403), which is NOT the same shape as an empty page:
    // an empty page is a real "0 today", a denial must become a NULL block. The
    // two were never distinguishable in this fixture, so "thiếu quyền một
    // doctype" had no test — and a wrapper that mapped a denial to an empty
    // list would have published a confident 0 (the fabricated number §4.3
    // forbids). Sentinel: that doctype's fixture value is the string
    // "__FORBIDDEN__".
    if (__FIXTURE__ && __FIXTURE__[args?.doctype] === "__FORBIDDEN__") {
      const denied = new Error(`PermissionError: Not permitted to read ${args.doctype}`);
      denied.status = 403;
      denied.excType = "PermissionError";
      throw denied;
    }
    if (__FIXTURE__ && args?.doctype === "Company") {
      const rows = __FIXTURE__.Company ?? [];
      return { doctype: "Company", count: rows.length, data: rows };
    }
    if (__FIXTURE__ && args?.doctype === "Account") {
      const rows = __FIXTURE__.Account ?? [];
      return { doctype: "Account", count: rows.length, data: rows };
    }
    if (__FIXTURE__ && args?.doctype === "GL Entry") {
      const filters = args?.filters ?? [];
      const rows = (__FIXTURE__["GL Entry"] ?? []).filter((row) =>
        filters.every(([field, op, value]) => {
          const actual = row[field];
          if (op === "=") return String(actual ?? "") === String(value ?? "");
          if (op === "<=") return String(actual ?? "") <= String(value ?? "");
          throw new Error(`mock supports only = and <= (got ${op})`);
        }),
      );
      return { doctype: "GL Entry", count: rows.length, data: rows };
    }
    if (__FIXTURE__ && ["Sales Order", "Sales Invoice", "Payment Entry", "Quotation", "Purchase Order"].includes(args?.doctype)) {
      const filters = args?.filters ?? [];
      // PARITY with the non-fixture branch below (and with the real site): a
      // doctype that has no `custom_ai_action_id` Custom Field cannot be
      // FILTERED by it — Frappe errors instead of returning an empty page. This
      // branch used to skip that check, so the one state the site was really in
      // until 2026-09-21 (field on Payment Entry only) could not be reproduced
      // by any test: a missing field silently became "0 drafts", which is the
      // fabricated 0 that §4.3 forbids. Knobs are per-doctype, same names as the
      // non-fixture ledger branch.
      const corrAvail =
        args.doctype === "Quotation"
          ? qtCorrelationAvailable()
          : args.doctype === "Purchase Order"
            ? poCorrelationAvailable()
            : args.doctype === "Sales Order"
              ? soCorrelationAvailable()
              : true; // Sales Invoice / Payment Entry: nothing declared missing
      if (filters.some(([field]) => field === "custom_ai_action_id") && !corrAvail) {
        throw new Error(`Unknown column 'custom_ai_action_id' in 'where clause'`);
      }
      // next3/B — the doc-key column, with its own knob (see poDocKeyAvailable).
      if (args.doctype === "Purchase Order" && filters.some(([field]) => field === DOC_KEY_FIELD) && !poDocKeyAvailable()) {
        throw new Error(`Unknown column '${DOC_KEY_FIELD}' in 'where clause'`);
      }
      const rows = (__FIXTURE__[args.doctype] ?? []).filter((row) =>
        filters.every(([field, op, value]) => {
          if (op === "is") return value === "set" ? row[field] != null && row[field] !== "" : true;
          if (op === "=") return String(row[field] ?? "") === String(value ?? "");
          if (op === "<=") return String(row[field] ?? "") <= String(value ?? "");
          // Frappe compares `>` numerically; a string compare would make "9" >
          // "10" true and silently change which rows get summed.
          if (op === ">") return Number(row[field] ?? 0) > Number(value ?? 0);
          throw new Error(`mock supports only =, <=, > and is (got ${op})`);
        }),
      );
      // The real tool PAGES (`count` is the returned page size — measured
      // 2026-09-21), so the mock must page too, or the skill's truncation guard
      // could never be exercised through it.
      const page = rows.slice(0, args?.limit ?? 20);
      return { doctype: args.doctype, count: page.length, data: page };
    }
    if (args?.doctype === "Sales Order" || args?.doctype === "Quotation" || args?.doctype === "Purchase Order") {
      const doctype = args.doctype;
      // Sales Order reads see BOTH halves: the drafts this session wrote AND the
      // submitted fixture orders (a delivery needs the latter, and the site
      // stores both in one table — so one list must serve both).
      const ledger =
        doctype === "Quotation" ? QUOTATIONS : doctype === "Purchase Order" ? allPurchaseOrders() : allSalesOrders();
      const available =
        doctype === "Quotation" ? qtCorrelationAvailable() : doctype === "Purchase Order" ? poCorrelationAvailable() : soCorrelationAvailable();
      const filters = args?.filters ?? [];
      // A site without the Custom Field cannot be filtered by it at all —
      // Frappe answers with an error, which is the fact the executor needs.
      const needsCorrelation = filters.some(([field]) => field === "custom_ai_action_id");
      if (needsCorrelation && !available) {
        throw new Error(`Unknown column 'custom_ai_action_id' in 'where clause'`);
      }
      // next3/B — parity for the document-identity column, separate flag: the two
      // columns arrive by two migrations, so "has one, not the other" must be
      // representable. The mock deliberately does NOT dedupe on the key it finds —
      // it returns the ROW and lets the skill refuse, so the guard under test is
      // the one that runs in production.
      if (doctype === "Purchase Order" && filters.some(([field]) => field === DOC_KEY_FIELD) && !poDocKeyAvailable()) {
        throw new Error(`Unknown column '${DOC_KEY_FIELD}' in 'where clause'`);
      }
      const rows = ledger
        .filter((row) =>
          filters.every(([field, op, value]) => {
            const actual = row[field];
            if (op === "=") return String(actual ?? "") === String(value ?? "");
            throw new Error(`mock supports only = (got ${op})`);
          }),
        )
        .slice(0, args?.limit ?? 20);
      return { doctype, count: rows.length, data: rows };
    }
    if (args?.doctype === "Purchase Receipt") {
      // The reconcile lookup (P9-B). Same shape as the Delivery Note branch:
      // a site WITHOUT the Custom Field cannot be filtered by it (Frappe
      // errors), which is a fact the executor needs, not an empty page.
      const filters = args?.filters ?? [];
      if (filters.some(([field]) => field === "custom_ai_action_id") && !prCorrelationAvailable()) {
        throw new Error("Unknown column 'custom_ai_action_id' in 'where clause'");
      }
      const rows = PURCHASE_RECEIPTS.filter((row) =>
        filters.every(([field, op, value]) => {
          const actual = row[field];
          if (op === "=") return String(actual ?? "") === String(value ?? "");
          throw new Error(`mock supports only = (got ${op})`);
        }),
      ).slice(0, args?.limit ?? 20);
      return { doctype: "Purchase Receipt", count: rows.length, data: rows };
    }
    if (args?.doctype === "Customer") {
      // M1: the reconcile lookup (by correlation field). Same shape as every
      // other ledger branch: a site WITHOUT the Custom Field cannot be filtered
      // by it (Frappe errors), which is a fact the executor needs, not an empty
      // page.
      const filters = args?.filters ?? [];
      if (filters.some(([field]) => field === "custom_ai_action_id") && !customerCorrelationAvailable()) {
        throw new Error("Unknown column 'custom_ai_action_id' in 'where clause'");
      }
      const rows = allCustomers().filter((row) =>
        filters.every(([field, op, value]) => {
          const actual = row[field];
          if (op === "=") return String(actual ?? "") === String(value ?? "");
          throw new Error(`mock supports only = (got ${op})`);
        }),
      ).slice(0, args?.limit ?? 20);
      return { doctype: "Customer", count: rows.length, data: rows };
    }
    if (args?.doctype === "Sales Invoice") {
      // P9-D: the reconcile lookup AND the draft-cover read (customer +
      // docstatus 0). Both go through here because both are `erpnext_doc_list`
      // filters — the same shape the real site serves. A site WITHOUT the
      // Custom Field cannot be filtered by it (Frappe errors), which is a fact
      // the executor needs, not an empty page.
      const filters = args?.filters ?? [];
      if (filters.some(([field]) => field === "custom_ai_action_id") && !siCorrelationAvailable()) {
        throw new Error("Unknown column 'custom_ai_action_id' in 'where clause'");
      }
      const rows = allSalesInvoices().filter((row) =>
        filters.every(([field, op, value]) => {
          const actual = row[field];
          if (op === "=") return String(actual ?? "") === String(value ?? "");
          throw new Error(`mock supports only = (got ${op})`);
        }),
      ).slice(0, args?.limit ?? 20);
      return { doctype: "Sales Invoice", count: rows.length, data: rows };
    }
    if (args?.doctype === "Delivery Note") {
      // The reconcile lookup. Filtering by the correlation field is the ONE
      // thing this has to get right: a site WITHOUT the Custom Field cannot be
      // filtered by it at all (Frappe errors), which is a fact the executor
      // needs, not an empty page. Same knob shape as the other write paths.
      const filters = args?.filters ?? [];
      if (filters.some(([field]) => field === "custom_ai_action_id") && !dnCorrelationAvailable()) {
        throw new Error("Unknown column 'custom_ai_action_id' in 'where clause'");
      }
      const rows = DELIVERY_NOTES.filter((row) =>
        filters.every(([field, op, value]) => {
          const actual = row[field];
          if (op === "=") return String(actual ?? "") === String(value ?? "");
          throw new Error(`mock supports only = (got ${op})`);
        }),
      ).slice(0, args?.limit ?? 20);
      return { doctype: "Delivery Note", count: rows.length, data: rows };
    }
    if (args?.doctype === "Stock Entry") {
      // P9-E: BOTH readers go through here — the reconcile lookup (by
      // correlation field) and the draft-cover read (stock_entry_type +
      // docstatus 0). A site WITHOUT the Custom Field cannot be filtered by it
      // (Frappe errors), which is a fact the executor needs, not an empty page.
      //
      // DELIBERATELY NO PRE-SEEDED ENTRIES. The mock holds only what a test
      // writes through it: real Stock Entries belong to the shop's own site, and
      // a fabricated "MAT-STE-…" here would be a claim about ERPNext that
      // nothing measured (user decision 2026-09-23: the site is the source of
      // truth for data; the mock only mirrors VALIDATION RULES). The draft-cover
      // arithmetic is unit-tested with an injected read instead.
      const filters = args?.filters ?? [];
      if (filters.some(([field]) => field === "custom_ai_action_id") && !seCorrelationAvailable()) {
        throw new Error("Unknown column 'custom_ai_action_id' in 'where clause'");
      }
      const rows = STOCK_ENTRIES.filter((row) =>
        filters.every(([field, op, value]) => {
          const actual = row[field];
          if (op === "=") return String(actual ?? "") === String(value ?? "");
          throw new Error(`mock supports only = (got ${op})`);
        }),
      ).slice(0, args?.limit ?? 20);
      return { doctype: "Stock Entry", count: rows.length, data: rows };
    }
    if (args?.doctype === "Item Price") {
      const filters = args?.filters ?? [];
      const rows = ITEM_PRICES.filter((row) =>
        filters.every(([field, op, value]) =>
          op === "=" ? String(row[field] ?? "") === String(value ?? "") : (() => { throw new Error(`mock supports only = (got ${op})`); })(),
        ),
      ).slice(0, args?.limit ?? 20);
      return { doctype: "Item Price", count: rows.length, data: rows };
    }
    if (args?.doctype === "Company") {
      return { doctype: "Company", count: COMPANIES.length, data: COMPANIES.map((name) => ({ name })) };
    }
    // B1: the UOM table and its factors are read through the SAME generic tool
    // the real site exposes (erpnext_doc_list works for any DocType).
    if (args?.doctype === "UOM") return { doctype: "UOM", count: UOMS.length, data: UOMS.map((name) => ({ name })) };
    if (args?.doctype === "UOM Conversion Factor") {
      return { doctype: "UOM Conversion Factor", count: UOM_FACTORS.length, data: UOM_FACTORS };
    }
    // A2 (e-invoice): suppliers read WITH their tax_id through the generic tool
    // (measured on the real site 2026-09-23 — `erpnext_supplier_list` drops the
    // field, `erpnext_doc_list` honours `fields`). The mock mirrors the REAL
    // payload's nullability: rows without a tax_id come back as null, never as
    // an invented number, so "MST match" cannot pass on the mock for the wrong
    // reason. `fields` is honoured as a PROJECTION (the real tool's behaviour).
    if (args?.doctype === "Supplier") {
      const wanted = Array.isArray(args?.fields) && args.fields.length > 0 ? new Set(args.fields) : null;
      const rows = SUPPLIERS.map((s) => {
        const full = { ...s, tax_id: s.tax_id ?? null };
        if (!wanted) return full;
        return Object.fromEntries([...wanted].map((f) => [f, full[f]]));
      }).slice(0, args?.limit ?? 20);
      return { doctype: "Supplier", count: rows.length, data: rows };
    }
    // M1-site: the two classification MASTERS plus the field RULES are read
    // through the same generic tool the real site exposes (measured 2026-09-24:
    // `erpnext_doc_list` answers for "Customer Group", "Territory" and
    // "DocField"; `erpnext_customer_list` would not carry `is_group`). Equality
    // filters only — the resolver asks for either nothing or one `parent`.
    if (["Customer Group", "Territory", "DocField"].includes(args?.doctype)) {
      const master =
        args.doctype === "Customer Group"
          ? CUSTOMER_GROUPS
          : args.doctype === "Territory"
            ? TERRITORIES
            : CUSTOMER_DOCFIELDS;
      const filters = args?.filters ?? [];
      const rows = master
        .filter((row) =>
          filters.every(([field, op, value]) => {
            if (op !== "=") throw new Error(`mock supports only = (got ${op})`);
            return String(row[field] ?? "") === String(value ?? "");
          }),
        )
        .slice(0, args?.limit ?? 20);
      return { doctype: args.doctype, count: rows.length, data: rows };
    }
    const source =
      args?.doctype === "Payment Entry"
        ? PAYMENTS
        : args?.doctype === "Mode of Payment"
          ? MODES
          : args?.doctype === "Purchase Invoice"
            ? PURCHASE_INVOICES
            : null;
    if (!source) throw new Error(`mock doc_list does not support doctype ${args?.doctype}`);
    const filters = args?.filters ?? [];
    const rows = source
      .filter((row) =>
        filters.every(([field, op, value]) => {
          const actual = row[field];
          if (op === "=") return String(actual ?? "") === String(value ?? "");
          if (op === "!=") return String(actual ?? "") !== String(value ?? "");
          throw new Error(`mock supports only = and != (got ${op})`);
        }),
      )
      .slice(0, args?.limit ?? 20);
    return { doctype: args?.doctype, count: rows.length, data: rows };
  },
  /** Generic get: the write path resolves company/accounts from live data.
   *  P4-1: with MOCK_ERP_P4_FIXTURE set, a fixture Company doc is served from
   *  the same env JSON (the ops summary reads default accounts from here). */
  erpnext_doc_get: (args) => {
    const name = String(args?.name ?? "");
    // A2 (measured 2026-09-24): the item's OWN default warehouse. The real read
    // route is pinned by what the tools actually return — `erpnext_item_get`
    // drops `item_defaults`, `erpnext_doc_list` on the child doctype ignores
    // `fields` and answers bare names, and `doc_get` on the Item document carries
    // the child table. So the mock answers it HERE, with the same shape.
    if (args?.doctype === "Item") {
      const item = ITEMS.find((i) => i.name === name || i.item_code === name);
      if (!item) throw new Error(`mock doc_get: unknown Item "${name}"`);
      const itemDefaults =
        item.is_stock_item === 1 && !process.env.MOCK_ERP_NO_ITEM_DEFAULT_WAREHOUSE
          ? [{ name: `ID-${item.name}`, parent: item.name, company: COMPANY, default_warehouse: DEFAULT_WAREHOUSE }]
          : [];
      return { data: { ...item, item_defaults: itemDefaults } };
    }
    // P4-2 — the ERPNext session default company the /read/daily-summary route
    // reads when configuration pins nothing. Shape + access path are the ones
    // MEASURED on the real site (2026-09-21): it is a Single, so doc_get works
    // (`{data:{default_company}}`) while doc_list on it answers HTTP 500.
    // MOCK_ERP_DEFAULT_COMPANY="" models a site with NO default company (the
    // route must then refuse rather than pick one of several companies);
    // MOCK_ERP_FAIL_GLOBAL_DEFAULTS models the read itself failing.
    if (args?.doctype === "Global Defaults") {
      if (process.env.MOCK_ERP_FAIL_GLOBAL_DEFAULTS) {
        throw new Error("simulated ERPNext failure reading Global Defaults");
      }
      let fallback = COMPANIES[0];
      if (process.env.MOCK_ERP_P4_FIXTURE) {
        const fixtureCompany = JSON.parse(process.env.MOCK_ERP_P4_FIXTURE).Company?.[0]?.name;
        if (fixtureCompany) fallback = fixtureCompany;
      }
      const configured = process.env.MOCK_ERP_DEFAULT_COMPANY;
      const value = configured === undefined ? fallback : configured.trim() || null;
      return { data: { name: "Global Defaults", default_company: value } };
    }
    if (args?.doctype === "Sales Invoice") {
      // P9-D: the DRAFTS written through this mock are searched FIRST, because
      // this branch serves BOTH readers — the payment path (anchoring on a
      // SUBMITTED invoice, which needs company/debit_to) and the invoice
      // executor's read-back + draft-cover read (which must see what it just
      // wrote). Two separate `Sales Invoice` branches used to sit in this
      // function; the earlier one threw on any name it did not hold, so the
      // later one was unreachable and the executor's verification failed on a
      // MOCK gap that looked exactly like a skill bug.
      const si = allSalesInvoices().find((d) => d.name === name);
      if (!si) throw new Error(`Sales Invoice ${name} not found`);
      // A fixture row is read by the payment path to anchor the party ledger on
      // the document's own account; a document this mock wrote keeps the fields
      // it was written with (that is what the executor reads back).
      return { data: INVOICES.includes(si) ? { ...si, company: COMPANY, debit_to: RECEIVABLE_ACCOUNT } : si };
    }
    // P9-C: the PAY-side anchor, read by name exactly like the Sales Invoice
    // above (company + the payable account come off the document itself).
    if (args?.doctype === "Purchase Invoice") {
      const inv = PURCHASE_INVOICES.find((i) => i.name === name);
      if (!inv) throw new Error(`Purchase Invoice ${name} not found`);
      return { data: inv };
    }
    // The executor re-derives the money direction by proving the party exists in
    // the SUPPLIER master (a crafted `kind: "supplier"` on a customer id must
    // fail closed here, before anything is written).
    if (args?.doctype === "Supplier") {
      const sup = SUPPLIERS.find((s) => s.name === name);
      if (!sup) throw new Error(`Supplier ${name} not found`);
      return { data: sup };
    }
    if (process.env.MOCK_ERP_P4_FIXTURE && args?.doctype === "Company") {
      const rows = JSON.parse(process.env.MOCK_ERP_P4_FIXTURE).Company ?? [];
      const row = rows.find((r) => r.name === String(args?.name ?? ""));
      if (!row) throw new Error(`Company ${args?.name} not found`);
      return { data: row };
    }
    if (args?.doctype === "Mode of Payment") {
      const account = MODE_ACCOUNTS[name];
      if (!account) throw new Error(`Mode of Payment ${name} not found`);
      return { data: { name, accounts: [{ company: COMPANY, default_account: account }] } };
    }
    if (args?.doctype === "Payment Entry") {
      const pe = PAYMENTS.find((p) => p.name === name);
      if (!pe) throw new Error(`Payment Entry ${name} not found`);
      return { data: pe };
    }
    if (args?.doctype === "Sales Order") {
      const so = allSalesOrders().find((s) => s.name === name);
      if (!so) throw new Error(`Sales Order ${name} not found`);
      return { data: so };
    }
    if (args?.doctype === "Delivery Note") {
      const dn = DELIVERY_NOTES.find((d) => d.name === name);
      if (!dn) throw new Error(`Delivery Note ${name} not found`);
      return { data: dn };
    }
    if (args?.doctype === "Purchase Receipt") {
      const pr = PURCHASE_RECEIPTS.find((d) => d.name === name);
      if (!pr) throw new Error(`Purchase Receipt ${name} not found`);
      return { data: pr };
    }
    if (args?.doctype === "Quotation") {
      const qt = QUOTATIONS.find((q) => q.name === name);
      if (!qt) throw new Error(`Quotation ${name} not found`);
      return { data: qt };
    }
    if (args?.doctype === "Purchase Order") {
      // P9-B: the submitted-PO fixture is part of "the site's orders" too —
      // a receipt builder reads the PO the same way the DN builder reads the SO.
      const po = allPurchaseOrders().find((p) => p.name === name);
      if (!po) throw new Error(`Purchase Order ${name} not found`);
      return { data: po };
    }
    if (args?.doctype === "Customer") {
      // M1: the executor's read-back. Both halves of the master list are
      // readable by name — the site's own fixtures (DB) AND what this session
      // created (the same "one table" convention the Sales Order reads use).
      const cu = allCustomers().find((c) => c.name === String(args?.name ?? ""));
      if (!cu) throw new Error(`Customer ${args?.name} not found`);
      return { data: cu };
    }
    if (args?.doctype === "Stock Entry") {
      // P9-E: only what this mock WROTE is readable by name — the fixtures below
      // are the site's own pre-existing entries and are served through
      // `erpnext_doc_list`, the shape the draft-cover read actually uses. The
      // executor's read-back (which must see the document it just created) is
      // what this branch exists for.
      const se = STOCK_ENTRIES.find((d) => d.name === name);
      if (!se) throw new Error(`Stock Entry ${name} not found`);
      return { data: se };
    }
    throw new Error(`mock doc_get does not support doctype ${args?.doctype}`);
  },
  erpnext_customer_list: (args) => {
    // M1: the list sees BOTH halves of the master table (fixtures + created) —
    // the skill's duplicate pre-check and every resolver read the same table
    // the real site keeps. Created rows arrive after the fixtures, matching
    // ERPNext's creation order.
    const docs = allCustomers().filter((c) => !args?.customer_group || c.customer_group === args.customer_group);
    // P9-C — a name that exists in BOTH masters (plan3_review3 A.3.1: "anh vừa
    // mua vừa bán"). Opt-in only (MOCK_ERP_DUPLICATE_CUSTOMER=<tên>): on such a
    // site the pay direction must REFUSE instead of guessing which way the money
    // goes, and the fixture has to exist to prove it — but adding it permanently
    // would perturb the customer lists every other test counts on.
    const dup = process.env.MOCK_ERP_DUPLICATE_CUSTOMER;
    if (dup && dup.trim()) {
      docs.push({ doctype: "Customer", name: `CUST-DUP-${dup.trim().replace(/\s+/g, "-").toUpperCase()}`, customer_name: dup.trim(), customer_group: "Individual", disabled: 0 });
    }
    return { doctype: "Customer", count: docs.length, data: docs };
  },
  erpnext_customer_get: (args) => {
    // M1: same both-halves rule as erpnext_customer_list — a just-created
    // customer must be readable by get (the executor's verify step).
    const doc = allCustomers().find((c) => c.name === String(args?.name ?? ""));
    if (!doc) throw new Error(`Customer ${args?.name} not found`);
    return { data: doc };
  },
  erpnext_stock_balance: (args) => {
    const rows = STOCK.filter(
      (s) => (!args?.item_code || s.item_code === args.item_code) && (!args?.warehouse || s.warehouse === args.warehouse),
    );
    return { doctype: "Bin", count: rows.length, data: rows };
  },
  erpnext_sales_invoice_list: (args) => {
    const rows = INVOICES.filter(
      (i) => (!args?.customer || i.customer === args.customer) && (args?.outstanding_only === false || i.outstanding_amount !== 0),
    );
    return { doctype: "Sales Invoice", count: rows.length, data: rows };
  },
  erpnext_payment_entry_list: (args) => {
    const rows = PAYMENTS.filter((p) => !args?.party || p.party === args.party);
    return { doctype: "Payment Entry", count: rows.length, data: rows };
  },
  erpnext_item_list: () => {
    // No server-side name filtering (the real 3.0.4 tool has no txt param either):
    // the skill layer filters client-side on item_name/item_code.
    return { doctype: "Item", count: ITEMS.length, data: ITEMS };
  },
  /** B1 — real shape verified live: { doctype, count, data: [...] }. */
  erpnext_supplier_list: (args) => {
    // Same opt-in fault injection as the other tools: B1's supplier branch must
    // REFUSE with the code its contract declares (ERP_UNAVAILABLE) instead of
    // throwing out of the pipeline into a bare 500.
    if (process.env.MOCK_ERP_FAIL_SUPPLIER_LIST) {
      throw new Error("simulated ERPNext read failure (MOCK_ERP_FAIL_SUPPLIER_LIST)");
    }
    const rows = SUPPLIERS.filter(
      (s) =>
        (!args?.supplier_group || s.supplier_group === args.supplier_group) &&
        (args?.include_disabled === true || s.disabled === 0),
    ).slice(0, args?.limit ?? 20);
    return { doctype: "Supplier", count: rows.length, data: rows };
  },
};

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    replyError(null, -32700, "Parse error");
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp-erpnext", version: "3.0.4-mock" },
      });
      break;
    case "tools/list":
      reply(id, {
        tools: Object.entries(TOOLS).map(([name, handler]) => ({
          name,
          annotations: { readOnlyHint: true },
          description: `Mock of ${name} (shape identical to @casys/mcp-erpnext 3.0.4)`,
          inputSchema: { type: "object" },
        })),
      });
      break;
    case "tools/call": {
      const handler = TOOLS[params?.name];
      if (!handler) {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        break;
      }
      try {
        const payload = handler(params?.arguments ?? {});
        reply(id, {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: false,
        });
      } catch (err) {
        reply(id, {
          content: [{ type: "text", text: String(err.message) }],
          isError: true,
        });
      }
      break;
    }
    default:
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
  }
});
