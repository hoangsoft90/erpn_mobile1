/**
 * Skill: sales_return WRITE (P9-F — khách trả hàng = Sales Invoice NHÁP
 * `is_return=1`, Credit Note nháp, liên kết `return_against` vào hoá đơn ĐÃ
 * SUBMIT).
 *
 * Phiếu trả hàng là NGƯỢC của hoá đơn bán, và các khác biệt đó đều là LUẬT, đo
 * trên site thật 2026-09-23 (soi phiếu return có sẵn ACC-SINV-2026-00052 ←
 * 00049, ACC-SINV-2026-00007 ← 00006):
 *
 *  - `items[].qty` GỬI **ÂM** (site thật: -1, -8) — câu nói dương "trả 2 bao",
 *    payload âm 2; dấu là của skill, không phải của người nói.
 *  - `rate` là GIÁ CỦA HÓA ĐƠN GỐC (rate_source erpnext) — trả hàng hoàn tiền
 *    theo giá đã bán, không bao giờ theo câu nói.
 *  - `update_stock: 1` TƯỜNG MINH — trả hàng phải NHẬN LẠI kho (chính là nghĩa
 *    của "khách trả hàng"). Khác SI bán hàng (P9-D gửi 0) CỐ Ý: hai đường ghi
 *    cùng doctype nhưng 2 hướng kho ngược nhau.
 *  - trần số lượng = phần CÒN LẠI được trả của từng dòng HĐ gốc: qty của dòng
 *    TRỪ các phiếu trả (is_return=1) ĐÃ SUBMIT — và TRỪ các phiếu trả NHÁP đang
 *    treo (user chốt 2026-09-23: trừ nháp như đường delivery — một phiếu nháp
 *    chưa nhận kho thật, nhưng hai lần xác nhận không được nhận kho hai lần).
 *  - trả CHỈ 1 lần per dòng: ERPNext không cho trả vượt số đã bán của dòng đó.
 *
 * KHÔNG có trong phạm vi phiên (CẤM theo prompt): purchase return, DN-return.
 */

import { assertReadOnly } from "../readonly-guard.mjs";
import { buildProposal } from "../action-proposal.mjs";
import { getCapability, __contract } from "../capability-contract.mjs";
import { classifyDriftCode } from "../proposal-freshness.mjs";
import { matchItemsByText, selectNonOverlappingItems } from "./inventory.mjs";
import { docOf, newActionId, refuse, resolveSalesCompany, rowsOf } from "./sales-order-write.mjs";
// `pairLines` lives in line-parse as pairLinesPure; the skills bag re-exports it
// under the short name (same convention sales-order-write.mjs uses).
import { maskPartyMention, pairLinesPure as pairLines } from "../line-parse.mjs";

/** The ONE doctype this skill may create (the RETURN of a sale is still an SI). */
export const WRITE_DOCTYPE = "Sales Invoice";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "sales_return.create";

/** The code prefix for every refusal this path can emit (contract taxonomy). */
const CODE_PREFIX = "SR_";

/** Floating-point tolerance for quantities (ERPNext floats, we compare). */
const EPS = 1e-9;

/**
 * How many draft RETURN invoices we are willing to read to compute the draft
 * cover — a FULL page means "there may be more", and then the honest answer is
 * a refusal, never a number that looks precise.
 */
const DRAFT_LOOKUP_LIMIT = 10;

/** Contract policy block, read per call (a missing block is a hard bug). */
function policies() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("SR_CONTRACT_MISSING: sales_return.create is not in the capability contract");
  return { cap, line: cap.line_policy };
}

/**
 * The return's nature, read from the contract rather than hardcoded, and
 * REFUSED when the contract does not say credit_note — same fail-closed shape
 * as the P9-E entry_type() guard (a default-to-literal is how a guard dies).
 */
function returnNature() {
  const declared = policies().line?.entry_type ?? null;
  if (declared !== "credit_note") {
    throw refuse(
      `${CODE_PREFIX}PURPOSE_UNSUPPORTED`,
      declared === null
        ? "contract chưa khai line_policy.entry_type cho sales_return.create — không ghi phiếu khi BẢN CHẤT phiếu chưa được tuyên bố (P9-F, fail closed)"
        : `contract khai line_policy.entry_type="${declared}" nhưng skill chỉ hỗ trợ "credit_note" (P9-F)`,
    );
  }
  return declared;
}

