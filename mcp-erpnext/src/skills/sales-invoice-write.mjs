/**
 * Skill: sales_invoice.create WRITE — P9-D (builder + executor, one phase).
 *
 * WHAT THIS FILE IS: the whole invoice path — buildSalesInvoiceProposal (the
 * /ask half) and executeSalesInvoiceProposal (the /execute half, reached ONLY
 * through the Safety Gateway after the confirm + idempotency gates). The
 * capability is a real WRITE in the contract; every document it creates is a
 * DRAFT (docstatus 0 — a SUBMITTED Sales Invoice posts revenue and receivable,
 * which is not a chat side effect).
 *
 * Guards this file owns (each has a test that goes RED when the guard is
 * removed — see test/p9-d-sales-invoice.test.mjs and the falsify harness):
 *
 *  - the ORDER anchors everything: lines, units and PRICE come from the Sales
 *    Order, never from the sentence. Measured on the real site (recipes):
 *    ERPNext refuses an invoice whose rate differs from the order it is linked
 *    to — HTTP 417 "Đơn giá phải giống với Purchase Order" on the buying side,
 *    and the same `validate_rate_with_reference_doc` runs on the selling side.
 *    So a rate taken from the utterance is not merely risky, it is unwritable;
 *  - what is still BILLABLE is arithmetic on ERPNext's own numbers:
 *    `qty − billed_amt / rate` (recipes §436 documents exactly this for the
 *    buying side: "billed_amt (billed_amt / rate = số lượng đã hoá đơn)").
 *    When the order does not carry that information at all the answer is a
 *    REFUSAL (SI_PENDING_UNKNOWN), never "assume nothing was billed" — that
 *    assumption is how a shop invoices the same goods twice;
 *  - OPEN DRAFT invoices already claiming part of this order are subtracted:
 *    ERPNext advances `billed_amt` only at SUBMIT, so raw pending still counts
 *    what live drafts promise. This is the P9-A1/P9-B lesson (a draft holds the
 *    goods on paper) applied to money instead of stock — fixed HERE rather than
 *    rediscovered, because for money the second confirmation is worse;
 *  - `update_stock: 0` is sent EXPLICITLY. An invoice created from chat must
 *    never move stock, even if a site's defaults would (recipes §704: the mapper
 *    keeps 0 when the source document did not stock-update — and §1223 warns
 *    that an invoice which DOES stock-update is what produces the "GP ảo": booked
 *    revenue with no COGS). The read-back verifies it;
 *  - a FULL page of the customer's open orders (or of their draft invoices) is a
 *    question, not a pick: past the page cap "exactly one candidate" is not
 *    knowable, so the path asks instead of choosing.
 *
 * Why an invoice needs its own rules (it is not "an order with a filter"):
 *
 *  - A Sales Invoice AGAINST A SALES ORDER links with `sales_order` + `so_detail`
 *    — NOT `against_sales_order`, which is the Delivery Note's field. Measured
 *    fact (.agents/skills/erpnext-rest-api-core/SKILL.md:205): swapping the two
 *    shapes is what ERPNext answers with "Đối ứng với Mục đơn hàng bán chưa
 *    thiết lập";
 *  - the order must be SUBMITTED (docstatus 1) for the same reason;
 *  - no `posting_date`, no `due_date`, no `payment_schedule` are sent: ERPNext
 *    defaults them at the SITE (P5-2 measured that a date derived from the host
 *    clock writes yesterday's document between 00:00–07:00 VN), and the recipes
 *    skill records that a hand-built `payment_schedule` is rejected unless it
 *    links a REAL Payment Term per row. Tax templates are ERPNext's own defaults
 *    too — never invented here.
 */

import { assertReadOnly } from "../readonly-guard.mjs";
import { buildProposal } from "../action-proposal.mjs";
import { getCapability } from "../capability-contract.mjs";
import { classifyDriftCode } from "../proposal-freshness.mjs";
import {
  docOf,
  newActionId,
  pairLines,
  refuse,
  resolveSalesCompany,
  rowsOf,
  selectNonOverlappingItems,
} from "./sales-order-write.mjs";

/** The ONE doctype this skill may build for (fail-closed everywhere else). */
export const WRITE_DOCTYPE = "Sales Invoice";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "sales_invoice.create";

/** Floating-point tolerance for quantities/amounts (ERPNext floats, we compare). */
const EPS = 1e-9;

/**
 * How many of a customer's open orders we are willing to look at before asking
 * which one. Not a performance knob: past this point the sentence "xuất hoá đơn
 * cho Lan" no longer identifies ONE order, so the pipeline must ask instead of
 * picking. A FULL page is treated as "possibly more".
 */
const OPEN_ORDER_LOOKUP_LIMIT = 5;

/**
 * How many OPEN DRAFT invoices of one customer we read per proposal. A FULL page
 * refuses (fail-closed): past this cap we cannot know how much of the order is
 * already claimed by drafts, so "what is still billable" is unknowable.
 */
const DRAFT_INVOICE_LOOKUP_LIMIT = 10;

/** Contract policy block, read per call (a missing block is a hard bug). */
function policy() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("SI_CONTRACT_MISSING: sales_invoice.create is not in the capability contract");
  return cap.line_policy ?? {};
}

