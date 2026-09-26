/**
 * Skill: quotation WRITE (B3, plan3_review3 — pattern B2 rút gọn).
 *
 * Same two-phase shape and the SAME guarantees as sales-order-write (B2): the
 * builder STOPS at the proposal, the executor runs only behind the Safety
 * Gateway's confirm + idempotency gates, and it produces a DRAFT only
 * (`execution.allow_submit: false`, honoured by the MCP client's write gate).
 *
 * What is REUSED instead of copied (a second copy is where the two paths drift):
 * pairing a quantity to its item, the declared-price lookup, company resolution,
 * the tool-result unwrapping, and the refusal convention. This file owns only
 * what is genuinely different about a quotation:
 *
 *  - the doctype and its party shape — a Quotation is `quotation_to` ("Customer")
 *    + `party_name`, not a bare `customer`;
 *  - the `QT_` code prefix, because the taxonomy is per-capability (every code a
 *    contract entry declares must be emittable by ITS OWN path);
 *  - the wording: a quotation is a non-binding OFFER. The card and the answer say
 *    "báo giá" and the drafter never claims a sale happened.
 *
 * The price rule is IDENTICAL to the order path and deliberately not relaxed for
 * "it is only an offer": the rate comes from ERPNext (Item Price), is re-read at
 * execute time, and a moved rate is a refusal (PROPOSAL_STALE) — never a silent
 * re-price, and never a price taken from the utterance.
 */

import { assertReadOnly } from "../readonly-guard.mjs";
import { buildProposal } from "../action-proposal.mjs";
import { getCapability, __contract } from "../capability-contract.mjs";
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
export const WRITE_DOCTYPE = "Quotation";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "quotation.create";

/** The code prefix for every refusal this path can emit (contract taxonomy). */
const CODE_PREFIX = "QT_";

/**
 * The ERPNext-side correlation field, read from the contract (single source of
 * truth) — the same Custom Field the order path uses, so ONE migration covers
 * both doctypes. Without it a quotation cannot be deduped server-side, and the
 * executor refuses to write rather than write twice.
 */
export function correlationField() {
  return getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
}

/** Contract policy blocks, read once per call (a missing block is a hard bug). */
function policies() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("QT_CONTRACT_MISSING: quotation.create is not in the capability contract");
  return { cap, line: cap.line_policy, uom: uomPolicy(__contract) };
}

/**
 * Stage A — build the draft Quotation proposal for a resolved customer.
 *
 * @param {object} skills { findItem, listUoms, listUomFactors, listItemPrices }
 * @param {object} resolved { customer, ambiguous, candidates }
 * @param {object} opts { nlp, text?, price_list? }
 * @returns {Promise<object>} { proposal, lines, warnings, action_id }
 */