/**
 * The stock direction, read from the contract. A return MUST declare
 * update_stock=1: the goods come BACK. A contract that stops saying so is not
 * "whatever the skill defaults to" — it is a refusal (P9-G review lesson: the
 * qty direction and the stock direction must both be DECLARED, never inferred).
 */
function stockDirection() {
  const declared = policies().line?.update_stock ?? null;
  if (declared !== 1) {
    throw refuse(
      `${CODE_PREFIX}PURPOSE_UNSUPPORTED`,
      declared === null
        ? "contract chưa khai line_policy.update_stock cho sales_return.create — không ghi phiếu khi CHIỀU KHO chưa được tuyên bố (P9-F, fail closed)"
        : `contract khai line_policy.update_stock=${declared} nhưng phiếu trả hàng phải nhận lại kho (update_stock=1) (P9-F)`,
    );
  }
  return declared;
}

/* ------------------------------------------------------------- reads ------ */

/** Guarded read: one Sales Invoice document (raw payload, `docOf` at caller). */
export async function getInvoiceDoc(mcp, name) {
  assertReadOnly("erpnext_doc_get");
  return mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: String(name) });
}

/**
 * The page of OPEN (draft) RETURN invoices — `is_return=1, docstatus=0` — for
 * the draft cover. Raw list payload; the caller wraps it into a cover.
 *
 * Filters are STRINGS on the real site (P4-1 lesson).
 */
export async function listOpenDraftReturns(mcp, invoiceName) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: WRITE_DOCTYPE,
    fields: ["name", "docstatus", "is_return", "return_against", "custom_ai_action_id"],
    filters: [
      ["is_return", "=", "1"],
      ["docstatus", "=", "0"],
      ["return_against", "=", String(invoiceName)],
    ],
    limit: DRAFT_LOOKUP_LIMIT,
    order_by: "creation desc",
  });
}

/**
 * How much of each item OPEN DRAFT returns already claim for ONE invoice —
 * list-then-get with a bounded page (a child table cannot be trusted off a list
 * endpoint). A FULL page or an unreadable draft is a REFUSAL upstream, never a
 * narrowed cover.
 *
 * @param {{listOpenDraftReturns: Function, getInvoiceDoc: Function}} reads
 * @returns {Promise<{drawn: Map<string,number>, drafts: string[]}>}
 */
