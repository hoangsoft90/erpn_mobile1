/**
 * Skill: payment WRITE (Phase 7 — the ONLY write in the project).
 *
 * Two-phase by design (user decision 2026-09-16):
 *   Stage A (this commit): buildPaymentProposal() STOPS at the proposal.
 *   Stage B: executePaymentProposal() runs ONLY after the human confirm flow
 *   (POST /execute) and ONLY behind the idempotency store. Stage B against
 *   the REAL ERPNext is a separate user-gated decision.
 *
 * Safety properties:
 *  - The proposal is the intent; AMOUNTS ARE NOT TRUSTED FROM IT. At execute
 *    time the outstanding amount is RE-READ from ERPNext and clamped: the
 *    paid amount can never exceed the true outstanding of the chosen invoice.
 *  - The write goes through the Phase 6 risk gate: buildProposal() marks it
 *    HIGH; assertProposalAllowed() would refuse execution without the
 *    confirm flow, and the idempotency store guarantees once-only.
 *  - reference_no = command_id is written on the Payment Entry — ERPNext's
 *    own reference field becomes the second, server-side idempotency half.
 */

import { randomUUID } from "node:crypto";

import { assertReadOnly } from "../readonly-guard.mjs";
import { readSessionCompany } from "../company-scope.mjs";
import { buildProposal } from "../action-proposal.mjs";
import { classifyDriftCode, detectDrift } from "../proposal-freshness.mjs";
import { getCapability } from "../capability-contract.mjs";

/** The ONE doctype this project may ever create (fail-closed everywhere). */
export const WRITE_DOCTYPE = "Payment Entry";

/**
 * P9-C — a payment has a DIRECTION, and the two directions are different
 * documents on different masters. Measured 2026-09-23 before this existed:
 * `buildPaymentEntryData` hardcoded `payment_type: "Receive"` /
 * `party_type: "Customer"` / a Sales Invoice reference, so a pay-out order
 * ("trả tiền NCC Hà Tiên 2 triệu") resolved through the customer master and could
 * only ever have produced money IN.
 *
 * The direction is NOT a request field: it is derived from which master list the
 * resolved party belongs to (Supplier ⇒ pay, Customer ⇒ receive) and re-derived
 * at execute time from the proposal's server-set `entity.kind`.
 */
export const DIRECTIONS = Object.freeze(["receive", "pay"]);

/** Per-direction document shape. One table, so the two sides cannot drift. */
export const DIRECTION_SPEC = Object.freeze({
  receive: Object.freeze({
    payment_type: "Receive",
    party_type: "Customer",
    party_doctype: "Customer",
    // Money comes FROM the debtor ledger (read off the anchor invoice), TO the
    // cash/bank account of the Mode of Payment.
    anchor_doctype: "Sales Invoice",
    anchor_account_field: "debit_to",
    // The type that side's ledger MUST carry — used by the advance path, where
    // no document supplies the account name (Phase 4).
    anchor_account_type: "Receivable",
    // The CHART-OF-ACCOUNTS family that side lives in (measured 2026-10-01 on
    // the real site: 1310 is root_type Asset, 2110 is root_type Liability) —
    // the advance resolver lists leaves by THIS root, or the payable anchor is
    // invisible and every Pay advance is refused as "unresolved".
    anchor_root_type: "Asset",
    money_side: "paid_to",
    label: "khách hàng",
    verb: "Thu",
  }),
  pay: Object.freeze({
    payment_type: "Pay",
    party_type: "Supplier",
    party_doctype: "Supplier",
    // Mirror image: money goes FROM cash/bank, TO the creditor ledger.
    anchor_doctype: "Purchase Invoice",
    anchor_account_field: "credit_to",
    anchor_account_type: "Payable",
    // Mirror image: the payable side is a LIABILITY account (root_type
    // Liability) — listing Asset leaves here is exactly the bug the first real
    // purchase round caught (PI written, PE refused "tài khoản Payable … không
    // xác định được").
    anchor_root_type: "Liability",
    money_side: "paid_from",
    label: "nhà cung cấp",
    verb: "Chi",
  }),
});

/** Throws unless `d` is one of the two declared directions (fail closed). */
export function assertDirection(d) {
  if (!DIRECTIONS.includes(d)) {
    throw Object.assign(new Error(`hướng tiền "${d}" không hợp lệ — chỉ nhận ${DIRECTIONS.join("|")}`), {
      code: "PAYMENT_DIRECTION_INVALID",
    });
  }
  return d;
}

/**
 * The two money channels a collection can use (owner lock §6.1) and the ERPNext
 * `account_type` each one demands. One table, so the channel → type mapping
 * cannot drift between the screen, the validator and the resolver.
 */
export const MONEY_CHANNELS = Object.freeze({ cash: "Cash", bank_transfer: "Bank" });

/**
 * Which channel a request is about. Accepts the draft's own tokens
 * (`cash` / `bank_transfer`) and the Vietnamese labels the chat uses
 * (`Tiền mặt` / `Chuyển khoản`). Returns `null` for anything else — the caller
 * refuses rather than guessing a channel (a guess here posts money into the
 * wrong ledger, which is the exact bug §6.2 names).
 *
 * @param {unknown} mode
 * @returns {"cash"|"bank_transfer"|null}
 */
export function channelOfMode(mode) {
  const raw = String(mode ?? "").trim().toLowerCase();
  if (raw === "cash") return "cash";
  if (raw === "bank_transfer" || raw === "bank" || raw === "transfer") return "bank_transfer";
  if (/chuyển\s*khoản|chuyen\s*khoan|chuyển\s*khoan|\bbank\b|transfer/.test(raw)) return "bank_transfer";
  if (/tiền\s*mặt|tiền\s*mat|tien\s*mat|tien\s*mt|\bcash\b|\btm\b/.test(raw)) return "cash";
  return null;
}

/**
 * The DIRECTION a proposal is about, read from the SERVER-SET entity kind.
 *
 * `entity.kind` is written by buildPaymentProposal() (never by the client), and
 * the executor treats anything that is not "supplier" as receive — so a crafted
 * `params.direction` cannot change what gets written, and a crafted kind that
 * disagrees with the party master fails the master read (see
 * executePaymentProposal step 1).
 */
export function directionOf(proposal) {
  return proposal?.entity?.kind === "supplier" ? "pay" : "receive";
}

/**
 * The money-direction markers that survive in the RAW sentence, or null.
 *
 * Deliberately limited to the UNAMBIGUOUS verbs. "trả tiền" and "thanh toán"
 * are NOT markers: Vietnamese uses both for money coming in ("khách trả tiền")
 * and going out, so treating them as "pay" would have refused every existing
 * "trả tiền cho <khách>" sentence (a real regression, not a safety win).
 * "chi tiết"/"chi nhánh" are excluded — they merely start with the same two
 * letters as the verb "chi".
 *
 * @param {string} rawText pre-synonym sentence (nlp.original)
 * @returns {"receive"|"pay"|null}
 */
export function verbDirection(rawText) {
  const t = String(rawText ?? "").toLowerCase();
  if (/(^|\s)(thu tiền|thu nợ|thu hộ|nhận tiền|khách trả|khách đưa|thu)(\s|$)/.test(t)) return "receive";
  if (/(^|\s)chi(?!\s*(tiết|nhánh))(\s|$)/.test(t)) return "pay";
  return null;
}

/**
 * Refuse when the SENTENCE and the DATA disagree about the direction.
 *
 * The data (which master list holds the name) decides; the verb can only BLOCK.
 * That ordering is the whole point: "thu tiền của Hà Tiên" where Hà Tiên is only
 * a supplier must not become a pay-out "because the master said supplier" — the
 * user asked to collect. Flip nothing; refuse and let them rephrase.
 *
 * @param {"receive"|"pay"} masterDirection
 * @param {string} rawText
 */
export function assertDirectionNotContradicted(masterDirection, rawText) {
  const fromVerb = verbDirection(rawText);
  if (!fromVerb || fromVerb === masterDirection) return masterDirection;
  const said = fromVerb === "pay" ? "chi tiền (trả cho đối tác)" : "thu tiền (nhận từ đối tác)";
  const found = DIRECTION_SPEC[masterDirection].label;
  throw Object.assign(
    new Error(
      `câu nói là ${said} nhưng "${rawText}" chỉ khớp ${found} trong hệ thống — TỪ CHỐI ghi vì không thể vừa thu vừa chi; hãy nói rõ "thu tiền cho <khách> …" hoặc "chi cho <nhà cung cấp> …"`,
    ),
    { code: "PAYMENT_DIRECTION_CONFLICT", verb_direction: fromVerb, master_direction: masterDirection },
  );
}

/**
 * P0 §10.4 — ERPNext-side correlation field, read from the contract (single
 * source of truth), NOT hardcoded here.
 * `custom_ai_action_id` (Data, unique, indexed) is the field an operator adds
 * to every WRITE doctype; the value written is the immutable proposal's
 * `action_id`, so a later lookup never has to guess from customer+amount+date.
 */
export function correlationField() {
  return getCapability("payment.create")?.execution?.correlation_field ?? "custom_ai_action_id";
}

/** `act_<uuid>` — a unique id for one logical action (plan2_final §2 D9). */
export function newActionId() {
  return `act_${randomUUID()}`;
}

/**
 * P5-2 (§4.4) — the SHOP's calendar day, `YYYY-MM-DD`.
 *
 * The contract already defines what `posting_date` MEANS: "which calendar day
 * is it at the shop", pinned to Asia/Ho_Chi_Minh (`http-ask.mjs` → `vnToday`;
 * `capabilities.json` → `user_timezone`). ERPNext itself would also default
 * `posting_date` to the SITE's today, so this is the value the server would
 * have picked on its own — which is why a receipt can be attributed to the day
 * the cash drawer was actually counted.
 *
 * Deliberately NOT `import { vnToday } from "../http-ask.mjs"`: http-ask reaches
 * this module again through safety-gateway (an import cycle), and relocating
 * `vnToday` out of http-ask would break the p42 falsify case that pins the
 * timezone line in that file. The duplication is instead held in check by a
 * test asserting both agree at the VN/UTC boundary
 * (`payment-write.test.mjs`: "shopDay agrees with vnToday …").
 *
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD in Asia/Ho_Chi_Minh
 */
export function shopDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * How far a proposal's frozen day may be from the shop's today.
 *
 * ONE day, because that is the only honest skew: a proposal's TTL is 10 minutes
 * (`proposal-freshness.mjs`), so the single legitimate reason for a mismatch is
 * a confirm that lands just after midnight — the very case `params.posting_date`
 * exists for (§4.4). Anything wider is not a clock drift; it is a client
 * choosing a day the user never approved.
 */
export const POSTING_DATE_MAX_SKEW_DAYS = 1;

/**
 * The posting day to WRITE, taken from the proposal's snapshot and VALIDATED.
 *
 * Why this exists (P5-2 self-review, 2026-09-22): `/execute` takes the proposal
 * straight from the request body (`http-ask.mjs` → gateway → this executor), so
 * `params` is client-authoritative — and `posting_date` decides which day's
 * books the money lands in. Before P5-2 the day was computed server-side at
 * execute time, so a client could not choose it; making it a snapshot field
 * handed that choice to the caller unless it is checked. A probe on 2026-09-22
 * showed a crafted `posting_date: "2026-01-02"` being written with no exception.
 *
 * So it is re-validated exactly like the other client-supplied parameters this
 * module does not trust: the amount is re-read and clamped, the invoice goes
 * through `detectDrift`, the customer is re-read by id. Fail closed.
 *
 * @param {object} proposal
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 */
export function readPostingDate(proposal, now = new Date()) {
  const raw = proposal?.params?.posting_date;
  // A card built BEFORE this field existed still works: today at the shop,
  // which is what the old code did at execute time. The P5-2 CẤM is that those
  // cards must not break.
  if (raw === undefined || raw === null) return shopDay(now);

  const bad = (why) => {
    const err = new Error(
      `ngày hạch toán của đề xuất không dùng được (${why}) — TỪ CHỐI ghi, hãy hỏi lại để tạo đề xuất mới`,
    );
    // PAYMENT_* maps onto BUSINESS_VALIDATION_FAILED in uncertainty.mjs, so the
    // card explains this the same way it explains every other payment refusal.
    err.code = "PAYMENT_POSTING_DATE_INVALID";
    return err;
  };

  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw bad(`phải là chuỗi YYYY-MM-DD, nhận ${JSON.stringify(raw)}`);
  }
  // Round-trip, because the shape alone accepts 2026-02-30 and 2026-13-01 and
  // `Date` silently rolls those over — the same technique, for the same reason,
  // as the read route's summaryDateProblem: "a day that quietly means another
  // day is a wrong MONEY report, which is worse than a refusal here".
  const asUtcMidnight = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(asUtcMidnight.getTime()) || asUtcMidnight.toISOString().slice(0, 10) !== raw) {
    throw bad(`${raw} không phải một ngày có thật`);
  }
  const today = shopDay(now);
  const skewDays = Math.round((asUtcMidnight - new Date(`${today}T00:00:00Z`)) / 86_400_000);
  if (Math.abs(skewDays) > POSTING_DATE_MAX_SKEW_DAYS) {
    throw bad(`lệch ${skewDays} ngày so với hôm nay tại tiệm (${today}), quá xa mức cho phép ±${POSTING_DATE_MAX_SKEW_DAYS}`);
  }
  return raw;
}