/** Read one Sales Order (wrapped tool result → the document). */
async function readOrder(skills, name) {
  try {
    return docOf(await skills.getSalesOrder(name));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được đơn bán ${name} từ ERPNext: ${err?.message ?? err}`);
  }
}

/**
 * How much of ONE order line is still BILLABLE.
 *
 * `billed_qty` comes from ERPNext's own `billed_amt` divided by the line's rate
 * (recipes §436 documents exactly this on the buying side: "billed_amt
 * (billed_amt / rate = số lượng đã hoá đơn)"). Both halves are ERPNext numbers;
 * nothing is estimated.
 *
 * Returns `billed_known: false` whenever the exact billed quantity cannot be
 * DERIVED — the caller turns that into a refusal. The two measured cases:
 *
 *  - the line carries NEITHER `billed_amt` NOR `per_billed`: the order may
 *    already be invoiced, so assuming "0 billed" is how the same goods get
 *    billed twice;
 *  - the line carries ONLY a PARTIAL `per_billed` (say 40%): the exact quantity
 *    is not recoverable from a rounded percentage (qty × 0.4 is an estimate, and
 *    on a 3-unit line it is not even an integer). Reading it as "0 billed" would
 *    invoice the whole line again — the same double-billing, one step subtler.
 *    A percentage of 0 or 100 IS exact, so those two are accepted.
 *
 * `rate <= 0` with money already billed is inconsistent data (returns/amends can
 * produce it): reported as unknown rather than divided by zero.
 */
function billableOf(item) {
  const qty = Number(item?.qty ?? 0);
  const rate = Number(item?.rate ?? 0);
  const hasBilledAmt = item?.billed_amt !== undefined && item?.billed_amt !== null;
  const hasPerBilled = item?.per_billed !== undefined && item?.per_billed !== null;
  const perBilled = hasPerBilled ? Number(item.per_billed) : null;
  if (hasBilledAmt) {
    const billedAmt = Number(item.billed_amt);
    if (!Number.isFinite(billedAmt) || billedAmt < 0) return { billed_known: false, qty, rate, billedQty: 0, why: "billed_amt không hợp lệ" };
    if (rate > 0) return { billed_known: true, qty, rate, billedQty: billedAmt / rate, per_billed: perBilled };
    if (billedAmt > 0) return { billed_known: false, qty, rate, billedQty: 0, why: "có tiền đã hoá đơn nhưng đơn giá bằng 0" };
    return { billed_known: true, qty, rate, billedQty: 0, per_billed: perBilled };
  }
  if (perBilled !== null && Number.isFinite(perBilled)) {
    if (perBilled <= 0) return { billed_known: true, qty, rate, billedQty: 0, per_billed: perBilled };
    if (perBilled >= 100) return { billed_known: true, qty, rate, billedQty: qty, per_billed: perBilled };
    return { billed_known: false, qty, rate, billedQty: 0, per_billed: perBilled, why: `chỉ có per_billed=${perBilled}%` };
  }
  return { billed_known: false, qty, rate, billedQty: 0, why: "thiếu cả billed_amt và per_billed" };
}

/**
 * The lines of an order that still OWE an invoice: `qty − billed_qty`, in the
 * order's own numbers, with the ORDER's price and unit carried along.
 */
function pendingLines(so) {
  const items = Array.isArray(so?.items) ? so.items : [];
  return items
    .map((it) => {
      const b = billableOf(it);
      return {
        item_code: String(it.item_code ?? it.name ?? ""),
        item_name: it.item_name ?? String(it.item_code ?? it.name ?? ""),
        uom: it.uom ?? it.stock_uom ?? null,
        so_detail: it.name ?? null,
        ordered: Number(it.qty ?? 0),
        rate: Number(it.rate ?? 0),
        billed_known: b.billed_known,
        billed: b.billedQty,
        pending: Number(it.qty ?? 0) - (Number.isFinite(b.billedQty) ? b.billedQty : 0),
      };
    })
    .filter((l) => l.pending > EPS);
}

/**
 * WHICH order does this invoice refer to?
 *
 * Two honest paths, no third:
 *  - the sentence named one (`resolved.order`) — it must exist and be SUBMITTED;
 *  - it named none — then the CUSTOMER's own open orders are read and exactly ONE
 *    that still owes an invoice is used. Several is a question: invoicing the
 *    wrong order books revenue against the wrong document and cannot be undone
 *    from chat.
 */
async function resolveOrder(skills, { orderName, customerId, ambiguous, candidates }) {
  if (orderName) {
    const so = await readOrder(skills, orderName);
    if (!so?.name) {
      throw refuse("SI_SO_NOT_FOUND", `không tìm thấy đơn bán "${orderName}" trong ERPNext — không xuất hoá đơn`);
    }
    return so;
  }
  if (!customerId) {
    throw refuse(
      "SI_SO_UNRESOLVED",
      ambiguous
        ? `tên khách khớp nhiều kết quả (${(candidates ?? []).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ trước khi xuất hoá đơn`
        : "chưa xác định được khách hàng nên không biết xuất hoá đơn cho đơn nào — không tự chọn đơn",
    );
  }
  let rows = [];
  try {
    rows = rowsOf(await skills.listOpenSalesOrders(customerId));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được danh sách đơn bán của khách từ ERPNext: ${err?.message ?? err}`);
  }
  const names = rows.map((r) => String(r.name ?? "")).filter(Boolean);
  if (names.length === 0) {
    throw refuse(
      "SI_SO_UNRESOLVED",
      "khách chưa có đơn bán nào ĐÃ SUBMIT — ERPNext chỉ cho xuất hoá đơn theo đơn đã submit, hãy submit đơn bán trước",
    );
  }
  const withPending = [];
  for (const name of names.slice(0, OPEN_ORDER_LOOKUP_LIMIT)) {
    const so = await readOrder(skills, name);
    if (so?.name && pendingLines(so).length > 0) withPending.push(so);
  }
  // A FULL page is "possibly more": the list read caps at exactly
  // OPEN_ORDER_LOOKUP_LIMIT rows, so `names.length >= LIMIT` means one order on
  // the page may not be the one the user meant. Ask.
  if (withPending.length > 1 || names.length >= OPEN_ORDER_LOOKUP_LIMIT) {
    const list = withPending.map((s) => s.name);
    throw refuse(
      "SI_SO_UNRESOLVED",
      `khách có ${names.length} đơn đã submit${list.length ? ` (${list.slice(0, 5).join(", ")} còn chờ hoá đơn)` : ""} — nói rõ xuất hoá đơn cho đơn nào`,
      { candidates: list },
    );
  }
  if (withPending.length === 0) {
    throw refuse(
      "SI_NOTHING_TO_BILL",
      `không đơn nào của khách còn phần chưa hoá đơn (đã xem ${names.length} đơn) — không tạo hoá đơn rỗng`,
    );
  }
  return withPending[0];
}

/**
 * What does the SENTENCE say to invoice?
 *
 * Returns null when it names no item — that is "xuất hoá đơn cho phần còn lại",
 * the one interpretation that needs no guess. But a sentence that carries a
 * QUANTITY yet matches no item is NOT null: it is a refusal. Defaulting to
 * "everything" there would ignore a number the user said, which is the silent
 * wrong-quantity invoice this path exists to prevent.
 */
async function requestedLinesFromText(skills, opts, partyName = null) {
  const text = opts.text ?? opts.nlp?.text ?? "";
  const quantities = opts.nlp?.quantities ?? [];
  let itemRows = [];
  try {
    itemRows = rowsOf(await skills.findItem(""));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được danh mục mặt hàng từ ERPNext: ${err?.message ?? err}`);
  }
  // R6: the customer's OWN name is not a line (see maskPartyMention).
  const named = selectNonOverlappingItems(itemRows, text, { partyNames: [partyName] });
  if (named.length === 0) {
    if (quantities.length > 0) {
      throw refuse(
        "SI_ITEM_UNRESOLVED",
        `câu có số lượng nhưng không khớp mặt hàng nào trong ERPNext ("${text}") — nói rõ tên mặt hàng, hoặc bỏ số lượng để xuất hoá đơn cho phần còn lại`,
      );
    }
    return null;
  }
  const { lines: paired, problems } = pairLines({ matched: named, quantities });
  if (problems.length > 0) {
    const code = String(problems[0].code ?? "").includes("AMBIGUOUS") ? "SI_QTY_AMBIGUOUS" : "SI_QTY_MISSING";
    throw refuse(code, problems[0].reason, { problems });
  }
  return paired.map(({ item, quantity }) => ({
    item_code: item.item_code ?? item.name,
    qty: Number(quantity.value),
    // The unit the user SAID. The invoice line's unit is the ORDER's, so a
    // mismatch must refuse (no hidden conversion, B1).
    unit: quantity.canonical_unit ?? null,
  }));
}

/** Guarded read: the customer's OPEN (draft) Sales Invoices. */
export async function listOpenDraftSalesInvoices(mcp, customerId) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: WRITE_DOCTYPE,
    fields: ["name", "docstatus", "customer"],
    filters: [["customer", "=", String(customerId)], ["docstatus", "=", "0"]],
    limit: DRAFT_INVOICE_LOOKUP_LIMIT,
  });
}

/** Guarded read: one Sales Invoice document. */
export async function getSalesInvoiceDoc(mcp, name) {
  assertReadOnly("erpnext_doc_get");
  return mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: String(name) });
}

/**
 * How much of one order do OPEN DRAFT invoices already claim?
 *
 * ERPNext advances `billed_amt` only at SUBMIT, so `qty − billed_qty` still
 * counts lines that live drafts promise. Ignoring them means a second
 * confirmation proposes the same money again — and unlike a delivery note, an
 * invoice that is later submitted twice puts the same revenue in the books
 * twice. A draft invoice links to its order with `sales_order` on each item
 * (core §205), which is what this sums.
 *
 * @param {{listOpenDraftSalesInvoices: Function, getSalesInvoiceDoc: Function}} reads
 * @returns {Promise<{drawn: Map<string, number>, drafts: string[]}>}
 */
async function openDraftCover(reads, customerId, soName) {
  let rows = [];
  try {
    rows = rowsOf(await reads.listOpenDraftSalesInvoices(customerId));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được hoá đơn NHÁP đang chờ của khách từ ERPNext: ${err?.message ?? err}`);
  }
  if (rows.length >= DRAFT_INVOICE_LOOKUP_LIMIT) {
    throw refuse(
      "SI_DRAFT_COVERED",
      `khách có ${rows.length} hoá đơn NHÁP chưa submit — dọn (submit hoặc hủy) các hoá đơn đó trên ERPNext trước khi xuất hoá đơn mới`,
    );
  }
  const drawn = new Map();
  const drafts = [];
  for (const row of rows) {
    const name = String(row.name ?? "");
    if (!name) continue;
    let doc = null;
    try {
      doc = docOf(await reads.getSalesInvoiceDoc(name));
    } catch (err) {
      throw refuse("ERP_UNAVAILABLE", `không đọc được hoá đơn nháp ${name}: ${err?.message ?? err}`);
    }
    const mine = (Array.isArray(doc?.items) ? doc.items : []).filter(
      (it) => String(it.sales_order ?? "") === String(soName),
    );
    if (mine.length === 0) continue;
    drafts.push(name);
    for (const it of mine) {
      const code = String(it.item_code ?? "");
      drawn.set(code, (drawn.get(code) ?? 0) + Number(it.qty ?? 0));
    }
  }
  return { drawn, drafts };
}