export async function openReturnDraftCover(reads, invoiceName) {
  let rows = [];
  try {
    rows = rowsOf(await reads.listOpenDraftReturns(invoiceName));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được các phiếu trả hàng NHÁP đang treo: ${err?.message ?? err}`);
  }
  if (rows.length >= DRAFT_LOOKUP_LIMIT) {
    throw refuse(
      `${CODE_PREFIX}DRAFT_COVERED`,
      `hoá đơn ${invoiceName} có ${rows.length} phiếu trả NHÁP đang treo — dọn (submit hoặc hủy) trên ERPNext trước khi trả tiếp`,
    );
  }
  const drawn = new Map();
  const drafts = [];
  for (const row of rows) {
    const name = String(row.name ?? "");
    if (!name) continue;
    let doc = null;
    try {
      doc = docOf(await reads.getInvoiceDoc(name));
    } catch (err) {
      throw refuse("ERP_UNAVAILABLE", `không đọc được phiếu trả NHÁP ${name}: ${err?.message ?? err}`);
    }
    drafts.push(name);
    for (const line of Array.isArray(doc?.items) ? doc.items : []) {
      const code = String(line.item_code ?? "");
      // Draft return lines are stored NEGATIVE; the cover counts how MUCH is
      // claimed, so the sign is folded here once.
      drawn.set(code, (drawn.get(code) ?? 0) + Math.abs(Number(line.qty) || 0));
    }
  }
  return { drawn, drafts };
}

/**
 * What each line of the ORIGINAL invoice may still receive back:
 * `qty − returned(submitted is_return=1) − drafted(open is_return=1)`.
 *
 * Why the draft half matters even though a draft moves nothing: two
 * confirmations must not receive the same goods back twice, and ERPNext only
 * refuses the SECOND one at submit time — long after the shop believed both.
 */
export async function returnableCover(reads, invoice, itemCode = null) {
  let submittedRows = [];
  try {
    submittedRows = rowsOf(
      await reads.listSubmittedReturns(invoice.name),
    );
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được các phiếu trả đã submit của ${invoice.name}: ${err?.message ?? err}`);
  }
  if (submittedRows.length >= DRAFT_LOOKUP_LIMIT) {
    throw refuse(
      `${CODE_PREFIX}RETURNABLE_UNKNOWN`,
      `hoá đơn ${invoice.name} có ${submittedRows.length} phiếu trả ĐÃ SUBMIT (trang đọc bị đầy) — KHÔNG biết còn được trả bao nhiêu; đối soát trên ERPNext rồi hỏi lại`,
    );
  }
  const returned = new Map();
  for (const row of submittedRows) {
    let doc = null;
    try {
      doc = docOf(await reads.getInvoiceDoc(row.name));
    } catch (err) {
      throw refuse(
        `${CODE_PREFIX}RETURNABLE_UNKNOWN`,
        `không đọc được phiếu trả ${row.name} đã submit của ${invoice.name} — không biết hàng đã về kho chưa; đối soát trên ERPNext rồi hỏi lại`,
      );
    }
    for (const line of Array.isArray(doc?.items) ? doc.items : []) {
      returned.set(String(line.item_code ?? ""), (returned.get(String(line.item_code ?? "")) ?? 0) + Math.abs(Number(line.qty) || 0));
    }
  }
  const draftCover = await openReturnDraftCover(reads, invoice.name);
  const cover = new Map();
  for (const line of Array.isArray(invoice.items) ? invoice.items : []) {
    const code = String(line.item_code ?? line.name ?? "");
    if (itemCode && code !== String(itemCode)) continue;
    const sold = Math.abs(Number(line.qty) || 0);
    const back = (returned.get(code) ?? 0) + (draftCover.drawn.get(code) ?? 0);
    cover.set(code, Math.max(0, sold - back));
  }
  return { cover, returned, drafted: draftCover.drawn, drafts: draftCover.drafts };
}

/** Reconcile a command against ERPNext — READ ONLY (lost-response retry path). */
export async function reconcileSalesReturn(mcp, reference, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const field = getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "is_return", "return_against", field],
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

/* -------------------------------------------------------------- builder --- */

/** What the SENTENCE asks to return — items + positive quantities, same shape
 * the invoice path parses (offsets included so pairLines can attribute). */
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
  const { matched, scored } = matchItemsByText(itemRows, maskPartyMention(text, [partyName]));
  const named = selectNonOverlappingItems(scored ?? matched);
  if (named.length === 0) {
    if (quantities.length > 0) {
      throw refuse(
        `${CODE_PREFIX}ITEM_UNRESOLVED`,
        `câu có số lượng nhưng không khớp mặt hàng nào trong ERPNext ("${text}") — nói rõ tên mặt hàng như trên hoá đơn gốc`,
      );
    }
    throw refuse(
      `${CODE_PREFIX}ITEM_UNRESOLVED`,
      `chưa rõ mặt hàng nào được trả ("${text}") — phiếu trả phải NÓI RÕ mặt hàng; trả TOÀN BỘ hoá đơn là một quyết định khác (làm trên ERPNext)`,
    );
  }
  const { lines: paired, problems } = pairLines({ matched: named, quantities, codePrefix: CODE_PREFIX });
  if (problems.length > 0) {
    throw refuse(problems[0].code, problems[0].reason, { problems });
  }
  return paired.map(({ item, quantity }) => ({
    item_code: item.item_code ?? item.name,
    qty: Number(quantity.value),
    unit: quantity.canonical_unit ?? quantity.unit ?? null,
  }));
}

/**
 * Resolve the ORIGINAL invoice the return links to.
 *
 * Accepted: an explicit docname in the sentence / resolved bag. A bare customer
 * name is NOT enough to pick an invoice — two invoices of the same customer are
 * two different money decisions, so the customer path resolves the PICKER (the
 * generic party machinery upstream already did that) and this guard only
 * accepts a concrete invoice reference.
 */
