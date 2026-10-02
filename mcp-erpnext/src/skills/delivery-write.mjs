/**
 * Skill: delivery.create WRITE — P9-A1 (builder) + P9-A2 (wired executor).
 *
 * WHAT THIS FILE IS: the whole delivery path — buildDeliveryProposal (the /ask
 * half) and executeDeliveryProposal (the /execute half, reached ONLY through
 * the Safety Gateway after confirm + idempotency gates). The capability is a
 * real, non-stub WRITE in the contract; every write it performs is a DRAFT
 * (docstatus 0 — a submitted Delivery Note moves stock, which is not a chat
 * side effect).
 *
 * Guards this file owns (each has a test that goes RED when the guard is
 * removed — see test/p9-delivery.test.mjs and the falsify runs):
 *
 *  - the ORDER anchors everything: lines, units, customer and warehouse come
 *    from the Sales Order, never from the sentence;
 *  - the unit the user SAID is checked against the order's unit — a mismatch
 *    refuses (DN_UOM_MISMATCH) instead of reinterpreting the number (no hidden
 *    conversion, per B1);
 *  - OPEN DRAFT notes already holding the order's goods are subtracted from
 *    pending: ERPNext advances delivered_qty only at SUBMIT, so raw pending
 *    still counts goods that live drafts promise — a second confirmation would
 *    ship them twice on paper (DN_DRAFT_COVERED / reduced proposal + warning);
 *  - a FULL page of the customer's open orders is a question, not a pick
 *    (DN_SO_UNRESOLVED) — the page cap makes "exactly one hit" unknowable.
 *
 * Why a Delivery Note needs its own rules (it is not "an order with a filter"):
 *
 *  - A Delivery Note AGAINST A SALES ORDER takes its lines from THAT ORDER, not
 *    from the sentence. Items, units and prices are the order's — the utterance
 *    may only decide HOW MUCH of what the order already promises.
 *  - The order must be SUBMITTED (docstatus 1): ERPNext refuses
 *    `against_sales_order` pointing at a draft. A refusal here is the correct
 *    answer, not a reason to build a free-standing delivery note.
 *  - "How much is still owed" is arithmetic on ERPNext's own numbers
 *    (qty − delivered_qty). It is never invented, and a request to deliver MORE
 *    than remains is refused rather than silently clamped (clamping would hide
 *    that the user is describing a different order).
 *  - The customer is decided by the ORDER (cross-checked against the resolved
 *    customer when the caller has one) — a delivery is never made to a party
 *    the order does not name.
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
export const WRITE_DOCTYPE = "Delivery Note";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "delivery.create";

/** Floating-point tolerance for quantities (ERPNext floats, we compare). */
const EPS = 1e-9;

/**
 * How many of a customer's open orders we are willing to look at before asking
 * which one. Not a performance knob: past this point the sentence "giao hàng
 * cho Lan" no longer identifies ONE order, so the pipeline must ask instead of
 * picking. The page-size heuristic below treats a FULL page as "possibly more".
 */
const OPEN_ORDER_LOOKUP_LIMIT = 5;

/**
 * How many OPEN DRAFT delivery notes of one customer we read per proposal.
 * A FULL page refuses (fail-closed): past this cap we cannot know how much of
 * the order is already promised by drafts, so "how much is still owed" is
 * unknowable and the answer is "dọn phiếu nháp trước", not a guess.
 */
const DRAFT_NOTE_LOOKUP_LIMIT = 10;

/** Contract policy block, read per call (a missing block is a hard bug). */
function policy() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("DN_CONTRACT_MISSING: delivery.create is not in the capability contract");
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
 * The lines of an order that still OWE goods, in the order's own numbers:
 * `pending = qty − delivered_qty`. Delivered-in-full lines are excluded — they
 * are not part of what a delivery could carry, and including them would offer
 * the user a line ERPNext would reject.
 */
