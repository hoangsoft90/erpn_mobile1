/**
 * Skill: payment (READ-ONLY in Phase 2).
 *
 * Primary tool: erpnext_payment_entry_list (params: party / limit).
 * FALLBACK (verified against real site 2026-09-14): this site's field
 * whitelist rejects the `currency` field the tool always sends (HTTP 417
 * "Trường không được phép trong truy vấn: currency"), so the direct tool can
 * never succeed here. erpnext_doc_list with explicit fields WITHOUT `currency`
 * works (29 entries verified via the same REST endpoint). Phase 7 is where
 * the first WRITE (`create_payment_entry`) lives, behind the Go/No-Go gate.
 */

import { assertReadOnly, assertKnownId, markUntrusted } from "../readonly-guard.mjs";

/** Fields for the fallback read — deliberately WITHOUT `currency` (417). */
const PAYMENT_FIELDS = ["name", "payment_type", "party_type", "party", "posting_date", "paid_amount"];

/**
 * List payment entries (read-only view of what has been received).
 * Tries the dedicated tool first; falls back to erpnext_doc_list when the
 * site rejects the tool's fixed field set (417 currency). Either way the
 * caller sees the same { data: [...] } shape.
 * @param {object} mcp
 * @param {string} customerId  MUST come from a previous tool result
 * @param {Set<string>} knownIds
 */
export async function listPaymentEntries(mcp, customerId, knownIds) {
  assertKnownId(customerId, knownIds);
  try {
    assertReadOnly("erpnext_payment_entry_list");
    const res = await mcp.callTool("erpnext_payment_entry_list", {
      party: customerId,
      party_type: "Customer", // real server: required when filtering by party
      limit: 100,
    });
    return markUntrusted("erpnext:erpnext_payment_entry_list", res.data ?? res);
  } catch (err) {
    const msg = String(err?.message ?? err);
    const isFieldWhitelist = msg.includes("417") || msg.includes("Trường không được phép");
    if (!isFieldWhitelist) throw err; // real failure — surface, never mask
    assertReadOnly("erpnext_doc_list");
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: "Payment Entry",
      fields: PAYMENT_FIELDS,
      filters: [["party", "=", customerId]],
      limit: 100,
      order_by: "posting_date desc",
    });
    const payload = res.data ?? res;
    return markUntrusted("erpnext:erpnext_doc_list", {
      doctype: "Payment Entry",
      count: (payload.data ?? []).length,
      data: payload.data ?? [],
    });
  }
}
