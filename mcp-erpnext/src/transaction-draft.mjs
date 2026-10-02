/**
 * next8 Phase 1 — TRANSACTION DRAFT primitives (plan1_final_v2 §7, §11, §12, §14).
 *
 * A draft is what the USER is building on a screen: items, discounts, which
 * invoices to settle and how the money arrives. The rules that matter here are
 * the ones that must hold for EVERY transaction screen (collect today, sales and
 * purchase next), so they live in one pure module instead of being re-derived in
 * each builder:
 *
 *  - money is an integer number of VND (plan §26): no floats anywhere;
 *  - the SERVER computes the summary — a client-supplied total is never an
 *    input, only something to compare against;
 *  - the draft never picks an invoice on the user's behalf (plan §2.1(11), §8.2,
 *    §9): there is no FIFO/oldest/first helper in this file, and
 *    test/next8-collect-draft.test.mjs asserts that against the module source so
 *    a future edit cannot quietly add one;
 *  - owner lock §6.1: NEXT8 collects with EXACTLY ONE payment method (cash OR
 *    bank). The array shape stays because sales/purchase reuse it — the LIMIT is
 *    what makes it one-payment-per-document today.
 *  - owner lock §6.3: allocations are mandatory whenever the customer has open
 *    invoices; an empty allocation list is only legal when there is nothing open
 *    (on-account / advance).
 */

export const DRAFT_CODES = Object.freeze({
  AMOUNT_INVALID: "INVALID_AMOUNT",
  ALLOCATION_REQUIRED: "MISSING_REQUIRED_FIELD",
  ALLOCATION_EXCEEDS: "INSUFFICIENT_OUTSTANDING",
  DUPLICATE_INVOICE: "DUPLICATE_ALLOCATION",
  METHOD_COUNT_INVALID: "PAYMENT_METHOD_COUNT_INVALID",
  METHOD_MODE_INVALID: "PAYMENT_METHOD_INVALID",
  TOTAL_MISMATCH: "ALLOCATION_TOTAL_MISMATCH",
  CLIENT_AUTHORITY: "CLIENT_AUTHORITY_REJECTED",
});

/** The two money channels ERPNext can receive on ONE document (lock §6.1). */
export const PAYMENT_MODES = Object.freeze(["cash", "bank_transfer"]);

/** Exactly one method per collect, by owner lock §6.1. */
export const MAX_METHODS_PER_TRANSACTION = 1;

export function isVndAmount(value) {
  return Number.isInteger(value);
}

function invalid(code, reason) {
  return Object.assign(new Error(reason), { code });
}

/**
 * PaymentMethod — HOW the money arrives. There is deliberately no `credit`
 * member: a credit remainder is `total − paid`, a NUMBER, never a channel
 * (plan §7.2 / §14: "do not model credit as money received by an account").
 *
 * @param {{mode:string, amount:number, account_id?:string|null}} args
 */
export function paymentMethod({ mode, amount, account_id = null }) {
  if (!PAYMENT_MODES.includes(mode)) {
    throw invalid(DRAFT_CODES.METHOD_MODE_INVALID, `phương thức "${mode}" không hợp lệ (chỉ nhận ${PAYMENT_MODES.join("|")})`);
  }
  if (!isVndAmount(amount)) {
    throw invalid(DRAFT_CODES.AMOUNT_INVALID, "số tiền phải là số nguyên VND");
  }
  return { mode, amount, account_id };
}

/** InvoiceAllocation — which invoice, and how much of the money goes to it. */
export function invoiceAllocation({ invoice_id, allocated_amount }) {
  if (typeof invoice_id !== "string" || invoice_id.trim() === "") {
    throw invalid(DRAFT_CODES.ALLOCATION_REQUIRED, "thiếu mã hoá đơn trong phân bổ");
  }
  if (!isVndAmount(allocated_amount)) {
    throw invalid(DRAFT_CODES.AMOUNT_INVALID, "số tiền phân bổ phải là số nguyên VND");
  }
  return { invoice_id, allocated_amount };
}

