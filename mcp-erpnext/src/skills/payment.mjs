/**
 * Skill: payment (READ-ONLY in Phase 2).
 *
 * Real tool: erpnext_payment_entry_list (params: party / limit).
 * Phase 7 is where the first WRITE (`create_payment_entry`) lives, behind the
 * Go/No-Go gate — no payment-write code exists here.
 */

import { assertReadOnly, assertKnownId, markUntrusted } from "../readonly-guard.mjs";

/**
 * List payment entries (read-only view of what has been received).
 * @param {object} mcp
 * @param {string} customerId  MUST come from a previous tool result
 * @param {Set<string>} knownIds
 */
export async function listPaymentEntries(mcp, customerId, knownIds) {
  assertKnownId(customerId, knownIds);
  assertReadOnly("erpnext_payment_entry_list");
  const res = await mcp.callTool("erpnext_payment_entry_list", { party: customerId, limit: 100 });
  return markUntrusted("erpnext:erpnext_payment_entry_list", res.data ?? res);
}
