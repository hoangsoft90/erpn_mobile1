/**
 * Skill: stock_adjustment WRITE (P9-E — Stock Entry **Material Issue**, DRAFT only).
 *
 * Cùng khuôn 2 pha như mọi WRITE khác: buildStockAdjustmentProposal() DỪNG ở
 * proposal; executeStockAdjustmentProposal() chỉ chạy sau cổng confirm +
 * idempotency của Safety Gateway và CHỈ tạo NHÁP. Submit không có trên đường
 * chat: contract khai `execution.allow_submit: false` và write gate của MCP
 * client tôn trọng điều đó (một phiếu xuất kho đã submit mới sinh Stock Ledger
 * Entry — tức mới thật sự trừ hàng).
 *
 * Vì sao xuất hủy cần luật an toàn riêng (nó KHÔNG phải "một đơn bán không giá"):
 *
 *  - CÂU NÓI ĐƯỢC QUYẾT ĐỊNH: mặt hàng nào, bao nhiêu, đơn vị gì, KHO NÀO.
 *    Không gì khác. Giá trị hàng xuất ra (valuation) là của ERPNext — skill này
 *    KHÔNG BAO GIỜ gửi một con số giá nào lên phiếu, và TỪ CHỐI nếu thấy `rate`
 *    trong params (xem assertNoPrice).
 *  - **XÁC NHẬN KÉP ở tầng dữ liệu** (user chốt 2026-09-23 khi chọn mô hình rủi
 *    ro): số lượng VÀ kho đều phải được NÓI RA. Thiếu kho ⇒ TỪ CHỐI kèm danh
 *    sách kho thật của mặt hàng, KHÔNG tự chọn "kho duy nhất còn hàng" — sai kho
 *    là sai chỗ kiểm kê của tiệm và không hoàn tác được bằng chat.
 *  - Số lượng bị chặn trần bởi **tồn thật** (`Bin.actual_qty`) TRỪ phần đã bị
 *    các phiếu xuất NHÁP khác chiếm (draft-cover). Vượt ⇒ TỪ CHỐI, không kẹp:
 *    "kẹp cho vừa" nghĩa là tự quyết định bao nhiêu hàng bị hủy.
 *  - `expense_account` / `company` / field `purpose` trên site thật là GAP đã
 *    ghi trong `.plan/result-p9-E.md` (chưa đo được: site đang 503). Payload ở
 *    đây theo ĐÚNG shape của tool `erpnext_stock_entry_create` trong bản pin
 *    `@casys/mcp-erpnext@3.0.4` (đọc từ source package), cộng `company` vì
 *    contract bắt scope company và ERPNext cần nó khi nhiều công ty.
 */

import { assertReadOnly } from "../readonly-guard.mjs";
import { buildProposal } from "../action-proposal.mjs";
import { getCapability, __contract } from "../capability-contract.mjs";
import { classifyDriftCode } from "../proposal-freshness.mjs";
import { normalizeUomToken, resolveLineUom, uomPolicy, UOM_ACTIONS } from "../uom.mjs";
import { matchItemsByText, selectNonOverlappingItems } from "./inventory.mjs";
import {
  docOf,
  newActionId,
  pairLines,
  refuse,
  resolveSalesCompany,
  rowsOf,
} from "./sales-order-write.mjs";

/** The ONE doctype this skill may create (fail-closed everywhere else). */
export const WRITE_DOCTYPE = "Stock Entry";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "stock.adjustment";

/** The code prefix for every refusal this path can emit (contract taxonomy). */
const CODE_PREFIX = "SE_";

/** The one Stock Entry purpose this skill may build (session scope, P9-E). */
const ENTRY_TYPE = "Material Issue";

/**
 * The naming series a Stock Entry is created under. MEASURED on the real site
 * (2026-09-23): `DocField.naming_series` for Stock Entry is `reqd = 1` with
 * `default = null` and `options = "MAT-STE-.YYYY.-"` — a single option, which is
 * the series every existing entry on that site actually carries. It is sent
 * explicitly because it is REQUIRED and nothing fills it in for us (unlike the
 * sales/purchase documents, whose payloads never send one). A wrong value fails
 * loudly on the site's own Select validation rather than writing a document
 * outside the shop's numbering, which is the direction that matters.
 */
const NAMING_SERIES = "MAT-STE-.YYYY.-";

/** Floating-point tolerance for quantities (ERPNext floats, we compare). */
const EPS = 1e-9;

/**
 * How many draft Stock Entries we are willing to read to compute the draft
 * cover. A FULL page means "there may be more" — and then the honest answer is
 * a refusal (`SE_DRAFT_COVER_UNKNOWN`), not a number that looks precise.
 */
const DRAFT_LOOKUP_LIMIT = 10;

