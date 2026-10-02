/**
 * Skill: inventory (READ-ONLY).
 */

import { assertReadOnly, markUntrusted } from "../readonly-guard.mjs";

/**
 * List stock balances across warehouses (real tool: erpnext_stock_balance).
 * @param {object} mcp
 * @param {{warehouse?: string}} [filters]
 */
export async function listInventory(mcp, filters = {}) {
  assertReadOnly("erpnext_stock_balance");
  const args = { limit: 100 };
  if (filters.warehouse) args.warehouse = filters.warehouse;
  const res = await mcp.callTool("erpnext_stock_balance", args);
  return markUntrusted("erpnext:erpnext_stock_balance", res.data ?? res);
}

/**
 * UOM names that really exist in ERPNext (real tool: erpnext_doc_list on the
 * `UOM` doctype).
 *
 * B1: the unit name must come from the site, never from a local table — the
 * live site stores "Thung" (no diacritic) while the Vietnamese word is "thùng",
 * and sending an invented name to ERPNext is a LinkValidationError.
 *
 * @param {object} mcp
 */
export async function listUoms(mcp) {
  assertReadOnly("erpnext_doc_list");
  const res = await mcp.callTool("erpnext_doc_list", { doctype: "UOM", fields: ["name"], limit: 500 });
  const payload = res.data ?? res;
  return markUntrusted("erpnext:erpnext_doc_list(doctype=UOM)", {
    doctype: "UOM",
    count: payload.data?.length ?? 0,
    data: (payload.data ?? []).map((r) => r.name).filter(Boolean),
  });
}

/**
 * Conversion factors declared by the site (real tool: erpnext_doc_list on
 * `UOM Conversion Factor`).
 *
 * Verified 2026-09-20 against the live site: this doctype has NO `item_code`
 * field (HTTP 417), so every factor here is GLOBAL — the resolver reports that
 * scope instead of pretending it is item-specific.
 *
 * @param {object} mcp
 */
export async function listUomFactors(mcp) {
  assertReadOnly("erpnext_doc_list");
  const res = await mcp.callTool("erpnext_doc_list", {
    doctype: "UOM Conversion Factor",
    fields: ["name", "from_uom", "to_uom", "value"],
    limit: 500,
  });
  const payload = res.data ?? res;
  return markUntrusted("erpnext:erpnext_doc_list(doctype=UOM Conversion Factor)", {
    doctype: "UOM Conversion Factor",
    count: payload.data?.length ?? 0,
    data: payload.data ?? [],
  });
}

/**
 * Which items does an utterance actually NAME? One matcher, shared by the
 * stock answer and the order builder (B2).
 *
 * Real item_names are longer than what people say ("Cám heo tăng trọng 25kg"),
 * so matching runs on word-PREFIXES of the stored name, longest first, and only
 * the items at the overall best prefix length survive — otherwise "cám heo ..."
 * also matched bare "cám" for every other feed (batch-accuracy b13–b15).
 *
 * Extracted verbatim from the inventory branch of the pipeline: the LOGIC is
 * unchanged (it is the matcher measured against real data), it just also
 * reports WHERE it matched so the order path can pair a quantity with the item
 * it belongs to instead of guessing.
 *
 * @param {object[]} items rows from erpnext_item_list
 * @param {string} text  the (normalized) utterance
 * @returns {{matched: {item:object, hit:number, span:{start:number,end:number,phrase:string}}[], bestLen:number, scored:object[]}}
 *          `matched` is the best-length-only set (a READ question is about ONE
 *          item); `scored` is every item that matched at any length, which an
 *          ORDER needs (see selectNonOverlappingItems).
 */
