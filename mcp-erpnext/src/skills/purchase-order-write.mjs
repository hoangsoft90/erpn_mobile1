/**
 * Skill: purchase_order WRITE (B4, plan3_review3 §52/§510 — pattern B2/B3).
 *
 * Same two-phase shape and the SAME guarantees as sales-order-write (B2): the
 * builder STOPS at the proposal, the executor runs ONLY behind the Safety
 * Gateway's confirm + idempotency gates, and it produces a DRAFT only
 * (`execution.allow_submit: false`, honoured by the MCP client's write gate).
 *
 * A purchase order is the mirror image of a sales order, and the two things
 * that make it NOT a copy-paste are exactly the things that would be dangerous
 * to get wrong:
 *
 *  1. THE PARTY IS A SUPPLIER. This is the misroute B4 exists to close —
 *     measured 2026-09-20 on the real path: "đặt mua 500 bao cám heo từ Hà Tiên"
 *     and (worse) "đặt nhà cung cấp Hà Tiên 500 bao cám heo" both routed to
 *     `sales_order.create`, i.e. a document would have been raised selling goods
 *     TO a supplier whenever the supplier's name also exists as a customer
 *     (plan3_review3 A.3.1: "anh vừa mua vừa bán" is the common case). The party
 *     is resolved against the SUPPLIER master list here, never the customer one.
 *
 *  2. THE PRICE IS THE BUYING PRICE. A Sales Order is priced from `Item Price`
 *     where selling=1; a Purchase Order must be priced from the buying side
 *     (verified live: this site declares both, `Standard Buying` even differs —
 *     CAM-HEO-25KG is 295.000/bao buying vs 305.000/bao selling). Booking a
 *     purchase at the selling price is a real accounting error, so the selling
 *     table is not even read on this path. The price still comes ONLY from
 *     ERPNext and is re-read at execute time — a moved price is drift
 *     (PROPOSAL_STALE), never a silent re-price and never a price from the
 *     utterance.
 *
 * What is REUSED rather than copied (a second copy is where the two paths
 * drift): pairing a quantity to its item, the declared-price lookup, company
 * resolution, the tool-result unwrapping, the refusal convention, the
 * draft-only payload discipline.
 */

import { assertReadOnly } from "../readonly-guard.mjs";
import { buildProposal } from "../action-proposal.mjs";
import { businessDocKeyPolicy, declaredDocumentKinds, getCapability, __contract } from "../capability-contract.mjs";
import {
  DOC_KEY_FIELD_FALLBACK,
  businessDocKeyParts,
  normalizeKind,
  validateSourceDocument,
} from "../business-doc-key.mjs";
import { classifyDriftCode } from "../proposal-freshness.mjs";
import { normalizeUomToken, resolveLineUom, uomPolicy, UOM_ACTIONS } from "../uom.mjs";
import { matchItemsByText, selectNonOverlappingItems } from "./inventory.mjs";
import { maskPartyMention } from "../line-parse.mjs";
import {
  docOf,
  newActionId,
  pairLines,
  priceForLine,
  refuse,
  resolveSalesCompany,
  rowsOf,
} from "./sales-order-write.mjs";

/** The ONE doctype this skill may create (fail-closed everywhere else). */
export const WRITE_DOCTYPE = "Purchase Order";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "purchase_order.create";

/** The code prefix for every refusal this path can emit (contract taxonomy). */
const CODE_PREFIX = "PO_";

/** The price side this document is booked at (contract declares it; see below). */
const PRICE_SIDE = "buying";

/**
 * The ERPNext-side correlation field, read from the contract (single source of
 * truth) — the same Custom Field the order/quotation paths use, so ONE migration
 * covers every doctype this copilot writes.
 */
export function correlationField() {
  return getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
}

/** Contract policy blocks, read once per call (a missing block is a hard bug). */
function policies() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("PO_CONTRACT_MISSING: purchase_order.create is not in the capability contract");
  // next3/B: the document-identity declaration, or null when this capability has
  // no such layer. Read THROUGH the contract so the column the executor writes
  // and the column the migration script creates are the same string.
  return { cap, line: cap.line_policy, uom: uomPolicy(__contract), docKey: businessDocKeyPolicy(CAPABILITY_ID) };
}

