/**
 * Skill: purchase_receipt.create WRITE — P9-B (pattern P9-A/A2, delivery-write).
 *
 * Two halves, one file: buildPurchaseReceiptProposal (the /ask half) and
 * executePurchaseReceiptProposal (the /execute half, reached ONLY through the
 * Safety Gateway after confirm + idempotency gates). Every write is a DRAFT
 * (docstatus 0) — only SUBMIT of a Purchase Receipt moves stock, and submit is
 * not a chat side effect.
 *
 * A Purchase Receipt is the receiving mirror of a Delivery Note, and the things
 * that make it NOT a copy-paste are exactly the things that would be dangerous
 * to get wrong:
 *
 *  1. THE PARTY IS A SUPPLIER and THE SOURCE IS A PURCHASE ORDER: lines, units,
 *     prices and the receiving warehouse come from THAT ORDER, never from the
 *     sentence. The utterance may only decide HOW MUCH of what the order
 *     already buys is received.
 *  2. "WHAT IS STILL OWED" IS ERPNext'S OWN ARITHMETIC, measured on this very
 *     site (.agents/skills/erpnext-rest-api-recipes §1171): pending REALLY is
 *     `qty − received_qty − returned_qty` — a part-returned PO can still show
 *     `To Receive` with nothing actually owed, so returned_qty is subtracted
 *     too. Over-receipt is refused, never clamped (clamping would hide that
 *     the user is describing a different order).
 *  3. THE RATE IS THE PO'S RATE: ERPNext's `validate_rate_with_reference_doc`
 *     (measured live, recipes §"NCC báo giá CAO HƠN": HTTP 417 "Đơn giá phải
 *     giống với Purchase Order") blocks a PR priced differently from its PO.
 *     The rate travels FROM the PO row and is verified on read-back — it is
 *     never taken from the utterance and never re-priced.
 *
 * Guard this file shares with delivery-write (same reasoning, own code): OPEN
 * DRAFT receipts already hold goods the raw pending still counts — ERPNext
 * advances received_qty only at SUBMIT. A second confirmation would promise
 * the same goods twice on paper, so open drafts are subtracted (PR_DRAFT_COVERED
 * / reduced proposal), and the executor repeats the subtraction so a proposal
 * written before the draft existed goes STALE instead of writing.
 *
 * Correlation: `custom_ai_action_id` — the same Custom Field as every other
 * write here (ONE migration covers all doctypes); the executor refuses to
 * write when the site cannot store it, because it is the only server-side
 * once-only half a Purchase Receipt has.
 */

import { assertReadOnly } from "../readonly-guard.mjs";
import { buildProposal } from "../action-proposal.mjs";
import { getCapability } from "../capability-contract.mjs";
import { classifyDriftCode } from "../proposal-freshness.mjs";
import { matchItemsByText, selectNonOverlappingItems } from "./inventory.mjs";
import { maskPartyMention } from "../line-parse.mjs";
import {
  docOf,
  newActionId,
  pairLines,
  refuse,
  resolveSalesCompany,
  rowsOf,
} from "./sales-order-write.mjs";

/** The ONE doctype this skill may create (fail-closed everywhere else). */
export const WRITE_DOCTYPE = "Purchase Receipt";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "purchase_receipt.create";

/** The code prefix for every refusal this path can emit (contract taxonomy). */
const CODE_PREFIX = "PR_";

/** Floating-point tolerance for quantities (ERPNext floats, we compare). */
const EPS = 1e-9;

/** How many of a supplier's open orders we look at before asking which one. */
const OPEN_ORDER_LOOKUP_LIMIT = 5;

/** How many OPEN DRAFT receipts of one supplier we read per proposal. */
const DRAFT_RECEIPT_LOOKUP_LIMIT = 10;

/** Contract policy block, read per call (a missing block is a hard bug). */
function policy() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("PR_CONTRACT_MISSING: purchase_receipt.create is not in the capability contract");
  return cap.line_policy ?? {};
}

/** The ERPNext-side correlation field, read from the contract (single truth). */
export function correlationField() {
  return getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
}