async function resolveInvoice(skills, { invoiceName, customer, ambiguous, candidates }) {
  if (!invoiceName) {
    throw refuse(
      `${CODE_PREFIX}INVOICE_UNRESOLVED`,
      `chưa rõ trả hàng theo HOÁ ĐƠN nào — nói số hoá đơn (vd "trả hàng hóa đơn ACC-SINV-…")`,
    );
  }
  let inv = null;
  try {
    inv = docOf(await skills.getInvoiceDoc(String(invoiceName)));
  } catch (err) {
    throw refuse(
      `${CODE_PREFIX}INVOICE_NOT_FOUND`,
      `hoá đơn "${invoiceName}" không đọc được trên ERPNext (${err?.message ?? err}) — kiểm tra lại số hoá đơn`,
    );
  }
  if (!inv?.name) {
    throw refuse(`${CODE_PREFIX}INVOICE_NOT_FOUND`, `hoá đơn "${invoiceName}" không tồn tại trên ERPNext — kiểm tra lại số hoá đơn`);
  }
  if (Number(inv.docstatus) !== 1) {
    throw refuse(
      `${CODE_PREFIX}INVOICE_NOT_SUBMITTED`,
      `hoá đơn ${inv.name} chưa submit (docstatus=${inv.docstatus ?? "?"}) — trả hàng phải theo hoá ĐƠN ĐÃ SUBMIT (nháp chưa bán gì để trả)`,
    );
  }
  if (Number(inv.is_return ?? 0) === 1) {
    throw refuse(
      `${CODE_PREFIX}INVOICE_IS_RETURN`,
      `hoá đơn ${inv.name} đã là phiếu TRẢ HÀNG (is_return=1) — không trả hàng "vào phiếu trả" (trả ngược không có nghĩa nghiệp vụ ở đây)`,
    );
  }
  const invCustomer = String(inv.customer ?? "");
  if (!invCustomer) {
    throw refuse(`${CODE_PREFIX}CUSTOMER_UNRESOLVED`, `hoá đơn ${inv.name} không có khách hàng — không dựng được phiếu trả`);
  }
  if (customer && String(customer.name) !== invCustomer) {
    throw refuse(
      `${CODE_PREFIX}CUSTOMER_MISMATCH`,
      `hoá đơn ${inv.name} thuộc khách ${inv.customer_name ?? invCustomer}, không phải ${customer.customer_name ?? customer.name} — không trả hàng cho sai khách`,
    );
  }
  return inv;
}

/**
 * Stage A — build the DRAFT return proposal. STOPS at the card: 0 write.
 *
 * @param {object} skills reads bag { findItem, getInvoiceDoc,
 *                               listSubmittedReturns, listOpenDraftReturns }
 * @param {object} resolved { invoice: string, customer?: row, ambiguous, candidates }
 * @param {object} opts { nlp, text? }
 */