/**
 * The ERPNext-side correlation field, read from the contract (single source of
 * truth) — the same Custom Field every other write in this project uses, so ONE
 * migration covers every doctype the copilot writes.
 */
export function correlationField() {
  return getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
}

/** Contract policy block, read per call (a missing block is a hard bug). */
function policies() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("SE_CONTRACT_MISSING: stock.adjustment is not in the capability contract");
  return { cap, line: cap.line_policy, uom: uomPolicy(__contract) };
}

/**
 * The declared purpose, read from the contract rather than hardcoded, and
 * REFUSED when the contract does not say — or says something other than —
 * Material Issue. Both halves matter: silently building a Material Receipt (or
 * Transfer) would move goods the WRONG WAY while the card still says "xuất hủy",
 * and defaulting to a literal when the declaration is MISSING is how a guard
 * becomes dead code (it can then never fire, because the only value it compares
 * against is the one it just defaulted to). The contract must therefore always
 * declare it — pinned by test/p9-e-stock.test.mjs and the contract validator.
 */
function entryType() {
  const declared = policies().line?.entry_type ?? null;
  if (declared !== ENTRY_TYPE) {
    throw refuse(
      `${CODE_PREFIX}PURPOSE_UNSUPPORTED`,
      declared === null
        ? `contract chưa khai line_policy.entry_type cho stock.adjustment — không ghi phiếu khi CHIỀU HÀNG chưa được tuyên bố (P9-E, fail closed)`
        : `contract khai line_policy.entry_type="${declared}" nhưng skill chỉ hỗ trợ "${ENTRY_TYPE}" (P9-E) — không ghi phiếu với chiều hàng sai`,
    );
  }
  return declared;
}

/* ------------------------------------------------------------- reads ------ */

/**
 * Guarded read: stock rows (Bin) for ONE item, across warehouses.
 *
 * Returns the RAW tool payload (not a filtered array) on purpose: every read on
 * the skills bag has the same MCP shape, so a test fake and the real client
 * differ only in where the data comes from. Filtering happens in the caller
 * through `rowsOf` — the convention every other write skill in this project
 * follows (delivery/receipt/invoice), and mixing the two conventions inside one
 * bag is how a fake quietly stops resembling the tool.
 */
export async function listStockRows(mcp) {
  assertReadOnly("erpnext_stock_balance");
  return mcp.callTool("erpnext_stock_balance", { limit: 100 });
}

/** Rows of Bin for ONE item — the shape every caller actually wants. */
export function stockRowsFor(payload, itemCode) {
  return rowsOf(payload).filter((r) => String(r.item_code ?? "") === String(itemCode ?? ""));
}

/** Guarded read: one Stock Entry document (raw payload, `docOf` at the caller). */
export async function getStockEntryDoc(mcp, name) {
  assertReadOnly("erpnext_doc_get");
  return mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name });
}

/**
 * The page of open DRAFT Stock Entries of THIS purpose. Raw list payload — the
 * caller turns it into a cover.
 *
 * Why a bounded page and not "all": a FULL page means there may be more, and
 * then the honest answer is a refusal (`SE_DRAFT_COVER_UNKNOWN`), never a number
 * that looks precise. A page this small is enough for a shop that submits what
 * it writes off.
 */
export async function listOpenDraftStockEntries(mcp) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: WRITE_DOCTYPE,
    fields: ["name", "docstatus", "stock_entry_type", correlationField()],
    // P4-1 lesson: filter values must be STRINGS on the real site.
    filters: [
      ["docstatus", "=", "0"],
      ["stock_entry_type", "=", ENTRY_TYPE],
    ],
    limit: DRAFT_LOOKUP_LIMIT,
    order_by: "creation desc",
  });
}

/**
 * What open drafts already claim for (item, warehouse) — computed from the
 * READS bag (the delivery path's shape, applied here rather than reinvented).
 *
 * A child table cannot be trusted off a list endpoint (documented ERPNext trap:
 * it can silently return only `name`), so this is list-then-get with a bounded
 * page. A draft that cannot be read is `unreadable`, never assumed empty: the
 * whole point is that its goods are still on the shelf.
 *
 * @param {{listOpenDraftStockEntries: Function, getStockEntryDoc: Function}} reads
 * @returns {Promise<{drawn: Map<string,number>, unknown: boolean, drafts: string[]}>}
 */