/** The ERPNext column holding the document-identity key (contract, else default). */
export function businessDocKeyField() {
  return businessDocKeyPolicy(CAPABILITY_ID)?.field ?? DOC_KEY_FIELD_FALLBACK;
}

/**
 * The document kind THIS capability creates, from the contract — the `kind` half
 * of the key. Shared by the builder and the executor on purpose: they must derive
 * the same key from the same snapshot, or the executor's re-derivation (see
 * `executePurchaseOrderProposal`) would refuse every legitimate proposal.
 * @returns {string|null} null when the contract does not declare a valid kind
 */
function docKeyKind() {
  return normalizeKind(businessDocKeyPolicy(CAPABILITY_ID)?.document_kind);
}

/**
 * Human label for a source document, for refusal messages and the card's summary
 * ONLY. Callers pass an already-validated `source_document` (the validator is
 * what bounds and strips it), never raw request bytes.
 */
function invoiceLabel(sd) {
  if (!sd) return "chứng từ này";
  const number = [sd.invoice_series, sd.invoice_no].filter(Boolean).join("-");
  return `hóa đơn ${number}${sd.invoice_date ? ` ngày ${sd.invoice_date}` : ""}`;
}

/**
 * The price side, read from the contract rather than hardcoded, and REFUSED if
 * the contract ever says something other than the buying table: silently falling
 * back would put the selling price on a purchase order.
 */
function priceSide() {
  const declared = policies().line?.price_side ?? PRICE_SIDE;
  if (declared !== "buying") {
    throw refuse(
      `${CODE_PREFIX}PRICE_SIDE_UNSUPPORTED`,
      `contract khai line_policy.price_side=\"${declared}\" cho đơn mua nhưng skill chỉ hỗ trợ \"buying\" — không ghi đơn với giá sai bên`,
    );
  }
  return declared;
}

/**
 * Stage A — build the draft Purchase Order proposal for a resolved supplier.
 *
 * @param {object} skills { findItem, listUoms, listUomFactors, listItemPrices, findSupplier }
 * @param {object} resolved { supplier, ambiguous, candidates }
 * @param {object} opts { nlp, text?, price_list? }
 * @returns {Promise<object>} { proposal, lines, warnings, action_id }
 */
