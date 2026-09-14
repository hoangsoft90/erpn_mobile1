/**
 * Intent router — keyword-based, NO embeddings.
 *
 * phase-02 spec (from review3/4): the package's tool descriptions are too
 * generic (`create_doc`, `get_list`) for semantic retrieval to distinguish
 * Payment Entry from Journal Entry — the difference lives in the ARGUMENTS.
 * So routing is a fixed keyword table -> one of 4 skill groups, each loading
 * 5-15 concrete tools. Deterministic, testable, and cheap (~0 tokens).
 *
 * Vietnamese keywords align with src/vietnamese_nlp intents (Phase 1):
 * payment, credit_sale, receivable, purchase, delivery, sale, stock_level.
 */

import * as customer from "./skills/customer.mjs";
import * as sales from "./skills/sales.mjs";
import * as payment from "./skills/payment.mjs";
import * as inventory from "./skills/inventory.mjs";

/**
 * Routes need an mcp client + a knownIds set at CALL time, not at import time
 * (the client owns the stdio process). `routeIntent` keeps returning the group
 * NAME plus a factory so callers wire their own client:
 *
 *   const r = routeIntent(text);         // { group, factory }
 *   const skills = r?.factory(mcp, knownIds);
 */

/** @type {Array<{group: string, keywords: string[]}>} */
const ROUTES = [
  {
    group: "customer",
    keywords: [
      "khách", "khach", "customer", "công nợ", "cong no", "receivable",
      "còn nợ", "còn lại", "must pay", "nợ", "no ",
    ],
  },
  {
    group: "sales",
    keywords: [
      "hóa đơn", "hoa don", "invoice", "đơn hàng", "don hang", "order",
      "bán", "ban ", "sale", "còn thiếu", "chưa trả", "chua tra",
    ],
  },
  {
    group: "payment",
    keywords: [
      "trả tiền", "tra tien", "thanh toán", "thanh toan", "phiếu thu",
      "phieu thu", "payment", "đã trả", "da tra", "trả", "tra ",
    ],
  },
  {
    group: "inventory",
    keywords: [
      "tồn kho", "ton kho", "stock", "kho", "còn bao nhiêu", "con bao nhieu",
      "cám", "cam ", "hàng", "hang ", "nhập hàng", "nhap hang", "purchase",
      "xuất kho", "xuat kho", "delivery",
    ],
  },
];

/** @type {Record<string, (mcp: object, knownIds: Set<string>) => object>} */
const SKILL_FACTORIES = {
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
};

/**
 * Route a normalized Vietnamese utterance to a skill group.
 * @param {string} text  already kinship-stripped / synonym-canonicalised (Phase 1 output)
 * @returns {{group: string, factory: (mcp: object, knownIds: Set<string>) => object, matched: string} | null}
 */
export function routeIntent(text) {
  const t = ` ${String(text).toLowerCase()} `;
  for (const route of ROUTES) {
    const hit = route.keywords.find((kw) => t.includes(kw.toLowerCase()));
    if (hit) {
      return { group: route.group, factory: SKILL_FACTORIES[route.group], matched: hit.trim() };
    }
  }
  return null;
}