export async function openDraftCover(reads, itemCode) {
  let rows = [];
  try {
    rows = rowsOf(await reads.listOpenDraftStockEntries());
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được các phiếu xuất kho NHÁP đang treo: ${err?.message ?? err}`);
  }
  const pageFull = rows.length >= DRAFT_LOOKUP_LIMIT;
  const drawn = new Map();
  const drafts = [];
  let unreadable = false;
  for (const row of rows) {
    const name = row?.name;
    if (!name) continue;
    drafts.push(name);
    let doc = null;
    try {
      doc = docOf(await reads.getStockEntryDoc(name));
    } catch {
      // A draft we cannot read is a draft we cannot subtract — the caller is
      // told via `unknown` instead of silently narrowing the cover.
      unreadable = true;
      continue;
    }
    for (const line of Array.isArray(doc?.items) ? doc.items : []) {
      if (String(line.item_code ?? "") !== String(itemCode ?? "")) continue;
      const wh = String(line.s_warehouse ?? "");
      if (!wh) continue;
      // A draft line may be counted in a NON-stock unit (conversion_factor ≠ 1);
      // Bin.actual_qty is always in the STOCK unit — normalize before summing,
      // otherwise a "1 Tấn (cf=1000)" draft would only cover 1 unit of the shelf.
      const lineCf = Number(line.conversion_factor);
      const factor = Number.isFinite(lineCf) && lineCf > 0 ? lineCf : 1;
      drawn.set(wh, (drawn.get(wh) ?? 0) + (Number(line.qty) || 0) * factor);
    }
  }
  return { drawn, unknown: pageFull || unreadable, drafts };
}

/** Reconcile a command against ERPNext — READ ONLY (lost-response retry path). */
export async function reconcileStockEntry(mcp, reference, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const field = correlationField();
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "stock_entry_type", field],
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

/**
 * Resolve the KHO the sentence names against the warehouses that really hold
 * this item (from Bin). Exact-insensitive on purpose: warehouse names are
 * ERPNext data, and guessing a near-miss here would book the write-off into the
 * wrong room.
 *
 * @returns {{warehouse: string|null, available: number, reason: string|null, options: string[]}}
 */
function pickWarehouse({ rows, text, itemCode, drawn }) {
  const withStock = rows.filter((r) => String(r.warehouse ?? "").trim() !== "");
  const options = withStock.map((r) => String(r.warehouse));
  if (options.length === 0) {
    return { warehouse: null, available: 0, reason: "no_stock_rows", options: [] };
  }
  const low = String(text ?? "").toLowerCase();
  // Longest name first so "Kho chính 2" cannot be matched by "Kho chính".
  const named = options
    .filter((w) => low.includes(w.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (named.length === 0) {
    return { warehouse: null, available: 0, reason: "not_named", options };
  }
  if (named.length > 1) {
    return { warehouse: null, available: 0, reason: "ambiguous", options: named };
  }
  const row = withStock.find((r) => String(r.warehouse) === named[0]);
  const onHand = Number(row?.actual_qty ?? 0);
  const covered = drawn?.get(named[0]) ?? 0;
  return {
    warehouse: named[0],
    available: onHand - covered,
    onHand,
    covered,
    reason: null,
    options,
    item_code: itemCode,
  };
}

/**
 * Stage A — build the DRAFT write-off proposal for a resolved item/qty/warehouse.
 *
 * @param {object} skills reads bag: { findItem, listUoms, listUomFactors,
 *                               listStockRows, listOpenDraftStockEntries, getStockEntryDoc }
 *                               — every entry returns a RAW tool payload and is
 *                               read here through rowsOf/docOf, so a test fake
 *                               differs from the real client only in where the
 *                               data comes from
 * @param {object} resolved { item, ambiguous, candidates }  (no party: a write-off has none)
 * @param {object} opts { nlp, text? }
 * @returns {Promise<object>} { proposal, line, warnings, action_id }
 */
export async function buildStockAdjustmentProposal(skills, resolved = {}, opts = {}) {
  const purpose = entryType();
  const { line: linePolicy, uom: uomPolicyBlock } = policies();
  const text = opts.text ?? opts.nlp?.text ?? "";

  // 1. WHICH item? The same catalogue the other write paths read. A write-off is
  //    ONE item at a time: the card has to be checkable against a single number,
  //    and "xuất hủy 2 bao cám heo và 3 bao cám gà" is two decisions.
  let itemRows = [];
  try {
    itemRows = rowsOf(await skills.findItem(""));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được danh mục mặt hàng từ ERPNext: ${err?.message ?? err}`);
  }
  const { matched, scored } = matchItemsByText(itemRows, text);
  const namedItems = selectNonOverlappingItems(scored ?? matched);
  if (namedItems.length === 0) {
    throw refuse(
      `${CODE_PREFIX}ITEM_UNRESOLVED`,
      `không xác định được mặt hàng nào trong "${text}" — nói rõ tên mặt hàng như trong ERPNext`,
    );
  }
  if (namedItems.length > Number(linePolicy.max_lines)) {
    throw refuse(
      `${CODE_PREFIX}ITEM_AMBIGUOUS`,
      `câu nói khớp ${namedItems.length} mặt hàng nhưng mỗi phiếu xuất hủy chỉ xử lý ${linePolicy.max_lines} mặt hàng — tách thành nhiều phiếu`,
      // `selectNonOverlappingItems` returns MATCH records ({item, hit, span}),
      // not the items themselves — reading `.item_name` off the wrapper would
      // print "undefined" at exactly the moment the user needs to know WHICH
      // items collided.
      { candidates: namedItems.map((m) => m.item?.item_name ?? m.item?.item_code) },
    );
  }
  const item = namedItems[0].item;
  const itemCode = item.item_code ?? item.name;

  // 2. HOW MUCH? One shared implementation with every other line document.
  const { lines: paired, problems } = pairLines({
    matched: namedItems,
    quantities: opts.nlp?.quantities ?? [],
    codePrefix: CODE_PREFIX,
  });
  if (problems.length > 0) {
    throw refuse(problems[0].code, problems[0].reason, { problems });
  }
  const quantity = paired[0]?.quantity;
  const qty = Number(quantity?.value);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw refuse(
      `${CODE_PREFIX}QTY_MISSING`,
      `số lượng xuất hủy của "${item.item_name ?? itemCode}" phải là số dương (đang ${quantity?.value ?? "?"})`,
    );
  }

  // 3. WHICH UNIT? B1's resolver, against the item's real stock_uom.
  const uomNames = rowsOf(await skills.listUoms());
  const factors = rowsOf(await skills.listUomFactors());
  const decision = resolveLineUom({
    text,
    uom: quantity?.canonical_unit ?? quantity?.unit ?? null,
    quantity: qty,
    item,
    erpUomNames: uomNames,
    factors,
    policy: uomPolicyBlock,
  });
  if (decision.action === UOM_ACTIONS.ASK) {
    throw refuse(
      `${CODE_PREFIX}UOM_UNRESOLVED`,
      decision.reason ?? "không xác định được đơn vị cho phiếu xuất hủy",
      { uom_code: decision.code, item: itemCode, candidates: decision.candidates ?? [] },
    );
  }

  // 4. WHICH WAREHOUSE + how much is really there. Số lượng nói ra bị chặn trần
  //    bởi tồn thật TRỪ phần các phiếu NHÁP khác đã chiếm (một phiếu nháp KHÔNG
  //    trừ Bin, nên nếu không trừ ở đây thì hai lần xác nhận sẽ xuất hủy gấp đôi).
  let rows = [];
  try {
    rows = stockRowsFor(await skills.listStockRows(), itemCode);
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được tồn kho của ${itemCode}: ${err?.message ?? err}`);
  }
  // A refusal about the drafts (too many of them) is a refusal about THIS
  // proposal, so it is caught and rethrown as-is rather than flattened into
  // ERP_UNAVAILABLE — the two mean different things to the shop owner.
  const cover = await openDraftCover(skills, itemCode);
  const picked = pickWarehouse({ rows, text, itemCode, drawn: cover.drawn });
  if (picked.reason === "not_named") {
    throw refuse(
      `${CODE_PREFIX}WAREHOUSE_MISSING`,
      `chưa nói rõ KHO nào — xuất hủy cần cả số lượng VÀ kho. ${item.item_name ?? itemCode} đang có ở: ${picked.options.join(", ")}. Nói lại kèm tên kho (vd "xuất hủy ${qty} ${decision.uom} ${item.item_name ?? itemCode} ở ${picked.options[0]}")`,
      { warehouses: picked.options },
    );
  }
  if (picked.reason === "ambiguous") {
    throw refuse(
      `${CODE_PREFIX}WAREHOUSE_AMBIGUOUS`,
      `tên kho trong "${text}" khớp nhiều kho (${picked.options.join(", ")}) — cần nói rõ tên đầy đủ`,
      { warehouses: picked.options },
    );
  }
  if (picked.reason === "no_stock_rows") {
    throw refuse(
      `${CODE_PREFIX}WAREHOUSE_NOT_FOUND`,
      `ERPNext không có dòng tồn (Bin) nào cho ${item.item_name ?? itemCode} — không có gì để xuất hủy`,
    );
  }
  if (cover.unknown) {
    throw refuse(
      `${CODE_PREFIX}DRAFT_COVER_UNKNOWN`,
      `có quá nhiều phiếu xuất NHÁP đang treo nên KHÔNG biết còn bao nhiêu hàng thực sự chưa bị chiếm — từ chối đề xuất (kiểm tra/hủy các phiếu nháp trên ERPNext rồi hỏi lại)`,
    );
  }
  const available = Number(picked.available ?? 0);
  if (available <= EPS) {
    throw refuse(
      `${CODE_PREFIX}NOTHING_TO_ISSUE`,
      `${item.item_name ?? itemCode} ở ${picked.warehouse} không còn hàng chưa bị chiếm (tồn ${picked.onHand ?? 0}${Number(picked.covered ?? 0) > 0 ? `, đã có phiếu NHÁP chiếm ${picked.covered}` : ""}) — không có gì để xuất hủy`,
    );
  }
  const stockUom = item.stock_uom ?? null;
  if (stockUom && normalizeUomToken(decision.uom) !== normalizeUomToken(stockUom) && decision.action !== UOM_ACTIONS.CONVERT) {
    // A same-number-different-unit write-off is the UOM mismatch P9-B found in
    // the delivery path: "1 tấn" against a line counted in bao is a WRONG NUMBER.
    throw refuse(
      `${CODE_PREFIX}UOM_UNRESOLVED`,
      `đơn vị "${decision.uom}" không khớp đơn vị tồn kho "${stockUom}" của ${item.item_name ?? itemCode} và không có hệ số quy đổi — nói theo đơn vị tồn kho`,
      { uom_code: decision.code, stock_uom: stockUom },
    );
  }
  // Trần tồn kho phải so trong ĐƠN VỊ TỒN KHO (Bin.actual_qty là stock unit).
  // Khi câu nói dùng đơn vị khác và hệ số là DECLARED (action CONVERT), quy đổi
  // TRƯỚC khi so — so 0.6 (Tấn) với 500 (Kg) là so hai thứ khác đơn vị ⇒ trần
  // bị vòng qua và phiếu NHÁP xin nhiều hơn cả kệ đang có. (Review P9-G bắt
  // được: đường CONVERT trước đây không test nào đi qua.)
  const conversionFactor =
    decision.action === UOM_ACTIONS.CONVERT && Number.isFinite(Number(decision.factor?.value))
      ? Number(decision.factor.value)
      : 1;
  const qtyInStockUom = qty * conversionFactor;
  if (qtyInStockUom > available + EPS) {
    throw refuse(
      `${CODE_PREFIX}QTY_EXCEEDS_STOCK`,
      `${item.item_name ?? itemCode} ở ${picked.warehouse} chỉ còn ${available} ${stockUom ?? decision.uom} chưa bị chiếm (bạn nói ${qty} ${decision.uom}${conversionFactor !== 1 ? ` = ${qtyInStockUom} ${stockUom ?? decision.uom}` : ""}) — KHÔNG tự kẹp số, hãy nói lại đúng số thực tế`,
      { available, on_hand: picked.onHand ?? null, covered: picked.covered ?? 0, warehouse: picked.warehouse },
    );
  }

  const line = {
    item_code: itemCode,
    item_name: item.item_name ?? itemCode,
    qty,
    uom: decision.uom,
    warehouse: picked.warehouse,
    stock_uom: stockUom,
    conversion_factor: conversionFactor !== 1 ? conversionFactor : null,
    qty_in_stock_uom: qtyInStockUom,
    available_after: available - qtyInStockUom,
    warehouse_on_hand: picked.onHand ?? null,
    draft_covered: picked.covered ?? 0,
  };
  const warnings = [];
  if (decision.warning) warnings.push(decision.warning);
  if (Number(picked.covered ?? 0) > 0) {
    warnings.push(
      `đã trừ ${picked.covered} ${stockUom ?? decision.uom} mà phiếu xuất NHÁP khác đang chiếm (nháp chưa trừ kho, nên nếu không trừ ở đây sẽ xuất hủy hai lần)`,
    );
  }
  warnings.push("phiếu tạo ở trạng thái NHÁP — CHƯA trừ kho cho tới khi submit trên ERPNext");

  const proposal = buildProposal({
    action: "create_stock_adjustment",
    risk: "HIGH",
    // XÁC NHẬN KÉP: contract khai risk.double_confirm=true (đọc, không hardcode)
    // ⇒ card nói rõ đây là thao tác 2 điều kiện (số lượng + kho) và không có
    // đường nào tự chạy khi thiếu một trong hai.
    needDoubleConfirm: policies().cap?.risk?.double_confirm === true,
    entity: { kind: "item", id: itemCode, name: item.item_name ?? itemCode },
    params: {
      purpose,
      entry_type: purpose,
      item_code: itemCode,
      item_name: item.item_name ?? itemCode,
      qty,
      uom: decision.uom,
      warehouse: picked.warehouse,
      warehouse_on_hand: picked.onHand ?? null,
      draft_covered: picked.covered ?? 0,
      available_before: available,
      available_after: available - qtyInStockUom,
      // Đơn vị tồn kho là thước đo của mọi con số trần: params phải mang đủ
      // hệ số + số quy đổi để EXECUTOR trần-check lại đúng đơn vị (không đoán
      // lại từ câu nói) và payload gửi đúng conversion_factor cho ERPNext.
      conversion_factor: conversionFactor !== 1 ? conversionFactor : null,
      qty_in_stock_uom: qtyInStockUom,
      // Draft-only là một phần của THỨ đang được duyệt: card hứa "NHÁP" và
      // không gì ở đây submit được (submit mới trừ kho).
      submit_now: false,
    },
    summary: `Xuất hủy NHÁP: ${qty} ${decision.uom}${conversionFactor !== 1 ? ` (=${qtyInStockUom} ${stockUom ?? decision.uom})` : ""} ${item.item_name ?? itemCode} ở ${picked.warehouse}`,
    extra: {
      warnings,
      action_id: newActionId(),
      schema_note:
        "params là ĐỀ XUẤT — execute đọc LẠI tồn kho + các phiếu nháp đang treo từ ERPNext, lệch thì TỪ CHỐI; phiếu luôn là NHÁP (docstatus 0), submit là bước riêng trên ERPNext",
    },
  });

  return { proposal, line, warnings, action_id: proposal.action_id };
}

/* ------------------------------------------------------------- executor -- */

/**
 * The REAL Stock Entry payload (pure — unit-testable without network).
 *
 * Shape measured from the pinned package's own `erpnext_stock_entry_create`
 * tool (source of truth for what the site accepts): `stock_entry_type` +
 * `items[{item_code, qty, s_warehouse}]`. `company` is ADDED on purpose (the
 * package tool omits it; ERPNext needs it when the site has more than one
 * company, and the contract already scopes every write to a company).
 *
 * NO price is ever sent: the valuation comes from ERPNext's own ledger.
 * `posting_date` is deliberately NOT sent (same lesson as the delivery path,
 * P5-2): a date the client picks without `set_posting_time` is silently ignored
 * by ERPNext anyway, so it is better to have one source of truth (the site's
 * today) than a field that lies.
 *
 * `stock_uom` + `conversion_factor` ARE sent, and the real site is why: the
 * measured `Stock Entry Detail` meta (probe 2026-09-23) marks both `reqd=1`,
 * and `conversion_factor` is NOT `fetch_from` anything — so nothing on the
 * server fills it in. Both values are DERIVED here, never guessed: `stock_uom`
 * is the item's own (`Item.stock_uom`, the same field every other path reads),
 * and `conversion_factor` is the factor the UOM resolver actually declared — or
 * 1, which is what a row means when it is already counted in the stock unit.
 */
export function buildStockEntryData({
  itemCode,
  qty,
  uom,
  warehouse,
  company,
  actionId,
  correlation,
  stockUom,
  conversionFactor = null,
}) {
  if (!warehouse) throw refuse(`${CODE_PREFIX}WAREHOUSE_MISSING`, "không có kho nguồn — không dựng được phiếu xuất hủy");
  return {
    doctype: WRITE_DOCTYPE,
    company,
    stock_entry_type: ENTRY_TYPE,
    naming_series: NAMING_SERIES,
    // Field `purpose` KHÔNG gửi: tool của package cũng không gửi (đo ở §0.1) —
    // ERPNext suy ra từ stock_entry_type.
    [correlation]: actionId ?? null,
    remarks: "ERPNext Voice Copilot · xác nhận bởi người dùng · xuất hủy hàng hỏng, tạo NHÁP chưa submit",
    items: [
      {
        item_code: itemCode,
        qty,
        uom,
        s_warehouse: warehouse,
        // Required child fields on the real site (measured meta 2026-09-23).
        ...(stockUom ? { stock_uom: stockUom } : {}),
        conversion_factor: Number(conversionFactor) > 0 ? Number(conversionFactor) : 1,
      },
    ],
  };
}

/**
 * Fail-closed price guard: this path has NO price. If a `rate`/`price` ever
 * appears in the proposal params, something upstream started inventing money —
 * refuse instead of writing it onto a stock document. Its own code, not
 * SE_PURPOSE_UNSUPPORTED: "the goods move the wrong way" and "someone put a
 * price on a write-off" are different failures and the card must say which.
 */
function assertNoPrice(params) {
  for (const key of ["rate", "price", "amount_vnd", "valuation_rate", "amount"]) {
    if (params && params[key] !== undefined && params[key] !== null) {
      throw refuse(
        `${CODE_PREFIX}PRICE_FORBIDDEN`,
        `params.${key} xuất hiện trên đề xuất xuất hủy — đường này KHÔNG có giá (giá trị hàng là của ERPNext), từ chối ghi`,
      );
    }
  }
}

/**
 * Read the written Stock Entry back and check it carries what we intended.
 *
 * `docOf` is not decoration: the REAL `erpnext_doc_get` answers
 * `{__untrusted, source, data: {data: {...the document...}}}` (measured on the
 * live site 2026-09-23). Reading the envelope as if it were the document made
 * every field `undefined`, so this check refused a write that had actually
 * succeeded — correct fail-closed behaviour, useless verification. (The real
 * loop found it: the same mistake a mock cannot catch, because the mock's
 * payload is already unwrapped.)
 */
export async function verifyWrittenStockEntry(mcp, docName, { itemCode, qty, uom, warehouse, actionId }) {
  const doc = docOf(await getStockEntryDoc(mcp, docName));
  const problems = [];
  if (Number(doc.docstatus) !== 0) problems.push(`docstatus=${doc.docstatus} (phiếu xuất hủy phải là NHÁP)`);
  if (String(doc.stock_entry_type ?? "") !== ENTRY_TYPE) problems.push(`stock_entry_type=${doc.stock_entry_type}`);
  const field = correlationField();
  if (actionId && Object.prototype.hasOwnProperty.call(doc, field) && String(doc[field] ?? "") !== String(actionId)) {
    problems.push(`${field}=${doc[field]}`);
  }
  const gotLines = Array.isArray(doc.items) ? doc.items : [];
  if (gotLines.length !== 1) {
    problems.push(`số dòng=${gotLines.length} (mong đợi 1)`);
  } else {
    const got = gotLines[0];
    if (String(got.item_code ?? "") !== String(itemCode)) problems.push(`item_code=${got.item_code}`);
    if (Math.abs(Number(got.qty) - Number(qty)) > EPS) problems.push(`qty=${got.qty}`);
    if (uom && normalizeUomToken(got.uom) !== normalizeUomToken(uom)) problems.push(`uom=${got.uom}`);
    if (String(got.s_warehouse ?? "") !== String(warehouse)) problems.push(`s_warehouse=${got.s_warehouse}`);
    if (got.t_warehouse) problems.push(`t_warehouse=${got.t_warehouse} (Material Issue không có kho đích)`);
  }
  if (problems.length) {
    throw refuse(
      `${CODE_PREFIX}WRITE_UNVERIFIED`,
      `đọc lại phiếu xuất kho ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc },
    );
  }
  return doc;
}