/** Read one Purchase Order (wrapped tool result → the document). */
async function readOrder(skills, name) {
  try {
    return docOf(await skills.getPurchaseOrder(name));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được đơn mua ${name} từ ERPNext: ${err?.message ?? err}`);
  }
}

/**
 * The lines of a Purchase Order that still OWE receiving, in the order's own
 * numbers: `pending = qty − received_qty − returned_qty` (returned_qty is the
 * measured lesson of recipes §1171 — a part-returned PO can still show
 * `To Receive` while owing nothing). Fully-received lines are excluded.
 */
function pendingLines(po) {
  const items = Array.isArray(po?.items) ? po.items : [];
  return items
    .map((it) => ({
      item_code: String(it.item_code ?? it.name ?? ""),
      item_name: it.item_name ?? String(it.item_code ?? it.name ?? ""),
      uom: it.uom ?? it.stock_uom ?? null,
      // The ORDER's warehouse — a PR item without one is a validation error on
      // a site with no default warehouse (same reasoning as the DN path).
      warehouse: it.warehouse ?? null,
      po_detail: it.name ?? null,
      rate: Number(it.rate ?? 0),
      ordered: Number(it.qty ?? 0),
      pending:
        Number(it.qty ?? 0) - Number(it.received_qty ?? 0) - Number(it.returned_qty ?? 0),
    }))
    .filter((l) => l.pending > EPS);
}

/**
 * WHICH order does this receipt refer to? Two honest paths, no third:
 *  - the sentence named one (resolved.order) — it must exist and be SUBMITTED
 *    (ERPNext refuses receiving against a draft PO);
 *  - it named none — the SUPPLIER's own submitted orders are read, and exactly
 *    ONE still owing goods is used. Several (or a FULL page, where "exactly
 *    one" is unknowable) is a question, not a coin flip: receiving the wrong
 *    order books the wrong goods against the wrong debt.
 */
async function resolveOrder(skills, { orderName, supplierId, ambiguous, candidates }) {
  if (orderName) {
    const po = await readOrder(skills, orderName);
    if (!po?.name) {
      throw refuse("PR_PO_NOT_FOUND", `không tìm thấy đơn mua "${orderName}" trong ERPNext — không tạo phiếu nhận`);
    }
    return po;
  }
  if (!supplierId) {
    throw refuse(
      "PR_PO_UNRESOLVED",
      ambiguous
        ? `tên nhà cung cấp khớp nhiều kết quả (${(candidates ?? []).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ trước khi nhận hàng`
        : "chưa xác định được nhà cung cấp nên không biết nhận đơn nào — không tự chọn đơn để nhận hàng",
    );
  }
  let rows = [];
  try {
    rows = rowsOf(await skills.listOpenPurchaseOrders(supplierId));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được danh sách đơn mua của nhà cung cấp từ ERPNext: ${err?.message ?? err}`);
  }
  const names = rows.map((r) => String(r.name ?? "")).filter(Boolean);
  if (names.length === 0) {
    throw refuse(
      "PR_PO_UNRESOLVED",
      "nhà cung cấp chưa có đơn mua nào ĐÃ SUBMIT — ERPNext chỉ cho nhận hàng theo đơn đã submit, hãy submit đơn mua trước",
    );
  }
  const withPending = [];
  for (const name of names.slice(0, OPEN_ORDER_LOOKUP_LIMIT)) {
    const po = await readOrder(skills, name);
    if (po?.name && pendingLines(po).length > 0) withPending.push(po);
  }
  if (withPending.length === 0) {
    throw refuse(
      "PR_NOTHING_TO_RECEIVE",
      `không đơn mua nào của nhà cung cấp còn hàng chờ nhận (đã xem ${names.length} đơn) — không tạo phiếu nhận rỗng`,
    );
  }
  // A FULL page is "possibly more": the list read caps at exactly
  // OPEN_ORDER_LOOKUP_LIMIT rows, so `>` was dead code and exactly-one-pending
  // on a full page got picked silently — the trap the delivery review closed.
  if (withPending.length > 1 || names.length >= OPEN_ORDER_LOOKUP_LIMIT) {
    const list = withPending.map((s) => s.name);
    throw refuse(
      "PR_PO_UNRESOLVED",
      `nhà cung cấp có ${names.length} đơn đã submit${list.length ? ` (${list.slice(0, 5).join(", ")} còn chờ nhận)` : ""} — nói rõ nhận đơn nào`,
      { candidates: list },
    );
  }
  return withPending[0];
}

/**
 * What does the SENTENCE say to receive? Same discipline as the delivery path:
 * a sentence naming no item but carrying a QUANTITY is a refusal (defaulting
 * to "everything" would ignore a number the user said); an item that exists
 * but is not on this order refuses as PR_ITEM_NOT_IN_PO in the caller.
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
  // R6: the supplier's OWN name is not a line (see maskPartyMention).
  const { matched, scored } = matchItemsByText(itemRows, maskPartyMention(text, [partyName]));
  const named = selectNonOverlappingItems(scored ?? matched);
  if (named.length === 0) {
    if (quantities.length > 0) {
      throw refuse(
        "PR_ITEM_UNRESOLVED",
        `câu có số lượng nhưng không khớp mặt hàng nào trong ERPNext ("${text}") — nói rõ tên mặt hàng, hoặc bỏ số lượng để nhận hết phần còn lại`,
      );
    }
    return null;
  }
  const { lines: paired, problems } = pairLines({ matched: named, quantities, codePrefix: CODE_PREFIX });
  if (problems.length > 0) {
    throw refuse(problems[0].code, problems[0].reason, { problems });
  }
  return paired.map(({ item, quantity }) => ({
    item_code: item.item_code ?? item.name,
    qty: Number(quantity.value),
    // The unit the user SAID — checked against the order's unit (no hidden
    // conversion, B1): "nhận 1 tấn" against a Bao row must not become "1 bao".
    unit: quantity.canonical_unit ?? null,
  }));
}

/** Guarded read: the supplier's SUBMITTED Purchase Orders. */
export async function listOpenPurchaseOrders(mcp, supplierId) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: "Purchase Order",
    fields: ["name", "supplier", "docstatus", "transaction_date"],
    filters: [["supplier", "=", String(supplierId)], ["docstatus", "=", "1"]],
    limit: OPEN_ORDER_LOOKUP_LIMIT,
  });
}

