/**
 * Skill: sales (READ-ONLY) — stock + receivables queries.
 * Real 3.0.4 tool names; results are untrusted data; invented IDs refused.
 */

import { assertReadOnly, assertKnownId, markUntrusted } from "../readonly-guard.mjs";

/**
 * Stock balance by item and/or warehouse.
 * Real params: limit / item_code / warehouse (reads the Bin DocType).
 * `itemCode` may be a free-typed name (the real tool resolves it); pass
 * `knownIds` only when the code came from a previous tool result.
 */
export async function stockBalance(mcp, itemCode, knownIds) {
  if (knownIds) assertKnownId(itemCode, knownIds);
  assertReadOnly("erpnext_stock_balance");
  const args = { limit: 100 };
  if (itemCode) args.item_code = itemCode;
  const res = await mcp.callTool("erpnext_stock_balance", args);
  return markUntrusted("erpnext:erpnext_stock_balance", res.data ?? res);
}

/**
 * Open (unsettled) sales invoices for a customer — includes credit notes.
 * Real params for erpnext_sales_invoice_list: customer / limit (+client-side
 * outstanding filter, mirroring what the real handler exposes).
 *
 * `!== 0`, NOT `> 0` — same rule as the customer skill (result20): credit
 * notes carry NEGATIVE outstanding and dropping them overstates the balance.
 */
export async function listUnpaidInvoices(mcp, customerId, knownIds) {
  assertKnownId(customerId, knownIds);
  assertReadOnly("erpnext_sales_invoice_list");
  const res = await mcp.callTool("erpnext_sales_invoice_list", { customer: customerId, limit: 100 });
  const payload = res.data ?? res;
  const rows = (payload.data ?? []).filter((r) => Number(r.outstanding_amount) !== 0);
  return markUntrusted("erpnext:erpnext_sales_invoice_list", {
    doctype: "Sales Invoice",
    count: rows.length,
    data: rows,
  });
}