/**
 * P5-2 (§4.2) — WHICH kind of submit refusal, so the card can advise correctly.
 *
 * String-match FALLBACK, and that is a measured choice, not laziness: P5-0 read
 * the pinned @casys/mcp-erpnext 3.0.4 source and found the real client DOES
 * carry a structured `FrappeAPIError(message, status, responseBody)` with
 * `exc_type`, but our wrapper collapses it to a flat
 * `Error("TOOL_ERROR: <text>")` before this module ever sees it
 * (`src/client.mjs:113`, `:155-161`). There is no structured field to read.
 *
 * The asymmetry is what makes this safe to ship: a mis-read only changes WHICH
 * advice the card shows. It cannot change what was written — the draft stands
 * either way, and `submit_error` keeps ERPNext's own words verbatim beside it.
 * An ERPNext that rewords its errors degrades to `other`, never to a wrong write.
 *
 * @param {unknown} message
 * @returns {"permission"|"period_locked"|"workflow"|"other"}
 */
export function classifySubmitError(message) {
  const text = String(message ?? "");
  // Permission first: Frappe raises `PermissionError` BY NAME, and the name is
  // the most specific token in the string. `HTTP 403` is the structural half of
  // the shape the client really produces
  // (`[FrappeClient] <METHOD> <path> failed: <msg> (HTTP <status>)`).
  if (/PermissionError|not permitted|no permission|insufficient permission|HTTP 403\b/i.test(text)) {
    return "permission";
  }
  // Period lock (Period Closing Voucher / Accounting Period).
  if (/PeriodClosingVoucher|Period Closing Voucher|period.{0,24}(closed|lock)|closed period|accounting period.{0,24}closed|(khóa|khoá) (sổ|kỳ)/i.test(text)) {
    return "period_locked";
  }
  // Workflow state — the document is not in a state that allows submit.
  if (/Workflow|workflow state|WorkflowStateError|not allowed to transition|invalid transition|được duyệt/i.test(text)) {
    return "workflow";
  }
  return "other";
}

/**
 * Unwrapping, in one place (learned the hard way: the client wraps every
 * tool result as {__untrusted, source, data: <payload>}, and the handler
 * payload itself already nests — `{data: doc}` for gets, `{data: rows}` for
 * lists). Miss the second layer and the code silently reads undefined.
 */