function pendingLines(so) {
  const items = Array.isArray(so?.items) ? so.items : [];
  return items
    .map((it) => ({
      item_code: String(it.item_code ?? it.name ?? ""),
      item_name: it.item_name ?? String(it.item_code ?? it.name ?? ""),
      uom: it.uom ?? it.stock_uom ?? null,
      // Carry the ORDER's warehouse (ERPNext data) — the delivery note must ship
      // from where the order said, and a DN item without a warehouse is a
      // validation error on a site with no default warehouse.
      warehouse: it.warehouse ?? null,
      so_detail: it.name ?? null,
      ordered: Number(it.qty ?? 0),
      pending: Number(it.qty ?? 0) - Number(it.delivered_qty ?? 0),
    }))
    .filter((l) => l.pending > EPS);
}

/**
 * WHICH order does this delivery refer to?
 *
 * Two honest paths, no third:
 *  - the sentence named one (A2 passes it in `resolved.order`) — it must exist
 *    and be SUBMITTED, because ERPNext refuses `against_sales_order` on a draft;
 *  - it named none — then the CUSTOMER's own open orders are read, and exactly
 *    ONE order still owing goods is used. Several is a question, not a coin
 *    flip: delivering the wrong order moves the wrong goods and cannot be undone
 *    from chat.
 */
async function resolveOrder(skills, { orderName, customerId, ambiguous, candidates }) {
  if (orderName) {
    const so = await readOrder(skills, orderName);
    if (!so?.name) {
      throw refuse("DN_SO_NOT_FOUND", `không tìm thấy đơn bán "${orderName}" trong ERPNext — không tạo phiếu giao`);
    }
    return so;
  }
  if (!customerId) {
    throw refuse(
      "DN_SO_UNRESOLVED",
      ambiguous
        ? `tên khách khớp nhiều kết quả (${(candidates ?? []).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ trước khi giao hàng`
        : "chưa xác định được khách hàng nên không biết giao đơn nào — không tự chọn đơn để giao",
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
      "DN_SO_UNRESOLVED",
      "khách chưa có đơn bán nào ĐÃ SUBMIT — ERPNext chỉ cho giao hàng theo đơn đã submit, hãy submit đơn bán trước",
    );
  }
  const withPending = [];
  for (const name of names.slice(0, OPEN_ORDER_LOOKUP_LIMIT)) {
    const so = await readOrder(skills, name);
    if (so?.name && pendingLines(so).length > 0) withPending.push(so);
  }
  // A FULL page is "possibly more": the list read caps at exactly
  // OPEN_ORDER_LOOKUP_LIMIT rows, so the old `names.length > LIMIT` clause was
  // dead code and a customer with exactly one pending order on a full page got
  // that order picked silently — possibly not the one the user meant.
  if (withPending.length > 1 || names.length >= OPEN_ORDER_LOOKUP_LIMIT) {
    const list = withPending.map((s) => s.name);
    throw refuse(
      "DN_SO_UNRESOLVED",
      `khách có ${names.length} đơn đã submit${list.length ? ` (${list.slice(0, 5).join(", ")} còn chờ giao)` : ""} — nói rõ giao đơn nào`,
      { candidates: list },
    );
  }
  if (withPending.length === 0) {
    throw refuse(
      "DN_NOTHING_TO_DELIVER",
      `không đơn nào của khách còn hàng chờ giao (đã xem ${names.length} đơn) — không tạo phiếu giao rỗng`,
    );
  }
  return withPending[0];
}