/** Raw pending minus what open drafts already claim. */
function subtractDrawn(pending, drawn) {
  return pending
    .map((l) => ({ ...l, pending: l.pending - (drawn.get(l.item_code) ?? 0) }))
    .filter((l) => l.pending > EPS);
}

/**
 * The customer's orders that could still be invoiced — SUBMITTED only.
 *
 * Exported (and guarded) so the router factory wires a read that goes through
 * the SAME `assertReadOnly` gate as every other skill read: a bare
 * `mcp.callTool` written inside the router would be the one read path with no
 * guard on it. Shared with the delivery path (same query, same reasoning).
 */
export async function listOpenSalesOrders(mcp, customerId) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: "Sales Order",
    fields: ["name", "customer", "docstatus", "transaction_date"],
    filters: [["customer", "=", String(customerId)], ["docstatus", "=", "1"]],
    limit: OPEN_ORDER_LOOKUP_LIMIT,
  });
}

/** Guarded read: one Sales Order document (the invoice proposal's source). */
export async function getSalesOrderDoc(mcp, name) {
  assertReadOnly("erpnext_doc_get");
  return mcp.callTool("erpnext_doc_get", { doctype: "Sales Order", name: String(name) });
}

/**
 * Stage A — build the draft Sales Invoice proposal for a resolved customer and
 * a Sales Order.
 *
 * @param {object} skills   { getSalesOrder }
 * @param {object} resolved { order, customer?, ambiguous?, candidates? }
 * @param {object} [opts]
 * @param {object[]} [opts.lines]  [{item_code, qty}] — what to invoice, if the
 *                                 user named quantities. Omitted ⇒ the whole
 *                                 still-billable quantity of every line.
 * @returns {Promise<{proposal:object, lines:object[], warnings:string[], action_id:string}>}
 */