export async function buildPurchaseOrderProposal(skills, resolved, opts = {}) {
  const { supplier, ambiguous, candidates } = resolved;
  if (!supplier) {
    throw refuse(
      `${CODE_PREFIX}SUPPLIER_UNRESOLVED`,
      ambiguous
        ? `tên nhà cung cấp khớp nhiều kết quả (${(candidates ?? []).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ trước khi đặt mua`
        : "không xác định được nhà cung cấp — không tạo đơn mua",
    );
  }
  const side = priceSide();
  const { line: linePolicy, uom: uomPolicyBlock, docKey: docKeyPolicy } = policies();
  const text = opts.text ?? opts.nlp?.text ?? "";
  // R6 (measured on the real site 2026-09-24): the supplier's OWN name is not a
  // line. Without this, a supplier called "Đại lý Cám Bình Dương" made every
  // `Cám …` item match on the bare word `cám`, adding a phantom line.
  const supplierName = supplier.supplier_name ?? supplier.name;

  // 0. THE DOCUMENT IDENTITY (next3/B) — validated BEFORE any ERPNext read and
  //    BEFORE a proposal exists, because the failure this closes is not a slow
  //    one: a half-identity that got silently dropped would leave the user
  //    believing the duplicate guard was on, and they would only discover it
  //    when the same invoice produced a second draft. So a `source_document`
  //    that cannot produce a key is refused HERE, out loud, and the key travels
  //    in `params` (the proposal snapshot) — execute never re-derives it from a
  //    client payload.
  let sourceDocument = null;
  let docKey = null;
  if (opts.sourceDocument != null) {
    if (!docKeyPolicy?.field) {
      throw refuse(
        `${CODE_PREFIX}DOC_KEY_UNRESOLVED`,
        `contract không khai business_doc_key cho ${CAPABILITY_ID} — không nhận source_document, vì nhận mà không có chỗ lưu thì trùng vẫn xảy ra`,
      );
    }
    // The kind vocabulary comes from the contract's own list of document kinds
    // (one list, two readers), so a kind a channel was served can never be one
    // this path rejects. Whether this path CONSUMES the identity is the separate
    // question `business_doc_key` answers — and it does, right below.
    const verdict = validateSourceDocument(opts.sourceDocument, {
      allowedKinds: declaredDocumentKinds(),
    });
    if (!verdict.ok) {
      throw refuse(`${CODE_PREFIX}DOC_KEY_UNRESOLVED`, verdict.error, {
        source_code: verdict.code,
        source_reason: verdict.reason,
      });
    }
    sourceDocument = verdict.value;
    // The KIND in the key is the document this capability CREATES, read from the
    // contract — never the label the client sent. That is what makes an XML today
    // and a photo tomorrow produce the SAME key for the same invoice even if a
    // channel labels its own reading differently.
    const docKind = docKeyKind();
    if (!docKind) {
      throw refuse(
        `${CODE_PREFIX}DOC_KEY_UNRESOLVED`,
        `contract khai business_doc_key cho ${CAPABILITY_ID} nhưng thiếu document_kind hợp lệ — không dựng được khóa chống trùng`,
      );
    }
    const parts = businessDocKeyParts({
      kind: docKind,
      // MST is preferred (the invoice's own identity, survives a supplier record
      // being re-created). Then the party the DOCUMENT itself claims, and only
      // then the supplier the SENTENCE resolved: the key must follow the paper,
      // not the sentence — a channel that resolves a party but carries no MST is
      // still describing the document.
      partyTaxId: sourceDocument.seller_tax_id,
      partyId: sourceDocument.party_id ?? supplier.name,
      invoiceNo: sourceDocument.invoice_no,
      invoiceDate: sourceDocument.invoice_date,
    });
    if (!parts.key) {
      throw refuse(
        `${CODE_PREFIX}DOC_KEY_UNRESOLVED`,
        `không dựng được khóa chống trùng cho chứng từ (thiếu: ${parts.missing.join(", ")})`,
        { missing: parts.missing },
      );
    }
    docKey = parts.key;
  }

  // 1. Which items does the sentence NAME? Read once (READ, mock or real) — the
  //    same catalogue the sales path reads: an item is an item on both sides.
  let itemRows = [];
  try {
    itemRows = rowsOf(await skills.findItem(""));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được danh mục mặt hàng từ ERPNext: ${err?.message ?? err}`);
  }
  const { matched, scored } = matchItemsByText(itemRows, maskPartyMention(text, [supplierName]));
  const namedItems = selectNonOverlappingItems(scored ?? matched);
  if (namedItems.length === 0) {
    throw refuse(
      `${CODE_PREFIX}ITEM_UNRESOLVED`,
      `không xác định được mặt hàng nào trong "${text}" — nói rõ tên mặt hàng như trong ERPNext`,
    );
  }
  if (namedItems.length > Number(linePolicy.max_lines)) {
    throw refuse(
      `${CODE_PREFIX}LINE_LIMIT`,
      `câu nói khớp ${namedItems.length} mặt hàng, vượt giới hạn ${linePolicy.max_lines} dòng mỗi đơn mua — tách thành nhiều đơn`,
    );
  }

  // 2. Pair item ↔ quantity — one shared implementation, the PO_ code prefix.
  const { lines: paired, problems } = pairLines({
    matched: namedItems,
    quantities: opts.nlp?.quantities ?? [],
    codePrefix: CODE_PREFIX,
  });
  if (problems.length > 0) {
    throw refuse(problems[0].code, problems[0].reason, { problems });
  }

  // 3. Unit per line (B1) + the DECLARED buying price per line.
  const uomNames = rowsOf(await skills.listUoms());
  const factors = rowsOf(await skills.listUomFactors());
  let priceRows = [];
  try {
    priceRows = rowsOf(await skills.listItemPrices({ limit: 200, side }));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được bảng giá MUA (Item Price) từ ERPNext: ${err?.message ?? err}`);
  }

  const warnings = [];
  const lines = [];
  for (const { item, quantity } of paired) {
    const itemCode = item.item_code ?? item.name;
    const decision = resolveLineUom({
      text,
      uom: quantity.canonical_unit ?? quantity.unit ?? null,
      quantity: Number(quantity.value),
      item,
      erpUomNames: uomNames,
      factors,
      policy: uomPolicyBlock,
    });
    if (decision.action === UOM_ACTIONS.ASK) {
      throw refuse(
        `${CODE_PREFIX}UOM_UNRESOLVED`,
        decision.reason ?? "không xác định được đơn vị cho dòng hàng",
        { uom_code: decision.code, item: itemCode, candidates: decision.candidates ?? [] },
      );
    }
    const qty = Number(quantity.value);
    if (!(qty > 0)) {
      throw refuse(`${CODE_PREFIX}QTY_MISSING`, `số lượng của "${item.item_name ?? itemCode}" phải là số dương (đang ${quantity.value})`);
    }
    const price = priceForLine(priceRows, { itemCode, uom: decision.uom, priceList: opts.price_list ?? null });
    if (!price) {
      throw refuse(
        `${CODE_PREFIX}PRICE_MISSING`,
        `ERPNext chưa có giá MUA cho "${item.item_name ?? itemCode}" theo đơn vị ${decision.uom} — không tự đặt giá; khai giá mua (Standard Buying) trong ERPNext trước`,
      );
    }
    // A2 (measured 2026-09-24, real site): ERPNext refuses a Purchase Order line
    // for a STOCK item with no warehouse — "Dòng #1: Kho là bắt buộc đối với mặt
    // hàng tồn kho CAM-GA-25KG" (HTTP 417) — and this site declares no default
    // warehouse for its stock items. The warehouse therefore comes from ERPNext's
    // own `Item Default` (read, never guessed), and an item whose master does not
    // say REFUSES here instead of booking stock into a warehouse nobody chose.
    const warehouseHint = await skills.getItemWarehouseHints(itemCode, { company: opts.company ?? null });
    let warehouse = null;
    if (warehouseHint.is_stock_item) {
      if (!warehouseHint.warehouse) {
        throw refuse(
          `${CODE_PREFIX}WAREHOUSE_UNRESOLVED`,
          warehouseHint.ambiguous
            ? `"${item.item_name ?? itemCode}" là hàng tồn kho và ERPNext khai NHIỀU kho mặc định (${warehouseHint.options.join(", ")}) — cần chọn kho rõ ràng trước khi đặt mua (KHÔNG tự chọn kho)`
            : `"${item.item_name ?? itemCode}" là hàng tồn kho nhưng ERPNext CHƯA khai kho mặc định cho nó — khai "Default Warehouse" (Item Default) cho mặt hàng này trên ERPNext rồi thử lại (KHÔNG tự chọn kho)`,
          { item: itemCode, options: warehouseHint.options },
        );
      }
      warehouse = warehouseHint.warehouse;
    }
    lines.push({
      item_code: itemCode,
      item_name: item.item_name ?? itemCode,
      qty,
      uom: decision.uom,
      rate: price.rate,
      price_list: price.price_list,
      amount_vnd: Math.round(qty * price.rate),
      conversion_factor: decision.action === UOM_ACTIONS.CONVERT ? (decision.factor?.value ?? null) : null,
      stock_uom: decision.stock_uom ?? null,
      uom_display: decision.display ?? null,
      // Absent for a service item (ERPNext does not ask for one) — and only ever
      // the value ERPNext itself declared.
      warehouse,
    });
    if (decision.warning) warnings.push(decision.warning);
  }

  const total = lines.reduce((s, l) => s + l.amount_vnd, 0);
  const proposal = buildProposal({
    action: "create_purchase_order",
    risk: "HIGH",
    entity: { kind: "supplier", id: supplier.name, name: supplierName },
    params: {
      lines,
      line_count: lines.length,
      estimated_total_vnd: total,
      total_source: "qty_x_erpnext_buying_rate",
      price_side: side,
      // Draft-only is part of WHAT is approved: the card says NHÁP and nothing
      // here can submit. A purchase order commits money to a supplier, so the
      // submit decision stays a human's on ERPNext.
      submit_now: false,
      // next3/B: present ONLY when the request carried a document identity. A
      // typed sentence keeps the exact params shape it had before this phase.
      ...(docKey ? { business_doc_key: docKey } : {}),
      ...(sourceDocument ? { source_document: sourceDocument } : {}),
    },
    summary: `Tạo đơn MUA NHÁP: ${lines
      .map((l) => `${l.qty} ${l.uom} ${l.item_name}`)
      .join(" + ")} từ ${supplierName}${
      sourceDocument ? ` (nhập theo ${invoiceLabel(sourceDocument)})` : ""
    }`,
    extra: {
      ambiguous,
      warnings,
      action_id: newActionId(),
      schema_note: "params.lines là ĐỀ XUẤT — execute đọc lại mặt hàng + giá MUA từ ERPNext, lệch thì TỪ CHỐI",
    },
  });

  return { proposal, lines, warnings, action_id: proposal.action_id };
}

