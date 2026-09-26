/**
 * Skill: ops (READ-ONLY) — P4-1 `ops.daily_summary` (plan4_final §4, §10 đã chốt).
 *
 * WHAT THIS IS: the server-side aggregate behind the Daily Operations Cockpit.
 * The Flutter client must never sum across APIs (plan4_final §1.4) — every
 * number here is computed in exactly ONE place: this skill.
 *
 * WHAT IT READS: five erpnext_doc_list calls (Sales Order / Sales Invoice /
 * Payment Entry / Company / Account) plus, for the cash drawer, erpnext_doc_list
 * on "GL Entry". Every call goes through assertReadOnly (read-only whitelist +
 * verb guard). There is NO callWriteTool anywhere in this file, and no /execute
 * path: the capability is READ, requires no confirmation, and the response
 * carries no command_id.
 *
 * COMPANY SCOPE: the caller passes the company resolved SERVER-side from the
 * ERPNext session (plan4_final §4.1: the client is never trusted with
 * `company`). This skill never accepts a company string from request data.
 *
 * PARTIAL POLICY (plan4_final §4.3): one failing block never fabricates a 0 —
 * it is recorded in meta.errors and its JSON block becomes null, so the caller
 * shows "Lỗi · Thử lại" for exactly that block while the readable ones stay
 * real. Everything below is written so a failed read can only ever surface as
 * an error or a null, never as a confident zero.
 */

import { assertReadOnly } from "../readonly-guard.mjs";

/** Company rows come from the mock/live site: { name } at minimum. */
function companyName(row) {
  return row?.company ?? row?.name ?? null;
}

/**
 * Row array from whatever shape the caller holds: docList already unwraps
 * client.callTool, but in-process test doubles return {data:[...]} directly.
 */
function rowsOf(wrapped) {
  if (Array.isArray(wrapped)) return wrapped;
  return wrapped?.data?.data ?? wrapped?.data ?? [];
}

/**
 * True when a row belongs to the given company. Company scope is enforced
 * server-side by the ERPNext user's permissions; this only drops rows whose
 * `company` field is known and different, and keeps rows that carry none.
 */
function rowOfCompany(row, company) {
  const c = row?.company;
  return typeof c === "string" && c.length > 0 ? c === company : true;
}

/** Filter docstatus=1 AND status != 'Cancelled' (plan4_final §3.1b). */
function submittedNotCancelled(rows) {
  return rows.filter((r) => r.docstatus === 1 && r.status !== "Cancelled");
}

/**
 * Cash|Bank classifier for a money account (plan4 P4-0, docs/plan4-mode-map.md):
 * primary = the ACCOUNT's account_type; fallback = the company's default
 * accounts; else it stays unclassified — never guessed into cash/bank.
 */
function classifyMoneyAccount(accountName, { accountsByCompany, companyDefaults }) {
  const t = accountsByCompany[accountName] ?? null;
  if (t === "Cash") return "cash";
  if (t === "Bank") return "bank";
  if (companyDefaults) {
    if (companyDefaults.cash && accountName === companyDefaults.cash) return "cash";
    if (companyDefaults.bank && accountName === companyDefaults.bank) return "bank";
  }
  return "unclassified";
}

function emptyBuckets() {
  return { cash: 0, bank: 0, unclassified: 0 };
}

function addInto(buckets, kind, amount) {
  buckets[kind] += Number(amount) || 0;
}

/** VND rounding per contract defaults (amount_precision.VND = 0). */
function vnd(n) {
  return Math.round(Number(n) || 0);
}

/**
 * D1 — the footnote §3.1 prescribes VERBATIM on every drawer money view: the
 * figures are the BOOKS' figures, open draft payments are NOT subtracted (and
 * §9 forbids subtracting them), so the hint line below exists to reconcile
 * what the user may know from a chat proposal instead of changing the number.
 */
const DRAWER_FOOTNOTE = "Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp).";

/**
 * D1 (§3.1 UX bridge) — the OPTIONAL draft-payment hint, COMPANY-wide.
 *
 * Reads the shop's OPEN DRAFT Payment Entries (docstatus 0, both directions)
 * and reports only A COUNT + what they promise (paid_amount). Deliberately NOT
 * per-invoice allocation matching: the drawer shows company-wide debts, a draft
 * PE's `references` point at specific invoices, and reconciling the two views
 * would mean computing an "effective" receivable here — exactly the number §9
 * forbids the drawer from showing. The chat proposal (P9-D) keeps the precise
 * effective math; the drawer gets the count hint only.
 *
 * NEVER throws: the hint is decoration on a view whose money is already
 * correct. A site that cannot read draft PEs gives NO hint — it must not turn
 * a readable debt list into an error page (the hint's own failure is not the
 * user's problem).
 *
 * @param {object} mcp
 * @param {string} company resolved SERVER-side
 * @returns {Promise<{count:number, amount_vnd:number}|null} null when nothing open or unreadable
 */
async function openDraftCompanyHint(mcp, company) {
  try {
    const res = await docList(mcp, "Payment Entry", {
      fields: ["name", "docstatus", "payment_type", "paid_amount", "received_amount", "company"],
      filters: [["docstatus", "=", "0"]],
      limit: 500,
    });
    const drafts = rowsOf(res).filter((r) => rowOfCompany(r, company));
    if (drafts.length === 0) return null;
    // Same money side the receipts block uses: Receive carries received_amount,
    // Pay carries paid_amount — fall back across so one expression covers both
    // directions (a mixed count is the point of a company-wide hint).
    const amount = drafts.reduce((s, r) => s + (Number(r.received_amount) || Number(r.paid_amount) || 0), 0);
    return { count: drafts.length, amount_vnd: vnd(amount) };
  } catch {
    // Readable-debt + unreadable-hint ⇒ the hint field stays null: the client
    // treats "no hint" and "hint unreadable" the same way — nothing shown.
    return null;
  }
}

