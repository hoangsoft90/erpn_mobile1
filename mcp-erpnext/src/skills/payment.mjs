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
 * List payment entries (read-only view of what has moved with a party).
 * Tries the dedicated tool first; falls back to erpnext_doc_list when the
 * site rejects the tool's fixed field set (417 currency). Either way the
 * caller sees the same { data: [...] } shape.
 *
 * P9-C: `partyType` is a parameter because the same call answers both
 * directions — a supplier's entries are money OUT ("đã chi"), a customer's are
 * money IN ("đã thu"). The real server REQUIRES party_type when filtering by
 * party, so hardcoding "Customer" silently hid every supplier payment
 * (`PAYMENT_FIELDS` above already carries `payment_type`, which is what the
 * caller renders).
 * @param {object} mcp
 * @param {string} partyId  MUST come from a previous tool result
 * @param {Set<string>} knownIds
 * @param {"Customer"|"Supplier"} [partyType]
 */
export async function listPaymentEntries(mcp, partyId, knownIds, partyType = "Customer") {
  assertKnownId(partyId, knownIds);
  const type = partyType === "Supplier" ? "Supplier" : "Customer";
  try {
    assertReadOnly("erpnext_payment_entry_list");
    const res = await mcp.callTool("erpnext_payment_entry_list", {
      party: partyId,
      party_type: type, // real server: required when filtering by party
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
      // Deliberately party-ONLY (no party_type filter): party values are
      // namespaced per master (CUST-… vs SUP-…), so the id alone identifies the
      // side, and a site whose rows predate/omit party_type must not lose its
      // history to an extra predicate. The dedicated tool above still passes
      // party_type because the real server REQUIRES it there.
      filters: [["party", "=", partyId]],
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