/** TransactionItem — reused by the sales/purchase screens (plan §12/§14). */
export function transactionItem({ item_id, uom = null, qty, unit_price = null, line_discount = 0 }) {
  if (typeof item_id !== "string" || item_id.trim() === "") {
    throw invalid(DRAFT_CODES.ALLOCATION_REQUIRED, "thiếu mã mặt hàng trong dòng hàng");
  }
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) {
    throw invalid(DRAFT_CODES.AMOUNT_INVALID, "số lượng phải lớn hơn 0");
  }
  if (unit_price !== null && !isVndAmount(unit_price)) {
    throw invalid(DRAFT_CODES.AMOUNT_INVALID, "đơn giá phải là số nguyên VND");
  }
  if (!isVndAmount(line_discount)) {
    throw invalid(DRAFT_CODES.AMOUNT_INVALID, "chiết khấu dòng phải là số nguyên VND");
  }
  return { item_id, uom, qty, unit_price, line_discount };
}

/**
 * Validate the allocation list against the invoices that really exist for this
 * customer.
 *
 * @param {Array} allocations
 * @param {object} args
 * @param {Array<{invoice_id:string, outstanding_vnd:number}>} args.openInvoices
 *        the LIVE open invoices (the caller re-read them; this function never reads)
 */
export function validateAllocations(allocations, { openInvoices = [] } = {}) {
  const list = Array.isArray(allocations) ? allocations : [];
  if (openInvoices.length === 0) {
    // Owner lock §6.3: nothing open ⇒ the ONLY legal shape is an empty list
    // (the receipt is an advance/unallocated one). A non-empty list here would
    // mean the user is settling an invoice the server cannot see — refuse rather
    // than write money against an unknown document.
    if (list.length > 0) {
      return {
        ok: false,
        code: DRAFT_CODES.ALLOCATION_EXCEEDS,
        reason: "khách không còn hoá đơn mở — không thể phân bổ vào hoá đơn nào; nếu là trả trước thì để trống danh sách hoá đơn",
      };
    }
    return { ok: true, allocations: [] };
  }
  if (list.length === 0) {
    return {
      ok: false,
      code: DRAFT_CODES.ALLOCATION_REQUIRED,
      reason: "khách còn hoá đơn mở — phải chọn hoá đơn cần gạch nợ (hệ thống không tự chọn giúp)",
    };
  }
  const byId = new Map(openInvoices.map((row) => [row.invoice_id, row]));
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const row = invoiceAllocation(raw ?? {});
    if (seen.has(row.invoice_id)) {
      return { ok: false, code: DRAFT_CODES.DUPLICATE_INVOICE, reason: `hoá đơn ${row.invoice_id} bị chọn hai lần` };
    }
    seen.add(row.invoice_id);
    const invoice = byId.get(row.invoice_id);
    if (!invoice) {
      return {
        ok: false,
        code: "NO_MATCH",
        reason: `hoá đơn ${row.invoice_id} không thuộc khách này hoặc không còn mở`,
      };
    }
    if (row.allocated_amount <= 0) {
      return { ok: false, code: DRAFT_CODES.AMOUNT_INVALID, reason: `số tiền gạch cho ${row.invoice_id} phải lớn hơn 0` };
    }
    if (row.allocated_amount > invoice.outstanding_vnd) {
      return {
        ok: false,
        code: DRAFT_CODES.ALLOCATION_EXCEEDS,
        reason: `số tiền gạch cho ${row.invoice_id} vượt quá số còn nợ (${invoice.outstanding_vnd})`,
      };
    }
    out.push(row);
  }
  return { ok: true, allocations: out };
}

/**
 * Validate the payment methods.
 *
 * @param {Array} methods
 * @param {{maxMethods?:number}} [opts] `maxMethods` exists so sales/purchase can
 *        lift the limit later WITHOUT editing collect's rule; NEXT8 uses the
 *        lock's value (1).
 */
export function validatePaymentMethods(methods, { maxMethods = MAX_METHODS_PER_TRANSACTION } = {}) {
  const list = Array.isArray(methods) ? methods : [];
  if (list.length === 0) {
    return { ok: false, code: DRAFT_CODES.METHOD_COUNT_INVALID, reason: "chưa chọn hình thức thanh toán" };
  }
  if (list.length > maxMethods) {
    return {
      ok: false,
      code: DRAFT_CODES.METHOD_COUNT_INVALID,
      reason: "mỗi lần thu chỉ một hình thức thanh toán — muốn vừa tiền mặt vừa chuyển khoản thì thu thành hai lần",
    };
  }
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const row = paymentMethod(raw ?? {});
    if (seen.has(row.mode)) {
      return { ok: false, code: DRAFT_CODES.METHOD_COUNT_INVALID, reason: `hình thức ${row.mode} bị khai hai lần` };
    }
    seen.add(row.mode);
    if (row.amount <= 0) {
      return { ok: false, code: DRAFT_CODES.AMOUNT_INVALID, reason: "số tiền thu phải lớn hơn 0" };
    }
    out.push(row);
  }
  return { ok: true, methods: out };
}