/**
 * Read rows via the whitelisted generic list tool. Throws on any error.
 *
 * Two guards here, both from MEASURED real-tool behaviour (2026-09-21):
 *
 *  - FILTER VALUES MUST BE STRINGS. The real tool rejects `["docstatus","=",1]`
 *    with "Property /filters/0/2 must be string" while the mock validates
 *    nothing — a numeric filter therefore passes every run of this suite and
 *    only fails on the site. A runtime check here would be unfalsifiable (every
 *    filter in this file is a literal), so the invariant is pinned instead by a
 *    static tripwire in test/p4-ops-summary.test.mjs.
 *  - `count` is the number of rows RETURNED (limit 3 → count 3), so a full page
 *    cannot be told from a truncated one by inspecting it. We ask for ONE row
 *    more than we accept: a silently truncated sum is a wrong MONEY number,
 *    which this project treats as worse than a missing one.
 *
 * Unwrap: client.callTool returns {__untrusted, source, data:<payload>} where
 * <payload> is the 3.0.4 tool shape {doctype, count, data:[...]}; client.callTool
 * has already applied markUntrusted, so this returns the plain row array.
 */
async function docList(mcp, doctype, { fields, filters, limit = 500, order_by }) {
  assertReadOnly("erpnext_doc_list");
  const res = await mcp.callTool("erpnext_doc_list", { doctype, fields, filters, limit: limit + 1, order_by });
  const payload = res?.data ?? {};
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : null;
  // Fail-closed on a malformed payload: a non-array (e.g. a site error object
  // or a string) must THROW as ERP_UNAVAILABLE, never be iterated as garbage —
  // iterating a string silently yields characters and every classification
  // downstream would run on invented data.
  if (!rows) {
    throw new Error(`ERP_MALFORMED_RESPONSE: ${doctype} list did not return an array`);
  }
  if (rows.length > limit) {
    throw new Error(`ERP_TRUNCATED: ${doctype} matched more than ${limit} rows — refusing to sum a partial page`);
  }
  return rows;
}

