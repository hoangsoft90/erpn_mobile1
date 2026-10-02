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
import { listOpenSalesInvoices } from "./sales.mjs";

/** Register every returned customer id so later calls can reference them. */
function registerIds(payload, knownIds) {
  for (const row of payload?.data ?? []) {
    if (row?.name) knownIds.add(row.name);
  }
  return payload;
}

/**
 * Per-REQUEST memo of the customer MASTER read (review FINDING 3, 2026-09-30).
 *
 * Reading the whole master is the deliberate cost of F-P5-1 (the page that hid 34
 * customers was the bug), and several call sites in one request may need it (chat
 * picker, balance, drill-down, `/collect/propose`). Re-reading is therefore
 * possible; re-reading is also pointless WITHIN one request, because nothing
 * writes between two master reads and every caller still re-validates the id it
 * was given (HINT-NOT-AUTHORITY).
 *
 * The memo is keyed by the caller's `knownIds` registry — an object each request
 * creates for itself (`copilot-server.mjs`, `read-views.mjs`, `http-ask.mjs`), so
 * the memo can never outlive its request. There is no TTL and nothing to
 * invalidate: the NEXT request reads ERPNext again, which is exactly what the
 * authority rule wants. A caller that passes no registry gets no memo at all.
 */
const masterReadCache = new WeakMap();

/**
 * Find a customer by (already kinship-stripped) name fragment.
 * Uses erpnext_customer_list (real 3.0.4 params: limit/customer_group/territory)
 * and filters client-side on the name — the real tool has no `txt` search param.
 *
 * F-P5-1 (Phase 5, measured 2026-09-30): the read used to pass `limit: 100`, so on
 * a site with more than 100 customers (the real shop has 134) the ~34 rows past
 * the first page were invisible to every resolver built on this function —
 * `/collect/propose` answered `NO_MATCH` for a customer that plainly owes money.
 * `limit: 0` = read the whole master, the same call `customer-create.mjs` already
 * makes for its duplicate pre-check. The returned rows are still only a HINT:
 * callers re-validate the id they were given against this fresh read.
 * @param {object} mcp   client with callTool(tool, args)
 * @param {string} nameFragment
 * @param {Set<string>} knownIds
 * @returns the matching customers, still only a hint
 */
export async function findCustomer(mcp, nameFragment, knownIds) {
  assertReadOnly("erpnext_customer_list");
  let all = knownIds ? masterReadCache.get(knownIds) : null;
  if (!all) {
    const res = await mcp.callTool("erpnext_customer_list", { limit: 0 });
    const payload = res.data ?? res;
    all = payload.data ?? [];
    if (knownIds) masterReadCache.set(knownIds, all);
  }
  const payload = { data: all };
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
 *
 * `company` (next8 §6.4) narrows the sum to the tenant the deployment resolved.
 * Without it the balance adds up invoices from every company on the site, which
 * on a multi-company site reports another tenant's debt as this shop's.
 *
 * @param {object} mcp
 * @param {string} customerId  MUST come from a previous tool result
 * @param {Set<string>} knownIds
 * @param {{company?: string|null}} [opts]
 */
export async function getCustomerBalance(mcp, customerId, knownIds, { company = null } = {}) {
  const invoices = await listUnpaidInvoices(mcp, customerId, knownIds, { company });
  const rows = invoices.data?.data ?? [];
  const outstanding = rows.reduce((sum, r) => sum + (Number(r.outstanding_amount) || 0), 0);
  return markUntrusted("derived:customer_balance", {
    customer: customerId,
    company,
    outstanding_vnd: outstanding,
    open_invoices: rows.length,
    // The balance is only as complete as the read behind it: say so when the read
    // hit its own cap, instead of publishing a partial sum as the whole debt.
    truncated: invoices.data?.truncated === true,
    source: "erpnext_doc_list(doctype=Sales Invoice)",
  });
}

/**
 * Open (unsettled) invoices of one customer — DELEGATES to `sales.mjs`.
 *
 * There used to be two implementations of this read (one here, one in the sales
 * skill) over the same tool, both with `limit: 100` and neither scoped to a
 * company. Two readers of "what does this customer owe" drift apart the moment
 * one of them is fixed; next8 §6.4 fixes the read itself, so the four callers
 * (chat balance, A1 drill-down, proposal builder, collect screen) now share one.
 *
 * The rules it inherits are documented on `listOpenSalesInvoices`:
 * `!== 0` (credit notes count — result20) and `docstatus = 1` (a draft is not yet
 * owed).
 *
 * @param {object} mcp
 * @param {string} customerId
 * @param {Set<string>} knownIds
 * @param {{company?: string|null, cap?: number}} [opts]
 */
async function listUnpaidInvoices(mcp, customerId, knownIds, { company = null, cap } = {}) {
  return listOpenSalesInvoices(mcp, { customerId, company, cap, knownIds });
}

export { listUnpaidInvoices };