/** Guarded read: one Purchase Order document (the receipt's source). */
export async function getPurchaseOrderDoc(mcp, name) {
  assertReadOnly("erpnext_doc_get");
  return mcp.callTool("erpnext_doc_get", { doctype: "Purchase Order", name: String(name) });
}

/** Guarded read: the supplier's OPEN (draft) Purchase Receipts. */
export async function listOpenDraftPurchaseReceipts(mcp, supplierId) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: WRITE_DOCTYPE,
    fields: ["name", "docstatus", "supplier"],
    filters: [["supplier", "=", String(supplierId)], ["docstatus", "=", "0"]],
    limit: DRAFT_RECEIPT_LOOKUP_LIMIT,
  });
}

/** Guarded read: one Purchase Receipt document. */
export async function getPurchaseReceiptDoc(mcp, name) {
  assertReadOnly("erpnext_doc_get");
  return mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: String(name) });
}

/**
 * How much of one order's pending quantity do OPEN DRAFT receipts already
 * hold? ERPNext advances received_qty only at SUBMIT, so raw pending still
 * counts goods live drafts promise. A FULL page refuses (fail-closed): past
 * the cap we cannot know how much is already promised.
 *
 * @param {{listOpenDraftPurchaseReceipts: Function, getPurchaseReceiptDoc: Function}} reads
 * @returns {Promise<{drawn: Map<string, number>, drafts: string[]}>}
 */
