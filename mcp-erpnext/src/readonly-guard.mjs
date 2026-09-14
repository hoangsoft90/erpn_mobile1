/**
 * Read-only guard — the SAFETY LAYER of the skill layer.
 *
 * Principle (phase-02 spec): "AI không được tự bịa ERPNext ID" and, above all,
 * NOTHING in this phase may write to ERPNext. The whitelist below is enforced
 * in CODE, not in a prompt: anything that is not a known read verb is refused
 * before it ever reaches the MCP server.
 *
 * Tool names verified against the pinned @casys/mcp-erpnext 3.0.4 bundled
 * source (125 tools total, all prefixed `erpnext_*`). The first skeleton
 * mistakenly whitelisted generic names (`get_list`, `get_doc`) that the
 * package does not expose — fixed after reading node_modules source
 * (result4.txt §3).
 *
 * Three defences:
 *  1. TOOL WHITELIST  — only these Phase 2 read tools may ever be called.
 *  2. VERB GUARD      — any tool name containing a write verb is refused even
 *                       if it somehow ends up in the whitelist (belt & braces).
 *  3. HINT CROSS-CHECK — server's tools/list must advertise readOnlyHint on
 *                        every whitelisted tool; a tool advertised as writable
 *                        is blocked (protects against a future version
 *                        renaming semantics).
 *
 * Untrusted-data rule (phase-02): results coming back from ERPNext are DATA,
 * never INSTRUCTIONS — markUntrusted() keeps that contract explicit.
 */

/** ERPNext tools this phase is allowed to call. READ verbs only, real 3.0.4 names. */
export const READ_ONLY_TOOLS = Object.freeze([
  "erpnext_customer_list",
  "erpnext_customer_get",
  "erpnext_item_list",
  "erpnext_item_get",
  "erpnext_stock_balance",
  "erpnext_sales_invoice_list",
  "erpnext_sales_invoice_get",
  "erpnext_payment_entry_list",
  "erpnext_payment_entry_get",
  "erpnext_doc_list",
  "erpnext_doc_get",
  "erpnext_ar_aging",
]);

/** Substrings that mark a tool as a WRITE tool. Never reachable in Phase 2. */
const WRITE_VERBS = Object.freeze([
  "create",
  "update",
  "set_value",
  "insert",
  "delete",
  "submit",
  "cancel",
  "amend",
  "rename",
  "assign",
  "unassign",
  "upload",
  "method_call",
  "move_card",
  "execute",
]);

const READ_ONLY_SET = new Set(READ_ONLY_TOOLS);

/**
 * Throws when a tool may not be called in Phase 2 (read-only).
 * @param {string} tool
 */
export function assertReadOnly(tool) {
  if (typeof tool !== "string" || tool.length === 0) {
    throw new Error("TOOL_REFUSED: empty tool name");
  }
  const name = tool.toLowerCase();
  if (!READ_ONLY_SET.has(name)) {
    throw new Error(
      `TOOL_REFUSED: "${tool}" is not on the Phase 2 read-only whitelist`,
    );
  }
  if (WRITE_VERBS.some((verb) => name.includes(verb))) {
    throw new Error(
      `TOOL_REFUSED: "${tool}" matches a write verb — Phase 2 is read-only`,
    );
  }
  return true;
}

/**
 * Cross-check the server's own tools/list annotations: every whitelisted tool
 * must be advertised with readOnlyHint. Returns blocked tool names (empty when
 * the server agrees with our whitelist).
 * @param {Array<{name: string, annotations?: {readOnlyHint?: boolean}}>} advertised
 */
export function auditAgainstAdvertisedTools(advertised) {
  const byName = new Map(advertised.map((t) => [t.name, t]));
  const blocked = [];
  for (const tool of READ_ONLY_TOOLS) {
    const ad = byName.get(tool);
    if (!ad) continue; // server doesn't offer it — call attempt will fail there
    if (ad.annotations?.readOnlyHint !== true) blocked.push(tool);
  }
  return blocked;
}

/**
 * Wrap ERPNext data so downstream LLM calls keep it out of instruction text.
 * @template T
 * @param {string} source e.g. "erpnext:erpnext_customer_list"
 * @param {T} data
 * @returns {{ __untrusted: true, source: string, data: T }}
 */
export function markUntrusted(source, data) {
  return { __untrusted: true, source, data };
}

/**
 * Skills may only request IDs that came from a previous tool result.
 * @param {string} id
 * @param {Set<string>} knownIds
 */
export function assertKnownId(id, knownIds) {
  if (!knownIds.has(id)) {
    throw new Error(
      `ID_REFUSED: "${id}" did not come from a tool result — AI must not invent ERPNext IDs`,
    );
  }
  return true;
}