/**
 * Cross-check the whole draft. Returns the SERVER's own summary — the client's
 * numbers are inputs to compare, never the output.
 *
 * @param {object} draft
 * @param {object} args
 * @param {Array} args.openInvoices live rows
 * @param {number|null} [args.claimedTotalVnd] what the client believes the total is
 */
export function validateTransactionDraft(draft = {}, { openInvoices = [], claimedTotalVnd = null } = {}) {
  const methods = validatePaymentMethods(draft.payment_methods);
  if (!methods.ok) return methods;
  const allocations = validateAllocations(draft.allocations, { openInvoices });
  if (!allocations.ok) return allocations;

  const paymentTotal = methods.methods.reduce((sum, m) => sum + m.amount, 0);
  const allocatedTotal = allocations.allocations.reduce((sum, a) => sum + a.allocated_amount, 0);

  // Lock §6.3: with open invoices the allocation total IS the payment total. With
  // none, allocations are empty and the whole amount is unallocated.
  if (openInvoices.length > 0 && allocatedTotal !== paymentTotal) {
    return {
      ok: false,
      code: DRAFT_CODES.TOTAL_MISMATCH,
      reason: `tổng gạch nợ (${allocatedTotal}) không khớp tổng tiền nhận (${paymentTotal})`,
    };
  }
  if (openInvoices.length === 0 && allocatedTotal !== 0) {
    return { ok: false, code: DRAFT_CODES.TOTAL_MISMATCH, reason: "không có hoá đơn mở thì không được phân bổ" };
  }
  if (claimedTotalVnd !== null && claimedTotalVnd !== paymentTotal) {
    // A client's total is only ever a claim to compare — refusing here keeps
    // "the server is the source of the number" true even for the UI's own math.
    return {
      ok: false,
      code: DRAFT_CODES.CLIENT_AUTHORITY,
      reason: `tổng tiền phía máy khách (${claimedTotalVnd}) không khớp số server tính (${paymentTotal})`,
    };
  }

  return {
    ok: true,
    methods: methods.methods,
    allocations: allocations.allocations,
    summary: buildTransactionSummary({
      paymentMethods: methods.methods,
      allocations: allocations.allocations,
    }),
  };
}

/**
 * TransactionSummary — the SERVER's arithmetic. `outstanding_after_vnd` is what
 * the customer still owes after this transaction; with an advance (no
 * allocations) the whole payment is `unallocated_vnd`.
 *
 * @param {object} args
 * @param {Array} [args.items] transaction lines (sales/purchase; collect has none)
 * @param {Array} args.paymentMethods
 * @param {Array} [args.allocations]
 * @param {number} [args.orderDiscount] sales' second discount layer — kept apart
 */
export function buildTransactionSummary({
  items = [],
  paymentMethods = [],
  allocations = [],
  orderDiscount = 0,
} = {}) {
  const subtotal = items.reduce((sum, item) => {
    const gross = Math.round((item.qty ?? 0) * (item.unit_price ?? 0));
    return sum + gross - (item.line_discount ?? 0);
  }, 0);
  const discount = orderDiscount;
  const total = subtotal - discount;
  const allocatedTotal = allocations.reduce((sum, a) => sum + a.allocated_amount, 0);
  const paymentTotal = paymentMethods.reduce((sum, m) => sum + m.amount, 0);
  return {
    subtotal_vnd: subtotal,
    // Two layers, never merged (plan §12.2): the line discounts are already
    // inside `subtotal`, the order discount is reported separately.
    line_discount_vnd: items.reduce((sum, item) => sum + (item.line_discount ?? 0), 0),
    order_discount_vnd: discount,
    total_vnd: total,
    payment_total_vnd: paymentTotal,
    allocated_total_vnd: allocatedTotal,
    unallocated_vnd: paymentTotal - allocatedTotal,
    // plan §12/§14: the credit remainder is a NUMBER, not a payment channel.
    outstanding_after_vnd: Math.max(0, total - paymentTotal),
  };
}