async function openDraftCover(reads, supplierId, poName) {
  let rows = [];
  try {
    rows = rowsOf(await reads.listOpenDraftPurchaseReceipts(supplierId));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được phiếu nhận NHÁP đang chờ của nhà cung cấp từ ERPNext: ${err?.message ?? err}`);
  }
  if (rows.length >= DRAFT_RECEIPT_LOOKUP_LIMIT) {
    throw refuse(
      "PR_DRAFT_COVERED",
      `nhà cung cấp có ${rows.length} phiếu nhận NHÁP chưa submit — dọn (submit hoặc hủy) các phiếu đó trên ERPNext trước khi tạo phiếu mới`,
    );
  }
  const drawn = new Map();
  const drafts = [];
  for (const row of rows) {
    const name = String(row.name ?? "");
    if (!name) continue;
    let doc = null;
    try {
      doc = docOf(await reads.getPurchaseReceiptDoc(name));
    } catch (err) {
      throw refuse("ERP_UNAVAILABLE", `không đọc được phiếu nhận nháp ${name}: ${err?.message ?? err}`);
    }
    const mine = (Array.isArray(doc?.items) ? doc.items : []).filter(
      (it) => String(it.purchase_order ?? "") === String(poName),
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

/** Raw pending minus what open drafts already hold. */
function subtractDrawn(pending, drawn) {
  return pending
    .map((l) => ({ ...l, pending: l.pending - (drawn.get(l.item_code) ?? 0) }))
    .filter((l) => l.pending > EPS);
}

/**
 * Stage A — build the draft Purchase Receipt proposal for a resolved supplier
 * (and, when the sentence names it, a Purchase Order).
 *
 * @param {object} skills   { findItem, getPurchaseOrder, listOpenPurchaseOrders, listOpenDraftPurchaseReceipts, getPurchaseReceiptDoc }
 * @param {object} resolved { supplier?, order?, ambiguous?, candidates? }
 * @param {object} [opts]   { nlp, text?, lines? }
 * @returns {Promise<{proposal:object, lines:object[], warnings:string[], action_id:string}>}
 */
export async function buildPurchaseReceiptProposal(skills, resolved, opts = {}) {
  const { supplier = null, order = null, ambiguous = false, candidates = [] } = resolved ?? {};

  const orderName = typeof order === "string" ? order : (order?.name ?? null);
  const po = await resolveOrder(skills, {
    orderName,
    supplierId: supplier?.name ?? null,
    ambiguous,
    candidates,
  });

  // ERPNext only accepts receiving against a SUBMITTED order.
  if (Number(po.docstatus) !== 1) {
    throw refuse(
      "PR_PO_NOT_SUBMITTED",
      `đơn mua ${po.name} chưa được submit (docstatus=${po.docstatus ?? "?"}) — ERPNext chỉ cho nhận hàng theo đơn ĐÃ SUBMIT; mở ERPNext submit đơn trước`,
    );
  }

  // The ORDER decides who receives the goods — cross-checked, never overridden.
  const poSupplierId = String(po.supplier ?? "");
  if (!poSupplierId) {
    throw refuse("PR_SUPPLIER_MISMATCH", `đơn mua ${po.name} không có nhà cung cấp — không tạo phiếu nhận`);
  }
  if (supplier && String(supplier.name) !== poSupplierId) {
    throw refuse(
      "PR_SUPPLIER_MISMATCH",
      `đơn mua ${po.name} thuộc NCC ${po.supplier_name ?? poSupplierId}, không phải ${supplier.supplier_name ?? supplier.name} — không nhận sai nhà cung cấp`,
    );
  }

  const poItems = Array.isArray(po.items) ? po.items : [];
  if (poItems.length === 0) {
    throw refuse("PR_NOTHING_TO_RECEIVE", `đơn mua ${po.name} không có dòng hàng nào — không tạo phiếu nhận`);
  }
  const rawPending = pendingLines(po);
  // Subtract what OPEN DRAFT receipts already promise (see openDraftCover) —
  // raw pending still counts goods live drafts hold.
  const draftCover = await openDraftCover(skills, poSupplierId, po.name);
  const pending = subtractDrawn(rawPending, draftCover.drawn);
  const draftWarnings = [];
  for (const l of rawPending) {
    const d = draftCover.drawn.get(l.item_code) ?? 0;
    if (d > EPS) draftWarnings.push(`${l.item_name}: đã có phiếu nhận NHÁP chờ ${d} ${l.uom ?? ""} (chưa submit)`);
  }
  if (pending.length === 0 && rawPending.length > 0) {
    throw refuse(
      "PR_DRAFT_COVERED",
      `đơn mua ${po.name} còn chờ nhận nhưng đã có phiếu nhận NHÁP (${draftCover.drafts.slice(0, 5).join(", ")}) chưa submit phủ hết — submit hoặc hủy phiếu đó trên ERPNext trước khi nhận tiếp`,
    );
  }
  if (pending.length === 0) {
    throw refuse(
      "PR_NOTHING_TO_RECEIVE",
      `đơn mua ${po.name} đã nhận đủ (không còn dòng nào chờ nhận) — không tạo phiếu nhận rỗng`,
    );
  }

  // Explicit quantities: caller-provided (slot form / tests) or from the
  // SENTENCE (parsed here so /ask and unit tests cannot diverge).
  const requested = Array.isArray(opts.lines) ? opts.lines : await requestedLinesFromText(skills, opts, po.supplier_name ?? null);
  let chosen;
  if (requested) {
    if (requested.length === 0) {
      throw refuse("PR_QTY_INVALID", "không có dòng hàng nào được nêu — không tạo phiếu nhận");
    }
    // The same item named twice is a QUESTION, not a sum — merging would
    // silently receive a total the user may not have meant (DN_QTY_AMBIGUOUS's
    // mirror; the order path refuses it for exactly this reason).
    const seen = new Set();
    for (const want of requested) {
      const code = String(want?.item_code ?? "");
      if (seen.has(code)) {
        throw refuse(
          "PR_QTY_AMBIGUOUS",
          `"${code}" được nêu nhiều lần trong cùng một câu — chưa rõ muốn nhận tổng bao nhiêu, nói lại một lần duy nhất`,
        );
      }
      seen.add(code);
    }
    chosen = requested.map((want) => {
      const code = String(want?.item_code ?? "");
      const line = pending.find((l) => l.item_code === code);
      if (!line) {
        const existed = poItems.some((it) => String(it.item_code ?? it.name ?? "") === code);
        if (existed) {
          // "Fulfilled" vs "a live DRAFT already holds it" — advice differs.
          const covered = rawPending.some((l) => l.item_code === code);
          throw covered
            ? refuse(
                "PR_DRAFT_COVERED",
                `"${code}" còn chờ nhận nhưng đã có phiếu nhận NHÁP (${draftCover.drafts.slice(0, 5).join(", ")}) chưa submit phủ hết — submit hoặc hủy phiếu đó trước`,
              )
            : refuse("PR_ALREADY_RECEIVED", `"${code}" trong đơn mua ${po.name} đã nhận đủ — không nhận thêm`);
        }
        throw refuse("PR_ITEM_NOT_IN_PO", `"${code}" không có trong đơn mua ${po.name} — chỉ nhận được hàng của chính đơn đó`);
      }
      const qty = Number(want?.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw refuse("PR_QTY_INVALID", `số lượng nhận của "${line.item_name}" phải là số dương (đang ${want?.qty})`);
      }
      if (qty - line.pending > EPS) {
        throw refuse(
          "PR_QTY_EXCEEDS_PENDING",
          `"${line.item_name}" chỉ còn ${line.pending} ${line.uom ?? ""} chờ nhận, không nhận được ${qty} — kiểm tra lại đơn mua`,
        );
      }
      // The unit the user said must be the order's unit. No hidden conversion.
      if (want.unit) {
        const spoken = String(want.unit).trim().toLowerCase();
        const orderUom = String(line.uom ?? "").trim().toLowerCase();
        if (orderUom && spoken !== orderUom) {
          throw refuse(
            "PR_UOM_MISMATCH",
            `đơn mua ${po.name} ghi "${line.item_name}" theo đơn vị "${line.uom}", câu nói theo "${want.unit}" — không tự quy đổi; hãy nói theo đơn vị của đơn, hoặc bỏ đơn vị để nhận phần còn lại`,
          );
        }
      }
      return { ...line, qty };
    });
  } else {
    // Nothing named ⇒ receive everything the order still owes, whole lines.
    chosen = pending.map((l) => ({ ...l, qty: l.pending }));
  }

  const maxLines = Number(policy().max_lines ?? 20);
  if (chosen.length > maxLines) {
    throw refuse(
      "PR_LINE_LIMIT",
      `phiếu nhận có ${chosen.length} dòng, vượt giới hạn ${maxLines} dòng mỗi phiếu — tách thành nhiều phiếu`,
    );
  }

  const warnings = [...draftWarnings];
  const lines = chosen.map((l) => {
    if (l.pending < l.ordered - EPS) {
      warnings.push(`${l.item_name}: đơn còn phải nhận ${l.pending}/${l.ordered} ${l.uom ?? ""}`);
    }
    if (l.qty < l.pending - EPS) {
      warnings.push(`${l.item_name}: nhận một phần ${l.qty}/${l.pending} ${l.uom ?? ""} (đơn vẫn còn chờ)`);
    }
    return {
      item_code: l.item_code,
      item_name: l.item_name,
      qty: l.qty,
      uom: l.uom,
      rate: l.rate,
      // Carried from the order (ERPNext's own values) — never invented here.
      ...(l.warehouse ? { warehouse: l.warehouse } : {}),
      purchase_order: po.name,
      po_detail: l.po_detail,
    };
  });

  const proposal = buildProposal({
    action: "create_purchase_receipt",
    risk: "HIGH",
    entity: {
      kind: "supplier",
      id: poSupplierId,
      name: po.supplier_name ?? supplier?.supplier_name ?? null,
    },
    params: {
      purchase_order: po.name,
      lines,
      line_count: lines.length,
      // Draft is part of WHAT is approved: the card promises a NHÁP receipt,
      // and nothing downstream may submit it (a submitted PR moves stock).
      submit_now: false,
    },
    summary: `Tạo phiếu nhận hàng NHÁP theo đơn mua ${po.name}: ${lines
      .map((l) => `${l.qty} ${l.uom ?? ""} ${l.item_name}`.trim())
      .join(" + ")}`,
    extra: {
      ambiguous,
      warnings,
      action_id: newActionId(),
      schema_note:
        "params.lines là ĐỀ XUẤT lấy từ chính đơn mua — execute đọc lại ERPNext lúc chạy; phiếu KHÔNG tự submit",
    },
  });

  return { proposal, lines, warnings, action_id: proposal.action_id };
}

/**
 * The REAL Purchase Receipt payload (pure — unit-testable without network).
 *
 * Field names are ERPNext's: items[] child rows carrying BOTH `purchase_order`
 * (header link) and `po_detail` (child-row link). Schema-derived provenance:
 * the project's verified recipe maps PR from PO "giữ liên kết purchase_order /
 * purchase_order_item" (erpnext-rest-api-recipes §362), and the child link
 * field is `po_detail` — the mirror of the DN's `so_detail`. Marked for the
 * same first-real-loop check the DN path documented.
 *
 * NO `posting_date`: the mapper sets it to TODAY at the SITE, and the
 * recipes' measured trap ("thiếu set_posting_time là ERPNext GHI ĐÈ về hôm
 * nay") applies to back-dating, not to defaulting. Omitting the field keeps
 * the site's own clock in charge — this capability has no reason to back-date.
 */
export function buildPurchaseReceiptData({ supplierId, purchaseOrder, lines, company, actionId, correlation }) {
  return {
    doctype: WRITE_DOCTYPE,
    supplier: supplierId,
    company,
    [correlation]: actionId ?? null,
    remarks: "ERPNext Voice Copilot · xác nhận bởi người dùng · phiếu nhận NHÁP, chưa submit (chưa cộng kho)",
    items: lines.map((l) => ({
      item_code: l.item_code,
      qty: l.qty,
      uom: l.uom,
      rate: l.rate,
      ...(l.warehouse ? { warehouse: l.warehouse } : {}),
      purchase_order: purchaseOrder,
      ...(l.po_detail ? { po_detail: l.po_detail } : {}),
    })),
  };
}

/** Read the written receipt back and check it carries what we intended. */
export async function verifyWrittenPurchaseReceipt(mcp, docName, { supplierId, purchaseOrder, lines, actionId }) {
  const res = await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName });
  const doc = docOf(res);
  const problems = [];
  if (String(doc.supplier ?? "") !== String(supplierId)) problems.push(`supplier=${doc.supplier}`);
  if (Number(doc.docstatus) !== 0) problems.push(`docstatus=${doc.docstatus} (phiếu nhận phải là NHÁP)`);
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
      if (String(got.purchase_order ?? "") !== String(purchaseOrder)) {
        problems.push(`${want.item_code}: purchase_order=${got.purchase_order}`);
      }
    }
  }
  if (problems.length) {
    throw refuse(
      "PR_WRITE_UNVERIFIED",
      `đọc lại phiếu nhận ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc },
    );
  }
  return doc;
}