export async function buildSalesInvoiceProposal(skills, resolved, opts = {}) {
  const { customer = null, order = null, ambiguous = false, candidates = [] } = resolved ?? {};

  // 1. An invoice has to be against a SPECIFIC order. Guessing one (or invoicing
  //    the customer's whole backlog) is what this refusal prevents.
  const orderName = typeof order === "string" ? order : (order?.name ?? null);
  const so = await resolveOrder(skills, {
    orderName,
    customerId: customer?.name ?? null,
    ambiguous,
    candidates,
  });

  // 2. ERPNext links an invoice to a SUBMITTED order. An app-created order is a
  //    DRAFT until someone submits it on the site, so this is a common case and
  //    it must say so rather than fail as a raw link.
  if (Number(so.docstatus) !== 1) {
    throw refuse(
      "SI_SO_NOT_SUBMITTED",
      `đơn ${so.name} chưa được submit (docstatus=${so.docstatus ?? "?"}) — ERPNext chỉ cho xuất hoá đơn theo đơn ĐÃ SUBMIT; mở ERPNext submit đơn trước`,
    );
  }

  // 3. The ORDER decides who is invoiced — cross-checked against the resolved
  //    customer, never overridden by it.
  const soCustomerId = String(so.customer ?? "");
  if (!soCustomerId) {
    throw refuse("SI_CUSTOMER_UNRESOLVED", `đơn ${so.name} không có khách hàng — không xuất hoá đơn`);
  }
  if (customer && String(customer.name) !== soCustomerId) {
    throw refuse(
      "SI_CUSTOMER_MISMATCH",
      `đơn ${so.name} thuộc khách ${so.customer_name ?? soCustomerId}, không phải ${customer.customer_name ?? customer.name} — không xuất hoá đơn cho sai khách`,
    );
  }

  // 4. What the order still OWES an invoice. Arithmetic on ERPNext's numbers.
  const soItems = Array.isArray(so.items) ? so.items : [];
  if (soItems.length === 0) {
    throw refuse("SI_NOTHING_TO_BILL", `đơn ${so.name} không có dòng hàng nào — không xuất hoá đơn`);
  }
  const rawPending = pendingLines(so);
  // 4b. NOTE (deliberate order): the "can I even know what is left to bill?"
  //     check is NOT here. It runs after `chosen` (step 5b) on the lines this
  //     proposal actually carries, so a legible line the user named is not
  //     blocked by an illegible SIBLING line they did not ask about. A line with
  //     unknown billed data keeps `pending = qty − 0`, which is exactly why it
  //     must never be written without that check — see billableOf().
  if (rawPending.length === 0) {
    throw refuse(
      "SI_ALREADY_BILLED",
      `đơn ${so.name} đã hoá đơn đủ (không còn dòng nào chờ xuất) — không tạo hoá đơn rỗng`,
    );
  }
  // 4c. Subtract what OPEN DRAFT invoices already claim (see openDraftCover).
  const draftCover = await openDraftCover(skills, soCustomerId, so.name);
  const pending = subtractDrawn(rawPending, draftCover.drawn);
  const draftWarnings = [];
  for (const l of rawPending) {
    const d = draftCover.drawn.get(l.item_code) ?? 0;
    if (d > EPS) draftWarnings.push(`${l.item_name}: đã có hoá đơn NHÁP chờ ${d} ${l.uom ?? ""} (chưa submit)`);
  }
  if (pending.length === 0 && rawPending.length > 0) {
    throw refuse(
      "SI_DRAFT_COVERED",
      `đơn ${so.name} còn chờ xuất hoá đơn nhưng đã có hoá đơn NHÁP (${draftCover.drafts.slice(0, 5).join(", ")}) chưa submit phủ hết — submit hoặc hủy hoá đơn đó trên ERPNext trước khi xuất tiếp`,
    );
  }

  // 5. Explicit quantities: each one must point at a line of THIS order and must
  //    not exceed what is still billable. Two sources, one validation — a caller
  //    may hand them in (`opts.lines`, used by the camera slot form and tests) or
  //    the SENTENCE may carry them (parsed here, so the /ask path and the unit
  //    tests cannot diverge on what "xuất 2 bao" means).
  const requested = Array.isArray(opts.lines) ? opts.lines : await requestedLinesFromText(skills, opts, so.customer_name ?? null);
  let chosen;
  if (requested) {
    if (requested.length === 0) {
      throw refuse("SI_QTY_INVALID", "không có dòng hàng nào được nêu — không xuất hoá đơn");
    }
    // The same item named twice is a QUESTION, not a sum — adding the numbers
    // would silently invoice 5 when the user may have meant 2 (or 3).
    const seen = new Set();
    for (const want of requested) {
      const code = String(want?.item_code ?? "");
      if (seen.has(code)) {
        throw refuse(
          "SI_QTY_AMBIGUOUS",
          `"${code}" được nêu nhiều lần trong cùng một câu — chưa rõ muốn xuất hoá đơn tổng bao nhiêu, nói lại một lần duy nhất`,
        );
      }
      seen.add(code);
    }
    chosen = requested.map((want) => {
      const code = String(want?.item_code ?? "");
      const line = pending.find((l) => l.item_code === code);
      if (!line) {
        const existed = soItems.some((it) => String(it.item_code ?? it.name ?? "") === code);
        if (existed) {
          const covered = rawPending.some((l) => l.item_code === code);
          throw covered
            ? refuse(
                "SI_DRAFT_COVERED",
                `"${code}" còn chờ xuất hoá đơn nhưng đã có hoá đơn NHÁP (${draftCover.drafts.slice(0, 5).join(", ")}) chưa submit phủ hết — submit hoặc hủy hoá đơn đó trước`,
              )
            : refuse("SI_ALREADY_BILLED", `"${code}" trong đơn ${so.name} đã hoá đơn đủ — không xuất thêm`);
        }
        throw refuse("SI_ITEM_NOT_IN_SO", `"${code}" không có trong đơn ${so.name} — chỉ xuất hoá đơn cho hàng của chính đơn đó`);
      }
      const qty = Number(want?.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw refuse("SI_QTY_INVALID", `số lượng xuất hoá đơn của "${line.item_name}" phải là số dương (đang ${want?.qty})`);
      }
      if (qty - line.pending > EPS) {
        throw refuse(
          "SI_QTY_EXCEEDS_PENDING",
          `"${line.item_name}" chỉ còn ${line.pending} ${line.uom ?? ""} chưa xuất hoá đơn, không xuất được ${qty} — kiểm tra lại đơn`,
        );
      }
      // The unit the user said must be the order's unit. No hidden conversion:
      // a number in another unit is a DIFFERENT quantity, and converting it here
      // is how "1 tấn" becomes a card that invoices "1 bao".
      if (want.unit) {
        const spoken = String(want.unit).trim().toLowerCase();
        const orderUom = String(line.uom ?? "").trim().toLowerCase();
        if (orderUom && spoken !== orderUom) {
          throw refuse(
            "SI_UOM_MISMATCH",
            `đơn ${so.name} ghi "${line.item_name}" theo đơn vị "${line.uom}", câu nói theo "${want.unit}" — không tự quy đổi; hãy nói theo đơn vị của đơn, hoặc bỏ đơn vị để xuất hoá đơn phần còn lại`,
          );
        }
      }
      return { ...line, qty };
    });
  } else {
    // Nothing named ⇒ invoice everything the order still owes, whole lines.
    chosen = pending.map((l) => ({ ...l, qty: l.pending }));
  }

  // 5b. "I cannot know what is left to bill" is a refusal, not a zero. A line
  //     whose billed quantity is not derivable may ALREADY be invoiced, and
  //     assuming it is not is exactly how the same goods get billed twice.
  //     Checked HERE (not earlier) because only the lines this proposal carries
  //     matter: an illegible sibling line must not block a clean one.
  const unknown = chosen.filter((l) => l.billed_known === false);
  if (unknown.length > 0) {
    const why = soItems
      .filter((it) => unknown.some((l) => l.item_code === String(it.item_code ?? it.name ?? "")))
      .map((it) => `${it.item_code ?? it.name}: ${billableOf(it).why ?? "thiếu dữ liệu"}`);
    throw refuse(
      "SI_PENDING_UNKNOWN",
      `đơn ${so.name} không đủ dự kiện để biết "đã hoá đơn bao nhiêu" (${why.slice(0, 3).join("; ")}) — không đoán, không xuất hoá đơn`,
    );
  }

  // 5c. A price is REQUIRED and comes from the ORDER only. `no_price: "ask"` in
  //     the contract: a line with no rate is a question (khai giá trên đơn), not
  //     a zero-value invoice — silently invoicing 0 books a sale of nothing.
  for (const l of chosen) {
    if (!(l.rate > 0)) {
      throw refuse(
        "SI_RATE_MISSING",
        `đơn ${so.name} không có đơn giá cho "${l.item_name}" — hoá đơn cần giá; khai giá trên đơn bán rồi xuất lại (không lấy giá từ câu nói)`,
      );
    }
  }

  const maxLines = Number(policy().max_lines ?? 20);
  if (chosen.length > maxLines) {
    throw refuse(
      "SI_LINE_LIMIT",
      `hoá đơn có ${chosen.length} dòng, vượt giới hạn ${maxLines} dòng mỗi hoá đơn — tách thành nhiều hoá đơn`,
    );
  }

  const warnings = [...draftWarnings];
  const lines = chosen.map((l) => {
    if (l.pending < l.ordered - EPS) {
      warnings.push(`${l.item_name}: đơn còn phải xuất hoá đơn ${l.pending}/${l.ordered} ${l.uom ?? ""}`);
    }
    if (l.qty < l.pending - EPS) {
      warnings.push(`${l.item_name}: xuất một phần ${l.qty}/${l.pending} ${l.uom ?? ""} (đơn vẫn còn chờ hoá đơn)`);
    }
    return {
      item_code: l.item_code,
      item_name: l.item_name,
      qty: l.qty,
      // The ORDER's price. Never the sentence, never a default.
      rate: l.rate,
      amount: Math.round(l.qty * l.rate),
      uom: l.uom,
      sales_order: so.name,
      so_detail: l.so_detail,
    };
  });

  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  const proposal = buildProposal({
    action: "create_sales_invoice",
    risk: "HIGH",
    entity: {
      kind: "customer",
      id: soCustomerId,
      name: so.customer_name ?? customer?.customer_name ?? null,
    },
    params: {
      sales_order: so.name,
      lines,
      line_count: lines.length,
      // Sum of the lines at the ORDER's prices — a report of what the card
      // shows, not a number any executor may write: ERPNext recomputes totals
      // (and adds its own taxes) when the document is inserted. Named
      // `estimated_total_vnd` like the other five line documents (SO/QT/PO/DN/
      // PR) so the card's one "Tạm tính" renderer shows the same key for all of
      // them — `net_total_vnd` is reserved for the WRITTEN document's own total
      // (the executor's result), which is a different number with a different
      // meaning.
      estimated_total_vnd: total,
      // Draft is part of WHAT is being approved: the card promises a NHÁP
      // invoice, and nothing downstream may submit it (allow_submit false — a
      // submitted invoice posts revenue and receivable).
      submit_now: false,
      update_stock: false,
    },
    summary: `Tạo hoá đơn NHÁP theo đơn ${so.name}: ${lines
      .map((l) => `${l.qty} ${l.uom ?? ""} ${l.item_name}`.trim())
      .join(" + ")}`,
    extra: {
      ambiguous,
      warnings,
      action_id: newActionId(),
      schema_note:
        "params.lines là ĐỀ XUẤT lấy từ chính đơn bán (dòng + ĐƠN GIÁ của đơn) — execute mới đọc lại ERPNext; hoá đơn KHÔNG tự submit và KHÔNG đụng kho (update_stock = 0)",
    },
  });

  return { proposal, lines, warnings, action_id: proposal.action_id };
}

