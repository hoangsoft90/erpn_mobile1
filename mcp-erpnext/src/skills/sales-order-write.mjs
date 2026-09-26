/**
 * Skill: sales_order WRITE (B2, plan3_review3 — Reference WRITE #2).
 *
 * Same two-phase shape as payment-write (PC): buildSalesOrderProposal() STOPS at
 * the proposal; executeSalesOrderProposal() runs ONLY behind the Safety
 * Gateway's confirm + idempotency gates, and ONLY produces a DRAFT. Submitting
 * an order is not reachable from this capability at all: the contract declares
 * `execution.allow_submit: false` and the MCP client's write gate honours it.
 *
 * Why an order needs its own safety rules (it is not "a payment with lines"):
 *
 *  - WHAT THE UTTERANCE MAY DECIDE: which item, how many, which unit. NOTHING
 *    else. The PRICE comes from ERPNext (Item Price) at build time and is
 *    re-read at execute time — a price that moved is drift, and drift is a
 *    refusal, never a silent re-price.
 *  - Quantities are never invented and never summed. Pairing an item with its
 *    quantity uses the character offsets the Python normalizer already returns
 *    (Vietnamese puts the number first: "10 bao cám heo"), and anything that
 *    cannot be attributed ASKS. "2 bao và 3 bao cám heo" is a question, not 5.
 *  - Unit conversion is B1's resolver: direct factors only, always displayed,
 *    and the factor is written ONTO the line (`conversion_factor`) so a
 *    converted quantity can never look like a plain one.
 *  - The line total is arithmetic this file does for DISPLAY; the verified
 *    number is what ERPNext computed and we read back (`grand_total`), reported
 *    next to our estimate instead of replacing the evidence.
 */

import { randomUUID } from "node:crypto";

import { assertReadOnly } from "../readonly-guard.mjs";
import { buildProposal } from "../action-proposal.mjs";
import { getCapability, __contract } from "../capability-contract.mjs";
import { classifyDriftCode } from "../proposal-freshness.mjs";
import {
  normalizeUomToken,
  resolveLineUom,
  uomPolicy,
  UOM_ACTIONS,
} from "../uom.mjs";
// C2: the two PURE steps below (item matching, quantity pairing) also feed the
// camera slot form (src/ocr), which is barred from importing skills/ — so their
// single home is ../line-parse.mjs and the original definitions here were moved
// there; the exported names below are kept for every existing caller.
import { orderItemsInText as _orderItems, pairLinesPure as _pairLines } from "../line-parse.mjs";
const selectNonOverlappingItems = _orderItems;
const pairLines = _pairLines;
export { selectNonOverlappingItems, pairLines };

/** The ONE doctype this skill may create (fail-closed everywhere else). */
export const WRITE_DOCTYPE = "Sales Order";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "sales_order.create";

/**
 * P0 §10.4 — ERPNext-side correlation field, read from the contract (single
 * source of truth), NOT hardcoded here. It is the ONLY server-side half of the
 * once-only guarantee for a Sales Order (a Payment Entry additionally has
 * `reference_no`), which is why the executor REFUSES to write when the site
 * cannot store it.
 */
export function correlationField() {
  return getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
}

/** `act_<uuid>` — a unique id for one logical action. */
export function newActionId() {
  return `act_${randomUUID()}`;
}

/** Contract policy blocks, read once per call (a missing block is a hard bug). */
function policies() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("SO_CONTRACT_MISSING: sales_order.create is not in the capability contract");
  return { cap, line: cap.line_policy, uom: uomPolicy(__contract) };
}

/**
 * A refusal with an HTTP-mappable code. EXPORTED since B3: the quotation path
 * builds refusals the same way, and a second local copy is where the two would
 * drift apart on the `code`/extra convention the gateway reads.
 */