function payloadOf(res) {
  return res?.data ?? res;
}
function docOf(res) {
  const p = payloadOf(res);
  return p?.data ?? p ?? {};
}
function rowsOf(res) {
  const p = payloadOf(res);
  const rows = p?.data ?? p;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Build the REAL Payment Entry payload (pure — unit-testable without network).
 *
 * Field names come from ERPNext's Payment Entry doctype, not from guesswork:
 * a payment needs the party, both accounts and the amount, and the
 * `references` child row is what actually ALLOCATES the money to the invoice
 * (without it the payment parks as an unallocated advance and the invoice
 * stays outstanding).
 *
 * P9-C: `direction` selects the whole shape (payment_type, party_type, which
 * account is the money side, and the referenced doctype) from DIRECTION_SPEC.
 * The `paid_from`/`paid_to` swap is the classic real-world trap the recipes
 * skill warns about ("paid_from / paid_to rất dễ đảo") — going OUT, the money
 * account is `paid_from`; coming IN, it is `paid_to`.
 */
export function buildPaymentEntryData({
  direction = "receive",
  customerId,
  partyId,
  paid,
  commandId,
  actionId,
  mode = "Tiền mặt",
  invoice,
  invoiceTotal,
  invoiceOutstanding,
  // Phase 3 §5.3 — one reference row PER allocation. When given, these win over
  // the single `invoice` shorthand, and `paid_amount` is the SERVER's sum
  // (`Σ allocated + unallocated`) rather than a caller-supplied number.
  references = null,
  unallocated = null,
  company,
  paidFrom,
  paidTo,
  postingDate,
}) {
  const spec = DIRECTION_SPEC[assertDirection(direction)];
  const party = partyId ?? customerId;

  // Build the reference rows from whichever shape the caller used. The single
  // `invoice` path stays byte-compatible with every pre-Phase-3 caller
  // (chat, executor, other write skills).
  // An EMPTY array is a real shape (an advance has no reference row) and must
  // not fall back to a single null-named row.
  const refRows = Array.isArray(references)
    ? references.map((r) => ({
        reference_doctype: spec.anchor_doctype,
        reference_name: r.reference_name ?? r.invoice ?? r.invoice_id ?? null,
        total_amount: Math.round(Number(r.total_amount ?? r.invoiceTotal ?? 0) || 0),
        outstanding_amount: Math.round(Number(r.outstanding_amount ?? r.invoiceOutstanding ?? 0) || 0),
        allocated_amount: Math.round(Number(r.allocated_amount ?? r.allocated ?? r.allocatedAmount ?? 0) || 0),
      }))
    : [
        {
          reference_doctype: spec.anchor_doctype,
          reference_name: invoice,
          total_amount: invoiceTotal,
          outstanding_amount: invoiceOutstanding,
          allocated_amount: paid,
        },
      ];
  const allocatedSum = refRows.reduce((sum, r) => sum + Number(r.allocated_amount || 0), 0);
  // `unallocated_amount` is written EXPLICITLY so ERPNext never has to infer the
  // part not tied to a document (plan §9); `difference_amount` then comes out 0.
  const unallocatedAmount = Number.isFinite(Number(unallocated))
    ? Math.round(Number(unallocated))
    : Math.max(0, Math.round(Number(paid) || 0) - allocatedSum);
  // With multiple references the paid total is the server's arithmetic; the
  // legacy single path keeps `paid` exactly (allocated_sum === paid there, and
  // unallocated is 0).
  const paidAmount = allocatedSum + unallocatedAmount;

  return {
    payment_type: spec.payment_type,
    party_type: spec.party_type,
    party,
    company,
    posting_date: postingDate,
    paid_from: paidFrom,
    paid_to: paidTo,
    paid_amount: paidAmount,
    received_amount: paidAmount,
    unallocated_amount: unallocatedAmount,
    // Single-currency assumption: this shop bills in VND only, so a rate of 1
    // is correct. A multi-currency site would need the real source/target
    // rates read from ERPNext — do not reuse this as-is there.
    source_exchange_rate: 1,
    target_exchange_rate: 1,
    mode_of_payment: mode,
    // ERPNext's own reference field carries the idempotency key — the second,
    // server-side half of the once-only guarantee (reconcile searches by it).
    reference_no: commandId,
    reference_date: postingDate,
    // P0 §10.4 — business-level correlation. ERPNext IGNORES fields that are
    // not on the doctype meta, so sending it is harmless on a site that has not
    // run the migration yet; once the Custom Field exists it is stored (and a
    // unique constraint there is the DB-level half of the duplicate guard).
    [correlationField()]: actionId ?? null,
    remarks: `ERPNext Voice Copilot · xác nhận bởi người dùng · command_id ${commandId}`,
    references: refRows,
  };
}

/**
 * Resolve the two accounts the Payment Entry needs, READING them from ERPNext
 * (never hardcoded — account names carry a company abbreviation).
 *
 *   party ledger = the ANCHOR document's own account: Sales Invoice.debit_to
 *               (receivable, on the receive side) or Purchase Invoice.credit_to
 *               (payable, on the pay side) — never hardcoded, since account
 *               names carry a company abbreviation and differ per site
 *   mode      = the REAL Mode of Payment document name on this site (the
 *               Vietnamese label "Tiền mặt" usually does NOT exist there;
 *               ERPNext refuses the write with LinkValidationError otherwise
 *               — hit for real on 2026-09-16)
 *   money account = resolved in EXACTLY one order (owner lock §6.2): (1) the
 *               account the user chose, when it exists, belongs to the company
 *               and its `account_type` matches the method's channel; (2) the
 *               company's own default for that channel (`default_cash_account`
 *               / `default_bank_account`); (3) **BLOCK**. There is NO "first
 *               Cash-type account" fallback, and the Mode of Payment's own
 *               account rows are NOT an account source (measured: they carry no
 *               usable account for the company on the shop's site). It becomes
 *               `paid_to` when collecting and `paid_from` when paying out.
 *
 * @returns {Promise<{company: string, paidFrom: string, paidTo: string, mode: string, mode_requested: string, channel: string, account_type: string}>}
 */
export async function resolvePaymentAccounts(mcp, { direction = "receive", invoice, mode = "Tiền mặt", account = null }) {
  const spec = DIRECTION_SPEC[assertDirection(direction)];
  const invRes = await mcp.callTool("erpnext_doc_get", { doctype: spec.anchor_doctype, name: invoice });
  const inv = docOf(invRes);
  const company = inv.company;
  const anchorAccount = inv[spec.anchor_account_field];
  if (!company || !anchorAccount) {
    throw Object.assign(
      new Error(
        `không đọc được company/${spec.anchor_account_field} của chứng từ ${invoice} — không dựng được phiếu ${spec.verb.toLowerCase()}`,
      ),
      { code: "PAYMENT_ACCOUNT_UNRESOLVED" },
    );
  }
  const plan = await resolveAccountPlan(mcp, { company, direction, mode, account });
  return {
    ...plan,
    paidFrom: spec.money_side === "paid_to" ? anchorAccount : plan.money_account,
    paidTo: spec.money_side === "paid_to" ? plan.money_account : anchorAccount,
  };
}

/**
 * Phase 4 — the two accounts for an ADVANCE (on-account) collection. There is
 * no invoice, so neither the company nor the party ledger can be read off one.
 *
 * Company: the company the AUTHORIZATION layer resolved (`ctx.company` — the
 * gateway's own output, never a body field) and, on a deployment that has pinned
 * none, the ERPNext session's Default Company. That is the same rule
 * `/collect/accounts`, `/collect/propose` and the read routes already follow
 * (`company-scope.mjs`) — one notion of "whose books", not a second one.
 *
 * Party ledger: `Company.default_receivable_account` (collect) /
 * `default_payable_account` (pay out), honoured ONLY when it is a real leaf of
 * that company carrying the matching `account_type`. A missing or mistyped
 * default is a BLOCK: posting an advance into a random ledger is worse than
 * refusing it, and ERPNext would accept a wrong-typed account only to fail
 * later.
 */
export async function resolveAdvanceAccounts(mcp, { direction = "receive", mode = "Tiền mặt", account = null, company = null }) {
  const spec = DIRECTION_SPEC[assertDirection(direction)];
  let resolvedCompany = typeof company === "string" && company.trim() ? company.trim() : null;
  if (!resolvedCompany) {
    try {
      resolvedCompany = await readSessionCompany(mcp);
    } catch {
      resolvedCompany = null; // unreadable site default ⇒ refuse below
    }
  }
  if (!resolvedCompany) {
    throw Object.assign(
      new Error(
        "chưa xác định được công ty cho phiếu trả trước (không gắn hoá đơn) — đặt COPILOT_COMPANY hoặc Default Company trên ERPNext",
      ),
      { code: "COMPANY_SCOPE_REQUIRED" },
    );
  }
  const plan = await resolveAccountPlan(mcp, { company: resolvedCompany, direction, mode, account });

  let declared = null;
  try {
    assertReadOnly("erpnext_doc_get");
    const doc = docOf(await mcp.callTool("erpnext_doc_get", { doctype: "Company", name: resolvedCompany }));
    declared = direction === "pay" ? doc?.default_payable_account ?? null : doc?.default_receivable_account ?? null;
  } catch {
    declared = null;
  }
  const leaves = await listCompanyAssetLeaves(mcp, resolvedCompany, spec.anchor_root_type);
  const anchor = declared
    ? leaves.find((a) => String(a.name) === String(declared) && String(a.account_type ?? "") === spec.anchor_account_type)
    : null;
  if (!anchor) {
    throw Object.assign(
      new Error(
        `chưa xác định được tài khoản ${spec.anchor_account_type} của công ty ${resolvedCompany} cho phiếu trả trước — khai báo ${direction === "pay" ? "default_payable_account" : "default_receivable_account"} trên ERPNext`,
      ),
      { code: "PAYMENT_ACCOUNT_UNRESOLVED" },
    );
  }
  return {
    ...plan,
    company: resolvedCompany,
    paidFrom: spec.money_side === "paid_to" ? String(anchor.name) : plan.money_account,
    paidTo: spec.money_side === "paid_to" ? plan.money_account : String(anchor.name),
  };
}

/**
 * The Company's account LEAVES of ONE root family, read once per resolution.
 * Owner lock §6.2: every candidate (the user's choice, the company default, the
 * receivable/payable side of an advance) is validated against THIS list, so an
 * account of another company or a group node can never be used by accident.
 *
 * `rootType` defaults to "Asset" (the money accounts) because that is what both
 * historical callers resolve; the ADVANCE resolver passes the direction's
 * `anchor_root_type` — the payable side of a Pay advance is a LIABILITY account
 * (measured 2026-10-01: 2110 is root_type Liability), and querying Asset there
 * makes the anchor invisible.
 */
async function listCompanyAssetLeaves(mcp, company, rootType = "Asset") {
  try {
    assertReadOnly("erpnext_account_list");
    const accRes = await mcp.callTool("erpnext_account_list", { company, root_type: rootType, limit: 200 });
    return rowsOf(accRes).filter((a) => !a.is_group && String(a.company ?? company) === String(company));
  } catch (err) {
    throw Object.assign(
      new Error(`không đọc được tài khoản của công ty ${company} từ ERPNext: ${err?.message ?? err}`),
      { code: "PAYMENT_ERP_UNAVAILABLE" },
    );
  }
}

/**
 * §6.2 — which MONEY account a company + method resolves to, with NO document
 * involved. Split out of `resolvePaymentAccounts` (Phase 4) so the on-account
 * case — an advance has no invoice to read a company/anchor account from — runs
 * the SAME rule instead of a second copy of it.
 *
 * @returns {Promise<{company:string, mode:string, mode_requested:string, channel:string, account_type:string, money_account:string, money_account_source:string}>}
 */
async function resolveAccountPlan(mcp, { company, direction = "receive", mode = "Tiền mặt", account = null }) {
  const requestedMode = mode;
  // F-P5-2 (Phase 5, measured 2026-09-30): the CHANNEL comes from the request's
  // label, and the Mode of Payment must AGREE with it. Read the channel before
  // choosing the document so a bank intent can never select a Cash-typed method —
  // the real draft `ACC-PAY-2026-00775` was written with `mode_of_payment =
  // "Cash"` on a `bank_transfer` request because the old order fell through to
  // "any Cash-type mode" with no bank branch.
  const requestedChannel = channelOfMode(requestedMode);
  const requestedType = requestedChannel ? MONEY_CHANNELS[requestedChannel] : null;

  // Resolve the Mode of Payment NAME first — the write is a Link field, so a
  // label that does not exist on this site makes ERPNext reject the document.
  let modeName = requestedMode;
  // F-P5-2/decision C: set when a method matching the requested LABEL exists but
  // its `type` contradicts the channel (F-P5-3: the site's "Chuyển khoản" is
  // declared Cash). The conflict is surfaced, never resolved silently.
  let modeWarning = null;
  try {
    const listRes = await mcp.callTool("erpnext_doc_list", {
      doctype: "Mode of Payment",
      fields: ["name", "enabled", "type"],
      limit: 50,
    });
    const modes = rowsOf(listRes).filter((m) => m.enabled === undefined || Number(m.enabled) !== 0);
    const wanted = String(requestedMode).trim().toLowerCase();
    const exact = modes.find((m) => String(m.name).toLowerCase() === wanted);
    let chosen = null;
    if (requestedType) {
      // Channel known ⇒ only a method of that channel's own `type` is legal.
      const sameType = modes.filter((m) => String(m.type ?? "").toLowerCase() === requestedType.toLowerCase());
      if (exact && sameType.includes(exact)) {
        chosen = exact.name;
      } else {
        if (exact) {
          modeWarning = `Phương thức "${exact.name}" đang được khai loại ${
            exact.type || "không rõ"
          } trên ERPNext, không khớp hình thức ${
            requestedType === "Bank" ? "chuyển khoản" : "tiền mặt"
          } — phiếu dùng một phương thức ${
            requestedType === "Bank" ? "ngân hàng" : "tiền mặt"
          } khác; muốn dùng đúng tên "${exact.name}" thì sửa lại loại của nó trên ERPNext`;
        }
        // A same-channel method, deterministic: a transfer-ish name first, else
        // the alphabetical head so the same site always resolves the same way.
        const hinted = sameType.find((m) => (requestedType === "Bank" ? /transfer|wire/i : /cash/i).test(String(m.name)));
        chosen = (hinted ?? [...sameType].sort((a, b) => String(a.name).localeCompare(String(b.name)))[0])?.name ?? null;
      }
    } else {
      // A label that maps to no channel keeps the legacy preference order:
      //   1. the requested label IS the stored name
      //   2. a mode whose name is "cash"-like ("Tiền mặt" = cash in English)
      //   3. any enabled Cash-type mode
      const cashNamed = modes.find((m) => /cash/i.test(String(m.name)));
      const cashTyped = modes.find((m) => String(m.type).toLowerCase() === "cash");
      chosen = exact?.name ?? cashNamed?.name ?? cashTyped?.name ?? null;
    }
    // There used to be a `?? modes[0]?.name` fallback. Removed (review finding,
    // 2026-09-16): picking an ARBITRARY enabled mode means a "thu tiền mặt"
    // intent can silently post into a bank account. Wrong ledger is worse than
    // a refusal — stop and let a human map the mode.
    if (!chosen) {
      throw Object.assign(
        new Error(
          `không xác định được phương thức thanh toán khớp "${requestedMode}" trên site này (đang có: ${modes
            .map((m) => m.name)
            .slice(0, 5)
            .join(", ")}) — không tự chọn phương thức khác vì sẽ ghi tiền vào sai tài khoản`,
        ),
        { code: "PAYMENT_MODE_UNRESOLVED" },
      );
    }
    modeName = chosen;
  } catch (err) {
    if (err?.code === "PAYMENT_MODE_UNRESOLVED") throw err;
    modeName = requestedMode; // listing unavailable ⇒ keep the label as-is
  }

  // ── Which channel is this method? (owner lock §6.2) ──────────────────────
  // The channel decides the REQUIRED `account_type`; a method that maps to
  // neither channel is refused rather than guessed at.
  const channel = channelOfMode(requestedMode) ?? channelOfMode(modeName);
  if (!channel) {
    throw Object.assign(
      new Error(
        `phương thức "${modeName}" không xác định được là tiền mặt hay chuyển khoản — không tự chọn tài khoản`,
      ),
      { code: "PAYMENT_MODE_UNRESOLVED" },
    );
  }
  const accountType = MONEY_CHANNELS[channel];

  // F-P5-2 / review FINDING 2 (2026-09-30): the MIRROR of the label conflict above.
  // The method is chosen by `type`, never by name — so when the site's data is
  // inverted (a method whose NAME reads like the OTHER channel is typed for this
  // one) the chosen name still reads wrong to the operator. The choice is NOT
  // changed here (the money account still follows `channel`, which is the part
  // that must be right); the mismatch is simply not allowed to stay silent.
  const nameChannel = channelOfMode(modeName);
  if (!modeWarning && requestedChannel && nameChannel && nameChannel !== channel) {
    const nameWords = nameChannel === "bank_transfer" ? "chuyển khoản" : "tiền mặt";
    const usedWords = channel === "bank_transfer" ? "chuyển khoản" : "tiền mặt";
    modeWarning = `Phương thức "${modeName}" có TÊN đọc như hình thức ${nameWords} nhưng ERPNext khai loại ${accountType} — phiếu dùng phương thức này cho đúng hình thức ${usedWords}; nếu tên bị khai sai thì sửa lại trên ERPNext`;
  }

  // Read the company's accounts ONCE; BOTH the explicit choice and the company
  // default are validated against this same leaf list.
  const leaves = await listCompanyAssetLeaves(mcp, company);
  const typed = (row) => String(row?.account_type ?? "") === accountType;

  let moneyAccount = null;
  let moneyAccountSource = null;
  if (account) {
    // (1) the account the USER chose — must exist, belong to the company and be
    // the RIGHT type. A wrong-typed account is refused, never substituted.
    const chosen = leaves.find((a) => String(a.name) === String(account));
    if (!chosen) {
      throw Object.assign(
        new Error(`tài khoản "${account}" không thuộc công ty ${company} (hoặc không phải tài khoản lá) — không dùng được`),
        { code: "PAYMENT_ACCOUNT_UNRESOLVED" },
      );
    }
    if (!typed(chosen)) {
      throw Object.assign(
        new Error(
          `tài khoản "${account}" (loại ${chosen.account_type ?? "không rõ"}) không khớp phương thức ${modeName} (cần loại ${accountType}) — không tự đổi sang tài khoản khác`,
        ),
        { code: "ACCOUNT_TYPE_MISMATCH" },
      );
    }
    moneyAccount = String(chosen.name);
    moneyAccountSource = "user_selected";
  }
  if (!moneyAccount) {
    // (2) the company's own DEFAULT for this channel — read from the Company
    // doc, honoured only when it is genuinely one of that type's leaves.
    let declared = null;
    try {
      assertReadOnly("erpnext_doc_get");
      const companyRes = await mcp.callTool("erpnext_doc_get", { doctype: "Company", name: company });
      const doc = docOf(companyRes);
      declared = channel === "cash" ? doc?.default_cash_account ?? null : doc?.default_bank_account ?? null;
    } catch {
      declared = null; // unreadable default ⇒ fall through to BLOCK
    }
    const row = declared ? leaves.find((a) => String(a.name) === String(declared)) : null;
    if (row && typed(row)) {
      moneyAccount = String(row.name);
      moneyAccountSource = "company_default";
    }
  }
  if (!moneyAccount) {
    // (3) BLOCK — never the other channel's ledger, never "the first one found".
    throw Object.assign(
      new Error(
        `không xác định được tài khoản ${direction === "pay" ? "xuất" : "nhận"} tiền loại ${accountType} cho công ty ${company} (phương thức "${modeName}") — chọn tài khoản hoặc khai báo default trên ERPNext`,
      ),
      { code: "PAYMENT_ACCOUNT_UNRESOLVED" },
    );
  }
  // The ONE place the sides are assigned, from the spec table: collecting moves
  // debtor → money account, paying moves money account → creditor.
  return {
    company,
    mode: modeName,
    mode_requested: requestedMode,
    channel,
    account_type: accountType,
    money_account: moneyAccount,
    money_account_source: moneyAccountSource,
    // F-P5-2/decision C: present only when a label-matching method carried a
    // contradicting `type`; the caller tells the operator instead of pretending
    // the shop's own method name was the one used.
    ...(modeWarning ? { mode_warning: modeWarning } : {}),
  };
}

/**
 * Open (submitted, still-owing) Purchase Invoices of one supplier — the PAY-side
 * twin of `sales.listUnpaidInvoices`.
 *
 * Read through the generic `erpnext_doc_list` (the real 3.0.4 package has a
 * supplier-scoped read for customers but the purchase side is queried the same
 * way the verified recipes do: `filters=[[supplier,=,X],[docstatus,=,1]]`). The
 * outstanding filter is applied HERE rather than in the query because the mock
 * (and a Frappe field whitelist) only supports `=`/`!=` on this path — and
 * "still owing" is a fact about the document, not a query dialect.
 *
 * @param {object} mcp
 * @param {string} supplierId must be a real supplier id from a tool result
 */
export async function listOpenPurchaseInvoices(mcp, supplierId) {
  assertReadOnly("erpnext_doc_list");
  const fields = ["name", "supplier", "posting_date", "grand_total", "outstanding_amount", "company", "credit_to", "docstatus", "is_return"];
  const res = await mcp.callTool("erpnext_doc_list", {
    doctype: "Purchase Invoice",
    fields,
    // STRING values only in Frappe filters (pinned by the "no NUMERIC filter
    // literal" tripwire): ERPNext compares these as strings and a numeric `1`
    // here is the classic silently-empty query on the real site.
    filters: [
      ["supplier", "=", supplierId],
      ["docstatus", "=", "1"],
    ],
    limit: 100,
  });
  const rows = rowsOf(res).filter((r) => Number(r.outstanding_amount) !== 0);
  return { data: { data: rows } };
}


/**
 * Reconcile a command against ERPNext — READ ONLY.
 *
 * Verified tool (source of @casys/mcp-erpnext 3.0.4): the dedicated
 * `erpnext_payment_entry_list` CANNOT filter by reference_no, so the correct
 * tool is the generic `erpnext_doc_list` with a Frappe filter tuple.
 *
 * @returns {Promise<{found: boolean, count: number, doc: object|null, duplicates: boolean}>}
 */
export async function reconcilePaymentEntry(mcp, commandId, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const fields = ["name", "docstatus", "paid_amount", "party", "reference_no", "posting_date"];
  const res = await mcp.callTool("erpnext_doc_list", {
    doctype: WRITE_DOCTYPE,
    fields,
    filters: [["reference_no", "=", commandId]],
    limit: 5,
  });
  const rows = rowsOf(res);

  // P0 §10.4 — ALSO look the action up by the correlation field. A site that
  // has not added the Custom Field yet makes Frappe reject the filter
  // (unknown field), which is caught here and reported — never fatal, because
  // the reference_no lookup above already proves the primary key is complete.
  let byAction = [];
  let correlationFieldUnavailable = false;
  const field = correlationField();
  if (actionId) {
    try {
      const res2 = await mcp.callTool("erpnext_doc_list", {
        doctype: WRITE_DOCTYPE,
        fields: [...fields, field],
        filters: [[field, "=", actionId]],
        limit: 5,
      });
      byAction = rowsOf(res2);
    } catch {
      correlationFieldUnavailable = true;
    }
  }
  const merged = [...rows, ...byAction.filter((r) => !rows.some((x) => x.name && x.name === r.name))];
  return {
    found: merged.length > 0,
    count: merged.length,
    doc: merged[0] ?? null,
    // >1 means a second write slipped through: surface it loudly, never hide it.
    duplicates: merged.length > 1,
    correlation_field: field,
    correlation_field_unavailable: correlationFieldUnavailable,
  };
}

/**
 * Read the written document BACK from ERPNext and check it really carries the
 * values we intended — the response of the write call itself is not evidence.
 */
export async function verifyWrittenPayment(mcp, docName, { commandId, paid, customerId, actionId, direction = null, expect = null }) {
  const res = await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName });
  const doc = docOf(res);
  const problems = [];
  if (String(doc.reference_no ?? "") !== String(commandId)) problems.push(`reference_no=${doc.reference_no}`);
  if (Math.round(Number(doc.paid_amount)) !== Math.round(Number(paid))) problems.push(`paid_amount=${doc.paid_amount}`);
  if (String(doc.party ?? "") !== String(customerId)) problems.push(`party=${doc.party}`);
  // Phase 4 §5 — the fields a multi-invoice write can get wrong. Every check is
  // conditional on the caller saying what it expected, so the other write paths
  // that already call this function keep their exact behaviour.
  if (expect) {
    if (expect.company && String(doc.company ?? "") !== String(expect.company)) {
      problems.push(`company=${doc.company} (đã ghi cho ${expect.company})`);
    }
    for (const side of ["paidFrom", "paidTo"]) {
      const field = side === "paidFrom" ? "paid_from" : "paid_to";
      if (expect[side] && String(doc[field] ?? "") !== String(expect[side])) {
        problems.push(`${field}=${doc[field]} (đã ghi ${expect[side]})`);
      }
    }
    if (Number.isFinite(Number(expect.unallocated)) && Math.round(Number(doc.unallocated_amount)) !== Math.round(Number(expect.unallocated))) {
      // The part NOT tied to a document. A silent difference here is money the
      // books park as an advance nobody asked for.
      problems.push(`unallocated_amount=${doc.unallocated_amount} (đã ghi ${expect.unallocated})`);
    }
    if (Math.round(Number(doc.received_amount)) !== Math.round(Number(paid))) {
      problems.push(`received_amount=${doc.received_amount}`);
    }
    if (Array.isArray(expect.references)) {
      const rows = Array.isArray(doc.references) ? doc.references : [];
      if (rows.length !== expect.references.length) {
        problems.push(`references=${rows.length} dòng (đã ghi ${expect.references.length})`);
      } else {
        // Match by INVOICE, not by index: the document's own row order is not
        // something a wrong write would preserve.
        const byInvoice = new Map(rows.map((r) => [String(r?.reference_name ?? ""), r]));
        for (const want of expect.references) {
          const got = byInvoice.get(String(want.invoice));
          if (!got) {
            problems.push(`thiếu dòng phân bổ cho ${want.invoice}`);
          } else if (Math.round(Number(got.allocated_amount)) !== Math.round(Number(want.allocated_amount))) {
            problems.push(`allocated_amount của ${want.invoice}=${got.allocated_amount} (đã ghi ${want.allocated_amount})`);
          }
        }
      }
    }
  }
  // P9-C: the direction is a VARIABLE now, so the read-back has to prove which
  // way the money moved. Without this, a document that came back on the OTHER
  // side (a Receive for a pay-out) passes verification whenever the party id and
  // the amount happen to match — the party id is the same string either way, and
  // `party` is all this check used to compare. Only asserted when the caller
  // says which direction it asked for (older callers keep working unchanged).
  if (direction) {
    const expected = DIRECTION_SPEC[assertDirection(direction)];
    if (String(doc.payment_type ?? "") !== expected.payment_type) {
      problems.push(`payment_type=${doc.payment_type} (đã yêu cầu ${expected.payment_type})`);
    }
    if (String(doc.party_type ?? "") !== expected.party_type) {
      problems.push(`party_type=${doc.party_type} (đã yêu cầu ${expected.party_type})`);
    }
  }
  // P0 §10.4 — verify the correlation field ONLY when the site actually stores
  // it. A site without the migration must not fail a perfectly good write; the
  // absence is reported instead (execution.correlation_field_missing).
  const field = correlationField();
  if (actionId && doc && Object.prototype.hasOwnProperty.call(doc, field)) {
    if (String(doc[field] ?? "") !== String(actionId)) problems.push(`${field}=${doc[field]}`);
  }
  if (problems.length) {
    throw Object.assign(
      new Error(`đọc lại phiếu ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`),
      { code: "PAYMENT_WRITE_UNVERIFIED", doc },
    );
  }
  return doc;
}

