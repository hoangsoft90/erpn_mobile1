/**
 * Intent router — CONTRACT-DRIVEN, keyword-based, NO embeddings.
 *
 * P0 (plan2_final §2 D5): the trigger table is no longer hardcoded here — it
 * lives in `capabilities.json` and is read through `capability-contract.mjs`,
 * so Router / Skill / Safety / Authorization / UI / Test all share ONE policy
 * source. This file keeps only the skill-factory wiring.
 *
 * Why keywords (phase-02 spec, from review3/4): the package's tool
 * descriptions are too generic (`create_doc`, `get_list`) for semantic
 * retrieval to distinguish Payment Entry from Journal Entry — the difference
 * lives in the ARGUMENTS. A fixed keyword table -> one of the skill groups is
 * deterministic, testable, and cheap (~0 tokens).
 *
 * Vietnamese keywords align with src/vietnamese_nlp intents (Phase 1):
 * payment, credit_sale, receivable, purchase, delivery, sale, stock_level.
 */

import * as customer from "./skills/customer.mjs";
import * as sales from "./skills/sales.mjs";
import * as payment from "./skills/payment.mjs";
import * as inventory from "./skills/inventory.mjs";
import * as purchasing from "./skills/purchasing.mjs";
import * as paymentWrite from "./skills/payment-write.mjs";
import { buildSalesOrderProposal } from "./skills/sales-order-write.mjs";
import { buildQuotationProposal } from "./skills/quotation-write.mjs";
import { buildPurchaseOrderProposal } from "./skills/purchase-order-write.mjs";
import * as deliveryWrite from "./skills/delivery-write.mjs";
import { buildDeliveryProposal } from "./skills/delivery-write.mjs";
import * as receiptWrite from "./skills/purchase-receipt-write.mjs";
import { buildPurchaseReceiptProposal } from "./skills/purchase-receipt-write.mjs";
import * as invoiceWrite from "./skills/sales-invoice-write.mjs";
import { buildSalesInvoiceProposal } from "./skills/sales-invoice-write.mjs";
import * as stockWrite from "./skills/stock-adjustment-write.mjs";
import * as returnWrite from "./skills/sales-return-write.mjs"; // P9-F: the return of a sale is still an SI, but its OWN reads bag
import * as customerCreate from "./skills/customer-create.mjs"; // M1: master data — listCustomers/getCustomerDoc/reconcile + the builder
import { resolveCapability, getCapability, isForbidden } from "./capability-contract.mjs";
import * as opsSummary from "./skills/ops-summary.mjs"; // P4-1: reached ONLY via routeByCapability — no keyword route

/**
 * Routes need an mcp client + a knownIds set at CALL time, not at import time
 * (the client owns the stdio process). `routeIntent` keeps returning the group
 * NAME plus a factory so callers wire their own client:
 *
 *   const r = routeIntent(text);         // { group, factory, capability }
 *   const skills = r?.factory(mcp, knownIds);
 */