export function refuse(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * Unwrap a tool result. Same trap the payment skill documents: the client wraps
 * every result as {__untrusted, source, data: <handler payload>} and the
 * handler payload nests again (`{data: rows}`), so missing the second layer
 * reads undefined and silently answers "no rows".
 */
export function rowsOf(res) {
  const p = res?.data ?? res;
  const rows = p?.data ?? p;
  return Array.isArray(rows) ? rows : [];
}
export function docOf(res) {
  const p = res?.data ?? res;
  return p?.data ?? p ?? {};
}

/* ------------------------------------------------------------------ lines -- */


/**
 * The declared selling price for (item, uom) — NEVER from the utterance.
 * @param {object[]} priceRows Item Price rows
 * @param {{itemCode:string, uom:string, priceList?:string|null}} target
 * @returns {{rate:number, uom:string, price_list:string}|null}
 */
export function priceForLine(priceRows, { itemCode, uom, priceList = null }) {
  const sameItem = (priceRows ?? []).filter((r) => String(r.item_code ?? "") === String(itemCode ?? ""));
  const sameUom = sameItem.filter((r) => normalizeUomToken(r.uom ?? "") === normalizeUomToken(uom));
  const pool = sameUom.length ? sameUom : sameItem.filter((r) => !String(r.uom ?? "").trim());
  const chosen =
    (priceList ? pool.find((r) => String(r.price_list ?? "") === String(priceList)) : null) ?? pool[0] ?? null;
  if (!chosen) return null;
  const rate = Number(chosen.price_list_rate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return { rate, uom: chosen.uom ?? uom, price_list: chosen.price_list ?? null };
}

/**
 * Stage A — build the draft Sales Order proposal for a resolved customer.
 *
 * @param {object} skills  { findItem, listUoms, listUomFactors, listItemPrices }
 * @param {object} resolved { customer, ambiguous, candidates }
 * @param {object} opts
 * @param {object} opts.nlp      Python normalizer output (quantities carry offsets)
 * @param {string} [opts.text]   normalized utterance
 * @param {string} [opts.price_list]  the shop's selling price list, if the client knows it
 * @returns {Promise<object>} { proposal, lines, warnings, action_id }
 */
export async function buildSalesOrderProposal(skills, resolved, opts = {}) {
  const { customer, ambiguous, candidates } = resolved;
  if (!customer) {
    throw refuse(
      "SO_CUSTOMER_UNRESOLVED",
      ambiguous
        ? `tên khách khớp nhiều kết quả (${(candidates ?? []).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ trước khi tạo đơn`
        : "không xác định được khách hàng — không tạo đơn",
    );
  }
  const { line: linePolicy, uom: uomPolicyBlock } = policies();
  const text = opts.text ?? opts.nlp?.text ?? "";
  // R6: the customer's OWN name is not a line (see maskPartyMention).
  const customerName = customer.customer_name ?? customer.name;

  // 1. Which items does the sentence NAME? Read once (READ, mock or real).
  let itemRows = [];
  try {
    itemRows = rowsOf(await skills.findItem(""));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được danh mục mặt hàng từ ERPNext: ${err?.message ?? err}`);
  }
  // An order is about EVERY item the sentence names (a READ question is about
  // one), so the non-overlapping selection is used instead of the best-only set.
  const namedItems = selectNonOverlappingItems(itemRows, text, { partyNames: [customerName] });
  if (namedItems.length === 0) {
    throw refuse(
      "SO_ITEM_UNRESOLVED",
      `không xác định được mặt hàng nào trong "${text}" — nói rõ tên mặt hàng như trong ERPNext`,
    );
  }
  if (namedItems.length > Number(linePolicy.max_lines)) {
    throw refuse(
      "SO_LINE_LIMIT",
      `câu nói khớp ${namedItems.length} mặt hàng, vượt giới hạn ${linePolicy.max_lines} dòng mỗi đơn — tách thành nhiều đơn`,
    );
  }

  // 2. Pair item ↔ quantity. A problem here is an ANSWER, not a write.
  const { lines: paired, problems } = pairLines({ matched: namedItems, quantities: opts.nlp?.quantities ?? [] });
  if (problems.length > 0) {
    throw refuse(problems[0].code, problems[0].reason, { problems });
  }

  // 3. Resolve the unit per line (B1) and read the DECLARED price per line.
  const namedUnit = namedItems.length > 0;
  const uomNames = namedUnit ? rowsOf(await skills.listUoms()) : [];
  const factors = namedUnit ? rowsOf(await skills.listUomFactors()) : [];
  let priceRows = [];
  try {
    priceRows = rowsOf(await skills.listItemPrices({ limit: 200 }));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được bảng giá (Item Price) từ ERPNext: ${err?.message ?? err}`);
  }

  const warnings = [];
  const lines = [];
  for (const { item, quantity } of paired) {
    const itemCode = item.item_code ?? item.name;
    const decision = resolveLineUom({
      text,
      uom: quantity.canonical_unit ?? quantity.unit ?? null,
      // The quantity is what the user SAID (in the unit they said). The line's
      // qty is not converted here — a conversion writes the factor onto the
      // line instead, so ERPNext and the card show the same two numbers.
      quantity: Number(quantity.value),
      item,
      erpUomNames: uomNames,
      factors,
      policy: uomPolicyBlock,
    });
    if (decision.action === UOM_ACTIONS.ASK) {
      throw refuse(
        "SO_UOM_UNRESOLVED",
        decision.reason ?? "không xác định được đơn vị cho dòng hàng",
        { uom_code: decision.code, item: itemCode, candidates: decision.candidates ?? [] },
      );
    }
    const qty = Number(quantity.value);
    if (!(qty > 0)) {
      throw refuse("SO_QTY_MISSING", `số lượng của "${item.item_name ?? itemCode}" phải là số dương (đang ${quantity.value})`);
    }
    const price = priceForLine(priceRows, { itemCode, uom: decision.uom, priceList: opts.price_list ?? null });
    if (!price) {
      throw refuse(
        "SO_PRICE_MISSING",
        `ERPNext chưa có giá bán cho "${item.item_name ?? itemCode}" theo đơn vị ${decision.uom} — không tự đặt giá, hãy khai giá trong ERPNext`,
      );
    }
    const amount = Math.round(qty * price.rate);
    lines.push({
      item_code: itemCode,
      item_name: item.item_name ?? itemCode,
      qty,
      uom: decision.uom,
      rate: price.rate,
      price_list: price.price_list,
      amount_vnd: amount,
      // A conversion always carries its factor AND its display line (B1): the
      // number a customer is billed in is never a hidden multiple.
      conversion_factor: decision.action === UOM_ACTIONS.CONVERT ? (decision.factor?.value ?? null) : null,
      stock_uom: decision.stock_uom ?? null,
      uom_display: decision.display ?? null,
    });
    if (decision.warning) warnings.push(decision.warning);
  }

  const total = lines.reduce((s, l) => s + l.amount_vnd, 0);
  const proposal = buildProposal({
    action: "create_sales_order",
    risk: "HIGH",
    entity: { kind: "customer", id: customer.name, name: customer.customer_name },
    params: {
      lines,
      line_count: lines.length,
      // TẠM TÍNH, và nói rõ như vậy: đây là số do server nhân ra để hiển thị,
      // số thật là `grand_total` ERPNext trả về lúc verify (thuế/chiết khấu do
      // ERPNext quyết định, không do file này).
      estimated_total_vnd: total,
      total_source: "qty_x_erpnext_rate",
      // Draft is part of WHAT is being approved, exactly like payment's
      // submit_now: the card says "tạo đơn NHÁP" and the executor cannot do
      // anything else.
      submit_now: false,
    },
    summary: `Tạo đơn NHÁP: ${lines
      .map((l) => `${l.qty} ${l.uom} ${l.item_name}`)
      .join(" + ")} cho ${customer.customer_name}`,
    extra: {
      ambiguous,
      warnings,
      action_id: newActionId(),
      schema_note: "params.lines là ĐỀ XUẤT — execute đọc lại mặt hàng + giá từ ERPNext, lệch thì TỪ CHỐI",
    },
  });

  return { proposal, lines, warnings, action_id: proposal.action_id };
}

/* --------------------------------------------------------------- executor -- */

/**
 * Reconcile a command against ERPNext — READ ONLY.
 *
 * A Sales Order has no natural ERPNext reference field to search, so the
 * correlation field IS the lookup key (see correlationField()). When the site
 * cannot filter by it, the caller is TOLD (`correlation_field_unavailable`)
 * rather than being told "nothing was written".
 */
export async function reconcileSalesOrder(mcp, reference, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const field = correlationField();
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "customer", "grand_total", field],
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

/** Read the written order back and check it carries what we intended. */
export async function verifyWrittenSalesOrder(mcp, docName, { commandId, lines, customerId, actionId }) {
  const res = await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName });
  const doc = docOf(res);
  const problems = [];
  if (String(doc.customer ?? "") !== String(customerId)) problems.push(`customer=${doc.customer}`);
  if (Number(doc.docstatus) !== 0) problems.push(`docstatus=${doc.docstatus} (đơn phải là NHÁP)`);
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
      if (normalizeUomToken(got.uom) !== normalizeUomToken(want.uom)) problems.push(`${want.item_code}: uom=${got.uom}`);
    }
  }
  if (problems.length) {
    throw refuse(
      "SO_WRITE_UNVERIFIED",
      `đọc lại đơn ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc },
    );
  }
  return doc;
}

/**
 * Resolve the company the order belongs to.
 *
 * Read from ERPNext (a real site has one or a few); an authorization-resolved
 * company wins, because that is the tenant the account is scoped to. Several
 * companies with nothing pinned is a REFUSAL — writing an order into a guessed
 * company is exactly the cross-tenant mistake P8 exists to prevent.
 */
export async function resolveSalesCompany(mcp, { authzCompany = null, code = "SO_COMPANY_UNRESOLVED", noun = "đơn" } = {}) {
  assertReadOnly("erpnext_doc_list");
  let names = [];
  try {
    const res = await mcp.callTool("erpnext_doc_list", { doctype: "Company", fields: ["name"], limit: 20 });
    names = rowsOf(res).map((c) => String(c.name ?? "")).filter(Boolean);
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được danh sách Company từ ERPNext: ${err?.message ?? err}`);
  }
  if (authzCompany) {
    // The company is already authorized — trust the authz layer, but say so if
    // ERPNext does not know it (a typo would otherwise fail as a raw link error).
    if (names.length > 0 && !names.includes(authzCompany)) {
      throw refuse(code, `company "${authzCompany}" không có trong ERPNext (đang có: ${names.join(", ")})`);
    }
    return authzCompany;
  }
  if (names.length === 1) return names[0];
  throw refuse(
    code,
    names.length === 0
      ? `ERPNext không trả về Company nào — không dựng được ${noun}`
      : `có ${names.length} company (${names.slice(0, 5).join(", ")}) và chưa pin company — đặt COPILOT_COMPANY trước khi tạo ${noun}`,
  );
}