/**
 * What does the SENTENCE say to deliver?
 *
 * Returns null when it names no item — that is "giao hết phần còn lại", the one
 * interpretation that needs no guess. But a sentence that carries a QUANTITY yet
 * matches no item is NOT null: it is a refusal. Defaulting to "everything" there
 * would ignore a number the user said ("giao 5 bao cám bò" ⇒ giao hết 6 bao cám
 * heo), which is exactly the silent wrong-quantity write this path exists to
 * prevent.
 *
 * Item matching runs against the FULL catalogue (what ERPNext knows), and the
 * ORDER-membership check then happens in the caller — so an item that exists but
 * is not on this order refuses as DN_ITEM_NOT_IN_SO rather than being silently
 * dropped.
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
        "DN_ITEM_UNRESOLVED",
        `câu có số lượng nhưng không khớp mặt hàng nào trong ERPNext ("${text}") — nói rõ tên mặt hàng, hoặc bỏ số lượng để giao hết phần còn lại`,
      );
    }
    return null;
  }
  const { lines: paired, problems } = pairLines({ matched: named, quantities });
  if (problems.length > 0) {
    // The pairing codes belong to the order path (SO_*); a delivery answers with
    // its OWN two codes so a copy-paste is visible instead of silently shared.
    const code = String(problems[0].code ?? "").includes("AMBIGUOUS") ? "DN_QTY_AMBIGUOUS" : "DN_QTY_MISSING";
    throw refuse(code, problems[0].reason, { problems });
  }
  return paired.map(({ item, quantity }) => ({
    item_code: item.item_code ?? item.name,
    qty: Number(quantity.value),
    // The unit the user SAID. The DN line's unit is the ORDER's, so a mismatch
    // must refuse (no hidden conversion, B1) instead of reinterpreting the
    // number — "giao 1 tấn" against a Bao line must not become "1 bao".
    unit: quantity.canonical_unit ?? null,
  }));
}

/** Guarded read: the customer's OPEN (draft) Delivery Notes. */
export async function listOpenDraftDeliveryNotes(mcp, customerId) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: WRITE_DOCTYPE,
    fields: ["name", "docstatus", "customer"],
    filters: [["customer", "=", String(customerId)], ["docstatus", "=", "0"]],
    limit: DRAFT_NOTE_LOOKUP_LIMIT,
  });
}

/** Guarded read: one Delivery Note document. */
export async function getDeliveryNoteDoc(mcp, name) {
  assertReadOnly("erpnext_doc_get");
  return mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: String(name) });
}

/**
 * How much of one order's pending quantity do OPEN DRAFT notes already hold?
 *
 * ERPNext advances delivered_qty only at SUBMIT, so `qty − delivered_qty`
 * still counts goods that live drafts promise. Ignoring them means a second
 * confirmation proposes the same goods again — harmless as a draft, but a trap
 * the moment both drafts are submitted. Reads go through the same guarded
 * reads every other skill read uses (the bag carries them; the executor wraps
 * its own mcp in the same shape).
 *
 * @param {{listOpenDraftDeliveryNotes: Function, getDeliveryNoteDoc: Function}} reads
 * @returns {Promise<{drawn: Map<string, number>, drafts: string[]}>}
 */