/**
 * P9-D — how many OPEN DRAFT Payment Entries one party lookup may return before
 * the shop is told to clean up instead of piling a new draft on top. Same
 * posture as `delivery-write`'s DRAFT_NOTE_LOOKUP_LIMIT: a party with a pile of
 * live drafts is a books problem a human must resolve, not one more draft.
 */
export const DRAFT_PAYMENT_LOOKUP_LIMIT = 10;

/**
 * P9-D — the party's OPEN DRAFT Payment Entries (docstatus 0), BOTH directions
 * (`payment_type` is not filtered: the caller names the direction and only
 * counts rows whose `payment_type` matches the DIRECTION_SPEC table).
 *
 * ERPNext reduces an invoice's `outstanding_amount` only when a payment entry
 * is SUBMITTED (GL entry), so a live draft is invisible money: a second /ask
 * still sees the full debt and happily proposes it again (measured 2026-09-25:
 * a 1.000.000 draft on SINV-0001 left both proposals at 2.500.000). Read through
 * the same generic guarded list every other skill read uses.
 *
 * @param {object} mcp
 * @param {string} partyId a real party id from a tool result (Customer or Supplier)
 * @param {object} [p]
 * @param {string|null} [p.company] resolved company scope (Phase 3 §5.2). When
 *   given, ONLY this company's open drafts count — a draft belonging to another
 *   company in a multi-company site must never reduce this company's remainder.
 *   Omitted (chat path) ⇒ the historical, unscoped read.
 */
export async function listOpenDraftPaymentEntries(mcp, partyId, { company = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const filters = [["party", "=", String(partyId)], ["docstatus", "=", "0"]];
  if (company) filters.push(["company", "=", String(company)]);
  return mcp.callTool("erpnext_doc_list", {
    doctype: WRITE_DOCTYPE,
    // `reference_no` + correlation field ride along so the USER-SIDE warning can
    // name the drafts it found (the executor does not need them).
    fields: ["name", "docstatus", "party", "payment_type", "paid_amount", "company", "reference_no", correlationField()],
    // docstatus = 0 is the whole point: submitted entries have ALREADY moved the
    // GL, and cancelled ones (2) claim nothing.
    filters,
    limit: DRAFT_PAYMENT_LOOKUP_LIMIT,
  });
}

/** P9-D — guarded read of ONE Payment Entry (its references carry the allocations). */
export async function getPaymentEntryDoc(mcp, name) {
  assertReadOnly("erpnext_doc_get");
  return mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: String(name) });
}

/**
 * P9-D — how much of each anchor invoice do OPEN DRAFT payments already hold?
 *
 * Same pattern as `delivery-write.openDraftCover` (P9-A1): ERPNext advances
 * `outstanding_amount` only at SUBMIT, so a live draft payment is money the
 * invoice no longer needs — but the ledger does not know that yet. Ignoring it
 * means the second /ask proposes the SAME money again; submitting both drafts
 * would overpay the invoice.
 *
 * Allocation is read off the document's own `references` child table — the row
 * the write itself created (buildPaymentEntryData). A draft with NO allocation
 * (an advance) claims nothing against any invoice here, because nothing on this
 * channel creates one.
 *
 * @param {{listOpenDraftPaymentEntries: Function, getPaymentEntryDoc: Function}} reads
 * @param {string} partyId
 * @param {"receive"|"pay"} direction — only entries whose `payment_type` matches
 *        the direction's own table count (a Receive draft cannot cover a pay-out).
 * @param {object} [opts]
 * @param {string|null} [opts.company] company scope handed to the draft read
 *   (§5.2): a foreign company's draft must not lower this company's remainder.
 * @returns {Promise<{drawn: Map<string, number>, drafts: string[]}>}
 */
export async function openDraftCover(reads, partyId, direction, opts = {}) {
  const spec = DIRECTION_SPEC[assertDirection(direction)];
  // Wiring guard (P9-B's lesson): a bag built without these two reads is a
  // PROGRAMMING error, not an ERPNext outage. Without this the call below throws
  // "listOpenDraftPaymentEntries is not a function" inside the catch and gets
  // relabelled PAYMENT_ERP_UNAVAILABLE — which tells the operator the ledger is
  // down when the truth is that a call site forgot to pass the reads.
  for (const fn of ["listOpenDraftPaymentEntries", "getPaymentEntryDoc"]) {
    if (typeof reads?.[fn] !== "function") {
      throw Object.assign(
        new Error(`PAYMENT_SKILLS_INCOMPLETE: reads.${fn} không phải function — bag thiếu read của P9-D`),
        { code: "PAYMENT_SKILLS_INCOMPLETE" },
      );
    }
  }
  let rows = [];
  try {
    rows = rowsOf(await reads.listOpenDraftPaymentEntries(partyId, { company: opts.company ?? null }));
  } catch (err) {
    throw Object.assign(
      new Error(`không đọc được phiếu ${spec.verb.toLowerCase()} NHÁP đang chờ của đối tác từ ERPNext: ${err?.message ?? err}`),
      { code: "PAYMENT_ERP_UNAVAILABLE" },
    );
  }
  if (rows.length >= DRAFT_PAYMENT_LOOKUP_LIMIT) {
    throw Object.assign(
      new Error(
        `đối tác có ${rows.length} phiếu ${spec.verb.toLowerCase()} NHÁP chưa submit — dọn (submit hoặc hủy) các phiếu đó trên ERPNext trước khi tạo phiếu mới`,
      ),
      { code: "PAYMENT_DRAFT_COVERED" },
    );
  }
  const drawn = new Map();
  const drafts = [];
  for (const row of rows) {
    const name = String(row.name ?? "");
    if (!name) continue;
    // The DIRECTION filter: the list carries payment_type so the count can be
    // done HERE (one party read, two directions) instead of one query per side.
    if (String(row.payment_type ?? "") !== spec.payment_type) continue;
    let doc = null;
    try {
      doc = docOf(await reads.getPaymentEntryDoc(name));
    } catch (err) {
      throw Object.assign(
        new Error(`không đọc được phiếu ${spec.verb.toLowerCase()} nháp ${name}: ${err?.message ?? err}`),
        { code: "PAYMENT_ERP_UNAVAILABLE" },
      );
    }
    const mine = (Array.isArray(doc?.references) ? doc.references : []).filter(
      (it) => String(it.reference_doctype ?? "") === spec.anchor_doctype,
    );
    if (mine.length === 0) continue;
    drafts.push(name);
    for (const it of mine) {
      const inv = String(it.reference_name ?? "");
      if (!inv) continue;
      drawn.set(inv, (drawn.get(inv) ?? 0) + Number(it.allocated_amount ?? 0));
    }
  }
  return { drawn, drafts };
}

/**
 * Stage A — build the payment proposal for a resolved customer. STOPS there.
 *
 * @param {object} skills  payment+customer skill factory output
 * @param {object} resolved  { customer, ambiguous, candidates } from resolveCustomer()
 * @param {object} [opts]
 * @param {number} [opts.amount_vnd]  optional client-suggested amount (validated, clamped)
 * @param {string} [opts.invoice]     optional invoice to settle (default: oldest open)
 * @param {string|null} [opts.company] company scope resolved SERVER-side (§6.4): the
 *   open-invoice read is narrowed to the books this deployment is allowed to read,
 *   so the proposed amount can never be measured against another tenant's invoice.
 * @param {string} [opts.mode]        payment mode label, default "Tiền mặt"
 * @returns {object} { proposal, invoice, outstanding_vnd, warnings }
 */