/** @type {Record<string, (mcp: object, knownIds: Set<string>) => object>} */
const SKILL_FACTORIES = {
  // M1: the customer-CREATE path. The bag is deliberately minimal: the skill's
  // whole pre-check works off the customer master list (a duplicate must be
  // SEEN to be refused), and the executor re-reads it + reads the created row
  // back. No inventory, no invoices — a create-customer proposal touches
  // nothing else.
  customer_create_write: (mcp) => ({
    listCustomers: () => customerCreate.listCustomers(mcp),
    getCustomerDoc: (name) => customerCreate.getCustomerDoc(mcp, name),
    // M1-site: the classification defaults come from the SITE (its own DocField
    // rules + its own master lists), so the builder needs those three reads. A
    // hardcoded group is what broke every create on the real site.
    ...customerCreate.profileReads(mcp),
  }),
  // Phase 7b: the ONLY write path. findCustomer is the same ID-from-tool-result
  // resolver the read groups use — a write never resolves a customer by guess.
  // buildPaymentProposal expects a skills bag with listUnpaidInvoices (same
  // customer-ID-guarded read the sales group uses) + the builder itself.
  payment_write: (mcp, knownIds) => ({
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    // P9-C: BOTH master lists, so the DIRECTION can be derived from which one
    // actually holds the named party (Supplier ⇒ pay, Customer ⇒ receive). The
    // read also registers the ids it returns, so a supplier id taken from it has
    // provenance (readonly-guard) when the history/execute path reuses it.
    findSupplier: (f) => purchasing.findSupplier(mcp, f, knownIds),
    listUnpaidInvoices: (id) => sales.listUnpaidInvoices(mcp, id, knownIds),
    listOpenPurchaseInvoices: (id) => paymentWrite.listOpenPurchaseInvoices(mcp, id),
    // P9-D: open DRAFT Payment Entries hold money raw outstanding still counts
    // (ERPNext lowers it only at SUBMIT) — the builder reads them so a second
    // /ask cannot propose the same money again. On the OUTER bag (not only
    // inside this closure), because the builder receives `skills` — the same
    // P9-B lesson delivery-write recorded.
    listOpenDraftPaymentEntries: (pid) => paymentWrite.listOpenDraftPaymentEntries(mcp, pid),
    getPaymentEntryDoc: (n) => paymentWrite.getPaymentEntryDoc(mcp, n),
    buildPaymentProposal: (resolved, opts) =>
      paymentWrite.buildPaymentProposal(
        {
          listUnpaidInvoices: (cid) => sales.listUnpaidInvoices(mcp, cid, knownIds),
          listOpenPurchaseInvoices: (sid) => paymentWrite.listOpenPurchaseInvoices(mcp, sid),
          // P9-D: the draft-cover reads ride on the bag the BUILDER sees.
          listOpenDraftPaymentEntries: (pid) => paymentWrite.listOpenDraftPaymentEntries(mcp, pid),
          getPaymentEntryDoc: (n) => paymentWrite.getPaymentEntryDoc(mcp, n),
        },
        resolved,
        opts,
      ),
  }),
  // B2: the order path. Every ID and every price comes from a READ through the
  // same customer/inventory skills the READ groups use — a write never resolves
  // an item by guess, and never takes a price from the utterance.
  sales_order_write: (mcp, knownIds) => ({
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    findItem: (n) => inventory.findItem(mcp, n),
    listUoms: () => inventory.listUoms(mcp),
    listUomFactors: () => inventory.listUomFactors(mcp),
    listItemPrices: (f) => inventory.listItemPrices(mcp, f),
    buildSalesOrderProposal: (resolved, opts) => buildSalesOrderProposal(
      {
        findItem: (n) => inventory.findItem(mcp, n),
        listUoms: () => inventory.listUoms(mcp),
        listUomFactors: () => inventory.listUomFactors(mcp),
        listItemPrices: (f) => inventory.listItemPrices(mcp, f),
      },
      resolved,
      opts,
    ),
  }),
  // B3: the quotation path. Same skills bag as the order path (item catalogue +
  // prices read through the READ skills) — a quotation never resolves an item by
  // guess either, and its price comes from the same Item Price rows.
  quotation_write: (mcp, knownIds) => ({
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    findItem: (n) => inventory.findItem(mcp, n),
    listUoms: () => inventory.listUoms(mcp),
    listUomFactors: () => inventory.listUomFactors(mcp),
    listItemPrices: (f) => inventory.listItemPrices(mcp, f),
    buildQuotationProposal: (resolved, opts) => buildQuotationProposal(
      {
        findItem: (n) => inventory.findItem(mcp, n),
        listUoms: () => inventory.listUoms(mcp),
        listUomFactors: () => inventory.listUomFactors(mcp),
        listItemPrices: (f) => inventory.listItemPrices(mcp, f),
      },
      resolved,
      opts,
    ),
  }),
  // B4: the purchase path. The party resolver is the SUPPLIER one (a purchase
  // order is not raised against the customer master list), the item catalogue is
  // the shared one, and the price rows passed to the builder come from the
  // BUYING side of Item Price — the skill refuses to build with any other side.
  purchase_order_write: (mcp, knownIds) => ({
    findSupplier: (f) => purchasing.findSupplier(mcp, f, knownIds),
    findItem: (n) => inventory.findItem(mcp, n),
    listUoms: () => inventory.listUoms(mcp),
    listUomFactors: () => inventory.listUomFactors(mcp),
    listItemPrices: (f) => inventory.listItemPrices(mcp, f),
    // A2: the item's own default warehouse (ERPNext `Item Default`), read on the
    // OUTER bag as well as inside the builder's closure — a purchase line cannot
    // be built without it for a stock item (measured refusal on the real site).
    getItemWarehouseHints: (code, opts) => inventory.getItemWarehouseHints(mcp, code, opts),
    buildPurchaseOrderProposal: (resolved, opts) => buildPurchaseOrderProposal(
      {
        findSupplier: (f) => purchasing.findSupplier(mcp, f),
        findItem: (n) => inventory.findItem(mcp, n),
        listUoms: () => inventory.listUoms(mcp),
        listUomFactors: () => inventory.listUomFactors(mcp),
        listItemPrices: (f) => inventory.listItemPrices(mcp, f),
        getItemWarehouseHints: (code, o) => inventory.getItemWarehouseHints(mcp, code, o),
      },
      resolved,
      opts,
    ),
  }),
  // P9-A2: the DELIVERY path. Its party is the CUSTOMER (resolved through the
  // same §4.3 guard every write uses), but its LINES come from an ORDER that is
  // already submitted — so the bag carries the order read (the delivery note
  // fulfils an order; it never invents lines) and the item catalogue used to
  // recognise an item the user actually named.
  delivery_write: (mcp, knownIds) => ({
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    findItem: (n) => inventory.findItem(mcp, n),
    getSalesOrder: (name) => deliveryWrite.getSalesOrderDoc(mcp, name),
    listOpenSalesOrders: (customerId) => deliveryWrite.listOpenSalesOrders(mcp, customerId),
    // On the OUTER bag too: the builder's draft-cover check reads through
    // `skills` (this bag), not through the closure-local reads below.
    listOpenDraftDeliveryNotes: (customerId) => deliveryWrite.listOpenDraftDeliveryNotes(mcp, customerId),
    getDeliveryNoteDoc: (name) => deliveryWrite.getDeliveryNoteDoc(mcp, name),
    buildDeliveryProposal: (resolved, opts) => buildDeliveryProposal(
      {
        findItem: (n) => inventory.findItem(mcp, n),
        getSalesOrder: (name) => deliveryWrite.getSalesOrderDoc(mcp, name),
        listOpenSalesOrders: (customerId) => deliveryWrite.listOpenSalesOrders(mcp, customerId),
        // P9-B review fix: open DRAFT notes hold goods raw pending still
        // counts — the builder reads them so a second confirmation cannot
        // propose the same goods again.
        listOpenDraftDeliveryNotes: (customerId) => deliveryWrite.listOpenDraftDeliveryNotes(mcp, customerId),
        getDeliveryNoteDoc: (name) => deliveryWrite.getDeliveryNoteDoc(mcp, name),
      },
      resolved,
      opts,
    ),
  }),
  // P9-D: the INVOICE path. Its party is the CUSTOMER (same §4.3 guard as the
  // order paths), its lines AND PRICES come from an order that is already
  // submitted — so the bag carries the order read plus the draft-invoice reads
  // the builder needs (draft invoices hold money raw pending still counts).
  sales_invoice_write: (mcp, knownIds) => ({
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    findItem: (n) => inventory.findItem(mcp, n),
    getSalesOrder: (name) => invoiceWrite.getSalesOrderDoc(mcp, name),
    listOpenSalesOrders: (customerId) => invoiceWrite.listOpenSalesOrders(mcp, customerId),
    listOpenDraftSalesInvoices: (customerId) => invoiceWrite.listOpenDraftSalesInvoices(mcp, customerId),
    getSalesInvoiceDoc: (name) => invoiceWrite.getSalesInvoiceDoc(mcp, name),
    buildSalesInvoiceProposal: (resolved, opts) => buildSalesInvoiceProposal(
      {
        findItem: (n) => inventory.findItem(mcp, n),
        getSalesOrder: (name) => invoiceWrite.getSalesOrderDoc(mcp, name),
        listOpenSalesOrders: (customerId) => invoiceWrite.listOpenSalesOrders(mcp, customerId),
        // A live DRAFT invoice claims money raw pending still counts — read on
        // the bag the BUILDER sees, not only inside this closure (P9-B lesson).
        listOpenDraftSalesInvoices: (customerId) => invoiceWrite.listOpenDraftSalesInvoices(mcp, customerId),
        getSalesInvoiceDoc: (name) => invoiceWrite.getSalesInvoiceDoc(mcp, name),
      },
      resolved,
      opts,
    ),
  }),
  // P9-B: the RECEIVING path. Its party is the SUPPLIER (same §4.3 guard as the
  // purchase order), but its LINES come from a PURCHASE ORDER that is already
  // submitted — so the bag carries the PO read and the draft-receipt reads the
  // builder needs; the executor lives behind the Safety Gateway, not here.
  purchase_receipt_write: (mcp, knownIds) => ({
    findSupplier: (f) => purchasing.findSupplier(mcp, f, knownIds),
    findItem: (n) => inventory.findItem(mcp, n),
    getPurchaseOrder: (name) => receiptWrite.getPurchaseOrderDoc(mcp, name),
    listOpenPurchaseOrders: (supplierId) => receiptWrite.listOpenPurchaseOrders(mcp, supplierId),
    listOpenDraftPurchaseReceipts: (supplierId) => receiptWrite.listOpenDraftPurchaseReceipts(mcp, supplierId),
    getPurchaseReceiptDoc: (name) => receiptWrite.getPurchaseReceiptDoc(mcp, name),
    buildPurchaseReceiptProposal: (resolved, opts) => buildPurchaseReceiptProposal(
      {
        findItem: (n) => inventory.findItem(mcp, n),
        getPurchaseOrder: (name) => receiptWrite.getPurchaseOrderDoc(mcp, name),
        listOpenPurchaseOrders: (supplierId) => receiptWrite.listOpenPurchaseOrders(mcp, supplierId),
        listOpenDraftPurchaseReceipts: (supplierId) => receiptWrite.listOpenDraftPurchaseReceipts(mcp, supplierId),
        getPurchaseReceiptDoc: (name) => receiptWrite.getPurchaseReceiptDoc(mcp, name),
      },
      resolved,
      opts,
    ),
  }),
  // P9-E: the STOCK WRITE-OFF path — the ONE write here with no party at all.
  // Its "entity" is the ITEM, and the two things the sentence must supply are
  // the quantity AND the warehouse it leaves. Nothing is priced: the valuation
  // belongs to ERPNext (`line_policy.rate_source = erpnext`), so the bag carries
  // only the reads the builder needs — the item catalogue (shared with every
  // other write), the Bin rows (what is really on the shelf), the open DRAFT
  // Stock Entries (a draft does NOT move Bin, so its goods are still physically
  // there and would be double-counted), and the UOM tables.
  stock_adjustment_write: (mcp, knownIds) => ({
    findItem: (n) => inventory.findItem(mcp, n),
    listUoms: () => inventory.listUoms(mcp),
    listUomFactors: () => inventory.listUomFactors(mcp),
    // Every read here is RAW MCP-SHAPED, and the builder wraps each with
    // `rowsOf`/`docOf` itself — the convention the delivery/receipt/invoice bags
    // follow. This bag therefore needs no second, inner copy of the reads: the
    // pipeline passes THIS object straight to buildStockAdjustmentProposal (the
    // exact trap the P9-B review found, where a read the builder could not reach
    // silently never happened).
    listStockRows: () => stockWrite.listStockRows(mcp),
    listOpenDraftStockEntries: () => stockWrite.listOpenDraftStockEntries(mcp),
    getStockEntryDoc: (name) => stockWrite.getStockEntryDoc(mcp, name),
  }),
  // P9-F: the RETURN path reads the INVOICE it links back to, the SUBMITTED
  // returns already received, and the OPEN draft returns claiming the same
  // goods. Every read is raw MCP-shaped and wrapped by the skill itself (the
  // bag convention since P9-B).
  sales_return_write: (mcp, knownIds) => ({
    // Same customer-party machinery as the invoice path: the return's entity is
    // the ORIGINAL invoice, but the shared §4.3 guard still resolves/checks the
    // customer named in the sentence — so this bag must serve findCustomer the
    // way every other customer-party WRITE bag does (measured: without it the
    // first /ask threw `skills.findCustomer is not a function`).
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    findItem: (n) => inventory.findItem(mcp, n),
    getInvoiceDoc: (name) => returnWrite.getInvoiceDoc(mcp, name),
    listSubmittedReturns: (name) => returnWrite.listSubmittedReturns(mcp, name),
    listOpenDraftReturns: (name) => returnWrite.listOpenDraftReturns(mcp, name),
  }),
  customer: (mcp, knownIds) => ({
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    getCustomer: (id) => customer.getCustomer(mcp, id, knownIds),
    getCustomerBalance: (id) => customer.getCustomerBalance(mcp, id, knownIds),
  }),
  // findCustomer is shared: sales/payment skills need a customerId that came
  // from a real lookup — it stays the customer skill's implementation.
  sales: (mcp, knownIds) => ({
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    stockBalance: (code) => sales.stockBalance(mcp, code, knownIds),
    listUnpaidInvoices: (id) => sales.listUnpaidInvoices(mcp, id, knownIds),
  }),
  payment: (mcp, knownIds) => ({
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    findSupplier: (f) => purchasing.findSupplier(mcp, f, knownIds),
    // P9-C: the history read takes the party TYPE too — a supplier's entries are
    // money out, and the real server requires party_type when filtering by party.
    listPaymentEntries: (id, type) => payment.listPaymentEntries(mcp, id, knownIds, type),
  }),
  inventory: (mcp) => ({
    listInventory: (f) => inventory.listInventory(mcp, f),
    findItem: (n) => inventory.findItem(mcp, n),
    // B1: the UOM table + factors, read only when the question names a unit.
    listUoms: () => inventory.listUoms(mcp),
    listUomFactors: () => inventory.listUomFactors(mcp),
  }),
  // B1: supplier READ resolver (master data only — no purchase flow yet).
  supplier: (mcp, knownIds) => ({
    findSupplier: (f) => purchasing.findSupplier(mcp, f, knownIds),
  }),
  // P4-1: ops.daily_summary — reached ONLY by routeByCapability("ops.daily_summary")
  // (the structured UI intent path). There is deliberately NO entry in the
  // keyword routing table, so no free-text utterance can land on this group:
  // the drawer calls the capability by id, never through the classifier.
  ops: (mcp) => ({
    getDailySummary: (opts) => opsSummary.getDailySummary(mcp, opts),
  }),
  // document_delete is not implemented on the AI path (plan2_final §8): the
  // router SURFACES it so the pipeline can refuse with a clear message instead
  // of misrouting the request into a READ group.
};