async function openDraftCover(reads, customerId, soName) {
  let rows = [];
  try {
    rows = rowsOf(await reads.listOpenDraftDeliveryNotes(customerId));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được phiếu giao NHÁP đang chờ của khách từ ERPNext: ${err?.message ?? err}`);
  }
  if (rows.length >= DRAFT_NOTE_LOOKUP_LIMIT) {
    throw refuse(
      "DN_DRAFT_COVERED",
      `khách có ${rows.length} phiếu giao NHÁP chưa submit — dọn (submit hoặc hủy) các phiếu đó trên ERPNext trước khi tạo phiếu mới`,
    );
  }
  const drawn = new Map();
  const drafts = [];
  for (const row of rows) {
    const name = String(row.name ?? "");
    if (!name) continue;
    let doc = null;
    try {
      doc = docOf(await reads.getDeliveryNoteDoc(name));
    } catch (err) {
      throw refuse("ERP_UNAVAILABLE", `không đọc được phiếu giao nháp ${name}: ${err?.message ?? err}`);
    }
    const mine = (Array.isArray(doc?.items) ? doc.items : []).filter(
      (it) => String(it.against_sales_order ?? "") === String(soName),
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
 * The customer's orders that could still receive goods — SUBMITTED only.
 *
 * Exported (and guarded) so the router factory wires a read that goes through
 * the SAME `assertReadOnly` gate as every other skill read: a bare
 * `mcp.callTool` written inside the router would be the one read path with no
 * guard on it.
 */
export async function listOpenSalesOrders(mcp, customerId) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: "Sales Order",
    fields: ["name", "customer", "docstatus", "transaction_date"],
    // `docstatus = 1` is the whole point: ERPNext cannot deliver against a
    // draft, so a draft must never appear as a candidate order.
    filters: [["customer", "=", String(customerId)], ["docstatus", "=", "1"]],
    limit: OPEN_ORDER_LOOKUP_LIMIT,
  });
}

/** Guarded read: one Sales Order document (the delivery proposal's source). */
export async function getSalesOrderDoc(mcp, name) {
  assertReadOnly("erpnext_doc_get");
  return mcp.callTool("erpnext_doc_get", { doctype: "Sales Order", name: String(name) });
}

/**
 * Stage A — build the draft Delivery Note proposal for a resolved customer and
 * a Sales Order.
 *
 * @param {object} skills   { getSalesOrder }
 * @param {object} resolved { order, customer?, ambiguous?, candidates? }
 * @param {object} [opts]
 * @param {object[]} [opts.lines]  [{item_code, qty}] — what to deliver, if the
 *                                 user named quantities. Omitted ⇒ the whole
 *                                 pending quantity of every line is proposed.
 * @returns {Promise<{proposal:object, lines:object[], warnings:string[], action_id:string}>}
 */
export async function buildDeliveryProposal(skills, resolved, opts = {}) {
  const { customer = null, order = null, ambiguous = false, candidates = [] } = resolved ?? {};

  // 1. A delivery has to be against a SPECIFIC order. Guessing one (or
  //    delivering the customer's whole backlog) is what this refusal prevents —
  //    the same reason a payment never picks its own invoice.
  const orderName = typeof order === "string" ? order : (order?.name ?? null);
  const so = await resolveOrder(skills, {
    orderName,
    customerId: customer?.name ?? null,
    ambiguous,
    candidates,
  });

  // 2. ERPNext only accepts `against_sales_order` for a SUBMITTED order. An
  //    app-created order is a DRAFT until someone submits it on the site, so
  //    this is a common case and it must say so rather than fail as a raw link.
  if (Number(so.docstatus) !== 1) {
    throw refuse(
      "DN_SO_NOT_SUBMITTED",
      `đơn ${so.name} chưa được submit (docstatus=${so.docstatus ?? "?"}) — ERPNext chỉ cho giao hàng theo đơn ĐÃ SUBMIT; mở ERPNext submit đơn trước`,
    );
  }

  // 3. The ORDER decides who receives the goods — cross-checked against the
  //    resolved customer, never overridden by it.
  const soCustomerId = String(so.customer ?? "");
  if (!soCustomerId) {
    throw refuse("DN_CUSTOMER_UNRESOLVED", `đơn ${so.name} không có khách hàng — không tạo phiếu giao`);
  }
  if (customer && String(customer.name) !== soCustomerId) {
    throw refuse(
      "DN_CUSTOMER_MISMATCH",
      `đơn ${so.name} thuộc khách ${so.customer_name ?? soCustomerId}, không phải ${customer.customer_name ?? customer.name} — không giao sai khách`,
    );
  }

  // 4. What the order still OWES. Arithmetic on ERPNext's numbers only.
  const soItems = Array.isArray(so.items) ? so.items : [];
  if (soItems.length === 0) {
    throw refuse("DN_NOTHING_TO_DELIVER", `đơn ${so.name} không có dòng hàng nào — không tạo phiếu giao`);
  }
  const rawPending = pendingLines(so);
  // 4b. Subtract what OPEN DRAFT notes already promise (see openDraftCover) —
  //     raw pending still counts goods live drafts hold.
  const draftCover = await openDraftCover(skills, soCustomerId, so.name);
  const pending = subtractDrawn(rawPending, draftCover.drawn);
  const draftWarnings = [];
  for (const l of rawPending) {
    const d = draftCover.drawn.get(l.item_code) ?? 0;
    if (d > EPS) draftWarnings.push(`${l.item_name}: đã có phiếu giao NHÁP chờ ${d} ${l.uom ?? ""} (chưa submit)`);
  }
  if (pending.length === 0 && rawPending.length > 0) {
    throw refuse(
      "DN_DRAFT_COVERED",
      `đơn ${so.name} còn chờ giao nhưng đã có phiếu giao NHÁP (${draftCover.drafts.slice(0, 5).join(", ")}) chưa submit phủ hết — submit hoặc hủy phiếu đó trên ERPNext trước khi giao tiếp`,
    );
  }
  if (pending.length === 0) {
    throw refuse(
      "DN_NOTHING_TO_DELIVER",
      `đơn ${so.name} đã giao đủ (không còn dòng nào chờ giao) — không tạo phiếu giao rỗng`,
    );
  }

  // 5. Explicit quantities: each one must point at a line of THIS order and must
  //    not exceed what is still owed. Two sources, one validation — a caller may
  //    hand them in (`opts.lines`, used by the camera slot form and tests) or the
  //    SENTENCE may carry them (parsed here, so the /ask path and the unit tests
  //    cannot diverge on what "giao 2 bao" means).
  const requested = Array.isArray(opts.lines) ? opts.lines : await requestedLinesFromText(skills, opts, so.customer_name ?? null);
  let chosen;
  if (requested) {
    if (requested.length === 0) {
      throw refuse("DN_QTY_INVALID", "không có dòng hàng nào được nêu — không tạo phiếu giao");
    }
    // The same item named twice is a QUESTION, not a sum — the order path
    // refuses "2 bao và 3 bao cám heo" for exactly this reason. Adding the two
    // numbers would silently deliver 5 when the user may have meant 2 (or 3),
    // so it is refused instead of merged.
    const seen = new Set();
    for (const want of requested) {
      const code = String(want?.item_code ?? "");
      if (seen.has(code)) {
        throw refuse(
          "DN_QTY_AMBIGUOUS",
          `"${code}" được nêu nhiều lần trong cùng một câu — chưa rõ muốn giao tổng bao nhiêu, nói lại một lần duy nhất`,
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
          // Distinguish "the order was fulfilled" from "a live DRAFT already
          // holds it" — the advice differs (submit/cancel the draft vs done).
          const covered = rawPending.some((l) => l.item_code === code);
          throw covered
            ? refuse(
                "DN_DRAFT_COVERED",
                `"${code}" còn chờ giao nhưng đã có phiếu giao NHÁP (${draftCover.drafts.slice(0, 5).join(", ")}) chưa submit phủ hết — submit hoặc hủy phiếu đó trước`,
              )
            : refuse("DN_ALREADY_DELIVERED", `"${code}" trong đơn ${so.name} đã giao đủ — không giao thêm`);
        }
        throw refuse("DN_ITEM_NOT_IN_SO", `"${code}" không có trong đơn ${so.name} — chỉ giao được hàng của chính đơn đó`);
      }
      const qty = Number(want?.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw refuse("DN_QTY_INVALID", `số lượng giao của "${line.item_name}" phải là số dương (đang ${want?.qty})`);
      }
      if (qty - line.pending > EPS) {
        throw refuse(
          "DN_QTY_EXCEEDS_PENDING",
          `"${line.item_name}" chỉ còn ${line.pending} ${line.uom ?? ""} chờ giao, không giao được ${qty} — kiểm tra lại đơn`,
        );
      }
      // The unit the user said must be the order's unit. No hidden conversion:
      // a number in another unit is a DIFFERENT quantity, and converting it
      // here is how "1 tấn" becomes a card that ships "1 bao".
      if (want.unit) {
        const spoken = String(want.unit).trim().toLowerCase();
        const orderUom = String(line.uom ?? "").trim().toLowerCase();
        if (orderUom && spoken !== orderUom) {
          throw refuse(
            "DN_UOM_MISMATCH",
            `đơn ${so.name} ghi "${line.item_name}" theo đơn vị "${line.uom}", câu nói theo "${want.unit}" — không tự quy đổi; hãy nói theo đơn vị của đơn, hoặc bỏ đơn vị để giao phần còn lại`,
          );
        }
      }
      return { ...line, qty };
    });
  } else {
    // Nothing named ⇒ deliver everything the order still owes, whole lines.
    chosen = pending.map((l) => ({ ...l, qty: l.pending }));
  }

  const maxLines = Number(policy().max_lines ?? 20);
  if (chosen.length > maxLines) {
    throw refuse(
      "DN_LINE_LIMIT",
      `phiếu giao có ${chosen.length} dòng, vượt giới hạn ${maxLines} dòng mỗi phiếu — tách thành nhiều phiếu`,
    );
  }

  const warnings = [...draftWarnings];
  const lines = chosen.map((l) => {
    if (l.pending < l.ordered - EPS) {
      warnings.push(`${l.item_name}: đơn còn phải giao ${l.pending}/${l.ordered} ${l.uom ?? ""}`);
    }
    if (l.qty < l.pending - EPS) {
      warnings.push(`${l.item_name}: giao một phần ${l.qty}/${l.pending} ${l.uom ?? ""} (đơn vẫn còn chờ)`);
    }
    return {
      item_code: l.item_code,
      item_name: l.item_name,
      qty: l.qty,
      uom: l.uom,
      // Carried from the order (ERPNext's own value) — never invented here.
      ...(l.warehouse ? { warehouse: l.warehouse } : {}),
      against_sales_order: so.name,
      so_detail: l.so_detail,
    };
  });

  const proposal = buildProposal({
    action: "create_delivery_note",
    risk: "HIGH",
    entity: {
      kind: "customer",
      id: soCustomerId,
      name: so.customer_name ?? customer?.customer_name ?? null,
    },
    params: {
      against_sales_order: so.name,
      lines,
      line_count: lines.length,
      // Draft is part of WHAT is being approved: the card promises a NHÁP
      // delivery note, and nothing downstream may submit it (A2 keeps
      // allow_submit false — a submitted DN moves stock, which is not a chat
      // side effect).
      submit_now: false,
    },
    summary: `Tạo phiếu giao NHÁP theo đơn ${so.name}: ${lines
      .map((l) => `${l.qty} ${l.uom ?? ""} ${l.item_name}`.trim())
      .join(" + ")}`,
    extra: {
      ambiguous,
      warnings,
      action_id: newActionId(),
      schema_note:
        "params.lines là ĐỀ XUẤT lấy từ chính đơn bán — A2 mới đọc lại ERPNext lúc execute; phiếu KHÔNG tự submit",
    },
  });

  return { proposal, lines, warnings, action_id: proposal.action_id };
}

/* --------------------------------------------------------------- executor -- */

/**
 * P0 §10.4 — ERPNext-side correlation field, read from the contract (single
 * source of truth). Same Custom Field as the order/quotation/purchase paths, so
 * one migration covers every write capability.
 */
export function correlationField() {
  return getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
}

/**
 * Reconcile a command against ERPNext — READ ONLY.
 *
 * A Delivery Note has no natural reference field to search, so the correlation
 * value IS the lookup key. When the site cannot filter by it, the caller is TOLD
 * (`correlation_field_unavailable`) rather than being told "nothing was written"
 * — the difference between "no delivery note" and "we cannot know" is the whole
 * point of reconcile.
 */
export async function reconcileDeliveryNote(mcp, reference, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const field = correlationField();
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "customer", "against_sales_order", field],
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
 * The REAL Delivery Note payload (pure — unit-testable without network).
 *
 * Field names are ERPNext's: `items[]` child rows carrying BOTH
 * `against_sales_order` and the child-row link `so_detail`. Measured fact this
 * follows (`.agents/skills/erpnext-rest-api-core/SKILL.md:205`): a DELIVERY NOTE
 * links to a Sales Order with `against_sales_order` — the `sales_order` +
 * `so_detail` shape belongs to Sales Invoice, and swapping them is what ERPNext
 * answers with "Đối ứng với Mục đơn hàng bán chưa thiết lập".
 *
 * NO `posting_date`: ERPNext defaults it to today at the SITE. The payment path
 * learned (P5-2) that sending a date derived from the host clock writes
 * yesterday's document between 00:00–07:00 VN — omitting the field is strictly
 * safer than guessing a date, and this capability has no reason to back-date.
 */
export function buildDeliveryNoteData({ customerId, againstSalesOrder, lines, company, actionId, correlation }) {
  return {
    doctype: WRITE_DOCTYPE,
    customer: customerId,
    company,
    [correlation]: actionId ?? null,
    remarks: "ERPNext Voice Copilot · xác nhận bởi người dùng · phiếu giao NHÁP, chưa submit (chưa trừ kho)",
    items: lines.map((l) => ({
      item_code: l.item_code,
      qty: l.qty,
      uom: l.uom,
      ...(l.warehouse ? { warehouse: l.warehouse } : {}),
      against_sales_order: againstSalesOrder,
      ...(l.so_detail ? { so_detail: l.so_detail } : {}),
    })),
  };
}

/** Read the written note back and check it carries what we intended. */
export async function verifyWrittenDeliveryNote(mcp, docName, { customerId, againstSalesOrder, lines, actionId }) {
  const res = await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName });
  const doc = docOf(res);
  const problems = [];
  if (String(doc.customer ?? "") !== String(customerId)) problems.push(`customer=${doc.customer}`);
  if (Number(doc.docstatus) !== 0) problems.push(`docstatus=${doc.docstatus} (phiếu giao phải là NHÁP)`);
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
      if (String(got.against_sales_order ?? "") !== String(againstSalesOrder)) {
        problems.push(`${want.item_code}: against_sales_order=${got.against_sales_order}`);
      }
    }
  }
  if (problems.length) {
    throw refuse(
      "DN_WRITE_UNVERIFIED",
      `đọc lại phiếu giao ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc },
    );
  }
  return doc;
}