/**
 * The REAL Sales Order payload (pure — unit-testable without network).
 *
 * Field names are ERPNext's (`items[]` child rows with item_code/qty/uom/rate);
 * `conversion_factor` is sent ONLY for a converted line, so the factor a user
 * saw is the factor ERPNext stores.
 */
export function buildSalesOrderData({
  customerId,
  lines,
  company,
  transactionDate,
  deliveryDate = null,
  actionId,
  correlation,
}) {
  return {
    doctype: WRITE_DOCTYPE,
    customer: customerId,
    company,
    transaction_date: transactionDate,
    ...(deliveryDate ? { delivery_date: deliveryDate } : {}),
    // P0 §10.4 — the correlation value; a site without the Custom Field simply
    // drops the key (ERPNext ignores unknown fields on create), which is why the
    // executor checks the field exists BEFORE writing.
    [correlation]: actionId ?? null,
    remarks: `ERPNext Voice Copilot · xác nhận bởi người dùng · tạo NHÁP, chưa submit`,
    items: lines.map((l) => ({
      item_code: l.item_code,
      qty: l.qty,
      uom: l.uom,
      rate: l.rate,
      ...(l.conversion_factor ? { conversion_factor: l.conversion_factor } : {}),
    })),
  };
}

/**
 * Stage B — execute a CONFIRMED order proposal. Called only from the Safety
 * Gateway AFTER the idempotency gate. Prices, units and the company are re-read
 * from live ERPNext; the proposal's numbers are compared, never trusted.
 *
 * @param {object} mcp MCP client (mock or real)
 * @param {object} proposal erpn.proposal/v1 with action=create_sales_order
 * @param {string} commandId client UUID (idempotency key)
 * @param {object} store IdempotencyStore (already gated this command)
 * @returns {Promise<object>} { erpnext_doc, lines, estimated_total_vnd, erpnext_total_vnd, customer }
 */
