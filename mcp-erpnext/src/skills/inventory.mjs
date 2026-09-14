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