/* --------------------------------------------------------------- executor -- */

/**
 * P0 §10.4 — ERPNext-side correlation field, read from the contract (single
 * source of truth). Same Custom Field as the order/quotation/purchase/delivery
 * paths, so one migration per doctype covers every write capability.
 */
export function correlationField() {
  return getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
}

/**
 * Reconcile a command against ERPNext — READ ONLY.
 *
 * A Sales Invoice has no natural reference field, so the correlation value IS
 * the lookup key. When the site cannot filter by it, the caller is TOLD
 * (`correlation_field_unavailable`) rather than told "nothing was written" —
 * the difference between "no invoice" and "we cannot know" is the entire point
 * of reconcile, and here it is money.
 */
export async function reconcileSalesInvoice(mcp, reference, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const field = correlationField();
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "customer", field],
      filters: [[field, "=", value]],
      limit: 5,
    });
    const rows = rowsOf(res);
    return {
      found: rows.length > 0,
      count: rows.length,
      doc: rows[0] ?? null,
      duplicates: rows.length > 1,
      correlation_field: field,
      correlation_field_unavailable: false,
    };
  } catch (err) {
    return {
      found: false,
      count: 0,
      doc: null,
      duplicates: false,
      correlation_field: field,
      correlation_field_unavailable: true,
      error: err?.message ?? String(err),
    };
  }
}