export async function getDailySummary(mcp, { date, company, tz, erpTarget = null }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("OPS_DATE_REQUIRED: date (YYYY-MM-DD, Asia/Ho_Chi_Minh) is required");
  }
  if (!company || typeof company !== "string") {
    throw new Error("COMPANY_UNRESOLVED: company must come from the ERPNext session, never from the client");
  }

  const errors = [];
  /** Run one aggregate branch; on failure record a partial error (never a 0). */
  async function branch(label, fn) {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      errors.push({ block: label, code: "ERP_UNAVAILABLE", detail: String(err?.message ?? err).slice(0, 300) });
      return { ok: false };
    }
  }

  // ---- shared lookups (company master data + account types) ----
  async function companyDefaults() {
    const rows = await docList(mcp, "Company", {
      fields: ["name", "default_cash_account", "default_bank_account"],
      filters: [["name", "=", company]],
      limit: 1,
    });
    const row = rows.find((r) => companyName(r) === company) ?? rows[0];
    if (!row) throw new Error(`Company ${company} not readable`);
    return { cash: row.default_cash_account ?? null, bank: row.default_bank_account ?? null };
  }

  async function accountTypes() {
    const rows = await docList(mcp, "Account", {
      fields: ["name", "account_type"],
      filters: [["company", "=", company]],
      limit: 2000,
    });
    const map = {};
    for (const row of rows) map[row.name] = row.account_type ?? null;
    return map;
  }

  // ---- 1. Sales Orders: submitted AND draft, TÁCH BẠCH (§10.1) ----
  async function salesOrders() {
    const res = await docList(mcp, "Sales Order", {
      fields: ["name", "docstatus", "status", "grand_total", "transaction_date", "company"],
      filters: [["transaction_date", "=", date]],
      limit: 1000,
    });
    const rows = rowsOf(res).filter((r) => rowOfCompany(r, company));
    const submitted = rows.filter((r) => r.docstatus === 1 && r.status !== "Cancelled");
    // Draft SO policy (§3.3): drafts are SHOWN (the app creates them all day),
    // never merged into the submitted totals.
    const drafts = rows.filter((r) => r.docstatus === 0 && r.status !== "Cancelled");
    const sum = (list) => list.reduce((s, r) => s + (Number(r.grand_total) || 0), 0);
    return {
      submitted: { count: submitted.length, amount: vnd(sum(submitted)) },
      draft: { count: drafts.length, amount: vnd(sum(drafts)) },
    };
  }

  // ---- 2. Sales Invoices: submitted, not cancelled, grand_total (§3.1/§3.1b/§10.5) ----
  async function salesInvoices() {
    const res = await docList(mcp, "Sales Invoice", {
      fields: ["name", "docstatus", "status", "grand_total", "posting_date", "company"],
      filters: [["posting_date", "=", date]],
      limit: 1000,
    });
    // §3.5: returns/credit notes never inflate the day's invoice amount — a
    // return is EXCLUDED from sales_invoices entirely (and must never surface
    // as a fabricated 0 elsewhere; the `returns` block stays null in V1).
    const rows = submittedNotCancelled(rowsOf(res).filter((r) => rowOfCompany(r, company) && !r.is_return));
    const amount = rows.reduce((s, r) => s + (Number(r.grand_total) || 0), 0);
    return { count: rows.length, amount: vnd(amount), includes_draft: false };
  }

  // ---- 3. Payment Entries: submitted, not cancelled, split receive/pay + advance ----
  async function paymentEntries() {
    const res = await docList(mcp, "Payment Entry", {
      fields: [
        "name", "docstatus", "status", "posting_date", "payment_type", "party_type",
        "paid_amount", "received_amount", "paid_to", "paid_from", "company",
        "unallocated_amount", "reference_no",
      ],
      filters: [["posting_date", "=", date]],
      limit: 2000,
    });
    const rows = submittedNotCancelled(rowsOf(res).filter((r) => rowOfCompany(r, company)));

    const [{ ok: accOk, value: acc }, { ok: defOk, value: defs }] = await Promise.all([
      branch("accounts", accountTypes),
      branch("company_defaults", companyDefaults),
    ]);
    const accountsByCompany = accOk ? acc : {};
    // NOT named companyDefaults: that identifier is the helper function above;
    // shadowing it TDZ'd the very branch call that took the helper as its arg.
    const defaults = defOk ? defs : null;

    /** Amount + money account per payment_type (money side = where the cash went). */
    function sideOf(row) {
      return row.payment_type === "Pay" ? row.paid_from : row.paid_to;
    }
    function amountOf(row) {
      return Number(row.payment_type === "Pay" ? row.paid_amount : row.received_amount) || 0;
    }
    function classify(row) {
      return classifyMoneyAccount(sideOf(row), { accountsByCompany, companyDefaults: defaults });
    }

    // plan4 §3.2: against_invoice = PE with at least one invoice allocation
    // (PE.references). unallocated_amount was VERIFIED on the real site
    // (2026-09-21, result-p4-0 probe); the review3 "references is empty" SQL was
    // explicitly NOT copied (§7.12 warning) — get_list drops the child table.
    const receive = rows.filter((r) => r.payment_type === "Receive");
    const pay = rows.filter((r) => r.payment_type === "Pay");
    const againstInvoice = receive.filter((r) => Array.isArray(r.references) && r.references.length > 0);
    const advances = receive.filter((r) => !Array.isArray(r.references) || r.references.length === 0);

    const sumSplit = (list) => {
      const b = emptyBuckets();
      for (const r of list) addInto(b, classify(r), amountOf(r));
      return { cash: vnd(b.cash), bank: vnd(b.bank), unclassified: vnd(b.unclassified) };
    };
    const splitTotal = (s) => s.cash + s.bank + s.unclassified;
    const receiptsSplit = sumSplit(againstInvoice);
    const advancesSplit = sumSplit(advances);
    const paySplit = sumSplit(pay);
    const receiptsTotal = splitTotal(receiptsSplit);
    const advancesTotal = splitTotal(advancesSplit);
    const totalIn = receiptsTotal + advancesTotal;
    const totalOut = splitTotal(paySplit);

    return {
      rows,
      classify,
      receipts: {
        against_invoice: vnd(receiptsTotal),
        advances: vnd(advancesTotal),
        cash: vnd(receiptsSplit.cash + advancesSplit.cash),
        bank: vnd(receiptsSplit.bank + advancesSplit.bank),
        unclassified: vnd(receiptsSplit.unclassified + advancesSplit.unclassified),
        total: vnd(totalIn),
      },
      payments_out: {
        cash: paySplit.cash,
        bank: paySplit.bank,
        unclassified: paySplit.unclassified,
        total: vnd(totalOut),
        includes_journal_entry: false,
        footnote: "Chưa gồm chi qua Journal Entry",
      },
    };
  }

  // ---- 4. Receivables: CURRENT outstanding (not as-of; plan4 §3.4) ----
  async function receivables() {
    const res = await docList(mcp, "Sales Invoice", {
      fields: ["name", "docstatus", "status", "outstanding_amount", "due_date", "grand_total", "posting_date", "company"],
      // String values only (the real tool rejects a numeric 1 — see docList).
      // `outstanding_amount > 0` is pushed to the SERVER: it drops the already
      // paid rows AND the negative credit notes (result20 rule), which keeps
      // this not-restricted-by-date query far from its page limit.
      filters: [["docstatus", "=", "1"], ["outstanding_amount", ">", "0"]],
      limit: 2000,
    });
    const rows = submittedNotCancelled(rowsOf(res).filter((r) => rowOfCompany(r, company)));
    const outstanding = rows.reduce((s, r) => s + Number(r.outstanding_amount), 0);
    const overdueRows = rows.filter((r) => r.due_date && r.due_date < date);
    const overdue = overdueRows.reduce((s, r) => s + Number(r.outstanding_amount), 0);
    return {
      outstanding_total: vnd(outstanding),
      overdue_total: vnd(overdue),
      overdue_count: overdueRows.length,
      as_of: "current",
    };
  }

  // ---- 5. App drafts: copilot-written docs today (custom_ai_action_id set) ----
  // §4.4 wants ONLY copilot drafts (correlation id set), never every draft on
  // the site. When a doctype cannot be filtered by that field the read THROWS
  // and this branch FAILS — the honest outcome. HISTORY (both halves measured):
  // until 2026-09-21 the real site had `custom_ai_action_id` on Payment Entry
  // only (Custom Field meta: 0 rows for Sales Order / Quotation / Purchase
  // Order), so this block failed and was reported as partial — the blanket
  // catch it originally had would instead have published a confident "0 nháp"
  // for a question the site could not answer at all (§4.3 forbids inheriting a
  // 0 from a failed branch). The operator migration has since created the field
  // on all four doctypes (result-p4-3.txt §7), which is what makes this block
  // readable now — NO code change was needed, by design: the branch was always
  // written to query all four and to fail loudly when it could not.
  async function appDrafts() {
    const doctypes = ["Sales Order", "Quotation", "Purchase Order", "Payment Entry"];
    const byType = {};
    for (const doctype of doctypes) {
      // Payment Entry dates on `posting_date`; the order documents on
      // `transaction_date`.
      const dateField = doctype === "Payment Entry" ? "posting_date" : "transaction_date";
      const res = await docList(mcp, doctype, {
        fields: ["name", "docstatus", "custom_ai_action_id", dateField, "company"],
        filters: [["custom_ai_action_id", "is", "set"]],
        limit: 500,
      });
      // Company scoping, same rule as every other block: a row WITHOUT a
      // company value passes (doc-level company is optional on these doctypes)
      // but a row BELONGING TO ANOTHER company must never be counted as this
      // shop's draft.
      const count = rowsOf(res)
        .filter((r) => r.docstatus === 0 && rowOfCompany(r, company) && (r[dateField] ?? null) === date)
        .length;
      if (count > 0) byType[doctype] = count;
    }
    return { count: Object.values(byType).reduce((s, n) => s + n, 0), by_type: byType };
  }

  // ---- 6. Cash drawer: opening from GL before 00:00 VN on the default cash account ----
  async function cashDrawer() {
    const defs = await companyDefaults();
    if (!defs.cash) return null; // §10.3 / §3.6: no configured opening → hide the block
    // Sum the cash account's GL up to (not including) 00:00 VN of `date`:
    // posting_date <= day-before. is_cancelled=0 — cancelled vouchers must not
    // move the opening (same §3.1b reasoning, GL side).
    const dayBefore = new Date(`${date}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const ymd = dayBefore.toISOString().slice(0, 10);
    const res = await docList(mcp, "GL Entry", {
      fields: ["posting_date", "account", "debit", "credit", "is_cancelled"],
      filters: [["account", "=", defs.cash], ["posting_date", "<=", ymd]],
      limit: 100000,
    });
    let opening = 0;
    for (const row of rowsOf(res)) {
      if (row.is_cancelled) continue;
      opening += (Number(row.debit) || 0) - (Number(row.credit) || 0);
    }
    // Only the OPENING comes from here. Cash in/out are taken from the receipts
    // block of the SAME response (§3.6 — one aggregate, one truth); returning
    // zeroed flows from this function would be a trap for the next caller, so
    // they are not returned at all.
    return { opening: vnd(opening), account: defs.cash };
  }

  // ---- assemble with partial semantics ----
  const [so, si, pe, rc, drafts, drawer] = await Promise.all([
    branch("sales_orders", salesOrders),
    branch("sales_invoices", salesInvoices),
    branch("receipts", paymentEntries),
    branch("receivables", receivables),
    branch("app_drafts", appDrafts),
    branch("cash_drawer", cashDrawer),
  ]);

  // §4.3 partial: a failing block is RECORDED and its JSON block becomes null —
  // the UI shows "Lỗi · Thử lại" for exactly those blocks. Nothing is invented
  // and the surviving blocks stay real. (An earlier draft threw the whole call
  // away here: stricter than the spec, and it hid the blocks that DID succeed.)

  const peOk = pe.ok;
  const receipts = peOk ? pe.value.receipts : null;
  let cashDrawerBlock = null;
  if (drawer.ok && drawer.value && peOk) {
    // §3.6: Két (dự kiến) = Đầu ngày + Thu TM − Chi TM (both from THIS response,
    // never re-queried — one aggregate, one truth).
    cashDrawerBlock = {
      opening: drawer.value.opening,
      cash_in_today: pe.value.receipts.cash,
      cash_out_today: pe.value.payments_out.cash,
      expected_closing: vnd(drawer.value.opening + pe.value.receipts.cash - pe.value.payments_out.cash),
      account: drawer.value.account,
      includes_bank: false,
    };
  } else if (drawer.ok && drawer.value && !peOk) {
    // Opening was readable but the day's cash flows are not: showing a
    // "dự kiến" without flows would be half-invented ⇒ hide + say why.
    errors.push({ block: "cash_drawer", code: "PARTIAL_DATA", detail: "receipts unavailable — opening known but cash in/out unknown" });
  }

  return {
    ok: true,
    meta: {
      date,
      timezone: tz ?? "Asia/Ho_Chi_Minh",
      generated_at: new Date().toISOString(),
      source: "real",
      // Which ERPNext these numbers came from (`"REAL"` / `"MOCK"`, from
      // copilot-server.mjs#erpTargetLabel). The drawer MUST show it next to the
      // numbers: a fixture day and a real day look identical otherwise, and
      // §6 only lets an empty day read as "hôm nay không có gì" when the data
      // is real. null when the caller did not supply it — never a guessed
      // "REAL".
      erp_target: erpTarget,
      company,
      partial: errors.length > 0,
      errors,
    },
    sales_orders: so.ok ? so.value : null,
    sales_invoices: si.ok ? si.value : null,
    receipts,
    payments_out: peOk ? pe.value.payments_out : null,
    receivables: rc.ok ? rc.value : null,
    app_drafts: drafts.ok ? drafts.value : null,
    cash_drawer: cashDrawerBlock,
    returns: null, // §3.5: not readable as an aggregate in V1 — null, not 0
  };
}

/**
 * P4-4 — the ROW-LEVEL reads behind the day drill-downs (plan4_final §4.4).
 *
 * Why this lives in the SAME file as the aggregate: the list a user taps into
 * must be the rows the number above it was computed from. Two modules with
 * their own copies of these filters is how a screen starts saying "quá hạn
 * 5.400.000" while the list under it sums to something else — the drift C2
 * already paid for once ("a second extractor is where the user confirmed one
 * thing and the document says another"). The filters, the company rule and the
 * submitted/not-cancelled rule below are the same ones `getDailySummary` uses,
 * and `test/p44-read-drill.test.mjs` asserts the drill rows ADD UP to the
 * aggregate's own numbers on the same fixture — that test is the guard that
 * keeps this promise from rotting silently.
 *
 * Bounded on purpose: the caller (drill-views) clamps the page size from the
 * CONTRACT and reports `total_documents` + `truncated`, so a capped list can
 * never be mistaken for the whole day.
 *
 * READ-only: only `docList` (whitelisted list tool) is used, no write surface.
 *
 * @param {object} mcp
 * @param {{drillId:string, date:string, company:string}} args
 * @returns {Promise<{summary_lines:Array, rows:Array}>}
 */
export async function readDayDrill(mcp, { drillId, date, company, env = process.env }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("OPS_DATE_REQUIRED: date (YYYY-MM-DD) is required");
  if (!company) throw new Error("COMPANY_UNRESOLVED: company must come from the ERPNext session");

  if (drillId === "sales_orders_today") {
    const res = await docList(mcp, "Sales Order", {
      fields: ["name", "docstatus", "status", "grand_total", "transaction_date", "company"],
      filters: [["transaction_date", "=", date]],
      limit: 1000,
    });
    const rows = rowsOf(res).filter((r) => rowOfCompany(r, company));
    const submitted = rows.filter((r) => r.docstatus === 1 && r.status !== "Cancelled");
    const drafts = rows.filter((r) => r.docstatus === 0 && r.status !== "Cancelled");
    const toRow = (r, kind) => ({
      name: r.name,
      date: r.transaction_date ?? null,
      amount_vnd: vnd(r.grand_total),
      // The note comes from the SERVER so a draft can never be labelled as a
      // real order by whoever renders the row (§10.1 keeps them apart).
      note: kind === "submitted" ? "Đã ghi" : "Nháp — chưa ghi sổ",
      kind,
    });
    return {
      summary_lines: [
        { label: "Đã ghi", amount_vnd: vnd(submitted.reduce((s, r) => s + (Number(r.grand_total) || 0), 0)), count: submitted.length },
        { label: "Nháp", amount_vnd: vnd(drafts.reduce((s, r) => s + (Number(r.grand_total) || 0), 0)), count: drafts.length },
      ],
      rows: [...submitted.map((r) => toRow(r, "submitted")), ...drafts.map((r) => toRow(r, "draft"))],
    };
  }

  if (drillId === "invoices_today") {
    const res = await docList(mcp, "Sales Invoice", {
      fields: ["name", "docstatus", "status", "grand_total", "outstanding_amount", "posting_date", "company", "is_return"],
      filters: [["posting_date", "=", date]],
      limit: 1000,
    });
    // SAME set the `sales_invoices` block sums: submitted, not cancelled, not a
    // return (§3.1b/§3.5).
    const rows = submittedNotCancelled(rowsOf(res).filter((r) => rowOfCompany(r, company) && !r.is_return));
    const amount = vnd(rows.reduce((s, r) => s + (Number(r.grand_total) || 0), 0));
    return {
      summary_lines: [{ label: "Hóa đơn đã xuất (giá trị sau VAT)", amount_vnd: amount, count: rows.length }],
      rows: rows
        .map((r) => ({
          name: r.name,
          date: r.posting_date ?? null,
          amount_vnd: vnd(r.grand_total),
          outstanding_vnd: vnd(r.outstanding_amount),
          note: Number(r.outstanding_amount) > 0 ? "Còn nợ" : "Đã trả",
          kind: "invoice",
        }))
        .sort((a, b) => (a.amount_vnd !== b.amount_vnd ? b.amount_vnd - a.amount_vnd : String(b.name).localeCompare(String(a.name)))),
    };
  }

  if (drillId === "receipts_today") {
    const res = await docList(mcp, "Payment Entry", {
      fields: ["name", "docstatus", "status", "posting_date", "payment_type", "paid_amount", "received_amount", "paid_to", "company", "reference_no", "references"],
      filters: [["posting_date", "=", date]],
      limit: 2000,
    });
    const rows = submittedNotCancelled(rowsOf(res).filter((r) => rowOfCompany(r, company)));
    const receive = rows.filter((r) => r.payment_type === "Receive");
    // Same split as the `receipts` block: allocation present ⇒ against invoice,
    // none ⇒ advance (§3.2).
    const withAlloc = receive.filter((r) => Array.isArray(r.references) && r.references.length > 0);
    const advances = receive.filter((r) => !Array.isArray(r.references) || r.references.length === 0);
    const amountOf = (r) => vnd(r.received_amount);
    const sum = (list) => vnd(list.reduce((s, r) => s + (Number(r.received_amount) || 0), 0));
    const toRow = (r, kind) => ({
      name: r.name,
      date: r.posting_date ?? null,
      amount_vnd: amountOf(r),
      // The account name is the money side; the note says which kind of receipt
      // it was, so "thu 11.430.000" can be read apart from "ứng trước".
      note: kind === "receipt_against_invoice" ? "Theo hóa đơn" : "Ứng trước (chưa gắn HĐ)",
      kind,
    });
    return {
      summary_lines: [
        { label: "Theo hóa đơn", amount_vnd: sum(withAlloc), count: withAlloc.length },
        { label: "Ứng trước", amount_vnd: sum(advances), count: advances.length },
        { label: "Tổng thu (chưa gồm tiền mặt/bank tách theo tài khoản)", amount_vnd: sum(receive), count: receive.length },
      ],
      rows: [
        ...withAlloc.map((r) => toRow(r, "receipt_against_invoice")),
        ...advances.map((r) => toRow(r, "receipt_advance")),
      ],
    };
  }

  if (drillId === "overdue_customers") {
    const res = await docList(mcp, "Sales Invoice", {
      fields: ["name", "docstatus", "status", "outstanding_amount", "due_date", "posting_date", "customer", "company"],
      // Exactly the `receivables` filters (string values — the real tool rejects
      // a numeric filter value).
      filters: [["docstatus", "=", "1"], ["outstanding_amount", ">", "0"]],
      limit: 2000,
    });
    const rows = submittedNotCancelled(rowsOf(res).filter((r) => rowOfCompany(r, company)));
    const overdue = rows.filter((r) => r.due_date && r.due_date < date);
    const byCustomer = new Map();
    for (const r of overdue) {
      const key = r.customer ?? "(không rõ khách)";
      const cur = byCustomer.get(key) ?? { customer: key, overdue_vnd: 0, count: 0 };
      cur.overdue_vnd += Number(r.outstanding_amount) || 0;
      cur.count += 1;
      byCustomer.set(key, cur);
    }
    const list = [...byCustomer.values()].map((c) => ({
      name: c.customer,
      date: null,
      amount_vnd: vnd(c.overdue_vnd),
      note: `Quá hạn · ${c.count} hóa đơn`,
      kind: "overdue_customer",
    }));
    list.sort((a, b) => (a.amount_vnd !== b.amount_vnd ? b.amount_vnd - a.amount_vnd : String(a.name).localeCompare(String(b.name))));
    return {
      summary_lines: [
        { label: "Tổng quá hạn", amount_vnd: vnd(overdue.reduce((s, r) => s + (Number(r.outstanding_amount) || 0), 0)), count: overdue.length },
        { label: "Khách có nợ quá hạn", amount_vnd: null, count: list.length },
      ],
      rows: list,
    };
  }

  // ── D1 (drawer-plan-final §3.1) — the COMPANY-WIDE debtor views ────────────
  // Shared read for BOTH drawer entries: every submitted, not-cancelled sales
  // invoice with outstanding > 0 — the EXACT set the `receivables` block sums
  // (§3.1: the list the user opens must be the rows the number came from, the
  // same anti-drift promise the day drills keep). NOT date-filtered.
  //
  // GL RAW, NO draft subtraction (§9 explicitly forbids subtracting Draft PE
  // from the drawer's figures): ERPNext lowers `outstanding_amount` only at
  // SUBMIT, so the number here is what the books have RECORDED. What the open
  // drafts promise travels separately as an OPTIONAL hint line — the same split
  // P9-D draws on the payment proposal, and `openDraftCompanyHint` below reads
  // it without ever touching the figure above.
  async function companyDebtRows() {
    const res = await docList(mcp, "Sales Invoice", {
      fields: ["name", "docstatus", "status", "outstanding_amount", "due_date", "posting_date", "customer", "company"],
      filters: [["docstatus", "=", "1"], ["outstanding_amount", ">", "0"]],
      limit: 2000,
    });
    return submittedNotCancelled(rowsOf(res).filter((r) => rowOfCompany(r, company)));
  }

  if (drillId === "receivable_customers") {
    const rows = await companyDebtRows();
    const byCustomer = new Map();
    for (const r of rows) {
      const key = r.customer ?? "(không rõ khách)";
      const cur = byCustomer.get(key) ?? { customer: key, outstanding_vnd: 0, count: 0, overdue_vnd: 0, oldest_overdue: null };
      const amount = Number(r.outstanding_amount) || 0;
      cur.outstanding_vnd += amount;
      cur.count += 1;
      if (r.due_date && r.due_date < date) {
        cur.overdue_vnd += amount;
        if (cur.oldest_overdue === null || r.due_date < cur.oldest_overdue) cur.oldest_overdue = r.due_date;
      }
      byCustomer.set(key, cur);
    }
    // §3.1: outstanding DESC, secondary by name (stable, no money tiebreak games).
    const list = [...byCustomer.values()]
      .map((c) => ({
        name: c.customer,
        date: null,
        amount_vnd: vnd(c.outstanding_vnd),
        note:
          c.overdue_vnd > 0
            ? `${c.count} hóa đơn · quá hạn ${vnd(c.overdue_vnd)}đ (lâu nhất ${c.oldest_overdue})`
            : `${c.count} hóa đơn`,
        kind: "receivable_customer",
      }))
      .sort((a, b) => (a.amount_vnd !== b.amount_vnd ? b.amount_vnd - a.amount_vnd : String(a.name).localeCompare(String(b.name))));
    // §3.1 UX bridge — the OPTIONAL hint line: how many open draft payments
    // exist and what they promise, NEVER folded into the figures above.
    const hint = await openDraftCompanyHint(mcp, company);
    return {
      summary_lines: [
        { label: "Tổng còn nợ (theo sổ)", amount_vnd: vnd(rows.reduce((s, r) => s + (Number(r.outstanding_amount) || 0), 0)), count: rows.length },
        { label: "Khách còn nợ", amount_vnd: null, count: list.length },
      ],
      rows: list,
      footnote: DRAWER_FOOTNOTE,
      draft_hint: hint,
    };
  }

  if (drillId === "overdue_top") {
    const rows = await companyDebtRows();
    const overdue = rows.filter((r) => r.due_date && r.due_date < date);
    // days_overdue is DERIVED here, server-side, from the invoice's own due_date
    // (D0 measured: Sales Invoice has no such field) against the SAME `date`
    // argument every drill uses — UTC date arithmetic, no timezone gymnastics:
    // both strings are YYYY-MM-DD, so a day is a day.
    const daysOverdue = (r) => {
      const ms = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${r.due_date}T00:00:00Z`);
      return Math.max(1, Math.round(ms / 86_400_000));
    };
    const byCustomer = new Map();
    for (const r of overdue) {
      const key = r.customer ?? "(không rõ khách)";
      const cur = byCustomer.get(key) ?? { customer: key, overdue_vnd: 0, count: 0, oldest: null };
      cur.overdue_vnd += Number(r.outstanding_amount) || 0;
      cur.count += 1;
      if (cur.oldest === null || r.due_date < cur.oldest) cur.oldest = r.due_date;
      byCustomer.set(key, cur);
    }
    // §3.1: days_overdue (nợ lâu trước) DESC, secondary outstanding DESC. The
    // customer's own days are the OLDEST overdue invoice's — sorting by a
    // weighted average would be computing money-adjacent policy here.
    const list = [...byCustomer.values()]
      .map((c) => {
        const days = Math.max(1, Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${c.oldest}T00:00:00Z`)) / 86_400_000));
        return {
          name: c.customer,
          date: c.oldest,
          amount_vnd: vnd(c.overdue_vnd),
          note: `Nợ lâu nhất ${days} ngày · ${c.count} hóa đơn`,
          kind: "overdue_top_customer",
        };
      })
      .sort((a, b) => a.date !== b.date ? a.date.localeCompare(b.date) : b.amount_vnd - a.amount_vnd);
    const hint = await openDraftCompanyHint(mcp, company);
    return {
      summary_lines: [
        { label: "Tổng quá hạn", amount_vnd: vnd(overdue.reduce((s, r) => s + (Number(r.outstanding_amount) || 0), 0)), count: overdue.length },
        { label: "Khách có nợ quá hạn", amount_vnd: null, count: list.length },
      ],
      rows: list,
      footnote: DRAWER_FOOTNOTE,
      draft_hint: hint,
    };
  }

  // ── D1c (drawer-plan-final §3.2) — "HĐ chưa trả": the invoice-level view.
  // CHỈ Sales Invoice docstatus=1 AND outstanding_amount>0, MỌI NGÀY — §3.2 has
  // no date condition, and a "PE-able" abstraction is explicitly forbidden (the
  // row IS an invoice, nothing else). Same shared read as the debt drills, so
  // per-customer sums of this list still reconcile with receivable_customers;
  // `outstanding > 0` already keeps returns (negative) out.
  if (drillId === "unpaid_invoices") {
    const rows = await companyDebtRows();
    const list = rows
      .map((r) => ({
        name: r.name,
        date: r.due_date ?? null,
        amount_vnd: vnd(r.outstanding_amount),
        note: r.customer ?? "(không rõ khách)",
        kind: "unpaid_invoice",
      }))
      // §3.2 has no mandated sort; biggest remaining debt first, then the
      // nearest due date — stable, no money recomputed.
      .sort((a, b) =>
        a.amount_vnd !== b.amount_vnd
          ? b.amount_vnd - a.amount_vnd
          : String(a.date ?? "9999-12-31").localeCompare(String(b.date ?? "9999-12-31")),
      );
    const hint = await openDraftCompanyHint(mcp, company);
    return {
      summary_lines: [
        { label: "Tổng còn phải thu", amount_vnd: vnd(rows.reduce((s, r) => s + (Number(r.outstanding_amount) || 0), 0)), count: rows.length },
        { label: "Hóa đơn chưa trả", amount_vnd: null, count: list.length },
      ],
      rows: list,
      footnote: DRAWER_FOOTNOTE,
      draft_hint: hint,
    };
  }

  // ── D2 (drawer-plan-final §3.3) — "Tồn kho nóng": the LOW-STOCK view.
  // Scope = ONE pinned warehouse: COPILOT_DEFAULT_WAREHOUSE, set by the
  // operator (D0 measured THREE conflicting settings sources, one of them
  // pointing at ANOTHER company's warehouse — "Stores - S" on SANLOAN — so the
  // site's Stock Settings header is deliberately NOT read here: guessing it
  // would read another shop's stock, and `warehouses[0]` is explicitly
  // forbidden by §9). No pin ⇒ a CONFIGURATION error naming the fix, never a
  // silent fallback to whichever warehouse answered first.
  //
  // The rows are QUANTITIES, not money: `amount_vnd` carries the item's own
  // `actual_qty` (COPY — never computed) so the shared DrillRow shape can carry
  // it, and the client renders it unit-less (no "đ") for this drill. Sort qty
  // ASCENDING — the low stock the shop must react to leads the list (§3.3).
  if (drillId === "stock_low") {
    // The pin comes from the env the ROUTE passed (the server's config surface,
    // injectable in tests) — never process.env directly, so the drill cannot
    // read a different configuration than the one the request arrived under.
    const warehouse = String(env?.COPILOT_DEFAULT_WAREHOUSE ?? "").trim();
    if (!warehouse) {
      throw Object.assign(
        new Error(
          "STOCK_WAREHOUSE_UNPINNED: chưa pin kho mặc định — đặt COPILOT_DEFAULT_WAREHOUSE trong .env " +
            "(hoặc khai Default Warehouse trên Desk > Settings), rồi khởi động lại gateway. " +
            "Server không tự đoán kho (cấm warehouses[0]).",
        ),
        { code: "STOCK_WAREHOUSE_UNPINNED" },
      );
    }
    assertReadOnly("erpnext_stock_balance");
    const res = await mcp.callTool("erpnext_stock_balance", { warehouse, limit: 1000 });
    const payload = res?.data ?? res;
    const bins = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : null;
    if (!bins) {
      throw new Error(`ERP_MALFORMED_RESPONSE: stock balance did not return an array`);
    }
    if (bins.length > 1000) {
      throw new Error(`ERP_TRUNCATED: stock balance matched more than 1000 rows — refusing to cap silently`);
    }
    const list = bins
      .map((b) => ({
        name: b.item_code ?? "(không rõ mặt hàng)",
        date: null,
        // The QUANTITY on the shelf — this drill's "number" is a count of
        // physical goods, copied verbatim from the Bin row.
        amount_vnd: Math.round(Number(b.actual_qty) || 0),
        note: warehouse,
        kind: "stock_low_item",
      }))
      .sort((a, b) => (a.amount_vnd !== b.amount_vnd ? a.amount_vnd - b.amount_vnd : String(a.name).localeCompare(String(b.name))));
    return {
      summary_lines: [
        { label: `Tồn thấp — Kho: ${warehouse}`, amount_vnd: null, count: list.length },
        { label: "Tổng số lượng đang có", amount_vnd: null, count: list.reduce((s, r) => s + r.amount_vnd, 0) },
      ],
      rows: list,
    };
  }

  if (drillId === "app_drafts_today") {
    // D3 (drawer-plan-final §3.4) — the app-drafts AGGREGATE: ONE response (the
    // client never calls the doctypes itself), built from the same four doctypes,
    // the same correlation filter and the SAME company scoping as the
    // `app_drafts` block — a draft created for another company is not this
    // shop's draft, in either view. The contract's MVP set is PE/SO/PO and this
    // is that set plus Quotation, which the block has counted since P4-5:
    // dropping it here would break the one rule this file exists to keep (the
    // list must ADD UP to the number above it).
    //
    // TWO D3 behaviours live here, and both are about NOT letting one section
    // take down the screen:
    //   * per-section status: a doctype that cannot be read (no correlation
    //     field, timeout, permission) is SKIPPED with its own code and the
    //     other sections still answer — `partial`, never a 500 for the page and
    //     never a fabricated 0 for the missing section;
    //   * dedupe: one `custom_ai_action_id` is ONE user action, and an action
    //     can leave rows in more than one doctype (the site's own index is
    //     unique PER doctype — measured at D0). The SERVER picks the canonical
    //     row (the earliest document of the action; a follower like the payment
    //     raised against an order loses), counts the dropped ones, and the
    //     client is never asked to choose.
    const doctypes = ["Sales Order", "Quotation", "Purchase Order", "Payment Entry"];
    const sections = {};
    const collected = [];
    for (const doctype of doctypes) {
      // Payment Entry dates on `posting_date` and has NO `grand_total` (measured
      // 2026-09-21 via DocField meta: rows=0 — asking for it 417s the whole
      // read); its money side is `paid_amount`, which is what a created payment
      // proposal sets.
      const isPE = doctype === "Payment Entry";
      const dateField = isPE ? "posting_date" : "transaction_date";
      const amountField = isPE ? "paid_amount" : "grand_total";
      try {
        const res = await docList(mcp, doctype, {
          fields: ["name", "docstatus", "custom_ai_action_id", dateField, "company", amountField],
          filters: [["custom_ai_action_id", "is", "set"]],
          limit: 500,
        });
        let count = 0;
        for (const r of rowsOf(res)) {
          if (r.docstatus !== 0 || !rowOfCompany(r, company) || (r[dateField] ?? null) !== date) continue;
          count += 1;
          collected.push({
            docDate: r[dateField] ?? null,
            actionId: String(r.custom_ai_action_id ?? ""),
            row: {
              name: r.name,
              date: r[dateField] ?? null,
              // COPY the document's own value (P4-5): 0 was a fabricated number
              // for a document that HAS one — money is never invented here, and
              // it is never summed either (the summary line is a count,
              // amount_vnd: null; the Flutter card leads with the document).
              amount_vnd: vnd(r[amountField]),
              note: `${doctype} · nháp (copilot tạo)`,
              kind: "app_draft",
            },
          });
        }
        sections[doctype] = { ok: true, count };
      } catch (err) {
        const msg = String(err?.message ?? err);
        // §3.4: "thiếu field trên doctype → skip section + log, không 500 cả
        // màn". A missing correlation column is its OWN code so the screen can
        // say which kind of gap it is instead of "ERP lỗi".
        sections[doctype] = {
          ok: false,
          code: /Unknown column|custom_ai_action_id/i.test(msg) ? "FIELD_MISSING" : "ERP_UNAVAILABLE",
          error: msg.slice(0, 200),
        };
      }
    }
    const byAction = new Map();
    let duplicatesDropped = 0;
    for (const item of collected) {
      const prev = byAction.get(item.actionId);
      if (!prev) {
        byAction.set(item.actionId, item);
        continue;
      }
      // Canonical = the EARLIEST document (the one the action originated from);
      // same-date ties resolve by name ASC so the choice is deterministic and
      // testable rather than "whichever loop ran last".
      duplicatesDropped += 1;
      const better =
        String(item.docDate) < String(prev.docDate) ||
        (String(item.docDate) === String(prev.docDate) && String(item.row.name) < String(prev.row.name));
      if (better) byAction.set(item.actionId, item);
    }
    const rows = [...byAction.values()].map((i) => i.row).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const failed = Object.entries(sections).filter(([, s]) => !s.ok).map(([d]) => d);
    const okCount = Object.values(sections).filter((s) => s.ok).length;
    // NOTHING answered ⇒ this is NOT a partial view: it is an outage, and §2.2
    // is explicit that an unreachable ERPNext is an ERROR with [Thử lại] — a
    // `partial: true` + empty list would render as "hôm nay không có nháp nào"
    // with a warning attached, which is the fabricated zero wearing a hat.
    // (Found live: the site's tunnel went down and the view still answered 200.)
    // `partial` therefore means exactly what §3.4 says: SOME sections answered.
    if (okCount === 0) {
      const firstDetail = Object.values(sections).map((s) => s.error).find(Boolean) ?? "ERPNext không đọc được";
      throw new Error(`ERP_UNAVAILABLE: không đọc được loại chứng từ nào (${failed.join(", ")}) — ${firstDetail}`.slice(0, 400));
    }
    return {
      summary_lines: [
        { label: "Nháp app hôm nay", amount_vnd: null, count: rows.length },
        // The section line is a COUNT of doctypes that answered — the drawer's
        // `loadedPartial` banner names the ones that did not.
        { label: `Đọc được ${okCount}/${doctypes.length} loại chứng từ`, amount_vnd: null, count: null },
      ],
      rows,
      partial: failed.length > 0,
      sections,
      duplicates_dropped: duplicatesDropped,
    };
  }

  throw new Error(`UNKNOWN_DRILL: "${drillId}" không phải drill id đã khai trong hợp đồng`);
}