export async function buildPaymentProposal(skills, resolved, opts = {}) {
  const { customer, supplier, ambiguous, candidates } = resolved;
  // DIRECTION, derived server-side from which master list resolved the party
  // (user decision 2026-09-23). Never from a request field.
  const direction = supplier ? "pay" : "receive";
  const spec = DIRECTION_SPEC[direction];
  const party = supplier ?? customer;
  if (!party) {
    const err = new Error(
      ambiguous
        ? `tên đối tác khớp nhiều kết quả (${(candidates ?? []).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ trước khi ghi phiếu`
        : "không xác định được đối tác (khách hàng hay nhà cung cấp) — không ghi phiếu",
    );
    err.code = "PAYMENT_CUSTOMER_UNRESOLVED";
    throw err;
  }
  const partyName = supplier ? (supplier.supplier_name ?? supplier.name) : (customer.customer_name ?? customer.name);

  // The sentence may only CONTRADICT the data-derived direction, never flip it:
  // "thu tiền của Hà Tiên" (Hà Tiên is only a supplier) must refuse, because
  // "the master said supplier" is not the user saying "chi".
  assertDirectionNotContradicted(direction, opts.raw_text);

  const inv = direction === "pay"
    ? await skills.listOpenPurchaseInvoices(party.name)
    : await skills.listUnpaidInvoices(party.name, { company: opts.company ?? null });
  const rows = (inv.data?.data ?? []).filter((r) => Number(r.outstanding_amount) !== 0);

  // P9-D — subtract what OPEN DRAFT payments already hold, BEFORE choosing the
  // target: ERPNext lowers outstanding only at SUBMIT, so a live draft is
  // invisible money and a second /ask would propose it again (measured:
  // a 1.000.000 draft left both proposals at 2.500.000). The read goes through
  // the bag (`skills`) like every other builder read — P9-B's lesson.
  const draftCover = await openDraftCover(skills, party.name, direction, { company: opts.company ?? null });
  const draftWarnings = [];
  const effective = rows
    .map((r) => {
      const drawn = draftCover.drawn.get(String(r.name)) ?? 0;
      return { ...r, effective_outstanding: Math.round(Number(r.outstanding_amount) || 0) - drawn };
    })
    .filter((r) => r.effective_outstanding !== 0);
  // ONE warning, naming BOTH halves of what the user must reconcile: which
  // documents the drafts are against, and which drafts to go submit/cancel. The
  // document names alone leave "submit/cancel WHAT?" unanswered, and the draft
  // names alone leave "of which debt?" unanswered.
  const covered = [...draftCover.drawn.entries()].filter(([, d]) => d > 0);
  if (covered.length > 0) {
    draftWarnings.push(
      `đã có phiếu ${spec.verb.toLowerCase()} NHÁP chưa submit (${draftCover.drafts.join(", ")}) phủ ${covered
        .map(([invName, d]) => `${invName} ${Math.round(d)}đ`)
        .join(", ")} — đề xuất dưới đây là phần CÒN LẠI, không cộng thêm phần đã có phiếu`,
    );
  }
  if (effective.length === 0 && draftCover.drafts.length > 0) {
    const err = new Error(
      `${partyName} còn nợ trên sổ nhưng đã có phiếu ${spec.verb.toLowerCase()} NHÁP (${draftCover.drafts.slice(0, 5).join(", ")}) chưa submit phủ hết — submit hoặc hủy phiếu đó trên ERPNext trước khi ${spec.verb.toLowerCase()} tiếp`,
    );
    err.code = "PAYMENT_DRAFT_COVERED";
    throw err;
  }
  if (effective.length === 0) {
    const err = direction === "pay"
      ? new Error(
          `${partyName} không còn hóa đơn mua nào chưa trả — không có gì để chi. (Chi không gắn hóa đơn/hóa đơn mua là khoản trả trước — chưa hỗ trợ trên chat.)`,
        )
      : new Error(`${partyName} không còn chứng từ nợ nào — không có gì để thu`);
    err.code = direction === "pay" ? "PAYMENT_SUPPLIER_NO_OPEN_INVOICE" : "PAYMENT_NO_OPEN_INVOICE";
    throw err;
  }

  // Default target: OLDEST open document (posting_date asc) — thu/trả công nợ cũ
  // trước là nghiệp vụ bán cám phổ biến; client có thể chỉ định invoice khác.
  const sorted = [...effective].sort((a, b) => String(a.posting_date).localeCompare(String(b.posting_date)));
  let target = opts.invoice
    ? sorted.find((r) => r.name === opts.invoice)
    : sorted[0];
  if (!target) {
    const err = new Error(`không tìm thấy chứng từ ${opts.invoice} đang nợ của ${partyName}`);
    err.code = "PAYMENT_INVOICE_NOT_OPEN";
    throw err;
  }

  // P9-D: the CEILING the proposal may claim is what the invoice still owes
  // AFTER the open drafts — NOT the raw GL number (which still counts drafts).
  // A draft-covered invoice that still has a remainder stays usable for the
  // remainder; the raw number is kept beside it for the execute-time drift
  // check, which compares against LIVE GL exactly as before (no semantic change
  // after submit — the GL stays the source of truth there).
  const outstanding = Math.round(Number(target.outstanding_amount) || 0);
  const effectiveOutstanding = Math.round(target.effective_outstanding);
  // The draft check is guarded on a draft ACTUALLY covering this document: a
  // negative remainder (a credit note, or a return) is zero-or-less with NO
  // draft involved, and it has to keep falling through to the "not a positive
  // receivable" refusal below instead of being relabelled a draft problem.
  const drawnForTarget = draftCover.drawn.get(String(target.name)) ?? 0;
  if (effectiveOutstanding <= 0 && drawnForTarget > 0) {
    // Only reachable when `opts.invoice` names a document whose remainder is
    // zero — the general case above already removed fully covered rows.
    const err = new Error(
      `chứng từ ${target.name} đã được phủ hết bởi phiếu ${spec.verb.toLowerCase()} NHÁP đang chờ — submit hoặc hủy phiếu đó trước khi ${spec.verb.toLowerCase()} tiếp`,
    );
    err.code = "PAYMENT_DRAFT_COVERED";
    throw err;
  }
  if (outstanding <= 0) {
    const err = new Error(
      `chứng từ ${target.name} không phải khoản ${direction === "pay" ? "phải trả" : "phải thu"} dương (outstanding ${outstanding}) — không ghi qua phiếu này`,
    );
    err.code = "PAYMENT_INVOICE_NOT_RECEIVABLE";
    throw err;
  }

  const warnings = [];
  // P1 (§13 degraded mode + §9 amount policy): the interactive path passes
  // `requireExplicitAmount`, because "the user said a number but the parser did
  // not catch it" must NOT silently become "thu toàn bộ nợ". Collecting the
  // whole debt stays a legitimate capability, but it has to be an explicit
  // intent — not the default a failed parse lands on.
  const hasExplicitAmount = Number.isFinite(Number(opts.amount_vnd));
  if (opts.requireExplicitAmount === true && !hasExplicitAmount) {
    const err = new Error(
      "câu nói thiếu số tiền (bộ chuẩn hoá không đọc ra số) — không tự đoán, hãy nói rõ số tiền cần thu",
    );
    err.code = "PAYMENT_AMOUNT_MISSING";
    throw err;
  }
  // P9-D: the ceiling is the EFFECTIVE outstanding (GL minus open drafts) —
  // clamping to the RAW number would let a second card re-propose money a live
  // draft already holds. The explicit-amount rule above is unchanged.
  let amount = Math.round(Number(hasExplicitAmount ? opts.amount_vnd : effectiveOutstanding) || 0);
  if (amount <= 0) {
    const err = new Error(`số tiền ${spec.verb.toLowerCase()} phải là số dương (VND)`);
    err.code = "PAYMENT_AMOUNT_INVALID";
    throw err;
  }
  if (amount > effectiveOutstanding) {
    warnings.push(
      `số tiền đề xuất ${amount} vượt phần còn lại của ${target.name} (${effectiveOutstanding}${draftCover.drafts.length > 0 ? ` — sau khi trừ phiếu NHÁP đang chờ, GL ${outstanding}` : ""}) — đã kẹp về đúng phần còn lại`,
    );
    amount = effectiveOutstanding;
  }
  warnings.push(...draftWarnings);

  // F7-2 (user decision 2026-09-18): whether a confirm SUBMITS the receipt is
  // frozen into the snapshot at proposal time. The card's description and the
  // executor both read THIS value — the setting is never re-read at execute
  // time, so the user cannot flip the switch between viewing and pressing
  // confirm and change what the press does (view/execute must not diverge).
  const submitNow = opts.submit_now === true;

  const proposal = buildProposal({
    action: "create_payment_entry",
    risk: "HIGH",
    // P9-C: the entity KIND is what the executor re-derives the direction from,
    // so the kind and the direction can never disagree inside one proposal.
    entity: { kind: supplier ? "supplier" : "customer", id: party.name, name: partyName },
    params: {
      // Advisory for the card only — the executor re-derives and ignores this.
      direction,
      amount_vnd: amount,
      // §9 provenance: was this number the user's (explicit) or derived from the
      // document (full balance)? Recorded in the snapshot so a later reviewer can
      // tell what was actually approved.
      amount_source: hasExplicitAmount ? "explicit" : "full_balance",
      invoice: target.name,
      // P9-D: the snapshot's debt number is the EFFECTIVE outstanding — the
      // same number the amount was clamped against. `detectDrift` compares the
      // execute-time re-read against THIS value, and the executor re-derives the
      // cover with the SAME code (see below), so a draft submitted/cancelled in
      // between changes the live number ⇒ PROPOSAL_STALE, not a silent write.
      // The RAW GL number rides along for the audit trail (display/compare only).
      outstanding_vnd: effectiveOutstanding,
      raw_outstanding_vnd: outstanding,
      draft_cover_vnd: outstanding - effectiveOutstanding,
      draft_cover_docs: draftCover.drafts,
      mode: opts.mode ?? "Tiền mặt",
      // Frozen intent: submit-or-draft is part of WHAT was approved.
      submit_now: submitNow,
      // P5-2 (§4.4): the DAY this receipt will post on is part of what was
      // approved, so it is frozen HERE — at proposal time, not at execute time.
      // Without it a confirm that lands after midnight moves the receipt to the
      // next day silently (review2 §9: nói 23:50, submit 00:01 ⇒ ngày nào?), and
      // posting_date is what decides which day's takings the money shows up in.
      posting_date: opts.now ? shopDay(opts.now) : shopDay(),
    },
    summary: `${spec.verb} ${amount}đ ${direction === "pay" ? "cho" : "từ"} ${partyName} cho chứng từ ${target.name}`,
    extra: {
      ambiguous,
      warnings,
      // P0 §9/§10.4 — the immutable action id travels WITH the proposal, so the
      // client round-trip cannot change what the ERPNext document is correlated
      // to (it is generated once, server-side, at proposal build time).
      action_id: newActionId(),
      schema_note: "params.amount_vnd là ĐỀ XUẤT — execute sẽ đọc lại nợ thật từ ERPNext và kẹp trần",
    },
  });

  return { proposal, invoice: target.name, outstanding_vnd: effectiveOutstanding, raw_outstanding_vnd: outstanding, warnings, action_id: proposal.action_id };
}

/**
 * Phase 3 §5.3 — build a COLLECT proposal from the form's explicit allocations.
 *
 * Unlike `buildPaymentProposal` (the chat path, which defaults to the OLDEST open
 * document), this builder NEVER chooses an invoice: the draft must name each one.
 * It re-reads the customer's live invoices for the resolved company, subtracts
 * same-company open drafts, bounds every allocation against that live remainder,
 * and emits ONE `params.allocations[]` entry per invoice plus exactly ONE payment
 * method (owner lock §6.1). With nothing open, the only legal shape is an empty
 * allocation list plus `unallocated` = the paid amount (an advance).
 *
 * Read-only: it builds a proposal and never writes (idempotency/execute is Phase 4).
 *
 * @param {object} skills  route factory bag (listUnpaidInvoices + draft-cover reads)
 * @param {object} p
 * @param {object} p.customer resolved customer row (from a live read)
 * @param {Array<{invoice_id:string, allocated_amount:number}>} p.allocations
 * @param {{mode:string, amount:number, account_id?:string|null}} p.method
 * @param {string|null} [p.company] company scope resolved SERVER-side
 * @param {string|null} [p.handoffId]
 * @param {boolean} [p.submitNow]
 * @param {Date} [p.now] injected clock (tests/ops only)
 * @returns {Promise<object>} { proposal, invoice, allocated_total_vnd, unallocated_vnd, effectiveOutstanding, warnings }
 */