export async function buildQuotationProposal(skills, resolved, opts = {}) {
  const { customer, ambiguous, candidates } = resolved;
  if (!customer) {
    throw refuse(
      `${CODE_PREFIX}CUSTOMER_UNRESOLVED`,
      ambiguous
        ? `tên khách khớp nhiều kết quả (${(candidates ?? []).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ trước khi báo giá`
        : "không xác định được khách hàng — không tạo báo giá",
    );
  }
  const { line: linePolicy, uom: uomPolicyBlock } = policies();
  const text = opts.text ?? opts.nlp?.text ?? "";
  // R6: the customer's OWN name is not a line (see maskPartyMention).
  const customerName = customer.customer_name ?? customer.name;

  // 1. Which items does the sentence NAME? (same rule as the order path: every
  //    named item is a line; a READ question is about one, a document is not.)
  let itemRows = [];
  try {
    itemRows = rowsOf(await skills.findItem(""));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được danh mục mặt hàng từ ERPNext: ${err?.message ?? err}`);
  }
  const { matched, scored } = matchItemsByText(itemRows, maskPartyMention(text, [customerName]));
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
      `câu nói khớp ${namedItems.length} mặt hàng, vượt giới hạn ${linePolicy.max_lines} dòng mỗi báo giá — tách thành nhiều báo giá`,
    );
  }

  // 2. Pair item ↔ quantity — one shared implementation, the QT_ code prefix.
  const { lines: paired, problems } = pairLines({
    matched: namedItems,
    quantities: opts.nlp?.quantities ?? [],
    codePrefix: CODE_PREFIX,
  });
  if (problems.length > 0) {
    throw refuse(problems[0].code, problems[0].reason, { problems });
  }

  // 3. Unit per line (B1) + the DECLARED price per line (never the utterance).
  const uomNames = rowsOf(await skills.listUoms());
  const factors = rowsOf(await skills.listUomFactors());
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
        `ERPNext chưa có giá bán cho "${item.item_name ?? itemCode}" theo đơn vị ${decision.uom} — không tự đặt giá trong báo giá`,
      );
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
    });
    if (decision.warning) warnings.push(decision.warning);
  }

  const total = lines.reduce((s, l) => s + l.amount_vnd, 0);
  const proposal = buildProposal({
    action: "create_quotation",
    risk: "HIGH",
    entity: { kind: "customer", id: customer.name, name: customer.customer_name },
    params: {
      lines,
      line_count: lines.length,
      estimated_total_vnd: total,
      total_source: "qty_x_erpnext_rate",
      // Draft-only is part of WHAT is approved, exactly like the order card: a
      // quotation is an offer, so the card says NHÁP and nothing here can submit.
      submit_now: false,
      offer: true,
    },
    summary: `Tạo báo giá NHÁP: ${lines
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
 * Reconcile a command against ERPNext — READ ONLY (same contract as the order
 * path: when the site cannot be filtered by the correlation field the caller is
 * TOLD so, instead of being told "nothing was written").
 */
export async function reconcileQuotation(mcp, reference, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const field = correlationField();
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "party_name", "grand_total", field],
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

/** Read the written quotation back and check it carries what we intended. */
export async function verifyWrittenQuotation(mcp, docName, { customerId, lines, actionId }) {
  const res = await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName });
  const doc = docOf(res);
  const problems = [];
  if (String(doc.party_name ?? "") !== String(customerId)) problems.push(`party_name=${doc.party_name}`);
  if (Number(doc.docstatus) !== 0) problems.push(`docstatus=${doc.docstatus} (báo giá phải là NHÁP)`);
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
      `${CODE_PREFIX}WRITE_UNVERIFIED`,
      `đọc lại báo giá ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc },
    );
  }
  return doc;
}

/**
 * The REAL Quotation payload (pure — unit-testable without network).
 *
 * A Quotation's party is `quotation_to` + `party_name`: `party_name` holds the
 * LINK VALUE (the customer id) and `quotation_to` names the link's doctype —
 * sending `customer` on this doctype would create a document with no party.
 */
export function buildQuotationData({ customerId, lines, company, transactionDate, validTill = null, actionId, correlation }) {
  return {
    doctype: WRITE_DOCTYPE,
    quotation_to: "Customer",
    party_name: customerId,
    company,
    transaction_date: transactionDate,
    ...(validTill ? { valid_till: validTill } : {}),
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
 * Stage B — execute a CONFIRMED quotation proposal. Called only from the Safety
 * Gateway AFTER the idempotency gate. Items, units, prices and the company are
 * re-read from live ERPNext; the proposal's numbers are compared, never trusted.
 */
export async function executeQuotationProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const customerId = proposal.entity?.id;
  const wantLines = Array.isArray(proposal.params?.lines) ? proposal.params.lines : [];
  if (wantLines.length === 0) {
    throw refuse(`${CODE_PREFIX}ITEM_UNRESOLVED`, "đề xuất không có dòng hàng nào — không ghi báo giá");
  }
  const { line: linePolicy } = policies();
  if (wantLines.length > Number(linePolicy.max_lines)) {
    throw refuse(`${CODE_PREFIX}LINE_LIMIT`, `đề xuất có ${wantLines.length} dòng, vượt giới hạn ${linePolicy.max_lines}`);
  }

  // 1. The correlation field is the ONLY once-only half a quotation has. Refuse
  //    BEFORE registering anything when the site cannot store it.
  const field = correlationField();
  const probe = await reconcileQuotation(mcp, commandId, { actionId: proposal.action_id ?? null });
  if (probe.correlation_field_unavailable) {
    throw refuse(
      `${CODE_PREFIX}CORRELATION_FIELD_MISSING`,
      `ERPNext chưa có field "${field}" trên ${WRITE_DOCTYPE} — không có cách chống trùng phía server, KHÔNG ghi báo giá (chạy migration thêm field cho ${WRITE_DOCTYPE} trước)`,
    );
  }
  // This proposal's action id ALREADY has a quotation on the site — the client
  // bug that confirms the SAME proposal under a NEW command_id. Terminal.
  if (probe.found) {
    throw refuse(
      `${CODE_PREFIX}DUPLICATE_ACTION`,
      `báo giá ${probe.doc?.name ?? "?"} đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước`,
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
      // String filter value — same measured rule as sales-order-write.mjs: the
      // pinned ERPNext tool rejects a numeric `1` ("Property /filters/0/2 must be
      // string"); the mock validates nothing, so a number here would only fail
      // against the real site.
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
    const price = priceForLine(priceRows, { itemCode: want.item_code, uom: want.uom, priceList: want.price_list ?? null });
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
    noun: "báo giá",
  });
  const transactionDate = new Date().toISOString().slice(0, 10);
  const actionId = proposal.action_id ?? null;

  // 3. Register the ERPNext-side reference BEFORE the write (crash safety).
  store.setReference(commandId, commandId);

  if (typeof mcp.callWriteTool !== "function") {
    throw refuse("EXECUTE_CLIENT_UNSUPPORTED", "this MCP client has no write method");
  }
  const data = buildQuotationData({
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
    throw refuse(`${CODE_PREFIX}WRITE_UNVERIFIED`, "ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile");
  }

  // 4. VERIFY by reading the document back — the write response is not evidence.
  const verified = await verifyWrittenQuotation(mcp, docName, { customerId, lines, actionId });

  const estimated = lines.reduce((s, l) => s + Math.round(l.qty * l.rate), 0);
  const result = {
    erpnext_doc: docName,
    customer: customerId,
    lines: lines.map((l) => ({ item_code: l.item_code, item_name: l.item_name, qty: l.qty, uom: l.uom, rate: l.rate })),
    line_count: lines.length,
    estimated_total_vnd: estimated,
    erpnext_total_vnd: Number.isFinite(Number(verified.grand_total)) ? Math.round(Number(verified.grand_total)) : null,
    action_id: actionId,
    docstatus: Number(verified.docstatus ?? 0),
    company: resolvedCompany,
    note: "báo giá tạo ở trạng thái NHÁP (docstatus 0) — đây là ĐỀ NGHỊ, không phải đơn đã chốt; submit là bước riêng trên ERPNext",
  };
  if (result.erpnext_total_vnd !== null && result.erpnext_total_vnd !== estimated) {
    result.total_note = `ERPNext tính ${result.erpnext_total_vnd}đ (có thuế/chiết khấu) — số tạm tính chỉ để hiển thị trước khi ghi`;
  }
  result.reference_no = commandId;
  store.complete(commandId, result);
  return result;
}