export async function buildSalesReturnProposal(skills, resolved = {}, opts = {}) {
  const nature = returnNature();
  const stockDir = stockDirection();
  const { line: linePolicy } = policies();
  const text = opts.text ?? opts.nlp?.text ?? "";

  // 1. WHICH invoice? The whole return hangs on it.
  const invoiceName = typeof resolved.invoice === "string"
    ? resolved.invoice
    : (resolved.invoice?.name ?? opts.nlp?.invoice ?? null);
  const invoice = await resolveInvoice(skills, {
    invoiceName,
    customer: resolved.customer ?? null,
    ambiguous: resolved.ambiguous,
    candidates: resolved.candidates,
  });

  // 2. WHICH items + how much (SPOKEN, positive). One line-document grammar.
  const requested = await requestedLinesFromText(
    skills,
    opts,
    resolved.customer?.customer_name ?? resolved.customer?.name ?? null,
  );
  if (requested.length > Number(linePolicy.max_lines)) {
    throw refuse(
      `${CODE_PREFIX}LINE_LIMIT`,
      `phiếu trả có ${requested.length} dòng, vượt giới hạn ${linePolicy.max_lines} dòng — tách thành nhiều phiếu trả`,
    );
  }

  // 3. What each line may still receive back (submitted returns − drafted ones).
  const cover = await returnableCover(
    {
      listSubmittedReturns: (name) => skills.listSubmittedReturns(name),
      getInvoiceDoc: (name) => skills.getInvoiceDoc(name),
      listOpenDraftReturns: (name) => skills.listOpenDraftReturns(name),
    },
    invoice,
  );
  const warnings = [];
  for (const want of requested) {
    const code = String(want.item_code);
    const invLine = (Array.isArray(invoice.items) ? invoice.items : []).find(
      (l) => String(l.item_code ?? l.name ?? "") === code,
    );
    if (!invLine) {
      throw refuse(
        `${CODE_PREFIX}ITEM_NOT_IN_INVOICE`,
        `"${code}" không có trong hoá đơn ${invoice.name} — chỉ trả hàng của CHÍNH hoá đơn đó (không trả hàng "thay thế")`,
      );
    }
    // The spoken unit must be the INVOICE's unit. A return line links a real
    // sold line; converting units here is how "1 tấn" returns as "1 bao".
    const invUom = String(invLine.uom ?? "").trim();
    if (want.unit && invUom) {
      const spoken = String(want.unit).trim().toLowerCase();
      if (spoken && spoken !== invUom.toLowerCase()) {
        throw refuse(
          `${CODE_PREFIX}UOM_MISMATCH`,
          `hoá đơn ${invoice.name} bán "${invLine.item_name ?? code}" theo đơn vị "${invUom}", câu nói trả theo "${want.unit}" — không tự quy đổi; nói lại theo đơn vị của hoá đơn`,
          { uom_code: "UOM_MISMATCH", invoice_uom: invUom },
        );
      }
    }
    if (!(Number(want.qty) > 0)) {
      throw refuse(`${CODE_PREFIX}QTY_INVALID`, `số lượng trả của "${invLine.item_name ?? code}" phải là số dương (đang ${want.qty})`);
    }
    const returnable = cover.cover.get(code) ?? 0;
    if (want.qty - returnable > EPS) {
      const sold = Math.abs(Number(invLine.qty) || 0);
      throw refuse(
        `${CODE_PREFIX}QTY_EXCEEDS_RETURNABLE`,
        `"${invLine.item_name ?? code}" chỉ còn ${returnable} ${invUom || ""} được trả (đã bán ${sold}, đã nhận lại ${cover.returned.get(code) ?? 0}${(cover.drafted.get(code) ?? 0) > 0 ? `, phiếu NHÁP đang chiếm ${cover.drafted.get(code)}` : ""}) — KHÔNG kẹp số, hãy nói lại đúng số thực tế`,
        { returnable, sold, returned: cover.returned.get(code) ?? 0, drafted: cover.drafted.get(code) ?? 0, invoice: invoice.name },
      );
    }
    if (want.qty < returnable - EPS) {
      warnings.push(`${invLine.item_name ?? code}: trả một phần ${want.qty}/${returnable} ${invUom || ""} (hoá đơn vẫn còn phần chưa trả)`);
    }
  }
  if (cover.drafts.length > 0) {
    warnings.push(`đã trừ số lượng mà ${cover.drafts.length} phiếu trả NHÁP đang treo chiếm (${cover.drafts.slice(0, 3).join(", ")})`);
  }
  warnings.push("phiếu trả tạo ở trạng thái NHÁP — CHƯA nhận lại kho / CHƯA ghi công nợ cho tới khi submit trên ERPNext");

  // 4. The card's numbers are the INVOICE's (rate) and the SENTENCE's (qty>0),
  //    so the user can check them without knowing ERPNext signs them.
  const lines = requested.map((want) => {
    const invLine = (Array.isArray(invoice.items) ? invoice.items : []).find(
      (l) => String(l.item_code ?? l.name ?? "") === String(want.item_code),
    );
    const rate = Number(invLine.rate ?? 0);
    if (!(rate > 0)) {
      throw refuse(
        `${CODE_PREFIX}QTY_INVALID`,
        `hoá đơn ${invoice.name} không có đơn giá đọc được cho "${invLine.item_name ?? want.item_code}" — không dựng được phiếu trả (giá trị hoàn là của ERPNext)`,
      );
    }
    return {
      item_code: want.item_code,
      item_name: invLine.item_name ?? want.item_code,
      qty: want.qty, // SPOKEN, positive — the payload negates, not the card.
      rate, // The INVOICE's price. Never the sentence, never a default.
      amount: Math.round(want.qty * rate),
      uom: invLine.uom ?? null,
      return_against: invoice.name,
      inv_detail: invLine.name ?? null,
    };
  });

  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  const proposal = buildProposal({
    action: "create_sales_return",
    risk: "HIGH",
    entity: {
      kind: "customer",
      id: String(invoice.customer),
      name: invoice.customer_name ?? String(invoice.customer),
    },
    params: {
      return_against: invoice.name,
      entry_type: nature,
      update_stock: stockDir, // Declared by the contract: the goods COME BACK.
      lines,
      line_count: lines.length,
      estimated_total_vnd: total,
      submit_now: false,
    },
    summary: `Khách trả hàng NHÁP theo hoá đơn ${invoice.name}: ${lines
      .map((l) => `${l.qty} ${l.uom ?? ""} ${l.item_name}`.trim())
      .join(" + ")}`,
    extra: {
      warnings,
      action_id: newActionId(),
      schema_note:
        "params.lines là ĐỀ XUẤT lấy từ hoá đơn gốc (dòng + ĐƠN GIÁ của hoá đơn, qty ÂM do skill gửi) — execute đọc LẠI hoá đơn + các phiếu trả đã submit/nháp từ ERPNext, lệch thì TỪ CHỐI; phiếu luôn NHÁP, submit là bước riêng trên ERPNext",
    },
  });

  return { proposal, lines, warnings, action_id: proposal.action_id };
}