export async function buildCollectProposal(skills, {
  customer,
  allocations = [],
  method,
  company = null,
  handoffId = null,
  submitNow = false,
  now = null,
} = {}) {
  if (!customer?.name) {
    throw Object.assign(new Error("không xác định được khách hàng để lập phiếu thu"), { code: "MISSING_REQUIRED_FIELD" });
  }
  if (!method || !Number.isInteger(method.amount) || method.amount <= 0) {
    throw Object.assign(new Error("số tiền thu phải là số nguyên VND dương"), { code: "PAYMENT_AMOUNT_INVALID" });
  }
  const partyName = customer.customer_name ?? customer.name;
  const direction = "receive";
  const spec = DIRECTION_SPEC[direction];

  const inv = await skills.listUnpaidInvoices(customer.name, { company });
  const rows = (inv?.data?.data ?? []).filter((r) => Number(r.outstanding_amount) !== 0);
  const cover = await openDraftCover(skills, customer.name, direction, { company });
  const effectiveOf = (r) => Math.round(Number(r.outstanding_amount) || 0) - (cover.drawn.get(String(r.name)) ?? 0);
  const byId = new Map(rows.map((r) => [String(r.name), r]));

  const list = Array.isArray(allocations) ? allocations : [];
  const seen = new Set();
  const validated = [];
  for (const a of list) {
    const invoiceId = String(a?.invoice_id ?? "").trim();
    const allocated = Number(a?.allocated_amount);
    if (!invoiceId) {
      throw Object.assign(new Error("thiếu mã hoá đơn trong phân bổ"), { code: "MISSING_REQUIRED_FIELD" });
    }
    if (seen.has(invoiceId)) {
      throw Object.assign(new Error(`hoá đơn ${invoiceId} bị chọn hai lần`), { code: "DUPLICATE_ALLOCATION" });
    }
    seen.add(invoiceId);
    const row = byId.get(invoiceId);
    if (!row) {
      throw Object.assign(
        new Error(`hoá đơn ${invoiceId} không thuộc khách này hoặc không còn mở`),
        { code: "NO_MATCH" },
      );
    }
    const effective = effectiveOf(row);
    if (effective <= 0) {
      throw Object.assign(
        new Error(`hoá đơn ${invoiceId} đã được phủ hết bởi phiếu thu NHÁP đang chờ — submit hoặc hủy phiếu đó trước khi thu tiếp`),
        { code: "INVOICE_ALREADY_PAID" },
      );
    }
    if (!Number.isInteger(allocated) || allocated <= 0) {
      throw Object.assign(new Error(`số tiền gạch cho ${invoiceId} phải là số nguyên VND dương`), { code: "INVALID_AMOUNT" });
    }
    if (allocated > effective) {
      throw Object.assign(
        new Error(`số tiền gạch cho ${invoiceId} vượt quá số còn nợ (${effective})`),
        { code: "INSUFFICIENT_OUTSTANDING" },
      );
    }
    validated.push({ invoice_id: invoiceId, allocated_amount: allocated, row, effective });
  }

  const allocatedTotal = validated.reduce((sum, a) => sum + a.allocated_amount, 0);
  const positive = rows.filter((r) => effectiveOf(r) > 0);
  let unallocatedVnd = 0;
  let target = null;
  if (validated.length === 0) {
    // Lock §6.3: with an open invoice an empty allocation list is refused; with
    // nothing open it is the ONLY legal shape (an advance).
    if (positive.length > 0) {
      throw Object.assign(
        new Error("khách còn hoá đơn mở — phải chọn hoá đơn cần gạch nợ (hệ thống không tự chọn giúp)"),
        { code: "MISSING_REQUIRED_FIELD" },
      );
    }
    unallocatedVnd = method.amount;
  } else {
    if (allocatedTotal !== method.amount) {
      throw Object.assign(
        new Error(`tổng gạch nợ (${allocatedTotal}) không khớp tổng tiền nhận (${method.amount})`),
        { code: "ALLOCATION_TOTAL_MISMATCH" },
      );
    }
    target = validated[0];
  }

  const warnings = [];
  if (cover.drafts.length > 0) {
    const covered = [...cover.drawn.entries()].filter(([, d]) => d > 0);
    if (covered.length > 0) {
      warnings.push(
        `đã có phiếu ${spec.verb.toLowerCase()} NHÁP chưa submit (${cover.drafts.join(", ")}) phủ ${covered
          .map(([n, d]) => `${n} ${Math.round(d)}đ`)
          .join(", ")} — số còn lại đã trừ phần này`,
      );
    }
  }

  const references = validated.map((a) => ({
    invoice: a.invoice_id,
    invoiceTotal: Math.round(Number(a.row.grand_total) || a.effective),
    invoiceOutstanding: a.effective,
    allocated_amount: a.allocated_amount,
  }));

  const proposal = buildProposal({
    action: "create_payment_entry",
    risk: "HIGH",
    entity: { kind: "customer", id: customer.name, name: partyName },
    params: {
      direction,
      amount_vnd: method.amount,
      amount_source: "explicit",
      // The ONE invoice the executor anchors on (Phase 4 widens execute to many);
      // the full list travels in `allocations` and is what the card shows.
      invoice: target?.invoice_id ?? null,
      allocations: validated.map((a) => ({ invoice_id: a.invoice_id, allocated_amount: a.allocated_amount })),
      payment_methods: [{ mode: method.mode, amount: method.amount, account_id: method.account_id ?? null }],
      unallocated_vnd: unallocatedVnd,
      reference_amounts: references,
      outstanding_vnd: target ? target.effective : 0,
      draft_cover_docs: cover.drafts,
      mode: method.mode,
      submit_now: submitNow,
      posting_date: now ? shopDay(now) : shopDay(),
    },
    summary: validated.length > 0
      ? `Thu ${method.amount}đ từ ${partyName} cho ${validated.map((a) => a.invoice_id).join(", ")}`
      : `Thu ${method.amount}đ từ ${partyName} (không gắn hoá đơn — trả trước)`,
    extra: {
      warnings,
      action_id: newActionId(),
      handoff_id: handoffId,
      schema_note: "params.amount_vnd là ĐỀ XUẤT — execute sẽ đọc lại nợ thật từ ERPNext và kẹp trần",
    },
  });

  return {
    proposal,
    invoice: target?.invoice_id ?? null,
    allocated_total_vnd: allocatedTotal,
    unallocated_vnd: unallocatedVnd,
    warnings,
    action_id: proposal.action_id,
  };
}

/**
 * Stage B — execute a CONFIRMED proposal. Called only from the /execute path
 * (http-ask) AFTER the idempotency gate. Amounts are re-read and clamped
 * against live ERPNext data — the client's numbers are advisory only.
 *
 * @param {object} mcp      MCP client (mock or real)
 * @param {object} proposal erpn.proposal/v1 with action=create_payment_entry
 * @param {string} commandId UUID from the client (idempotency key)
 * @param {object} store    IdempotencyStore (already gated this command)
 * @param {object} [opts]   { now } — an injected clock for tests/ops only; the
 *                          gateway passes its own bag, never client input
 * @returns {object} { erpnext_doc, paid_vnd, invoice, customer }
 */