/**
 * The REAL Sales Invoice payload (pure — unit-testable without network).
 *
 * Field names are ERPNext's: each item links to its order with `sales_order` +
 * the child-row link `so_detail`. Measured fact this follows
 * (`.agents/skills/erpnext-rest-api-core/SKILL.md:205`): `against_sales_order`
 * is the DELIVERY NOTE's shape; a Sales Invoice uses `sales_order` + `so_detail`,
 * and swapping them is what ERPNext answers with "Đối ứng với Mục đơn hàng bán
 * chưa thiết lập".
 *
 * `update_stock: 0` is explicit and load-bearing: an invoice created from chat
 * must never move stock (recipes §704 keeps 0; §1223 documents that an invoice
 * which DOES stock-update is what books revenue with no COGS — "GP ảo").
 *
 * NO `posting_date` / `due_date` / `payment_schedule` / tax template: ERPNext
 * defaults all of them at the SITE. The payment path measured (P5-2) that a date
 * derived from the host clock writes yesterday's document between 00:00–07:00
 * VN, and recipes records that a hand-built payment_schedule is rejected unless
 * every row links a REAL Payment Term — omitting is strictly safer than guessing.
 */
export function buildSalesInvoiceData({ customerId, salesOrder, lines, company, actionId, correlation }) {
  return {
    doctype: WRITE_DOCTYPE,
    customer: customerId,
    company,
    [correlation]: actionId ?? null,
    update_stock: 0,
    remarks: "ERPNext Voice Copilot · xác nhận bởi người dùng · hoá đơn NHÁP, chưa submit (chưa ghi doanh thu/công nợ)",
    items: lines.map((l) => ({
      item_code: l.item_code,
      qty: l.qty,
      rate: l.rate,
      uom: l.uom,
      sales_order: salesOrder,
      ...(l.so_detail ? { so_detail: l.so_detail } : {}),
    })),
  };
}