/* ------------------------------------------------------------- executor -- */

/**
 * The REAL return payload (pure — unit-testable without network).
 *
 * Measured from the site's own return documents (2026-09-23):
 * `is_return: 1` + `return_against` + `update_stock: 1` + `items[].qty` NEGATIVE
 * at the SOLD line's rate. No `posting_date`, no tax template, no payment
 * schedule: ERPNext defaults them at the site (P5-2/P9-D lessons).
 */
export function buildSalesReturnData({ customerId, invoiceName, lines, company, actionId, correlation }) {
  return {
    doctype: WRITE_DOCTYPE,
    customer: customerId,
    company,
    is_return: 1,
    return_against: invoiceName,
    update_stock: 1,
    [correlation]: actionId ?? null,
    remarks: "ERPNext Voice Copilot · xác nhận bởi người dùng · phiếu TRẢ HÀNG NHÁP (chưa nhận kho / chưa ghi công nợ)",
    items: lines.map((l) => ({
      item_code: l.item_code,
      // NEGATIVE on the wire: a return RECEIVES. The card showed the positive
      // number the user said; the sign lives here, once.
      qty: -Math.abs(Number(l.qty)),
      rate: l.rate,
      uom: l.uom ?? null,
      return_against: invoiceName,
      ...(l.inv_detail ? { si_detail: l.inv_detail } : {}),
      ...(l.sales_order ? { sales_order: l.sales_order } : {}),
      ...(l.so_detail ? { so_detail: l.so_detail } : {}),
    })),
  };
}