export async function executePaymentProposal(mcp, proposal, commandId, store, opts = {}) {
  const { id: customerId } = proposal.entity;
  const requestedInvoice = proposal.params?.invoice;

  // Phase 4: a multi-invoice proposal IS executable now. The reference rows are
  // built from `params.allocations[]` further down, each one re-bounded by the
  // invoice's own live remainder — the old single-reference boundary (and its
  // PAYMENT_MULTI_REFERENCE_NOT_READY refusal) is gone.
  // 1. DIRECTION, re-derived SERVER-SIDE from the party id — not read from
  //    `params.direction` (client-authoritative at /execute) and not even from
  //    `entity.kind` alone: the kind only selects WHICH master is then read, and
  //    a kind that disagrees with that master refuses here. So a crafted
  //    direction cannot pick which document gets written; it can only make the
  //    master read fail.
  const direction = directionOf(proposal);
  const spec = DIRECTION_SPEC[direction];
  if (direction === "pay") {
    assertReadOnly("erpnext_doc_get");
    let supplierDoc = null;
    let readError = null;
    try {
      supplierDoc = docOf(await mcp.callTool("erpnext_doc_get", { doctype: spec.party_doctype, name: customerId }));
    } catch (err) {
      // Keep WHY it could not be confirmed: "not a supplier" and "the read was
      // denied" are different problems for the operator, and collapsing them
      // would send someone looking for the wrong one. Both refuse (fail closed).
      readError = err?.message ?? String(err);
      supplierDoc = null;
    }
    if (!supplierDoc?.name) {
      throw Object.assign(
        new Error(
          `đề xuất khai hướng CHI nhưng không xác nhận được "${customerId}" là nhà cung cấp trên ERPNext` +
            `${readError ? ` (lỗi đọc Supplier: ${readError})` : ""} — TỪ CHỐI ghi (không tự chuyển sang phiếu thu)`,
        ),
        { code: "PAYMENT_PARTY_NOT_SUPPLIER", read_error: readError },
      );
    }
  }

  // 2. RE-READ live outstanding from ERPNext (never trust the proposal).
  assertReadOnly("erpnext_sales_invoice_list");
  const inv = direction === "pay"
    ? await listOpenPurchaseInvoices(mcp, customerId)
    : await mcp.callTool("erpnext_sales_invoice_list", { customer: customerId, limit: 100 });
  const openRows = rowsOf(inv).filter((r) => Number(r.outstanding_amount) !== 0);

  // ── Phase 4 — WHICH invoices does this confirmation settle? ────────────────
  //   `params.allocations` PRESENT ⇒ a COLLECT proposal: exactly the invoices the
  //     user ticked (Phase 3 always writes the key; an EMPTY list is the
  //     advance/on-account shape, legal only when nothing is open — lock §6.3).
  //   ABSENT ⇒ the chat-driven payment path: exactly ONE anchor invoice
  //     (`params.invoice`, or the oldest open one) — byte-compatible with every
  //     pre-Phase-4 caller, and the shape its own tests pin.
  const allocationList = Array.isArray(proposal.params?.allocations) ? proposal.params.allocations : null;
  const anchorDoctype = DIRECTION_SPEC[direction].anchor_doctype;
  let settled;
  if (allocationList) {
    // Each allocated invoice is confirmed on its OWN document read. The list read
    // above cannot answer this: `erpnext_sales_invoice_list` has a FIXED field set
    // with NO `company` and NO `docstatus` (documented in `sales.mjs`), so a
    // confirmation built on it could not tell whether an allocation points at
    // another company — or at an invoice that is not even submitted yet.
    settled = [];
    for (const raw of allocationList) {
      const invoiceId = String(raw?.invoice_id ?? "").trim();
      if (!invoiceId) {
        throw Object.assign(new Error("phân bổ thiếu mã hoá đơn — không ghi gì"), { code: "MISSING_REQUIRED_FIELD" });
      }
      let doc = null;
      let readError = null;
      try {
        assertReadOnly("erpnext_doc_get");
        doc = docOf(await mcp.callTool("erpnext_doc_get", { doctype: anchorDoctype, name: invoiceId }));
      } catch (err) {
        readError = err?.message ?? String(err);
      }
      if (!doc || readError) {
        // An unreadable document is an OUTAGE, not "the debt is gone" — saying
        // the latter would send the seller looking for a payment nobody made.
        throw Object.assign(
          new Error(`không đọc được chứng từ ${invoiceId} từ ERPNext: ${readError ?? "không có dữ liệu trả về"} — chưa ghi gì, thử lại`),
          { code: "PAYMENT_ERP_UNAVAILABLE" },
        );
      }
      settled.push({
        invoice_id: invoiceId,
        allocated: Number(raw?.allocated_amount),
        // Same row shape the legacy list read produces, so ONE loop validates both.
        row: {
          name: doc.name ?? invoiceId,
          company: doc.company,
          posting_date: doc.posting_date,
          grand_total: doc.grand_total,
          outstanding_amount: doc.outstanding_amount,
          is_return: doc.is_return,
          docstatus: doc.docstatus,
          debit_to: doc.debit_to,
          credit_to: doc.credit_to,
          customer: doc.customer,
          supplier: doc.supplier,
        },
      });
    }
  } else {
    const oldestRow = [...openRows].sort((a, b) => String(a.posting_date).localeCompare(String(b.posting_date)))[0];
    settled = [
      {
        invoice_id: requestedInvoice ?? oldestRow?.name ?? null,
        allocated: null,
        row: requestedInvoice ? openRows.find((r) => r.name === requestedInvoice) : oldestRow,
      },
    ];
  }

  for (const s of settled) {
    if (!s.row) {
      throw Object.assign(
        new Error(
          `chứng từ ${s.invoice_id ?? "(mới nhất)"} không còn nợ tại thời điểm xác nhận — đã có người ${direction === "pay" ? "trả" : "thu"} trước đó`,
        ),
        { code: "PAYMENT_INVOICE_ALREADY_SETTLED" },
      );
    }
    // Phase 4: an allocation may only point at a SUBMITTED invoice (a draft is
    // not yet debt). The legacy list read carries no docstatus, so this is
    // asserted only where the document itself was read.
    if (s.row.docstatus !== undefined && Number(s.row.docstatus) !== 1) {
      throw Object.assign(
        new Error(`hoá đơn ${s.row.name} chưa được submit (docstatus ${s.row.docstatus}) — không phải khoản nợ, không ghi gì`),
        { code: "PAYMENT_INVOICE_NOT_RECEIVABLE" },
      );
    }
    // `<= 0` alone lets NaN through (NaN <= 0 is false), which would build a
    // payload with paid_amount NaN. Require a finite positive number instead
    // (review finding, 2026-09-16).
    const rawOutstanding = Number(s.row.outstanding_amount);
    if (Number(s.row.is_return) === 1 || !Number.isFinite(rawOutstanding) || rawOutstanding <= 0) {
      // P9-C: name the side the operator is actually on. (The CODE keeps its
      // historical name — it is mapped in P2's uncertainty table and asserted by
      // existing tests — but a pay-out told to look for a "receivable" would send
      // someone hunting the wrong ledger.)
      throw Object.assign(
        new Error(
          `chứng từ ${s.row.name} không phải khoản ${direction === "pay" ? "phải trả" : "phải thu"} dương`,
        ),
        { code: "PAYMENT_INVOICE_NOT_RECEIVABLE" },
      );
    }
    s.live_gl = Math.round(rawOutstanding);
  }

  // One Payment Entry moves money under ONE company, so a confirmation whose
  // invoices live in different companies is refused: writing it would put another
  // tenant's document behind one company's ledger.
  const settledCompanies = new Set(settled.map((s) => String(s.row.company ?? "")));
  if (settledCompanies.size > 1) {
    throw Object.assign(
      new Error(
        `các hoá đơn được chọn thuộc nhiều công ty (${[...settledCompanies].filter(Boolean).join(", ")}) — một phiếu chỉ ghi cho một công ty`,
      ),
      { code: "PAYMENT_MIXED_COMPANY" },
    );
  }
  const anchorCompany = settled[0]?.row.company ?? null;

  // P9-D — re-derive the DRAFT COVER at execute time with the SAME code the
  // builder used. A draft payment submitted/cancelled between proposal and
  // confirm changes this number ⇒ the drift check below refuses (the live
  // snapshot no longer matches), exactly the PROPOSAL_STALE contract. Without
  // the re-derivation a draft submitted in between would make the snapshot look
  // "too small" and a draft CANCELLED in between would let the write proceed
  // on a ceiling that double-counts nothing — both wrong in the money path.
  // The cover read is scoped to the anchor's own company (§5.2). Undefined on a
  // site/tool that omits `company` ⇒ old behaviour.
  const coverReads = {
    listOpenDraftPaymentEntries: (pid, o = {}) => listOpenDraftPaymentEntries(mcp, pid, o),
    getPaymentEntryDoc: (n) => getPaymentEntryDoc(mcp, n),
  };
  const liveCover = settled.length > 0
    ? await openDraftCover(coverReads, customerId, direction, { company: anchorCompany ?? null })
    : { drawn: new Map(), drafts: [] };
  for (const s of settled) {
    s.live_effective = Math.max(0, s.live_gl - (liveCover.drawn.get(String(s.row.name)) ?? 0));
  }
  // The chat path's single anchor — kept for the drift compare further down and
  // for the legacy "amount may not exceed the anchor's remainder" rule.
  const target = settled[0];
  const liveEffective = target?.live_effective ?? 0;
  const liveOutstanding = target?.live_gl ?? 0;

  // The amount is the client's INTENT; the live outstanding is the CEILING. The two
  // must not be conflated (review finding, 2026-09-16): `Number(x) || live`
  // treats 0/NaN/"" as "collect everything", so a client that sends amount 0
  // (which buildPaymentProposal() itself rejects as PAYMENT_AMOUNT_INVALID)
  // would silently write a payment for the FULL debt. Fail closed instead —
  // never promote an invalid amount into a bigger one. This runs BEFORE
  // setReference(), so nothing is registered and nothing is written.
  const requested = Number(proposal.params?.amount_vnd);
  if (!Number.isFinite(requested) || requested <= 0) {
    throw Object.assign(
      new Error(
        `số tiền ${direction === "pay" ? "chi" : "thu"} không hợp lệ (amount_vnd=${JSON.stringify(proposal.params?.amount_vnd)}) — từ chối ghi`,
      ),
      { code: "PAYMENT_AMOUNT_INVALID" },
    );
  }

  // Phase 9 (review of phase-07 behaviour): the proposal's snapshot must still
  // match ERPNext. Phase 7 CLAMPED the amount to the live debt and wrote anyway
  // — safe for the money but silent for the user. Now a mismatch is refused so
  // the user re-confirms on fresh numbers. This runs BEFORE setReference(), so
  // nothing is registered and nothing is written.
  if (allocationList) {
    // A COLLECT confirmation is checked PER INVOICE against that invoice's own
    // live number. `detectDrift` (the chat branch below) compares ONE snapshot
    // with ONE live number and holds the payment TOTAL against a single
    // remainder — which would false-stale a legitimate split (2 × 250.000 on two
    // invoices that each still owe 300.000: the total is "bigger than the debt"
    // while every allocation fits). Phase 3 wrote the per-invoice snapshot into
    // `params.reference_amounts[]`, which is exactly this comparison's input, so
    // the same contract survives: numbers moved ⇒ re-confirm, never a silent write.
    const snapshots = new Map(
      (Array.isArray(proposal.params?.reference_amounts) ? proposal.params.reference_amounts : []).map((r) => [
        String(r?.invoice ?? r?.invoice_id ?? ""),
        Number(r?.invoiceOutstanding ?? r?.outstanding_amount),
      ]),
    );
    const problems = [];
    for (const s of settled) {
      const snap = snapshots.get(String(s.row.name));
      if (Number.isFinite(snap) && Math.round(snap) !== Math.round(s.live_effective)) {
        problems.push(
          `nợ của ${s.row.name} lúc tạo đề xuất ${Math.round(snap)} ≠ nợ hiện tại ${Math.round(s.live_effective)}`,
        );
      }
      // The party field is the one `detectDrift` uses to notice an invoice that
      // moved to another master; the per-invoice document read carries it.
      const partyField = direction === "pay" ? "supplier" : "customer";
      if (s.row[partyField] !== undefined && String(s.row[partyField]) !== String(customerId)) {
        problems.push(`chứng từ ${s.row.name} không còn thuộc ${spec.label} ${customerId} (nay là ${s.row[partyField]})`);
      }
    }
    if (problems.length > 0) {
      throw Object.assign(
        new Error(`đề xuất đã lệch so với dữ liệu thật: ${problems.join("; ")} — KHÔNG ghi, hãy xác nhận lại`),
        { code: "PROPOSAL_STALE", drift_code: classifyDriftCode(problems), problems },
      );
    }
  } else {
    const drift = detectDrift(proposal, {
      // `detectDrift` compares the anchor's PARTY field; a Purchase Invoice stores
      // it as `supplier`, a Sales Invoice as `customer`. Passing the right one is
      // what keeps the freshness check meaningful on both sides.
      // P9-D: the compared debt number is the LIVE EFFECTIVE ceiling (GL minus
      // open drafts, re-derived above) — the same definition the snapshot was
      // written with. Comparing against raw GL would refuse EVERY confirm when a
      // draft exists (snapshot = effective < live raw) — a false stale on the
      // ordinary path. The GL itself is re-read live two steps up and still the
      // source of truth for the clamps below: no semantic change after submit.
      customerId,
      invoice: target.row.name,
      outstanding_vnd: liveEffective,
      customer: (direction === "pay" ? target.row.supplier : target.row.customer) ?? null,
    });
    if (drift.length > 0) {
      throw Object.assign(
        new Error(`đề xuất đã lệch so với dữ liệu thật: ${drift.join("; ")} — KHÔNG ghi, hãy xác nhận lại`),
        // P1: name WHICH kind of staleness (taxonomy §12) — the generic
        // PROPOSAL_STALE stays for compatibility, `drift_code` is what the
        // gateway answers with.
        { code: "PROPOSAL_STALE", drift_code: classifyDriftCode(drift), problems: drift },
      );
    }
  }

  // P5-2 self-review finding (2026-09-22): the posting DAY is client-supplied
  // too — /execute takes `params` straight from the request body — and it is
  // the one client parameter that decides which DAY's books the money lands in.
  // So it is validated HERE, with the other re-checks and BEFORE
  // setReference(), so a refused date registers nothing and writes nothing.
  const postingDate = readPostingDate(proposal, opts.now ?? new Date());

  // P9-D: WHAT ACTUALLY REFUSES A SECOND CARD IS `detectDrift` ABOVE — it is fed
  // `outstanding_vnd: liveEffective`, so a proposal built before a draft existed
  // (snapshot = raw GL) no longer matches (live = GL − drafts) and gets
  // PROPOSAL_STALE; one built after (snapshot = effective) that asks for more
  // than the effective remainder is refused there too. This check is the narrow
  // backstop BEHIND it, for the one input shape the drift compare rounds away:
  // a crafted fractional amount (1_500_000.4) rounds equal to the snapshot but
  // still exceeds it exactly. Fail closed rather than rely on that rounding.
  // Raw GL remains the truth for everything else — the reference row's
  // outstanding_amount below records the RAW live number, as it always did.
  const paid = Math.round(requested);
  const modeRequested = proposal.params?.mode ?? "Tiền mặt";
  // §6.1 — a collect confirmation carries exactly ONE payment method, and the
  // account it names is an INPUT TO CHECK (never an instruction): the resolver
  // re-reads the company's accounts and refuses a wrong-typed or foreign one.
  //
  // The COUNT is re-checked HERE, not only in the draft validator: /execute takes
  // the proposal straight from the request body, so a crafted pair of methods
  // would otherwise be silently narrowed to `[0]` — a receipt the user never
  // approved (F6). One entry point, one method, or no write.
  if (Array.isArray(proposal.params?.payment_methods) && proposal.params.payment_methods.length > 1) {
    throw Object.assign(
      new Error(
        `một phiếu chỉ có MỘT hình thức thanh toán — nhận ${proposal.params.payment_methods.length}, từ chối ghi`,
      ),
      { code: "PAYMENT_METHOD_COUNT_INVALID" },
    );
  }
  const chosenAccount =
    typeof proposal.params?.payment_methods?.[0]?.account_id === "string"
      ? proposal.params.payment_methods[0].account_id
      : null;
  const totalAllocated = settled.reduce((sum, s) => sum + (allocationList ? s.allocated : paid), 0);

  if (allocationList) {
    if (settled.length === 0) {
      // Advance/on-account: nothing is allocated, the whole amount is unallocated.
      // The legal-only-when-nothing-is-open rule is enforced below, once the
      // company is known.
    } else {
      for (const s of settled) {
        if (!Number.isInteger(s.allocated) || s.allocated <= 0) {
          throw Object.assign(
            new Error(`số tiền gạch cho ${s.row.name} phải là số nguyên VND dương`),
            { code: "INVALID_AMOUNT" },
          );
        }
        // Per-invoice ceiling. The payment TOTAL may legitimately exceed one
        // invoice's remainder — that is what a multi-invoice collection IS — so
        // the legacy total-vs-one-invoice rule below must NOT be applied here.
        if (s.allocated > s.live_effective) {
          throw Object.assign(
            new Error(
              `số tiền gạch cho ${s.row.name} (${s.allocated}) vượt phần còn lại (${s.live_effective} — đã trừ phiếu ${spec.verb.toLowerCase()} NHÁP đang chờ trên GL ${s.live_gl}) — không ghi, hãy hỏi lại`,
            ),
            { code: "PAYMENT_AMOUNT_EXCEEDS_REMAINDER" },
          );
        }
      }
      if (totalAllocated > paid) {
        throw Object.assign(
          new Error(`tổng gạch nợ (${totalAllocated}) vượt số tiền nhận (${paid}) — không ghi, hãy hỏi lại`),
          { code: "PAYMENT_AMOUNT_EXCEEDS_REMAINDER" },
        );
      }
      // The split the user approved must still be the split being written: the
      // unallocated part is the SERVER's arithmetic, compared with the snapshot.
      const claimedUnallocated = Number(proposal.params?.unallocated_vnd);
      if (Number.isFinite(claimedUnallocated) && Math.round(claimedUnallocated) !== paid - totalAllocated) {
        throw Object.assign(
          new Error(
            `phần không gạch nợ đã thay đổi: đề xuất ${Math.round(claimedUnallocated)} ≠ thực tế ${paid - totalAllocated} — KHÔNG ghi, hãy xác nhận lại`,
          ),
          { code: "PROPOSAL_STALE", drift_code: "PROPOSAL_VERSION_STALE" },
        );
      }
    }
  } else if (requested > liveEffective) {
    throw Object.assign(
      new Error(
        `số tiền ${Math.round(requested)} vượt phần còn lại của ${target.row.name} (${liveEffective} — đã trừ phiếu ${spec.verb.toLowerCase()} NHÁP đang chờ trên GL ${liveOutstanding}) — không ghi, hãy hỏi lại`,
      ),
      { code: "PAYMENT_AMOUNT_EXCEEDS_REMAINDER" },
    );
  }

  // 2. Accounts AND the mode-of-payment document name are READ from ERPNext at
  //    execute time: account names embed a company abbreviation, and the
  //    Vietnamese label is usually not the stored document name (both facts
  //    learned from a real LinkValidationError, 2026-09-16).
  //    An invoiced run anchors on the first allocation; an ADVANCE has no invoice
  //    to read a company/anchor ledger from, so it resolves both from the
  //    company itself (the same §6.2 rule, one implementation).
  const accounts = settled.length > 0
    ? await resolvePaymentAccounts(mcp, {
        direction,
        invoice: settled[0].row.name,
        mode: modeRequested,
        account: chosenAccount,
      })
    : await resolveAdvanceAccounts(mcp, {
        direction,
        mode: modeRequested,
        account: chosenAccount,
        company: opts.company ?? null,
      });
  const mode = accounts.mode;

  // Lock §6.3 — an advance is legal ONLY when the counterparty has nothing open.
  // Asked here because it needs the company (which the advance resolver just
  // resolved) and because it must run BEFORE setReference()/the write.
  if (allocationList && settled.length === 0) {
    const advanceCover = await openDraftCover(coverReads, customerId, direction, { company: accounts.company });
    const stillOpen = openRows.filter((r) => {
      const effective = Math.round(Number(r.outstanding_amount) || 0) - (advanceCover.drawn.get(String(r.name)) ?? 0);
      return effective > 0;
    });
    if (stillOpen.length > 0) {
      throw Object.assign(
        new Error(
          `đối tác còn ${stillOpen.length} chứng từ đang nợ (${stillOpen
            .slice(0, 3)
            .map((r) => r.name)
            .join(", ")}) — phiếu không gắn hoá đơn chỉ dùng khi không còn nợ; hãy chọn hoá đơn cần gạch`,
        ),
        { code: "MISSING_REQUIRED_FIELD" },
      );
    }
  }

  // 3. Register the ERPNext-side reference BEFORE the write (crash safety):
  //    if we die mid-call, reconcile looks for reference_no = command_id.
  store.setReference(commandId, commandId);

  // 4. THE WRITE — the only create call in the entire project.
  //    Tool name verified in the pinned @casys/mcp-erpnext 3.0.4 source: there
  //    is NO `erpnext_create_payment_entry`; creating a document is
  //    `erpnext_doc_create` with {doctype, data}. The client's write gate only
  //    lets that tool through for doctype "Payment Entry" (fail-closed).
  if (typeof mcp.callWriteTool !== "function") {
    throw Object.assign(new Error("EXECUTE_CLIENT_UNSUPPORTED: this MCP client has no write method"), { code: "EXECUTE_CLIENT_UNSUPPORTED" });
  }
  // `postingDate` was already read FROM THE SNAPSHOT and validated above, with
  // the other client-parameter re-checks and before setReference() — see
  // readPostingDate(). It is never recomputed from the clock here.
  const actionId = proposal.action_id ?? null;
  // One reference row per settlement, ordered by the invoices' own dates so the
  // ERPNext form always shows the same order (display only — the ORDER carries
  // no allocation meaning, the amount in each row does).
  const ordered = [...settled].sort(
    (a, b) =>
      String(a.row.posting_date ?? "").localeCompare(String(b.row.posting_date ?? "")) ||
      String(a.row.name).localeCompare(String(b.row.name)),
  );
  const references = ordered.map((s) => ({
    invoice: s.row.name,
    invoiceTotal: Math.round(Number(s.row.grand_total) || s.live_gl),
    invoiceOutstanding: s.live_gl,
    // Legacy (no allocations): the whole paid amount goes on the single row,
    // exactly as the previous single-invoice payload did.
    allocated_amount: allocationList ? s.allocated : paid,
  }));
  const unallocated = paid - totalAllocated;
  const data = buildPaymentEntryData({
    direction,
    partyId: customerId,
    paid,
    commandId,
    actionId,
    mode,
    references,
    unallocated,
    company: accounts.company,
    paidFrom: accounts.paidFrom,
    paidTo: accounts.paidTo,
    postingDate,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });

  const doc = docOf(res);
  const docName = doc?.name ?? null;
  if (!docName) {
    throw Object.assign(new Error("ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile"), {
      code: "PAYMENT_WRITE_UNVERIFIED",
    });
  }

  // 5. VERIFY by reading the document back — the write response is not evidence.
  //    Phase 4 widens the read-back to everything this change can now get wrong:
  //    the company and both ledgers, the whole amount split, and EVERY reference
  //    row (count + per-invoice allocated amount).
  const verified = await verifyWrittenPayment(mcp, docName, {
    commandId,
    paid,
    customerId,
    actionId,
    direction,
    expect: {
      company: accounts.company,
      paidFrom: accounts.paidFrom,
      paidTo: accounts.paidTo,
      unallocated,
      references,
    },
  });

  const result = {
    erpnext_doc: docName,
    paid_vnd: paid,
    // `invoice` stays the ANCHOR invoice for every existing client/test; the
    // full list travels beside it (a multi-invoice receipt has no single one).
    invoice: ordered[0]?.row.name ?? null,
    invoices: ordered.map((s) => s.row.name),
    allocated_vnd: totalAllocated,
    unallocated_vnd: unallocated,
    customer: customerId,
    // P9-C: which direction actually got written, and under which key the party
    // travels. `customer` stays populated for every existing client/test that
    // reads it (on the pay side it is the supplier id — see `party_kind`).
    direction,
    party_kind: spec.party_type.toLowerCase(),
    reference_no: commandId,
    action_id: actionId,
    docstatus: verified.docstatus ?? 0,
    mode_of_payment: mode,
    note: `phiếu ${direction === "pay" ? "chi" : "thu"} tạo ở trạng thái NHÁP (docstatus 0) — submit là bước riêng, cần người quyết định`,
  };
  if (actionId && !Object.prototype.hasOwnProperty.call(verified, correlationField())) {
    // The site has not run the schema migration yet: the value could not be
    // stored. Say so instead of pretending the correlation exists (§10.4).
    result.correlation_field_missing = correlationField();
  }
  if (mode !== modeRequested) {
    // Surface the substitution — silently paying into a different channel
    // would be a reportable business difference, not a cosmetic detail.
    result.mode_substituted_from = modeRequested;
  }
  if (accounts.mode_warning) {
    // F-P5-2/decision C: the site declares a method whose NAME matched the user's
    // words but whose `type` contradicts the channel; a real same-channel method
    // was used instead, and this names the conflict so an operator can fix the
    // site's data (F-P5-3: MoP "Chuyển khoản" is typed Cash).
    result.mode_warning = accounts.mode_warning;
  }

  // F7-2 — CONDITIONAL SUBMIT (user decision 2026-09-18). The draft is DONE and
  // verified at this point: whatever happens below must never turn the whole
  // transaction into FAILED (the money record exists; begin() refuses FAILED so
  // a terminal mark would make reconcile impossible). The submit flag comes
  // from the SNAPSHOT (params.submit_now), frozen when the proposal was built —
  // the server does not re-read any client-side setting here.
  //
  // PROMPT-4 tightened the END state: once `submit_now` is true the command is
  // COMPLETED only on a verified `docstatus === 1`. An unverified submit stays
  // PENDING (reconcile-able) instead — see the two throw sites below.
  if (proposal.params?.submit_now !== true) {
    result.note = `phiếu ${direction === "pay" ? "chi" : "thu"} tạo ở trạng thái NHÁP (docstatus 0) — submit là bước riêng, cần người quyết định`;
    store.complete(commandId, result);
    return result;
  }
  result.submit_requested = true;
  try {
    // Deliberately NOT assertReadOnly(): the guard refuses every write verb by
    // design. The submit reaches ERPNext only through callWriteTool(), whose
    // gate now allows exactly one more shape — erpnext_doc_submit on the SAME
    // Payment Entry doctype (fail-closed in client.mjs).
    await mcp.callWriteTool("erpnext_doc_submit", { doctype: WRITE_DOCTYPE, name: docName });
  } catch (err) {
    // PROMPT-4 (targeted correctness fix): the submit call THREW, so the
    // outcome is UNKNOWN — ERPNext may have APPLIED the submit and only the
    // response was lost (socket hang up / timeout). Writing `docstatus: 0` into
    // a COMPLETED record would turn that assumption into a frozen "fact":
    // begin() replays a COMPLETED command WITHOUT re-reading ERPNext, so the app
    // would report "chưa nộp" forever even when ERPNext says docstatus 1, and no
    // reconcile could ever correct it. Invariant (spec §6.1): "chỉ complete
    // pending action sau khi verify ERPNext thành công". Here it is NOT verified,
    // so the command stays PENDING: the draft is REAL (reference_no is already
    // registered), and the next attempt reconciles against ERPNext by that
    // reference and reports the TRUE docstatus (0 or 1). NOT FAILED either —
    // FAILED is terminal and would make reconcile impossible.
    const submitError = err?.message ?? String(err);
    process.stderr.write(
      `[payment-write] submit UNVERIFIED after draft: command=${commandId} doc=${docName} error=${submitError}\n`,
    );
    throw Object.assign(
      new Error(
        `đã tạo NHÁP ${docName} nhưng CHƯA xác minh được submit (${submitError}) — chưa coi là đã nộp; gửi lại ĐÚNG command_id để hệ thống đối soát ERPNext`,
      ),
      {
        // In `unverifiedCodes`, so the Safety Gateway keeps the command PENDING
        // and answers 503 retry_same_command_id (it does NOT burn the id).
        code: "PAYMENT_WRITE_UNVERIFIED",
        erpnext_doc: docName,
        submit_error: submitError,
        // P5-2 (§4.2): WHICH refusal, beside the verbatim message. `other` when
        // the string carries no known marker — never a guess at the kind.
        submit_error_kind: classifySubmitError(submitError),
      },
    );
  }
  // 6. VERIFY THE SUBMIT by reading the doc back — same rule as the create.
  const submitted = await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName });
  const submittedDoc = docOf(submitted);
  const finalStatus = Number(submittedDoc?.docstatus);
  if (finalStatus !== 1) {
    // PROMPT-4: the submit call "succeeded" but a fresh READ proves the document
    // is STILL a draft — the requested end state (docstatus 1) was NOT achieved,
    // so the action is not verified complete. Same rule as above: do NOT complete
    // with an assumed draft state; stay PENDING so a retry reconciles against
    // ERPNext (and reports whatever ERPNext really holds). It is not FAILED — a
    // terminal mark would make reconcile impossible.
    const detail = `sau submit, docstatus đọc lại = ${submittedDoc?.docstatus ?? "?"} (mong đợi 1)`;
    process.stderr.write(
      `[payment-write] submit unverified: command=${commandId} doc=${docName} docstatus=${submittedDoc?.docstatus}\n`,
    );
    throw Object.assign(
      new Error(
        `đã tạo NHÁP ${docName}, submit chưa xác minh được: ${detail} — gửi lại ĐÚNG command_id để hệ thống đối soát ERPNext`,
      ),
      {
        code: "PAYMENT_WRITE_UNVERIFIED",
        erpnext_doc: docName,
        submit_error: detail,
        // This message is OURS, not ERPNext's — the submit call did not refuse,
        // the read-back disagreed. Deliberately `other`.
        submit_error_kind: "other",
      },
    );
  }
  result.submit_ok = true;
  result.docstatus = finalStatus;
  result.note = direction === "pay"
    ? "phiếu chi ĐÃ SUBMIT (docstatus 1) — công nợ nhà cung cấp đã giảm; hoàn tác = cancel trên ERPNext"
    : "phiếu thu ĐÃ SUBMIT (docstatus 1) — công nợ khách đã giảm; hoàn tác = cancel trên ERPNext";
  store.complete(commandId, result);
  return result;
}