/**
 * Route a normalized Vietnamese utterance to a skill group.
 * @param {string} text  already kinship-stripped / synonym-canonicalised (Phase 1 output)
 * @returns {{group: string, factory: ((mcp: object, knownIds: Set<string>) => object) | undefined, matched: string, capability: string, forbidden: boolean} | null}
 */
export function routeIntent(text) {
  const hit = resolveCapability(text);
  if (!hit) return null;
  return {
    group: hit.group,
    factory: SKILL_FACTORIES[hit.group],
    matched: hit.matched,
    // P0: the resolved capability id travels with the route so the pipeline,
    // the Safety Gateway and the proposal all quote the SAME contract entry
    // instead of re-deriving policy locally.
    capability: hit.id,
    forbidden: hit.forbidden,
  };
}

/**
 * Route by an EXPLICIT capability id (P3 classifier path).
 *
 * The classifier produces a semantic intent that must already be a contract
 * capability; this turns it into the SAME route shape the keyword router
 * returns so the rest of the pipeline (skills, forbidden check, stub check,
 * Safety Gateway) is byte-for-byte identical — the classifier only chooses
 * WHICH group, never HOW a group behaves.
 *
 * @param {string} capabilityId a capability id from capabilities.json
 * @returns {object|null} route shape, or null when the id is not in the contract
 */
export function routeByCapability(capabilityId) {
  const cap = getCapability(capabilityId);
  if (!cap) return null;
  const factory = SKILL_FACTORIES[cap.route_group];
  const forbidden = isForbidden(capabilityId);
  // A NON-forbidden capability whose route_group has no skill factory cannot
  // be executed. Fail closed to "unresolved" (the caller then answers
  // UNKNOWN_INTENT) instead of handing the pipeline a route with an undefined
  // `factory` — that would throw at call time and take the whole request down.
  // (Today every runnable group has a factory; this guards a future contract
  // entry from silently lacking its implementation. Forbidden capabilities keep
  // their route so the pipeline can still refuse with FORBIDDEN_IN_AI_PATH.)
  if (!forbidden && typeof factory !== "function") return null;
  return {
    group: cap.route_group,
    factory,
    matched: "classifier",
    capability: capabilityId,
    forbidden,
  };
}
