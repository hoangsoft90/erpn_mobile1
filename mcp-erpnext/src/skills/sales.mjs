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
 * How many rows one open-invoice read may hold before it must SAY it is bounded.
 *
 * Next8/Phase 0 measured ONE customer with 179 open invoices, and the read this
 * replaces capped at 100 while reporting nothing — the list was 79 documents
 * short with no signal anywhere (plan §2.1(11), lock §6.4). The cap is a memory
 * guard, never a claim about the debt: `truncated` travels with the rows, so the
 * default only has to exceed the largest customer measured on the site (179).
 *
 * NOT exported on purpose: a skill group is a bag of business functions
 * (router.test.mjs enforces that), and the number is not a contract — the
 * BEHAVIOUR (a full page is reported as bounded) is what tests pin.
 */
const OPEN_INVOICE_READ_CAP = 200;

/**
 * Is this row matched by a user's search text?
 *
 * Deliberately dumb and local: the shop searches by invoice number, by date ("15/9",
 * "2026-09-15") or by an amount they remember. Matching on the row's own fields
 * keeps the search honest — nothing is inferred and no ranking is invented.
 */
function matchesQuery(row, needle) {
  const haystack = [
    row.name,
    row.posting_date,
    row.due_date,
    row.outstanding_amount,
    row.grand_total,
  ]
    .map((v) => String(v ?? "").toLowerCase())
    .join(" ");
  // A date typed the Vietnamese way ("15/9") must find "2026-09-15".
  const slashDate = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(needle);
  if (slashDate) {
    const [, d, m, y] = slashDate;
    const iso = `${y ?? ""}${y ? "-" : ""}${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (haystack.includes(iso)) return true;
  }
  return haystack.includes(needle);
}

/**
 * Open (unsettled) sales invoices of ONE customer in ONE company — the single
 * implementation every reader of "what does this customer owe" goes through.
 *
 * Read through the generic `erpnext_doc_list` (free fields/filters), the same way
 * `payment-write.mjs#listOpenPurchaseInvoices` reads the pay side. The tool this
 * replaces (`erpnext_sales_invoice_list`) has a FIXED field set — no `company`,
 * no `docstatus` — and a silent `limit: 100`, which is precisely the read Phase 0
 * flagged as wrong for money (it cannot scope to a tenant, and it cannot say it
 * was cut).
 *
 * Two rules from the existing code survive on purpose:
 *  - `!== 0`, NOT `> 0`: credit notes carry NEGATIVE outstanding and dropping them
 *    overstates the balance (result20: 269.000đ/3 instead of the correct
 *    171.800đ/4).
 *  - `docstatus = 1`: a DRAFT invoice is not yet debt; it becomes one at submit.
 *
 * @param {object} mcp
 * @param {object} p
 * @param {string} p.customerId      customer id (from a previous tool result)
 * @param {string|null} [p.company]  resolved company; `null` means "this caller has
 *   no company" and is reported as such (never guessed, never widened to all tenants)
 * @param {string} [p.query]         free search text (invoice no / date / amount)
 * @param {number} [p.cap]           row cap (default OPEN_INVOICE_READ_CAP)
 * @param {number} [p.offset]        page offset applied to the COMPLETE read
 *   (Phase 3 §5.1). The pinned tool exposes `limit` but NO offset, so paging is
 *   done here, over an already-complete read — never by asking the site for a
 *   "page 2" that does not exist.
 * @param {boolean} [p.complete]     read EVERY row (`limit: 0` — measured on the
 *   real site as "no limit") then slice `[offset, offset+cap)`. Default false
 *   keeps the chat/drill byte-compatible (bounded read, no slicing).
 * @param {Set<string>|null} [p.knownIds]
 * @returns {Promise<object>} markUntrusted payload: `{doctype, company, scanned,
 *   matched, truncated, count, offset, complete, data: page}`
 */
export async function listOpenSalesInvoices(
  mcp,
  { customerId, company = null, query = "", cap = OPEN_INVOICE_READ_CAP, offset = 0, complete = false, knownIds = null } = {},
) {
  if (knownIds) assertKnownId(customerId, knownIds);
  assertReadOnly("erpnext_doc_list");
  const filters = [
    ["customer", "=", customerId],
    // STRING value only: Frappe compares filters as strings, and a numeric `1`
    // here is the classic silently-empty query on the real site (the "no NUMERIC
    // filter literal" tripwire pins this).
    ["docstatus", "=", "1"],
  ];
  if (company) filters.push(["company", "=", company]);

  const res = await mcp.callTool("erpnext_doc_list", {
    doctype: "Sales Invoice",
    fields: [
      "name",
      "customer",
      "company",
      "posting_date",
      "due_date",
      "grand_total",
      "outstanding_amount",
      "debit_to",
      "docstatus",
      "is_return",
      "status",
    ],
    filters,
    // `limit: 0` = "no limit" (measured through the pinned tool 2026-09-24: 20→20,
    // 100→100, 0→all). The complete read is what makes an offset honest.
    limit: complete ? 0 : cap,
  });
  const raw = res?.data?.data ?? [];
  let rows = raw.filter((r) => Number(r.outstanding_amount) !== 0);
  const needle = String(query ?? "").trim().toLowerCase();
  if (needle) rows = rows.filter((r) => matchesQuery(r, needle));

  const matched = rows.length;
  // Paging is a slice of the matched set — never a second query. On the bounded
  // (chat) path there is no slicing, so behaviour is unchanged.
  const start = complete ? Math.max(0, Math.floor(offset) || 0) : 0;
  const page = complete ? rows.slice(start, start + cap) : rows;

  return markUntrusted("erpnext:erpnext_doc_list(doctype=Sales Invoice)", {
    doctype: "Sales Invoice",
    company,
    // `scanned` is what the site returned for the query; `truncated` says there
    // are MORE matched rows than this page shows — so no caller can present a
    // bounded page as the whole debt. A complete read of 179 rows sliced at 10
    // reports `matched: 179, truncated: true`, never "10".
    scanned: raw.length,
    matched,
    truncated: complete ? start + cap < matched : raw.length >= cap,
    count: page.length,
    offset: start,
    complete,
    data: page,
  });
}

/**
 * Open (unsettled) sales invoices for a customer — the name the rest of the
 * codebase already knows.
 *
 * Delegates to `listOpenSalesInvoices` so chat balance, the A1 drill-down, the
 * collect screen and the proposal builder literally run one read. The parameter
 * list stays compatible (`knownIds` third) and the returned `.data.data` shape is
 * unchanged, with `company`/`truncated`/`matched` added.
 */
export async function listUnpaidInvoices(mcp, customerId, knownIds, { company = null, cap } = {}) {
  return listOpenSalesInvoices(mcp, { customerId, company, cap, knownIds });
}

