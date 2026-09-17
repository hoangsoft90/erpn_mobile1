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
import * as paymentWrite from "./skills/payment-write.mjs";
import { resolveCapability } from "./capability-contract.mjs";

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
  // Phase 7b: the ONLY write path. findCustomer is the same ID-from-tool-result
  // resolver the read groups use — a write never resolves a customer by guess.
  // buildPaymentProposal expects a skills bag with listUnpaidInvoices (same
  // customer-ID-guarded read the sales group uses) + the builder itself.
  payment_write: (mcp, knownIds) => ({
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    listUnpaidInvoices: (id) => sales.listUnpaidInvoices(mcp, id, knownIds),
    buildPaymentProposal: (resolved, opts) =>
      paymentWrite.buildPaymentProposal(
        { listUnpaidInvoices: (cid) => sales.listUnpaidInvoices(mcp, cid, knownIds) },
        resolved,
        opts,
      ),
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
    listPaymentEntries: (id) => payment.listPaymentEntries(mcp, id, knownIds),
  }),
  inventory: (mcp) => ({
    listInventory: (f) => inventory.listInventory(mcp, f),
    findItem: (n) => inventory.findItem(mcp, n),
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
