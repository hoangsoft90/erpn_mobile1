/**
 * Skill: purchasing (READ-ONLY) — B1.
 *
 * Supplier resolution hook for the later purchase path (B4). READ only: the only
 * tool touched is `erpnext_supplier_list`, which the read-only guard refuses
 * unless it is explicitly whitelisted (B1 added it there, deliberately — the
 * supplier WRITE tool `erpnext_supplier_create` stays refused by the verb guard).
 *
 * Shape mirrors the pinned @casys/mcp-erpnext 3.0.4 handler verified on the live
 * site 2026-09-20: `{ doctype, count, data: [{ name, supplier_name,
 * supplier_group, supplier_type, email_id, disabled }] }`.
 */

import { assertReadOnly, markUntrusted } from "../readonly-guard.mjs";

/**
 * Register the ids a successful read returned, so a LATER call may use one
 * (readonly-guard.assertKnownId refuses an id that never came from a tool
 * result — the rule that stops a client/AI from inventing an ERPNext id).
 *
 * P9-C: the customer skill has always done this (`customer.mjs#registerIds`);
 * the supplier read never needed it until the PAYMENT path started passing a
 * supplier id into `listPaymentEntries` (pay history) — which then refused with
 * ID_REFUSED because "SUP-HATIEN" had no provenance. Same rule, same place in
 * the flow: the read that produced the id is what registers it.
 */
function registerIds(payload, knownIds) {
  if (!knownIds) return;
  for (const row of payload?.data ?? []) {
    if (row?.name) knownIds.add(row.name);
  }
}

/**
 * Read the supplier master list (optionally filtered by group).
 *
 * The real tool has no free-text search param (same as customers), so filtering
 * by name is client-side — callers pass their own fragment.
 *
 * @param {object} mcp
 * @param {{supplierGroup?: string, includeDisabled?: boolean}} [filters]
 * @param {Set<string>} [knownIds] provenance set — see registerIds
 */
export async function findSupplier(mcp, filters = {}, knownIds = null) {
  assertReadOnly("erpnext_supplier_list");
  const args = { limit: 100 };
  if (filters.supplierGroup) args.supplier_group = filters.supplierGroup;
  if (filters.includeDisabled) args.include_disabled = true;
  const res = await mcp.callTool("erpnext_supplier_list", args);
  const payload = res.data ?? res;
  registerIds(payload, knownIds);
  return markUntrusted("erpnext:erpnext_supplier_list", {
    doctype: "Supplier",
    count: payload.data?.length ?? 0,
    data: payload.data ?? [],
  });
}

/**
 * A2 (e-invoice) — read the supplier master WITH each row's `tax_id`.
 *
 * WHY A SECOND READ INSTEAD OF EXTENDING `findSupplier`: measured on the real
 * site 2026-09-23 through the pinned 3.0.4 server, `erpnext_supplier_list`
 * returns a FIXED projection — {name, supplier_name, supplier_group,
 * supplier_type, email_id, disabled} — and silently DROPS any other field. The
 * generic `erpnext_doc_list` does honour a `fields` argument (probe
 * `.plan/next3/probe-a2-doclist-taxid.mjs`: tax_id=0300000002 → "Đại lý Cám Bình
 * Dương"), so the e-invoice path reads through it instead of building MST
 * matching on a payload that can never carry the value.
 *
 * Still READ-only (the tool is whitelisted) and still untrusted-wrapped; the
 * rows keep the same accessor shape the slot builders use (`name` +
 * `supplier_name`), plus `tax_id`.
 *
 * @param {object} mcp
 * @param {Set<string>} [knownIds] provenance set — see registerIds
 */
export async function listSuppliersWithTaxId(mcp, knownIds = null) {
  assertReadOnly("erpnext_doc_list");
  const res = await mcp.callTool("erpnext_doc_list", {
    doctype: "Supplier",
    fields: ["name", "supplier_name", "tax_id", "disabled"],
    limit: 100,
  });
  const payload = res.data ?? res;
  registerIds(payload, knownIds);
  return markUntrusted("erpnext:erpnext_doc_list:Supplier", {
    doctype: "Supplier",
    count: payload.data?.length ?? 0,
    data: payload.data ?? [],
  });
}