/* --------------------------------------------------------------- executor -- */

/**
 * Reconcile a command against ERPNext — READ ONLY. Same contract as the sales
 * paths: when the site cannot be filtered by the correlation field the caller is
 * TOLD so, instead of being told "nothing was written".
 */
export async function reconcilePurchaseOrder(mcp, reference, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const field = correlationField();
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "supplier", "grand_total", field],
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
 * next3/B — has this DOCUMENT identity already been written into a purchase order?
 *
 * READ ONLY, and deliberately NOT limited to drafts: a cancelled or submitted PO
 * holding the invoice is exactly what a human needs to be told about, and hiding
 * it would make the shop's own ERPNext disagree with a "safe to write" answer.
 *
 * The `field_unavailable` half is the load-bearing one: filtering by a column the
 * doctype does not have makes Frappe ERROR, and that error is the fact the caller
 * needs ("this site cannot store the key, so it cannot dedupe") — never folded
 * into "no rows found", which would read as a green light.
 *
 * @returns {Promise<{found:boolean, doc:object|null, field:string, field_unavailable:boolean}>}
 */
export async function probeBusinessDocKey(mcp, key) {
  assertReadOnly("erpnext_doc_list");
  const field = businessDocKeyField();
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "supplier", "transaction_date", field],
      filters: [[field, "=", key]],
      limit: 5,
    });
    const rows = rowsOf(res);
    return { found: rows.length > 0, doc: rows[0] ?? null, field, field_unavailable: false };
  } catch (err) {
    return { found: false, doc: null, field, field_unavailable: true, error: err?.message ?? String(err) };
  }
}