export function matchItemsByText(items, text) {
  const low = String(text ?? "").toLowerCase();
  const scored = [];
  let bestLen = 0;
  for (const it of items) {
    const words = String(it?.item_name ?? it?.item_code ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    let hit = 0;
    let span = null;
    for (let len = words.length; len >= 1; len--) {
      const phrase = words.slice(0, len).join(" ");
      const at = low.indexOf(phrase);
      if (at >= 0) {
        hit = len;
        span = { start: at, end: at + phrase.length, phrase };
        break;
      }
    }
    if (hit > 0) {
      scored.push({ item: it, hit, span });
      if (hit > bestLen) bestLen = hit;
    }
  }
  return { matched: scored.filter((s) => s.hit === bestLen), bestLen, scored };
}

/**
 * Which items an ORDER is about: every named item, not just the best-matching
 * one.
 *
 * A READ question is about ONE item, so the best-prefix-length rule above is
 * right for it. An order names SEVERAL ("2 bao cám heo tăng trọng 25kg và 3 bao
 * cám gà thịt 10kg"), and taking only the best match silently drops a line — an
 * order missing goods the user asked for. The rule here is still deterministic
 * and still avoids the original false-positive: longer matches win first, and a
 * match whose span is CONTAINED in a kept one is the same goods mentioned again
 * (that is how "cám heo ..." used to also match bare "cám" for other items).
 *
 * @param {{item:object, hit:number, span:{start:number,end:number,phrase:string}}[]} scored
 * @returns {object[]} non-overlapping matches, in text order
 */
export function selectNonOverlappingItems(scored) {
  const ordered = [...(scored ?? [])].sort(
    (a, b) => b.hit - a.hit || (a.span?.start ?? 0) - (b.span?.start ?? 0),
  );
  const kept = [];
  for (const cand of ordered) {
    const { start, end } = cand.span ?? {};
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (kept.some((k) => start < k.span.end && k.span.start < end)) continue;
    kept.push(cand);
  }
  return kept.sort((a, b) => a.span.start - b.span.start);
}

/**
 * Selling prices declared by the site (real tool: erpnext_doc_list on
 * `Item Price`).
 *
 * B2 — the ORDER path must never take a price out of an utterance: the price on
 * a Sales Order is what the shop published, so it is READ here and re-read at
 * execute time (a price that moved is drift, not a detail). No rows ⇒ the
 * builder ASKS instead of defaulting to 0.
 *
 * @param {object} mcp
 * @param {{itemCode?: string|null, limit?: number}} [filters]
 */
/**
 * A2 / P9-E (measured 2026-09-24 on the REAL site) — where a purchase line's
 * warehouse may come from.
 *
 * WHY THIS EXISTS: ERPNext REFUSED the first real draft with
 *   "Dòng #1: Kho là bắt buộc đối với mặt hàng tồn kho CAM-GA-25KG" (HTTP 417)
 * and the site declares NO default warehouse for its stock items
 * (`Item.item_defaults` is empty for CAM-GA-25KG / CAM-HEO-25KG / XM-PCB40,
 * measured). Picking one of the shop's twelve warehouses off a list would be a
 * GUESS about where stock physically lands, so the rule is the same one the
 * price follows: read it from ERPNext, and REFUSE when ERPNext has not said.
 *
 * The READ ROUTE is measured, not assumed: `erpnext_item_get` does NOT return
 * `item_defaults`, and `erpnext_doc_list` on the child doctype ignores `fields`
 * (bare names only) — `erpnext_doc_get` on the Item document carries it.
 *
 * @param {object} mcp
 * @param {string} itemCode
 * @param {{company?: string|null}} [opts] preferred company (rows for it win)
 * @returns {Promise<{item_code:string,is_stock_item:boolean,warehouse:string|null,options:string[],ambiguous:boolean}>}
 */
export async function getItemWarehouseHints(mcp, itemCode, { company = null } = {}) {
  assertReadOnly("erpnext_doc_get");
  const res = await mcp.callTool("erpnext_doc_get", { doctype: "Item", name: itemCode });
  const payload = res?.data ?? res;
  const doc = payload?.data ?? payload ?? {};
  const rows = Array.isArray(doc.item_defaults) ? doc.item_defaults : [];
  const withWarehouse = rows.filter((r) => String(r?.default_warehouse ?? "").trim() !== "");
  const preferred = company
    ? withWarehouse.filter((r) => String(r.company ?? "") === String(company))
    : withWarehouse;
  const pool = preferred.length > 0 ? preferred : withWarehouse;
  const options = [...new Set(pool.map((r) => String(r.default_warehouse).trim()))];
  return {
    item_code: itemCode,
    is_stock_item: Number(doc.is_stock_item ?? 0) === 1,
    // Exactly one answer is an answer; two are a question.
    warehouse: options.length === 1 ? options[0] : null,
    options,
    ambiguous: options.length > 1,
  };
}

export async function listItemPrices(mcp, { itemCode = null, limit = 100, side = "selling" } = {}) {
  assertReadOnly("erpnext_doc_list");
  // B4: an Item Price row is one side of the catalogue — `selling` feeds a
  // Sales Order / Quotation, `buying` feeds a Purchase Order. Reading the wrong
  // side is not a cosmetic mistake (a PO would be booked at the price we SELL
  // at), so the side is a parameter and never inferred from context.
  if (side !== "selling" && side !== "buying") {
    throw new Error(`unsupported Item Price side "${side}" (expected selling|buying)`);
  }
  // String filter value — measured rule, same as sales-order-write.mjs /
  // quotation-write.mjs: the pinned ERPNext tool REJECTS a numeric `1`
  // ("Property /filters/0/2 must be string") and the mock validates nothing, so
  // a number here only ever failed against the REAL site. Measured 2026-09-24 by
  // the A2 real loop: this call made every `/ask` for a purchase a 500 before a
  // card existed.
  const filters = [[side, "=", "1"]];
  if (itemCode) filters.push(["item_code", "=", itemCode]);
  const res = await mcp.callTool("erpnext_doc_list", {
    doctype: "Item Price",
    fields: ["name", "item_code", "price_list", "price_list_rate", "currency", "buying", "selling"],
    filters,
    limit,
  });
  const payload = res.data ?? res;
  return markUntrusted("erpnext:erpnext_doc_list(doctype=Item Price)", {
    doctype: "Item Price",
    count: payload.data?.length ?? 0,
    data: payload.data ?? [],
  });
}

/**
 * Find items by name fragment (real tool: erpnext_item_list).
 * @param {object} mcp
 * @param {string} nameFragment
 */
export async function findItem(mcp, nameFragment) {
  assertReadOnly("erpnext_item_list");
  const res = await mcp.callTool("erpnext_item_list", { limit: 100 });
  const payload = res.data ?? res;
  const needle = nameFragment.toLowerCase();
  const matched = (payload.data ?? []).filter(
    (i) => i.item_name?.toLowerCase().includes(needle) || i.name?.toLowerCase().includes(needle),
  );
  return markUntrusted("erpnext:erpnext_item_list", { doctype: "Item", count: matched.length, data: matched });
}