/** Read the written invoice back and check it carries what we intended. */
export async function verifyWrittenSalesInvoice(
  mcp,
  docName,
  { customerId, salesOrder, lines, actionId },
) {
  const res = await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName });
  const doc = docOf(res);
  const problems = [];
  if (String(doc.customer ?? "") !== String(customerId)) problems.push(`customer=${doc.customer}`);
  if (Number(doc.docstatus) !== 0) problems.push(`docstatus=${doc.docstatus} (hoá đơn phải là NHÁP)`);
  // The stock flag is part of what was approved: a site that ignored it would
  // have moved stock from a chat command.
  if (Number(doc.update_stock ?? 0) !== 0) {
    problems.push(`update_stock=${doc.update_stock} (hoá đơn từ chat không được đụng kho)`);
  }
  const field = correlationField();
  if (actionId && Object.prototype.hasOwnProperty.call(doc, field)) {
    if (String(doc[field] ?? "") !== String(actionId)) problems.push(`${field}=${doc[field]}`);
  }
  const gotLines = Array.isArray(doc.items) ? doc.items : [];
  if (gotLines.length !== lines.length) {
    problems.push(`số dòng=${gotLines.length} (mong đợi ${lines.length})`);
  } else {
    for (const want of lines) {
      const got = gotLines.find((g) => String(g.item_code) === String(want.item_code));
      if (!got) {
        problems.push(`thiếu dòng ${want.item_code}`);
        continue;
      }
      if (Math.abs(Number(got.qty) - Number(want.qty)) > 1e-9) problems.push(`${want.item_code}: qty=${got.qty}`);
      if (Math.abs(Number(got.rate) - Number(want.rate)) > 1e-9) problems.push(`${want.item_code}: rate=${got.rate}`);
      if (String(got.sales_order ?? "") !== String(salesOrder)) {
        problems.push(`${want.item_code}: sales_order=${got.sales_order}`);
      }
    }
  }
  if (problems.length) {
    throw refuse(
      "SI_WRITE_UNVERIFIED",
      `đọc lại hoá đơn ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc },
    );
  }
  return doc;
}

/**
 * Stage B — execute a CONFIRMED invoice proposal. Called only from the Safety
 * Gateway AFTER the confirm + idempotency gates. The ORDER is re-read from live
 * ERPNext and the billable quantities are recomputed: the proposal's numbers are
 * compared, never trusted.
 *
 * @param {object} mcp MCP client (mock or real)
 * @param {object} proposal erpn.proposal/v1 with action=create_sales_invoice
 * @param {string} commandId client UUID (idempotency key)
 * @param {object} store IdempotencyStore (already gated this command)
 * @returns {Promise<object>} the recorded result (never a submitted document)
 */
export async function executeSalesInvoiceProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const customerId = proposal.entity?.id;
  const salesOrder = String(proposal.params?.sales_order ?? "");
  const wantLines = Array.isArray(proposal.params?.lines) ? proposal.params.lines : [];
  if (!salesOrder) {
    throw refuse("SI_SO_UNRESOLVED", "đề xuất không nói xuất hoá đơn theo ĐƠN BÁN nào — không ghi hoá đơn");
  }
  if (wantLines.length === 0) {
    throw refuse("SI_QTY_INVALID", "đề xuất không có dòng hàng nào — không ghi hoá đơn rỗng");
  }
  const maxLines = Number(policy().max_lines ?? 20);
  if (wantLines.length > maxLines) {
    throw refuse("SI_LINE_LIMIT", `đề xuất có ${wantLines.length} dòng, vượt giới hạn ${maxLines}`);
  }

  // 1. The correlation field is the ONLY once-only half an invoice has. Refuse
  //    BEFORE registering anything when the site cannot store it.
  const field = correlationField();
  const probe = await reconcileSalesInvoice(mcp, commandId, { actionId: proposal.action_id ?? null });
  if (probe.correlation_field_unavailable) {
    throw refuse(
      "SI_CORRELATION_FIELD_MISSING",
      `ERPNext chưa có field "${field}" trên ${WRITE_DOCTYPE} — không có cách chống trùng phía server, KHÔNG ghi hoá đơn (chạy migration thêm field cho ${WRITE_DOCTYPE} trước)`,
    );
  }
  if (probe.found) {
    throw refuse(
      "SI_DUPLICATE_ACTION",
      `hoá đơn ${probe.doc?.name ?? "?"} đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước`,
      { existing_doc: probe.doc?.name ?? null },
    );
  }

  // 2. RE-READ the order: it must still be submitted, still belong to this
  //    customer, still price every line the same way, and still owe every
  //    quantity this proposal promised.
  let so = null;
  try {
    so = docOf(await mcp.callTool("erpnext_doc_get", { doctype: "Sales Order", name: salesOrder }));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc lại được đơn bán ${salesOrder}: ${err?.message ?? err}`);
  }
  const drift = [];
  if (!so?.name) {
    drift.push(`đơn ${salesOrder} không còn tồn tại`);
  } else {
    if (Number(so.docstatus) !== 1) drift.push(`đơn ${so.name} không còn ở trạng thái đã submit (docstatus=${so.docstatus})`);
    if (String(so.customer ?? "") !== String(customerId)) drift.push(`đơn ${so.name} đã đổi sang khách ${so.customer}`);
  }
  const soItems = Array.isArray(so?.items) ? so.items : [];
  if (so?.name && soItems.some((it) => !billableOf(it).billed_known)) {
    throw refuse(
      "SI_PENDING_UNKNOWN",
      `đơn ${salesOrder} không còn đủ dự kiện để biết "đã hoá đơn bao nhiêu" — không biết còn phải xuất bao nhiêu, KHÔNG ghi hoá đơn`,
    );
  }
  const pendingRaw = so?.name ? pendingLines(so) : [];
  // Same draft-deduction as the builder: a live DRAFT claims money the raw
  // pending still counts. Re-checking against RAW pending would let a proposal
  // written before the draft existed pass its drift check and duplicate it.
  const draftCover = so?.name
    ? await openDraftCover(
        {
          listOpenDraftSalesInvoices: (id) => listOpenDraftSalesInvoices(mcp, id),
          getSalesInvoiceDoc: (name) => getSalesInvoiceDoc(mcp, name),
        },
        customerId ?? so?.customer ?? "",
        so.name,
      )
    : { drawn: new Map(), drafts: [] };
  const pending = so?.name ? subtractDrawn(pendingRaw, draftCover.drawn) : [];
  const soItemCodes = soItems.map((it) => String(it.item_code ?? it.name ?? ""));
  const lines = [];
  for (const want of wantLines) {
    const line = pending.find((l) => l.item_code === String(want.item_code));
    if (!line) {
      drift.push(
        soItemCodes.includes(String(want.item_code))
          ? pendingRaw.some((l) => l.item_code === String(want.item_code))
            ? `${want.item_code}: còn chờ xuất hoá đơn nhưng đã có hoá đơn NHÁP chưa submit phủ hết`
            : `${want.item_code}: đơn đã hoá đơn đủ phần còn lại`
          : `${want.item_code} không còn trong đơn ${salesOrder}`,
      );
      continue;
    }
    const qty = Number(want.qty);
    if (!(qty > 0)) {
      throw refuse("SI_QTY_INVALID", `số lượng ${want.item_code} không hợp lệ (${want.qty}) — từ chối ghi`);
    }
    if (qty - line.pending > EPS) {
      drift.push(`${want.item_code}: chỉ còn ${line.pending} chưa xuất hoá đơn (đề xuất ${qty})`);
      continue;
    }
    // The PRICE is re-derived from the order, and the proposal's rate must still
    // be the order's rate — ERPNext refuses a mismatch anyway (417), and catching
    // it here names the reason instead of failing as a raw tool error. A changed
    // price is a CHANGED DEAL, so it is drift, not something to silently adopt.
    if (!(line.rate > 0)) {
      throw refuse("SI_RATE_MISSING", `đơn ${salesOrder} không có đơn giá cho ${want.item_code} — không xuất hoá đơn`);
    }
    if (Math.abs(Number(want.rate) - line.rate) > EPS) {
      drift.push(`${want.item_code}: đơn giá đã đổi (${line.rate} thay vì ${want.rate})`);
      continue;
    }
    lines.push({ ...line, qty });
  }
  if (drift.length > 0) {
    throw refuse(
      "PROPOSAL_STALE",
      `đề xuất đã lệch so với dữ liệu thật: ${drift.join("; ")} — KHÔNG ghi, hãy xác nhận lại`,
      { drift_code: classifyDriftCode(drift), problems: drift },
    );
  }

  const resolvedCompany = await resolveSalesCompany(mcp, {
    authzCompany: company ?? proposal.params?.company ?? null,
    code: "SI_COMPANY_UNRESOLVED",
    noun: "hoá đơn",
  });
  const actionId = proposal.action_id ?? null;

  // 3. Register the ERPNext-side reference BEFORE the write (crash safety): if
  //    we die mid-call, the reconcile looks the invoice up by correlation value.
  store.setReference(commandId, commandId);

  if (typeof mcp.callWriteTool !== "function") {
    throw refuse("SI_CLIENT_UNAVAILABLE", "this MCP client has no write method");
  }
  const data = buildSalesInvoiceData({
    customerId,
    salesOrder,
    lines,
    company: resolvedCompany,
    actionId,
    correlation: field,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });
  const doc = docOf(res);
  const docName = doc?.name ?? null;
  if (!docName) {
    throw refuse("SI_WRITE_UNVERIFIED", "ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile");
  }

  // 4. VERIFY by reading the document back — the write response is not evidence.
  const verified = await verifyWrittenSalesInvoice(mcp, docName, {
    customerId,
    salesOrder,
    lines,
    actionId,
  });

  const result = {
    erpnext_doc: docName,
    customer: customerId,
    sales_order: salesOrder,
    lines: lines.map((l) => ({
      item_code: l.item_code,
      item_name: l.item_name,
      qty: l.qty,
      rate: l.rate,
      amount: Math.round(l.qty * l.rate),
      uom: l.uom,
    })),
    line_count: lines.length,
    net_total_vnd: lines.reduce((sum, l) => sum + Math.round(l.qty * l.rate), 0),
    // What the DOCUMENT says, not what we computed: ERPNext adds its own taxes
    // and rounds to its own precision, and an answer that quotes our arithmetic
    // as the invoice total is a number the shop would have to re-check.
    erpnext_grand_total: verified.grand_total ?? null,
    erpnext_net_total: verified.net_total ?? null,
    update_stock: Number(verified.update_stock ?? 0),
    action_id: actionId,
    docstatus: Number(verified.docstatus ?? 0),
    company: resolvedCompany,
    note: "hoá đơn tạo ở trạng thái NHÁP (docstatus 0) — CHƯA ghi doanh thu/công nợ và KHÔNG đụng kho, submit là bước riêng trên ERPNext",
  };
  if (doc && !Object.prototype.hasOwnProperty.call(verified, field)) {
    result.correlation_field_missing = field;
  }
  result.reference_no = commandId;
  store.complete(commandId, result);
  return result;
}
