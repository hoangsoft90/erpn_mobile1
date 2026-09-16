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
import * as paymentWrite from "./skills/payment-write.mjs";

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
  // WRITE FIRST (Phase 7b, user decision 2026-09-16): the Phase 1 synonym
  // mapper rewrites the VERB "thu tiền/trả tiền/thanh toán" to canonical
  // "payment". But "payment" ALSO appears inside READING questions
  // ("chưa thanh toán" → "chưa payment", "đã thanh toán" → "đã payment"), so
  // a substring keyword cannot separate them. A collect-money COMMAND begins
  // its sentence with the verb — the write route is therefore anchored to the
  // SENTENCE START (checked in routeIntent, not a substring keyword).
  // Review round 2 (2026-09-16): sentence-start alone is STILL not enough —
  // "thanh toán gần nhất của chị Lan là bao nhiêu" (READ history) also
  // normalizes to a sentence starting with "payment". Question/history words
  // deny-list the write route; such questions fall through to the READ
  // payment group (substring "payment"). Fail-safe both ways: a misrouted
  // write only ever shows a HIGH card, a misrouted read only shows history.
  // An amount is NOT required for routing: without one the writer builds a
  // full-debt proposal, which is still a visible HIGH card the user must
  // confirm — never an implicit write.
  {
    group: "payment_write",
    keywords: ["payment"],
    startsWith: true,
    notIf: /bao nhiêu|bao nhieu|mấy|may |gần nhất|gan nhat|mới nhất|moi nhat|\?/,
  },
  // SPECIFIC groups FIRST — the customer group is intentionally broad
  // ("khách"/"nợ"/"còn lại" appear in most questions), so a broad-first order
  // swallows invoice/stock/payment questions that merely mention a customer
  // (batch-accuracy result9: b08–b10 misrouted). Most-specific-match wins.
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
      // "còn bao nhiêu" deliberately ABSENT: it stole "còn nợ" questions when
      // inventory was checked before the broad customer group (result9 fix).
      "tồn kho", "ton kho", "stock", "kho",
      "cám", "cam ", "hàng", "hang ", "nhập hàng", "nhap hang", "purchase",
      "xuất kho", "xuat kho", "delivery",
    ],
  },
  // BROAD group LAST — catches bare receivable questions like
  // "Khách X còn nợ bao nhiêu" that no specific group claimed.
  {
    group: "customer",
    keywords: [
      "khách", "khach", "customer", "công nợ", "cong no", "receivable",
      "còn nợ", "còn lại", "must pay", "nợ", "no ",
    ],
  },
];

/** @type {Record<string, (mcp: object, knownIds: Set<string>) => object>} */
const SKILL_FACTORIES = {
  // Phase 7b: the ONLY write path. findCustomer is the same ID-from-tool-result
  // resolver the read groups use — a write never resolves a customer by guess.
  // buildPaymentProposal expects a skills bag with listUnpaidInvoices (same
  // customer-ID-guarded read the sales group uses) + the builder itself.
  payment_write: (mcp, knownIds) => ({
    findCustomer: (n) => customer.findCustomer(mcp, n, knownIds),
    listUnpaidInvoices: (id) => sales.listUnpaidInvoices(mcp, id, knownIds),
    buildPaymentProposal: (resolved, opts) => paymentWrite.buildPaymentProposal({ listUnpaidInvoices: (cid) => sales.listUnpaidInvoices(mcp, cid, knownIds) }, resolved, opts),
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
};

/**
 * Route a normalized Vietnamese utterance to a skill group.
 * @param {string} text  already kinship-stripped / synonym-canonicalised (Phase 1 output)
 * @returns {{group: string, factory: (mcp: object, knownIds: Set<string>) => object, matched: string} | null}
 */
export function routeIntent(text) {
  // "khách hàng" is THE Vietnamese word for customer — the inventory keyword
  // "hàng" must never eat it (router.test regression, result9).
  const raw = String(text).toLowerCase().replaceAll("khách hàng", "khách");
  const t = ` ${raw} `;
  for (const route of ROUTES) {
    // startsWith routes (the Phase 7b write) anchor to the SENTENCE START —
    // substring matching would also swallow reading questions that merely
    // CONTAIN the word ("...chưa payment"). Both checks use the same
    // normalized text, so the anchor survives the khach-hang rewrite.
    const hit = route.startsWith
      ? route.keywords.find(
          (kw) =>
            raw.startsWith(kw.toLowerCase()) &&
            !(route.notIf && route.notIf.test(raw)),
        )
      : route.keywords.find((kw) => t.includes(kw.toLowerCase()));
    if (hit) {
      return { group: route.group, factory: SKILL_FACTORIES[route.group], matched: hit.trim() };
    }
  }
  return null;
}