/** Read the written purchase order back and check it carries what we intended. */
export async function verifyWrittenPurchaseOrder(mcp, docName, { supplierId, lines, actionId, businessDocKey = null }) {
  const res = await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName });
  const doc = docOf(res);
  const problems = [];
  if (String(doc.supplier ?? "") !== String(supplierId)) problems.push(`supplier=${doc.supplier}`);
  if (Number(doc.docstatus) !== 0) problems.push(`docstatus=${doc.docstatus} (đơn mua phải là NHÁP)`);
  const field = correlationField();
  if (actionId && Object.prototype.hasOwnProperty.call(doc, field)) {
    if (String(doc[field] ?? "") !== String(actionId)) problems.push(`${field}=${doc[field]}`);
  }
  // next3/B: STRICTER than the correlation field above, on purpose. The executor
  // refuses to write without this column, so a document that reads back WITHOUT
  // the key means the value was dropped on the way in — and a dropped key is a
  // silent loss of the duplicate guard for every later send of this invoice.
  // Reported as `PO_WRITE_UNVERIFIED` (503, command stays reconcilable).
  if (businessDocKey) {
    const keyField = businessDocKeyField();
    const stored = Object.prototype.hasOwnProperty.call(doc, keyField) ? String(doc[keyField] ?? "") : null;
    if (stored !== String(businessDocKey)) {
      problems.push(`${keyField} không lưu đúng (đọc lại: ${stored ?? "(thiếu field)"})`);
    }
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
      if (normalizeUomToken(got.uom) !== normalizeUomToken(want.uom)) problems.push(`${want.item_code}: uom=${got.uom}`);
    }
  }
  if (problems.length) {
    throw refuse(
      `${CODE_PREFIX}WRITE_UNVERIFIED`,
      `đọc lại đơn mua ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc },
    );
  }
  return doc;
}

/**
 * The REAL Purchase Order payload (pure — unit-testable without network).
 *
 * A Purchase Order's party is a bare `supplier` link (unlike a Quotation's
 * `quotation_to`/`party_name` pair). `schedule_date` is sent on every line: it is
 * a mandatory Purchase Order Item field in standard ERPNext, and omitting it
 * would make the create fail on the real site. (Schema-derived, not measured —
 * the read-only probe cannot create a document; stated in B4-result §gap.)
 */
export function buildPurchaseOrderData({
  supplierId,
  lines,
  company,
  transactionDate,
  scheduleDate = null,
  actionId,
  correlation,
  businessDocKey = null,
  businessDocKeyField = null,
}) {
  const schedule = scheduleDate ?? transactionDate;
  return {
    doctype: WRITE_DOCTYPE,
    supplier: supplierId,
    company,
    transaction_date: transactionDate,
    [correlation]: actionId ?? null,
    // next3/B: sent ONLY when there is a key. A site that has not run the
    // migration must keep accepting ordinary typed purchase orders exactly as
    // before — and a document with no key cannot be deduped, which is the honest
    // state rather than a key invented to fill the column.
    ...(businessDocKey && businessDocKeyField ? { [businessDocKeyField]: businessDocKey } : {}),
    remarks: `ERPNext Voice Copilot · xác nhận bởi người dùng · tạo NHÁP, chưa submit`,
    items: lines.map((l) => ({
      item_code: l.item_code,
      qty: l.qty,
      uom: l.uom,
      rate: l.rate,
      schedule_date: schedule,
      ...(l.conversion_factor ? { conversion_factor: l.conversion_factor } : {}),
      // A2: measured mandatory for a stock item on the real site — the value
      // comes from `Item Default` in ERPNext (see the builder's refusal).
      ...(l.warehouse ? { warehouse: l.warehouse } : {}),
    })),
  };
}

/**
 * Stage B — execute a CONFIRMED purchase proposal. Called only from the Safety
 * Gateway AFTER the idempotency gate. Items, units, BUYING prices and the
 * company are re-read from live ERPNext; the proposal's numbers are compared,
 * never trusted.
 */
export async function executePurchaseOrderProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const supplierId = proposal.entity?.id;
  const wantLines = Array.isArray(proposal.params?.lines) ? proposal.params.lines : [];
  if (wantLines.length === 0) {
    throw refuse(`${CODE_PREFIX}ITEM_UNRESOLVED`, "đề xuất không có dòng hàng nào — không ghi đơn mua");
  }
  const { line: linePolicy } = policies();
  if (wantLines.length > Number(linePolicy.max_lines)) {
    throw refuse(`${CODE_PREFIX}LINE_LIMIT`, `đề xuất có ${wantLines.length} dòng, vượt giới hạn ${linePolicy.max_lines}`);
  }
  const side = priceSide();

  // 0. THE DOCUMENT IDENTITY (next3/B) — the invoice this draft would represent.
  //    Checked BEFORE the correlation probe because it names the DOCUMENT the
  //    user actually holds ("already entered as PO-…"), which is the more useful
  //    of the two refusals when both fire. Both probes run before anything is
  //    written and before `store.setReference`, so neither can leave an
  //    unverifiable half-state.
  //
  //    What they do NOT do (a claim this comment used to make, corrected in
  //    review 2026-09-25): they do not keep the command_id ALIVE. The gateway
  //    owns the command from `store.begin` (step 6) onward, and a refusal from
  //    here lands in its terminal branch — so the command is FAILED and the user
  //    must RE-ASK; retrying the same command_id after an operator fixes the
  //    site is not a supported recovery. That is the same shape as
  //    PROPOSAL_STALE (and as the correlation-field refusal), and the reason the
  //    refusal messages are written to be acted on by a human.
  const wantDocKey = proposal.params?.business_doc_key ?? null;
  const docKeyColumn = businessDocKeyField();
  if (wantDocKey) {
    // 0a. DERIVE, DON'T TRUST. A proposal is a snapshot the CLIENT hands back on
    //     /execute — that is the whole confirm flow — so a key the client could
    //     edit would be a value planted straight into the column that blocks the
    //     NEXT legitimate send of that invoice. One hash to recompute it from the
    //     document fields the proposal carries, and one comparison.
    //
    //     `sd` here is RAW proposal JSON, not a validated `source_document`: the
    //     /ask boundary validated what IT received, and this recomputation is
    //     what makes that irrelevant — the key is rebuilt from the document
    //     fields exactly as the builder rebuilt it, so a tampered body can only
    //     ever agree with itself or be refused. (Pinned by the test "the key is
    //     RE-DERIVED at execute…" and falsify case I.)
    const sd = proposal.params?.source_document ?? null;
    const kind = docKeyKind();
    const rebuiltDocKey =
      sd && kind
        ? businessDocKeyParts({
            kind,
            partyTaxId: sd.seller_tax_id ?? null,
            partyId: sd.party_id ?? proposal.entity?.id ?? null,
            invoiceNo: sd.invoice_no ?? null,
            invoiceDate: sd.invoice_date ?? null,
          }).key
        : null;
    if (!rebuiltDocKey || rebuiltDocKey !== wantDocKey) {
      throw refuse(
        `${CODE_PREFIX}DOC_KEY_UNRESOLVED`,
        "khóa chống trùng trong đề xuất không khớp với thông tin chứng từ đi kèm đề xuất — KHÔNG ghi; hỏi lại để dựng đề xuất mới",
        { source_code: "DOC_KEY_MISMATCH" },
      );
    }

    const keyProbe = await probeBusinessDocKey(mcp, wantDocKey);
    if (keyProbe.field_unavailable) {
      throw refuse(
        `${CODE_PREFIX}DOC_KEY_FIELD_MISSING`,
        // The underlying ERPNext error is APPENDED rather than dropped: a
        // transient read failure takes this same branch, and without the real
        // error an operator would be told to run a migration that is already
        // there. (No error-string matching decides anything here — the branch
        // stays fail-closed either way.)
        `ERPNext chưa có field "${docKeyColumn}" trên ${WRITE_DOCTYPE} — KHÔNG ghi, vì tờ hóa đơn này sẽ không được ghi dấu và gửi lại sẽ tạo đơn mua trùng (chạy migration thêm field cho ${WRITE_DOCTYPE} trước)${keyProbe.error ? ` [lỗi đọc: ${String(keyProbe.error).slice(0, 200)}]` : ""}`,
        { field: docKeyColumn },
      );
    }
    if (keyProbe.found) {
      throw refuse(
        `${CODE_PREFIX}DUPLICATE_DOC`,
        `${invoiceLabel(proposal.params?.source_document)} đã được nhập vào đơn mua ${keyProbe.doc?.name ?? "?"} trên ERPNext — KHÔNG ghi thêm đơn thứ hai (mở đơn cũ nếu cần sửa)`,
        // `existing_doc` is the ONE field the gateway forwards (it is what the
        // card needs to name the document) — anything else here would be dead.
        { existing_doc: keyProbe.doc?.name ?? null },
      );
    }
  }

  // 1. The correlation field is the ONLY once-only half a purchase order has.
  //    Refuse BEFORE registering anything when the site cannot store it.
  const field = correlationField();
  const probe = await reconcilePurchaseOrder(mcp, commandId, { actionId: proposal.action_id ?? null });
  if (probe.correlation_field_unavailable) {
    throw refuse(
      `${CODE_PREFIX}CORRELATION_FIELD_MISSING`,
      `ERPNext chưa có field "${field}" trên ${WRITE_DOCTYPE} — không có cách chống trùng phía server, KHÔNG ghi đơn mua (chạy migration thêm field cho ${WRITE_DOCTYPE} trước)`,
    );
  }
  // This proposal's action id ALREADY has a purchase order on the site — the
  // client bug that confirms the SAME proposal under a NEW command_id. Terminal.
  if (probe.found) {
    throw refuse(
      `${CODE_PREFIX}DUPLICATE_ACTION`,
      `đơn mua ${probe.doc?.name ?? "?"} đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước`,
      { existing_doc: probe.doc?.name ?? null },
    );
  }

  // 2. RE-READ items and BUYING prices; anything that moved is drift.
  let itemRows = [];
  let priceRows = [];
  try {
    itemRows = rowsOf(await mcp.callTool("erpnext_item_list", { limit: 100 }));
    priceRows = rowsOf(await mcp.callTool("erpnext_doc_list", {
      doctype: "Item Price",
      fields: ["name", "item_code", "price_list", "price_list_rate", "uom", "buying"],
      // String filter value — same measured rule as sales-order-write.mjs and
      // quotation-write.mjs, which carried it while this file did not: the pinned
      // ERPNext tool rejects a numeric `1` ("Property /filters/0/2 must be
      // string"), and the mock validates nothing, so the number only ever failed
      // against the REAL site. Measured 2026-09-24 by the A2 real loop: this call
      // turned every `/ask` for a purchase into a 500 before any card existed.
      filters: [[side, "=", "1"]],
      limit: 200,
    }));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc lại được mặt hàng/giá mua từ ERPNext: ${err?.message ?? err}`);
  }

  const drift = [];
  const lines = [];
  for (const want of wantLines) {
    const item = itemRows.find((i) => String(i.item_code ?? i.name) === String(want.item_code));
    if (!item) {
      drift.push(`mặt hàng ${want.item_code} không còn tồn tại`);
      continue;
    }
    if (normalizeUomToken(item.stock_uom) !== normalizeUomToken(want.stock_uom)) {
      drift.push(`${want.item_code}: đơn vị tồn kho đổi thành ${item.stock_uom} (đề xuất ${want.stock_uom})`);
      continue;
    }
    const price = priceForLine(priceRows, { itemCode: want.item_code, uom: want.uom, priceList: want.price_list ?? null });
    if (!price) {
      drift.push(`${want.item_code}: giá MUA cho đơn vị ${want.uom} không còn trong ERPNext`);
      continue;
    }
    if (Math.abs(price.rate - Number(want.rate)) > 1e-9) {
      drift.push(`${want.item_code}: giá mua đổi ${want.rate} → ${price.rate}`);
      continue;
    }
    const qty = Number(want.qty);
    if (!(qty > 0)) {
      throw refuse(`${CODE_PREFIX}QTY_MISSING`, `số lượng ${want.item_code} không hợp lệ (${want.qty}) — từ chối ghi`);
    }
    lines.push({ ...want, qty, rate: price.rate, item_name: item.item_name ?? want.item_name ?? want.item_code });
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
    noun: "đơn mua",
  });
  const transactionDate = new Date().toISOString().slice(0, 10);
  const actionId = proposal.action_id ?? null;

  // 3. Register the ERPNext-side reference BEFORE the write (crash safety).
  store.setReference(commandId, commandId);

  if (typeof mcp.callWriteTool !== "function") {
    throw refuse("EXECUTE_CLIENT_UNSUPPORTED", "this MCP client has no write method");
  }
  const data = buildPurchaseOrderData({
    supplierId,
    lines,
    company: resolvedCompany,
    transactionDate,
    actionId,
    correlation: field,
    businessDocKey: wantDocKey,
    businessDocKeyField: docKeyColumn,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });
  const doc = docOf(res);
  const docName = doc?.name ?? null;
  if (!docName) {
    throw refuse(`${CODE_PREFIX}WRITE_UNVERIFIED`, "ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile");
  }

  // 4. VERIFY by reading the document back — the write response is not evidence.
  const verified = await verifyWrittenPurchaseOrder(mcp, docName, {
    supplierId,
    lines,
    actionId,
    businessDocKey: wantDocKey,
  });

  const estimated = lines.reduce((s, l) => s + Math.round(l.qty * l.rate), 0);
  const result = {
    erpnext_doc: docName,
    supplier: supplierId,
    lines: lines.map((l) => ({ item_code: l.item_code, item_name: l.item_name, qty: l.qty, uom: l.uom, rate: l.rate })),
    line_count: lines.length,
    estimated_total_vnd: estimated,
    erpnext_total_vnd: Number.isFinite(Number(verified.grand_total)) ? Math.round(Number(verified.grand_total)) : null,
    action_id: actionId,
    docstatus: Number(verified.docstatus ?? 0),
    company: resolvedCompany,
    price_side: side,
    // next3/B: the identity that now guards this invoice against a second send —
    // the proof the column really holds it (the strategy above reads it back).
    ...(wantDocKey ? { business_doc_key: wantDocKey } : {}),
    note: "đơn MUA tạo ở trạng thái NHÁP (docstatus 0) — đây là cam kết mua chưa chốt; submit là bước riêng trên ERPNext, không tự động",
  };
  if (result.erpnext_total_vnd !== null && result.erpnext_total_vnd !== estimated) {
    result.total_note = `ERPNext tính ${result.erpnext_total_vnd}đ (có thuế/chiết khấu) — số tạm tính chỉ để hiển thị trước khi ghi`;
  }
  result.reference_no = commandId;
  store.complete(commandId, result);
  return result;
}