/**
 * Stage B — execute a CONFIRMED delivery proposal. Called only from the Safety
 * Gateway AFTER the confirm + idempotency gates. The ORDER is re-read from live
 * ERPNext and the quantities are recomputed: the proposal's numbers are
 * compared, never trusted.
 *
 * @param {object} mcp MCP client (mock or real)
 * @param {object} proposal erpn.proposal/v1 with action=create_delivery_note
 * @param {string} commandId client UUID (idempotency key)
 * @param {object} store IdempotencyStore (already gated this command)
 * @returns {Promise<object>} the recorded result (never a submitted document)
 */
export async function executeDeliveryProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const customerId = proposal.entity?.id;
  const againstSalesOrder = String(proposal.params?.against_sales_order ?? "");
  const wantLines = Array.isArray(proposal.params?.lines) ? proposal.params.lines : [];
  if (!againstSalesOrder) {
    throw refuse("DN_SO_UNRESOLVED", "đề xuất không nói giao hàng theo ĐƠN BÁN nào — không ghi phiếu");
  }
  if (wantLines.length === 0) {
    throw refuse("DN_QTY_INVALID", "đề xuất không có dòng hàng nào — không ghi phiếu giao rỗng");
  }
  const maxLines = Number(policy().max_lines ?? 20);
  if (wantLines.length > maxLines) {
    throw refuse("DN_LINE_LIMIT", `đề xuất có ${wantLines.length} dòng, vượt giới hạn ${maxLines}`);
  }

  // 1. The correlation field is the ONLY once-only half a delivery note has.
  //    Refuse BEFORE registering anything when the site cannot store it.
  const field = correlationField();
  const probe = await reconcileDeliveryNote(mcp, commandId, { actionId: proposal.action_id ?? null });
  if (probe.correlation_field_unavailable) {
    throw refuse(
      "DN_CORRELATION_FIELD_MISSING",
      `ERPNext chưa có field "${field}" trên ${WRITE_DOCTYPE} — không có cách chống trùng phía server, KHÔNG ghi phiếu (chạy migration thêm field cho ${WRITE_DOCTYPE} trước)`,
    );
  }
  if (probe.found) {
    throw refuse(
      "DN_DUPLICATE_ACTION",
      `phiếu giao ${probe.doc?.name ?? "?"} đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước`,
      { existing_doc: probe.doc?.name ?? null },
    );
  }

  // 2. RE-READ the order: it must still be submitted, still belong to this
  //    customer, and still owe every quantity this proposal promised.
  let so = null;
  try {
    so = docOf(await mcp.callTool("erpnext_doc_get", { doctype: "Sales Order", name: againstSalesOrder }));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc lại được đơn bán ${againstSalesOrder}: ${err?.message ?? err}`);
  }
  const drift = [];
  if (!so?.name) {
    drift.push(`đơn ${againstSalesOrder} không còn tồn tại`);
  } else {
    if (Number(so.docstatus) !== 1) drift.push(`đơn ${so.name} không còn ở trạng thái đã submit (docstatus=${so.docstatus})`);
    if (String(so.customer ?? "") !== String(customerId)) drift.push(`đơn ${so.name} đã đổi sang khách ${so.customer}`);
  }
  const pendingRaw = so?.name ? pendingLines(so) : [];
  // Same draft-deduction as the builder: a live DRAFT holds goods the raw
  // pending still counts. Re-checking against RAW pending would let a proposal
  // written before the draft existed pass its drift check and duplicate it.
  const draftCover = so?.name
    ? await openDraftCover(
        {
          listOpenDraftDeliveryNotes: (id) => listOpenDraftDeliveryNotes(mcp, id),
          getDeliveryNoteDoc: (name) => getDeliveryNoteDoc(mcp, name),
        },
        customerId ?? so?.customer ?? "",
        so.name,
      )
    : { drawn: new Map(), drafts: [] };
  const pending = so?.name ? subtractDrawn(pendingRaw, draftCover.drawn) : [];
  const soItemCodes = (Array.isArray(so?.items) ? so.items : []).map((it) => String(it.item_code ?? it.name ?? ""));
  const lines = [];
  for (const want of wantLines) {
    const line = pending.find((l) => l.item_code === String(want.item_code));
    if (!line) {
      drift.push(
        soItemCodes.includes(String(want.item_code))
          ? pendingRaw.some((l) => l.item_code === String(want.item_code))
            ? `${want.item_code}: còn chờ giao nhưng đã có phiếu giao NHÁP chưa submit phủ hết`
            : `${want.item_code}: đơn đã giao đủ phần còn lại`
          : `${want.item_code} không còn trong đơn ${againstSalesOrder}`,
      );
      continue;
    }
    const qty = Number(want.qty);
    if (!(qty > 0)) {
      throw refuse("DN_QTY_INVALID", `số lượng ${want.item_code} không hợp lệ (${want.qty}) — từ chối ghi`);
    }
    if (qty - line.pending > EPS) {
      drift.push(`${want.item_code}: chỉ còn ${line.pending} chờ giao (đề xuất ${qty})`);
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
    code: "DN_COMPANY_UNRESOLVED",
    noun: "phiếu giao",
  });
  const actionId = proposal.action_id ?? null;

  // 3. Register the ERPNext-side reference BEFORE the write (crash safety): if
  //    we die mid-call, the reconcile looks the note up by correlation value.
  store.setReference(commandId, commandId);

  if (typeof mcp.callWriteTool !== "function") {
    throw refuse("DN_CLIENT_UNAVAILABLE", "this MCP client has no write method");
  }
  const data = buildDeliveryNoteData({
    customerId,
    againstSalesOrder,
    lines,
    company: resolvedCompany,
    actionId,
    correlation: field,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });
  const doc = docOf(res);
  const docName = doc?.name ?? null;
  if (!docName) {
    throw refuse("DN_WRITE_UNVERIFIED", "ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile");
  }

  // 4. VERIFY by reading the document back — the write response is not evidence.
  const verified = await verifyWrittenDeliveryNote(mcp, docName, {
    customerId,
    againstSalesOrder,
    lines,
    actionId,
  });

  const result = {
    erpnext_doc: docName,
    customer: customerId,
    against_sales_order: againstSalesOrder,
    lines: lines.map((l) => ({
      item_code: l.item_code,
      item_name: l.item_name,
      qty: l.qty,
      uom: l.uom,
    })),
    line_count: lines.length,
    action_id: actionId,
    docstatus: Number(verified.docstatus ?? 0),
    company: resolvedCompany,
    note: "phiếu giao tạo ở trạng thái NHÁP (docstatus 0) — CHƯA trừ kho, submit là bước riêng trên ERPNext",
  };
  if (doc && !Object.prototype.hasOwnProperty.call(verified, field)) {
    result.correlation_field_missing = field;
  }
  result.reference_no = commandId;
  store.complete(commandId, result);
  return result;
}