export async function executeSalesOrderProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const customerId = proposal.entity?.id;
  const wantLines = Array.isArray(proposal.params?.lines) ? proposal.params.lines : [];
  if (wantLines.length === 0) {
    throw refuse("SO_ITEM_UNRESOLVED", "đề xuất không có dòng hàng nào — không ghi đơn");
  }
  const { line: linePolicy } = policies();
  if (wantLines.length > Number(linePolicy.max_lines)) {
    throw refuse("SO_LINE_LIMIT", `đề xuất có ${wantLines.length} dòng, vượt giới hạn ${linePolicy.max_lines}`);
  }

  // 1. The correlation field is the ONLY once-only half an order has. Refuse
  //    BEFORE registering anything when the site cannot store it.
  const field = correlationField();
  const probe = await reconcileSalesOrder(mcp, commandId, { actionId: proposal.action_id ?? null });
  if (probe.correlation_field_unavailable) {
    throw refuse(
      "SO_CORRELATION_FIELD_MISSING",
      `ERPNext chưa có field "${field}" trên ${WRITE_DOCTYPE} — không có cách chống trùng phía server, KHÔNG ghi đơn (chạy migration thêm field cho ${WRITE_DOCTYPE} trước)`,
    );
  }
  // This proposal's action id ALREADY has an order on the site. The gateway's
  // command_id replay covers "same card pressed twice"; this covers the client
  // bug that confirms the SAME proposal under a NEW command_id — the exact
  // second-order this phase exists to prevent. Terminal: a retry cannot help.
  if (probe.found) {
    throw refuse(
      "SO_DUPLICATE_ACTION",
      `đơn ${probe.doc?.name ?? "?"} đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước`,
      { existing_doc: probe.doc?.name ?? null },
    );
  }

  // 2. RE-READ items and prices; anything that moved is drift, not a detail.
  let itemRows = [];
  let priceRows = [];
  try {
    itemRows = rowsOf(await mcp.callTool("erpnext_item_list", { limit: 100 }));
    priceRows = rowsOf(await mcp.callTool("erpnext_doc_list", {
      doctype: "Item Price",
      fields: ["name", "item_code", "price_list", "price_list_rate", "uom", "selling"],
      // String filter value: the pinned ERPNext tool rejects a numeric `1` with
      // "Property /filters/0/2 must be string" — measured on the real site
      // 2026-09-21 (P4-1). The mock does not validate it, so a numeric value here
      // would pass every test and kill the Item Price read only on the site.
      filters: [["selling", "=", "1"]],
      limit: 200,
    }));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc lại được mặt hàng/giá từ ERPNext: ${err?.message ?? err}`);
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
    const price = priceForLine(priceRows, {
      itemCode: want.item_code,
      uom: want.uom,
      priceList: want.price_list ?? null,
    });
    if (!price) {
      drift.push(`${want.item_code}: giá bán cho đơn vị ${want.uom} không còn trong ERPNext`);
      continue;
    }
    if (Math.abs(price.rate - Number(want.rate)) > 1e-9) {
      drift.push(`${want.item_code}: giá đổi ${want.rate} → ${price.rate}`);
      continue;
    }
    const qty = Number(want.qty);
    if (!(qty > 0)) {
      throw refuse("SO_QTY_MISSING", `số lượng ${want.item_code} không hợp lệ (${want.qty}) — từ chối ghi`);
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

  const resolvedCompany = await resolveSalesCompany(mcp, { authzCompany: company ?? proposal.params?.company ?? null });
  const transactionDate = new Date().toISOString().slice(0, 10);
  const actionId = proposal.action_id ?? null;

  // 3. Register the ERPNext-side reference BEFORE the write (crash safety): if
  //    we die mid-call, the reconcile looks the order up by correlation value.
  store.setReference(commandId, commandId);

  if (typeof mcp.callWriteTool !== "function") {
    throw refuse("EXECUTE_CLIENT_UNSUPPORTED", "this MCP client has no write method");
  }
  const data = buildSalesOrderData({
    customerId,
    lines,
    company: resolvedCompany,
    transactionDate,
    actionId,
    correlation: field,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });
  const doc = docOf(res);
  const docName = doc?.name ?? null;
  if (!docName) {
    throw refuse("SO_WRITE_UNVERIFIED", "ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile");
  }

  // 4. VERIFY by reading the document back — the write response is not evidence.
  const verified = await verifyWrittenSalesOrder(mcp, docName, {
    commandId,
    lines,
    customerId,
    actionId,
  });

  const estimated = lines.reduce((s, l) => s + Math.round(l.qty * l.rate), 0);
  const result = {
    erpnext_doc: docName,
    customer: customerId,
    lines: lines.map((l) => ({ item_code: l.item_code, item_name: l.item_name, qty: l.qty, uom: l.uom, rate: l.rate })),
    line_count: lines.length,
    // Display arithmetic vs. ERPNext's own number, side by side. They can differ
    // (taxes/discounts are ERPNext's business) — the ERPNext value is the truth,
    // so it is reported and the difference is named, never hidden.
    estimated_total_vnd: estimated,
    erpnext_total_vnd: Number.isFinite(Number(verified.grand_total)) ? Math.round(Number(verified.grand_total)) : null,
    action_id: actionId,
    docstatus: Number(verified.docstatus ?? 0),
    company: resolvedCompany,
    note: "đơn tạo ở trạng thái NHÁP (docstatus 0) — submit là bước riêng trên ERPNext, không tự động",
  };
  if (result.erpnext_total_vnd !== null && result.erpnext_total_vnd !== estimated) {
    result.total_note = `ERPNext tính ${result.erpnext_total_vnd}đ (có thuế/chiết khấu) — số tạm tính chỉ để hiển thị trước khi ghi`;
  }
  if (doc && !Object.prototype.hasOwnProperty.call(verified, field)) {
    result.correlation_field_missing = field;
  }
  result.reference_no = commandId;
  store.complete(commandId, result);
  return result;
}