/**
 * Stage B — execute a CONFIRMED write-off proposal. Called only from the Safety
 * Gateway AFTER the idempotency gate. Stock, units and open drafts are re-read
 * from live ERPNext; the proposal's numbers are compared, never trusted.
 */
export async function executeStockAdjustmentProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const params = proposal.params ?? {};
  assertNoPrice(params);
  const itemCode = params.item_code ?? proposal.entity?.id ?? null;
  const qty = Number(params.qty);
  const warehouse = params.warehouse ?? null;
  const uom = params.uom ?? null;
  if (!itemCode || !warehouse || !Number.isFinite(qty) || qty <= 0) {
    throw refuse(
      `${CODE_PREFIX}QTY_MISSING`,
      `đề xuất thiếu mặt hàng/số lượng/kho (item=${itemCode ?? "?"}, qty=${params.qty ?? "?"}, kho=${warehouse ?? "?"}) — không ghi phiếu`,
    );
  }

  // 1. Correlation field is the ONLY server-side duplicate defence a Stock
  //    Entry has. Refuse BEFORE registering anything when the site cannot store it.
  const field = correlationField();
  const probe = await reconcileStockEntry(mcp, commandId, { actionId: proposal.action_id ?? null });
  if (probe.correlation_field_unavailable) {
    throw refuse(
      `${CODE_PREFIX}CORRELATION_FIELD_MISSING`,
      `ERPNext chưa có field "${field}" trên ${WRITE_DOCTYPE} — không có cách chống trùng phía server, KHÔNG ghi phiếu (chạy migration thêm field cho ${WRITE_DOCTYPE} trước)`,
    );
  }
  if (probe.found) {
    throw refuse(
      `${CODE_PREFIX}DUPLICATE_ACTION`,
      `phiếu xuất kho ${probe.doc?.name ?? "?"} đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước`,
      { existing_doc: probe.doc?.name ?? null },
    );
  }

  // 2. RE-READ live stock + the drafts still holding goods; anything that moved
  //    is drift ⇒ refusal (never a silently smaller write-off).
  let item = null;
  let rows = [];
  let cover = { drawn: new Map(), unknown: false, drafts: [] };
  try {
    const items = rowsOf(await mcp.callTool("erpnext_item_list", { limit: 100 }));
    item = items.find((i) => String(i.item_code ?? i.name) === String(itemCode)) ?? null;
    rows = stockRowsFor(await listStockRows(mcp), itemCode);
    cover = await openDraftCover(
      {
        listOpenDraftStockEntries: () => listOpenDraftStockEntries(mcp),
        getStockEntryDoc: (name) => getStockEntryDoc(mcp, name),
      },
      itemCode,
    );
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc lại được mặt hàng/tồn kho từ ERPNext: ${err?.message ?? err}`);
  }
  const drift = [];
  if (!item) drift.push(`mặt hàng ${itemCode} không còn tồn tại`);
  // The unit an item is STOCKED in can be edited on the site; the proposal froze
  // what it saw. Compared only when the snapshot recorded one — otherwise there
  // is nothing to compare and the claim would be `x !== x` (a dead clause).
  const snapStockUom = params.stock_uom ?? null;
  if (item && snapStockUom && normalizeUomToken(item.stock_uom) !== normalizeUomToken(snapStockUom)) {
    drift.push(`${itemCode}: đơn vị tồn kho đổi thành ${item.stock_uom} (đề xuất ${snapStockUom})`);
  }
  const row = rows.find((r) => String(r.warehouse ?? "") === String(warehouse));
  if (!row) {
    drift.push(`${itemCode}: kho "${warehouse}" không còn dòng tồn kho nào`);
  } else {
    const available = Number(row.actual_qty ?? 0) - (cover.unknown ? 0 : (cover.drawn.get(warehouse) ?? 0));
    // Trần-check trong ĐƠN VỊ TỒN KHO (Bin.actual_qty là stock unit): một đề
    // xuất "0.006 Tấn" phải trần-check như 6 Kg, không phải 0.006 — so hai đơn
    // vị khác nhau là trần bị vòng qua (cùng họ lỗi builder, review P9-G).
    const snapFactor = Number(params.conversion_factor);
    const factor = Number.isFinite(snapFactor) && snapFactor > 0 ? snapFactor : 1;
    const proposedInStockUom = qty * factor;
    if (proposedInStockUom > available + EPS) {
      drift.push(
        `${itemCode} ở ${warehouse}: chỉ còn ${available} chưa bị chiếm (đề xuất ${qty}${factor !== 1 ? ` × ${factor} = ${proposedInStockUom} ${item?.stock_uom ?? ""}` : ""})`,
      );
    }
  }
  if (drift.length > 0) {
    throw refuse(
      "PROPOSAL_STALE",
      `đề xuất đã lệch so với tồn kho thật: ${drift.join("; ")} — KHÔNG ghi, hãy xác nhận lại`,
      { drift_code: classifyDriftCode(drift), problems: drift },
    );
  }
  const resolvedUom = uom ?? item?.stock_uom ?? null;
  const resolvedCompany = await resolveSalesCompany(mcp, {
    authzCompany: company ?? params.company ?? null,
    code: `${CODE_PREFIX}COMPANY_UNRESOLVED`,
    noun: "phiếu xuất hủy",
  });
  const actionId = proposal.action_id ?? null;

  // 3. Register the ERPNext-side reference BEFORE the write (crash safety).
  store.setReference(commandId, commandId);

  if (typeof mcp.callWriteTool !== "function") {
    throw refuse("EXECUTE_CLIENT_UNSUPPORTED", "this MCP client has no write method");
  }
  const data = buildStockEntryData({
    itemCode,
    qty,
    uom: resolvedUom,
    warehouse,
    company: resolvedCompany,
    actionId,
    correlation: field,
    // Both read back off the ITEM (never off the proposal) — the proposal's copy
    // is a snapshot for the card, and the site is the authority on which unit an
    // item is stocked in (P9-B's drift lesson).
    stockUom: item?.stock_uom ?? params.stock_uom ?? null,
    // The BUILDER's declared factor (measured against the UOM tables at build
    // time) — not re-derived here, so what the card showed is what gets sent.
    // A null/absent factor means "already counted in the stock unit" and the
    // payload helper defaults it to 1.
    conversionFactor: params.conversion_factor ?? null,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });
  const doc = docOf(res);
  const docName = doc?.name ?? null;
  if (!docName) {
    throw refuse(`${CODE_PREFIX}WRITE_UNVERIFIED`, "ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile");
  }

  // 4. VERIFY by reading the document back — the write response is not evidence.
  const verified = await verifyWrittenStockEntry(mcp, docName, {
    itemCode,
    qty,
    uom: resolvedUom,
    warehouse,
    actionId,
  });

  const result = {
    erpnext_doc: docName,
    item_code: itemCode,
    item_name: params.item_name ?? item?.item_name ?? itemCode,
    qty,
    uom: resolvedUom,
    warehouse,
    purpose: ENTRY_TYPE,
    action_id: actionId,
    docstatus: Number(verified.docstatus ?? 0),
    company: resolvedCompany,
    reference_no: commandId,
    note: "phiếu xuất hủy tạo ở trạng thái NHÁP (docstatus 0) — CHƯA trừ kho; submit là bước riêng trên ERPNext, không tự động",
  };
  store.complete(commandId, result);
  return result;
}