/** Read the written return back and check it carries what we intended. */
export async function verifyWrittenSalesReturn(mcp, docName, { customerId, invoiceName, lines, actionId }) {
  const res = await getInvoiceDoc(mcp, docName);
  const doc = docOf(res);
  const problems = [];
  if (String(doc.customer ?? "") !== String(customerId)) problems.push(`customer=${doc.customer}`);
  if (Number(doc.docstatus) !== 0) problems.push(`docstatus=${doc.docstatus} (phiếu trả phải là NHÁP)`);
  if (Number(doc.is_return ?? 0) !== 1) problems.push(`is_return=${doc.is_return} (phải là phiếu TRẢ)`);
  if (String(doc.return_against ?? "") !== String(invoiceName)) problems.push(`return_against=${doc.return_against}`);
  // The stock direction is part of what was approved: a site that ignored it
  // would return money WITHOUT receiving the goods.
  if (Number(doc.update_stock ?? 0) !== 1) {
    problems.push(`update_stock=${doc.update_stock} (phiếu trả phải nhận lại kho)`);
  }
  const field = getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
  if (actionId && Object.prototype.hasOwnProperty.call(doc, field) && String(doc[field] ?? "") !== String(actionId)) {
    problems.push(`${field}=${doc[field]}`);
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
      // On the wire the line is NEGATIVE; compare magnitudes.
      if (Math.abs(Math.abs(Number(got.qty)) - Math.abs(Number(want.qty))) > EPS) {
        problems.push(`${want.item_code}: qty=${got.qty}`);
      }
      if (Number(got.qty) > 0) problems.push(`${want.item_code}: qty dương (${got.qty}) — phiếu trả phải gửi qty âm`);
      if (Math.abs(Number(got.rate) - Number(want.rate)) > EPS) problems.push(`${want.item_code}: rate=${got.rate}`);
      if (String(got.return_against ?? "") !== String(invoiceName)) {
        problems.push(`${want.item_code}: return_against=${got.return_against}`);
      }
    }
  }
  if (problems.length) {
    throw refuse(
      `${CODE_PREFIX}WRITE_UNVERIFIED`,
      `đọc lại phiếu trả ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc },
    );
  }
  return doc;
}

/**
 * Stage B — execute a CONFIRMED return proposal. Called only from the Safety
 * Gateway AFTER the idempotency gate. The INVOICE, its submitted returns and
 * its open draft returns are re-read from live ERPNext; the proposal's numbers
 * are compared, never trusted.
 */
export async function executeSalesReturnProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const customerId = String(proposal.entity?.id ?? "");
  const invoiceName = String(proposal.params?.return_against ?? "");
  const wantLines = Array.isArray(proposal.params?.lines) ? proposal.params.lines : [];
  if (!invoiceName) {
    throw refuse(`${CODE_PREFIX}INVOICE_UNRESOLVED`, "đề xuất không nói trả hàng theo HOÁ ĐƠN nào — không ghi phiếu trả");
  }
  if (wantLines.length === 0) {
    throw refuse(`${CODE_PREFIX}QTY_INVALID`, "đề xuất không có dòng hàng nào — không ghi phiếu trả rỗng");
  }

  // 1. Correlation field: the only server-side dedup this document has.
  const field = getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
  const probe = await reconcileSalesReturn(mcp, commandId, { actionId: proposal.action_id ?? null });
  if (probe.correlation_field_unavailable) {
    throw refuse(
      `${CODE_PREFIX}CORRELATION_FIELD_MISSING`,
      `ERPNext chưa có field "${field}" trên ${WRITE_DOCTYPE} — không có cách chống trùng phía server, KHÔNG ghi phiếu trả (chạy migration trước)`,
    );
  }
  if (probe.found) {
    throw refuse(
      `${CODE_PREFIX}DUPLICATE_ACTION`,
      `phiếu trả ${probe.doc?.name ?? "?"} đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước`,
      { existing_doc: probe.doc?.name ?? null },
    );
  }

  // 2. RE-READ the invoice: still submitted, still non-return, still the same
  //    customer; every line still owned by it; every quantity still returnable
  //    (submitted + drafted returns subtracted).
  let invoice = null;
  try {
    invoice = docOf(await getInvoiceDoc(mcp, invoiceName));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc lại được hoá đơn ${invoiceName}: ${err?.message ?? err}`);
  }
  const drift = [];
  if (!invoice?.name) {
    drift.push(`hoá đơn ${invoiceName} không còn tồn tại`);
  } else {
    if (Number(invoice.docstatus) !== 1) drift.push(`hoá đơn ${invoice.name} không còn ở trạng thái đã submit (docstatus=${invoice.docstatus})`);
    if (Number(invoice.is_return ?? 0) === 1) drift.push(`hoá đơn ${invoice.name} là phiếu trả (is_return=1) — không trả hàng vào phiếu trả`);
    if (String(invoice.customer ?? "") !== customerId) drift.push(`hoá đơn ${invoice.name} đã đổi sang khách ${invoice.customer}`);
  }
  const cover = invoice?.name
    ? await returnableCover(
        {
          listSubmittedReturns: (name) => listSubmittedReturns(mcp, name),
          getInvoiceDoc: (name) => getInvoiceDoc(mcp, name),
          listOpenDraftReturns: (name) => listOpenDraftReturns(mcp, name),
        },
        invoice,
      )
    : { cover: new Map(), returned: new Map(), drafted: new Map(), drafts: [] };
  const invItems = Array.isArray(invoice?.items) ? invoice.items : [];
  const lines = [];
  for (const want of wantLines) {
    const code = String(want.item_code);
    const invLine = invItems.find((l) => String(l.item_code ?? l.name ?? "") === code);
    if (!invLine) {
      drift.push(`${code} không còn trong hoá đơn ${invoiceName}`);
      continue;
    }
    const rate = Number(invLine.rate ?? 0);
    if (!(rate > 0)) {
      throw refuse(`${CODE_PREFIX}QTY_INVALID`, `hoá đơn ${invoiceName} không có đơn giá đọc được cho ${code} — không ghi phiếu trả`);
    }
    if (Math.abs(Number(want.rate) - rate) > EPS) {
      drift.push(`${code}: đơn giá hoá đơn đã đổi (${rate} thay vì ${want.rate})`);
      continue;
    }
    const qty = Number(want.qty);
    if (!(qty > 0)) {
      throw refuse(`${CODE_PREFIX}QTY_INVALID`, `số lượng trả ${code} không hợp lệ (${want.qty}) — từ chối ghi`);
    }
    const returnable = cover.cover.get(code) ?? 0;
    if (qty - returnable > EPS) {
      drift.push(`${code}: chỉ còn ${returnable} được trả (đề xuất ${qty})`);
      continue;
    }
    lines.push({ ...want, rate, item_name: invLine.item_name ?? code, uom: invLine.uom ?? want.uom ?? null });
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
    code: `${CODE_PREFIX}COMPANY_UNRESOLVED`,
    noun: "phiếu trả hàng",
  });
  const actionId = proposal.action_id ?? null;

  // 3. Register the ERPNext-side reference BEFORE the write (crash safety).
  store.setReference(commandId, commandId);

  if (typeof mcp.callWriteTool !== "function") {
    throw refuse(`${CODE_PREFIX}CLIENT_UNAVAILABLE`, "this MCP client has no write method");
  }
  const data = buildSalesReturnData({
    customerId,
    invoiceName,
    lines,
    company: resolvedCompany,
    actionId,
    correlation: field,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });
  const doc = docOf(res);
  const docName = doc?.name ?? null;
  if (!docName) {
    throw refuse(`${CODE_PREFIX}WRITE_UNVERIFIED`, "ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile");
  }

  // 4. VERIFY by reading the document back — the write response is not evidence.
  const verified = await verifyWrittenSalesReturn(mcp, docName, {
    customerId,
    invoiceName,
    lines,
    actionId,
  });

  const result = {
    erpnext_doc: docName,
    customer: customerId,
    return_against: invoiceName,
    is_return: 1,
    update_stock: Number(verified.update_stock ?? 1),
    lines: lines.map((l) => ({
      item_code: l.item_code,
      item_name: l.item_name,
      qty: l.qty,
      rate: l.rate,
      amount: Math.round(l.qty * l.rate),
      uom: l.uom,
    })),
    line_count: lines.length,
    estimated_total_vnd: lines.reduce((sum, l) => sum + Math.round(l.qty * l.rate), 0),
    erpnext_grand_total: verified.grand_total ?? null,
    action_id: actionId,
    docstatus: Number(verified.docstatus ?? 0),
    company: resolvedCompany,
    note: "phiếu trả hàng tạo ở trạng thái NHÁP (docstatus 0) — CHƯA nhận lại kho / CHƯA ghi công nợ; submit là bước riêng trên ERPNext, không tự động",
  };
  result.reference_no = commandId;
  store.complete(commandId, result);
  return result;
}

/** Guarded read: SUBMITTED returns (is_return=1, docstatus=1) of ONE invoice. */
export async function listSubmittedReturns(mcp, invoiceName) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: WRITE_DOCTYPE,
    fields: ["name", "docstatus", "is_return", "return_against"],
    filters: [
      ["is_return", "=", "1"],
      ["docstatus", "=", "1"],
      ["return_against", "=", String(invoiceName)],
    ],
    limit: DRAFT_LOOKUP_LIMIT,
    order_by: "creation desc",
  });
}