/**
 * Stage B — execute a CONFIRMED receipt proposal. Called only from the Safety
 * Gateway AFTER the confirm + idempotency gates. The ORDER is re-read from
 * live ERPNext and the quantities recomputed: the proposal's numbers are
 * compared, never trusted.
 */
export async function executePurchaseReceiptProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const supplierId = proposal.entity?.id;
  const purchaseOrder = String(proposal.params?.purchase_order ?? "");
  const wantLines = Array.isArray(proposal.params?.lines) ? proposal.params.lines : [];
  if (!purchaseOrder) {
    throw refuse("PR_PO_UNRESOLVED", "đề xuất không nói nhận hàng theo ĐƠN MUA nào — không ghi phiếu");
  }
  if (wantLines.length === 0) {
    throw refuse("PR_QTY_INVALID", "đề xuất không có dòng hàng nào — không ghi phiếu nhận rỗng");
  }
  const maxLines = Number(policy().max_lines ?? 20);
  if (wantLines.length > maxLines) {
    throw refuse("PR_LINE_LIMIT", `đề xuất có ${wantLines.length} dòng, vượt giới hạn ${maxLines}`);
  }

  // 1. The correlation field is the ONLY once-only half a receipt has.
  //    Refuse BEFORE registering anything when the site cannot store it.
  const field = correlationField();
  const probe = await reconcilePurchaseReceipt(mcp, commandId, { actionId: proposal.action_id ?? null });
  if (probe.correlation_field_unavailable) {
    throw refuse(
      "PR_CORRELATION_FIELD_MISSING",
      `ERPNext chưa có field "${field}" trên ${WRITE_DOCTYPE} — không có cách chống trùng phía server, KHÔNG ghi phiếu (chạy migration thêm field cho ${WRITE_DOCTYPE} trước)`,
    );
  }
  if (probe.found) {
    throw refuse(
      "PR_DUPLICATE_ACTION",
      `phiếu nhận ${probe.doc?.name ?? "?"} đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước`,
      { existing_doc: probe.doc?.name ?? null },
    );
  }

  // 2. RE-READ the order: still submitted, still this supplier, still owing
  //    every quantity this proposal promised (draft cover subtracted too).
  let po = null;
  try {
    po = docOf(await mcp.callTool("erpnext_doc_get", { doctype: "Purchase Order", name: purchaseOrder }));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc lại được đơn mua ${purchaseOrder}: ${err?.message ?? err}`);
  }
  const drift = [];
  if (!po?.name) {
    drift.push(`đơn mua ${purchaseOrder} không còn tồn tại`);
  } else {
    if (Number(po.docstatus) !== 1) drift.push(`đơn mua ${po.name} không còn ở trạng thái đã submit (docstatus=${po.docstatus})`);
    if (String(po.supplier ?? "") !== String(supplierId)) drift.push(`đơn mua ${po.name} đã đổi sang NCC ${po.supplier}`);
  }
  const pendingRaw = po?.name ? pendingLines(po) : [];
  const draftCover = po?.name
    ? await openDraftCover(
        {
          listOpenDraftPurchaseReceipts: (id) => listOpenDraftPurchaseReceipts(mcp, id),
          getPurchaseReceiptDoc: (name) => getPurchaseReceiptDoc(mcp, name),
        },
        supplierId ?? po?.supplier ?? "",
        po.name,
      )
    : { drawn: new Map(), drafts: [] };
  const pending = po?.name ? subtractDrawn(pendingRaw, draftCover.drawn) : [];
  const poItemCodes = (Array.isArray(po?.items) ? po.items : []).map((it) => String(it.item_code ?? it.name ?? ""));
  const lines = [];
  for (const want of wantLines) {
    const line = pending.find((l) => l.item_code === String(want.item_code));
    if (!line) {
      drift.push(
        poItemCodes.includes(String(want.item_code))
          ? pendingRaw.some((l) => l.item_code === String(want.item_code))
            ? `${want.item_code}: còn chờ nhận nhưng đã có phiếu nhận NHÁP chưa submit phủ hết`
            : `${want.item_code}: đơn mua đã nhận đủ phần còn lại`
          : `${want.item_code} không còn trong đơn mua ${purchaseOrder}`,
      );
      continue;
    }
    const qty = Number(want.qty);
    if (!(qty > 0)) {
      throw refuse("PR_QTY_INVALID", `số lượng ${want.item_code} không hợp lệ (${want.qty}) — từ chối ghi`);
    }
    if (qty - line.pending > EPS) {
      drift.push(`${want.item_code}: chỉ còn ${line.pending} chờ nhận (đề xuất ${qty})`);
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
    code: "PR_COMPANY_UNRESOLVED",
    noun: "phiếu nhận hàng",
  });
  const actionId = proposal.action_id ?? null;

  // 3. Register the ERPNext-side reference BEFORE the write (crash safety).
  store.setReference(commandId, commandId);

  if (typeof mcp.callWriteTool !== "function") {
    throw refuse("PR_CLIENT_UNAVAILABLE", "this MCP client has no write method");
  }
  const data = buildPurchaseReceiptData({
    supplierId,
    purchaseOrder,
    lines,
    company: resolvedCompany,
    actionId,
    correlation: field,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });
  const doc = docOf(res);
  const docName = doc?.name ?? null;
  if (!docName) {
    throw refuse("PR_WRITE_UNVERIFIED", "ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile");
  }

  // 4. VERIFY by reading the document back — the write response is not evidence.
  const verified = await verifyWrittenPurchaseReceipt(mcp, docName, {
    supplierId,
    purchaseOrder,
    lines,
    actionId,
  });

  const result = {
    erpnext_doc: docName,
    supplier: supplierId,
    purchase_order: purchaseOrder,
    lines: lines.map((l) => ({
      item_code: l.item_code,
      item_name: l.item_name,
      qty: l.qty,
      uom: l.uom,
      rate: l.rate,
    })),
    line_count: lines.length,
    action_id: actionId,
    docstatus: Number(verified.docstatus ?? 0),
    company: resolvedCompany,
    note: "phiếu NHẬP hàng tạo ở trạng thái NHÁP (docstatus 0) — CHƯA cộng kho, submit là bước riêng trên ERPNext",
  };
  if (doc && !Object.prototype.hasOwnProperty.call(verified, field)) {
    result.correlation_field_missing = field;
  }
  result.reference_no = commandId;
  store.complete(commandId, result);
  return result;
}

/**
 * Reconcile a command against ERPNext — READ ONLY. The correlation value IS
 * the lookup key; when the site cannot filter by it the caller is TOLD
 * (`correlation_field_unavailable`), never told "nothing was written".
 */
export async function reconcilePurchaseReceipt(mcp, reference, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const field = correlationField();
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "supplier", "purchase_order", field],
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
