/**
 * Skill: customer (READ-ONLY).
 *
 * Business-level operations instead of handing 120+ raw tools to the LLM.
 * Tool names are the REAL 3.0.4 names (verified in node_modules source).
 * Every customer ID used here MUST come from a previous tool result — each
 * successful read registers returned IDs into `knownIds` so later calls can
 * reference them (and invented ones are refused by readonly-guard).
 */

import { assertReadOnly, assertKnownId, markUntrusted } from "../readonly-guard.mjs";

/** Register every returned customer id so later calls can reference them. */
function registerIds(payload, knownIds) {
  for (const row of payload?.data ?? []) {
    if (row?.name) knownIds.add(row.name);
  }
  return payload;
}

/**
 * Find a customer by (already kinship-stripped) name fragment.
 * Uses erpnext_customer_list (real 3.0.4 params: limit/customer_group/territory)
 * and filters client-side on the name — the real tool has no `txt` search param.
 * @param {object} mcp   client with callTool(tool, args)
 * @param {string} nameFragment
 * @param {Set<string>} knownIds
 */
export async function findCustomer(mcp, nameFragment, knownIds) {
  assertReadOnly("erpnext_customer_list");
  const res = await mcp.callTool("erpnext_customer_list", { limit: 100 });
  const payload = res.data ?? res;
  const needle = nameFragment.toLowerCase();
  const matched = (payload.data ?? []).filter(
    (c) =>
      c.customer_name?.toLowerCase().includes(needle) ||
      c.name?.toLowerCase().includes(needle),
  );
  const wrapped = markUntrusted("erpnext:erpnext_customer_list", {
    doctype: "Customer",
    count: matched.length,
    data: matched,
  });
  registerIds(wrapped.data, knownIds);
  return wrapped;
}

/**
 * Full customer record (includes contact details).
 * `customerId` MUST come from a previous tool result.
 * @param {object} mcp
 * @param {string} customerId
 * @param {Set<string>} knownIds
 */
export async function getCustomer(mcp, customerId, knownIds) {
  assertKnownId(customerId, knownIds);
  assertReadOnly("erpnext_customer_get");
  const res = await mcp.callTool("erpnext_customer_get", { name: customerId });
  return markUntrusted("erpnext:erpnext_customer_get", res.data ?? res);
}

/**
 * Outstanding balance for a customer = sum of unpaid sales invoices
 * (read-only composition; ERPNext stores outstanding on the invoice).
 * @param {object} mcp
 * @param {string} customerId  MUST come from a previous tool result
 * @param {Set<string>} knownIds
 */
export async function getCustomerBalance(mcp, customerId, knownIds) {
  const invoices = await listUnpaidInvoices(mcp, customerId, knownIds);
  const rows = invoices.data?.data ?? [];
  const outstanding = rows.reduce((sum, r) => sum + (Number(r.outstanding_amount) || 0), 0);
  return markUntrusted("derived:customer_balance", {
    customer: customerId,
    outstanding_vnd: outstanding,
    open_invoices: rows.length,
    source: "erpnext_sales_invoice_list",
  });
}

/** Shared by balance + sales skill: unpaid invoices of one customer. */
async function listUnpaidInvoices(mcp, customerId, knownIds) {
  assertKnownId(customerId, knownIds);
  assertReadOnly("erpnext_sales_invoice_list");
  const res = await mcp.callTool("erpnext_sales_invoice_list", { customer: customerId, limit: 100 });
  const payload = res.data ?? res;
  const rows = (payload.data ?? []).filter((r) => Number(r.outstanding_amount) > 0);
  return markUntrusted("erpnext:erpnext_sales_invoice_list", {
    doctype: "Sales Invoice",
    count: rows.length,
    data: rows,
  });
}

export { listUnpaidInvoices };
