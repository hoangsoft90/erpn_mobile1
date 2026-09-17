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
import { buildProposal } from "../action-proposal.mjs";
import { detectDrift } from "../proposal-freshness.mjs";
import { getCapability } from "../capability-contract.mjs";

/** The ONE doctype this project may ever create (fail-closed everywhere). */
export const WRITE_DOCTYPE = "Payment Entry";

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
 * a Receive payment needs the party, both accounts and the amount, and the
 * `references` child row is what actually ALLOCATES the money to the invoice
 * (without it the payment parks as an unallocated advance and the invoice
 * stays outstanding).
 */
export function buildPaymentEntryData({
  customerId,
  paid,
  commandId,
  actionId,
  mode = "Tiền mặt",
  invoice,
  invoiceTotal,
  invoiceOutstanding,
  company,
  paidFrom,
  paidTo,
  postingDate,
}) {
  return {
    payment_type: "Receive",
    party_type: "Customer",
    party: customerId,
    company,
    posting_date: postingDate,
    paid_from: paidFrom,
    paid_to: paidTo,
    paid_amount: paid,
    received_amount: paid,
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
    references: [
      {
        reference_doctype: "Sales Invoice",
        reference_name: invoice,
        total_amount: invoiceTotal,
        outstanding_amount: invoiceOutstanding,
        allocated_amount: paid,
      },
    ],
  };
}

/**
 * Resolve the two accounts the Payment Entry needs, READING them from ERPNext
 * (never hardcoded — account names carry a company abbreviation).
 *
 *   paid_from = the invoice's `debit_to` (receivable) — read from the invoice
 *   mode      = the REAL Mode of Payment document name on this site (the
 *               Vietnamese label "Tiền mặt" usually does NOT exist there;
 *               ERPNext refuses the write with LinkValidationError otherwise
 *               — hit for real on 2026-09-16)
 *   paid_to   = that mode's default account for the company, falling back to
 *               the company's first Cash-type ledger account
 *
 * @returns {Promise<{company: string, paidFrom: string, paidTo: string, mode: string, mode_requested: string}>}
 */
export async function resolvePaymentAccounts(mcp, { invoice, mode = "Tiền mặt" }) {
  const requestedMode = mode;
  const invRes = await mcp.callTool("erpnext_doc_get", { doctype: "Sales Invoice", name: invoice });
  const inv = docOf(invRes);
  const company = inv.company;
  const paidFrom = inv.debit_to;
  if (!company || !paidFrom) {
    throw Object.assign(
      new Error(`không đọc được company/debit_to của chứng từ ${invoice} — không dựng được phiếu thu`),
      { code: "PAYMENT_ACCOUNT_UNRESOLVED" },
    );
  }

  // Resolve the Mode of Payment NAME first — the write is a Link field, so a
  // label that does not exist on this site makes ERPNext reject the document.
  let modeName = requestedMode;
  try {
    const listRes = await mcp.callTool("erpnext_doc_list", {
      doctype: "Mode of Payment",
      fields: ["name", "enabled", "type"],
      limit: 50,
    });
    const modes = rowsOf(listRes).filter((m) => m.enabled === undefined || Number(m.enabled) !== 0);
    // Deterministic preference order, most specific first:
    //   1. the requested label IS the stored name
    //   2. a mode whose name is "cash"-like ("Tiền mặt" = cash in English)
    //   3. any enabled Cash-type mode
    //   4. whatever exists (better a real document than a label ERPNext rejects)
    const wanted = String(requestedMode).trim().toLowerCase();
    const exact = modes.find((m) => String(m.name).toLowerCase() === wanted);
    const cashNamed = modes.find((m) => /cash/i.test(String(m.name)));
    const cashTyped = modes.find((m) => String(m.type).toLowerCase() === "cash");
    const chosen = exact?.name ?? cashNamed?.name ?? cashTyped?.name;
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

  let paidTo = null;
  try {
    const modeRes = await mcp.callTool("erpnext_doc_get", { doctype: "Mode of Payment", name: modeName });
    const modeDoc = docOf(modeRes);
    const row = (modeDoc.accounts ?? []).find((a) => a.company === company) ??
      (modeDoc.accounts ?? []).find((a) => !a.company);
    paidTo = row?.default_account ?? null;
  } catch {
    paidTo = null; // mode doc unreadable ⇒ fall through to the Cash lookup
  }
  if (!paidTo) {
    const accRes = await mcp.callTool("erpnext_account_list", { company, root_type: "Asset", limit: 200 });
    const cash = rowsOf(accRes).find(
      (a) => !a.is_group && (a.account_type === "Cash" || /cash|tiền mặt/i.test(String(a.account_name ?? a.name))),
    );
    paidTo = cash?.name ?? null;
  }
  if (!paidTo) {
    throw Object.assign(
      new Error(`không xác định được tài khoản nhận tiền cho chế độ "${modeName}"`),
      { code: "PAYMENT_ACCOUNT_UNRESOLVED" },
    );
  }
  return { company, paidFrom, paidTo, mode: modeName, mode_requested: requestedMode };
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
export async function verifyWrittenPayment(mcp, docName, { commandId, paid, customerId, actionId }) {
  const res = await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName });
  const doc = docOf(res);
  const problems = [];
  if (String(doc.reference_no ?? "") !== String(commandId)) problems.push(`reference_no=${doc.reference_no}`);
  if (Math.round(Number(doc.paid_amount)) !== Math.round(Number(paid))) problems.push(`paid_amount=${doc.paid_amount}`);
  if (String(doc.party ?? "") !== String(customerId)) problems.push(`party=${doc.party}`);
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
 * Stage A — build the payment proposal for a resolved customer. STOPS there.
 *
 * @param {object} skills  payment+customer skill factory output
 * @param {object} resolved  { customer, ambiguous, candidates } from resolveCustomer()
 * @param {object} [opts]
 * @param {number} [opts.amount_vnd]  optional client-suggested amount (validated, clamped)
 * @param {string} [opts.invoice]     optional invoice to settle (default: oldest open)
 * @param {string} [opts.mode]        payment mode label, default "Tiền mặt"
 * @returns {object} { proposal, invoice, outstanding_vnd, warnings }
 */
export async function buildPaymentProposal(skills, resolved, opts = {}) {
  const { customer, ambiguous, candidates } = resolved;
  if (!customer) {
    const err = new Error(
      ambiguous
        ? `tên khách khớp nhiều kết quả (${(candidates ?? []).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ trước khi ghi phiếu thu`
        : "không xác định được khách hàng — không ghi phiếu thu",
    );
    err.code = "PAYMENT_CUSTOMER_UNRESOLVED";
    throw err;
  }

  const inv = await skills.listUnpaidInvoices(customer.name, undefined);
  const rows = (inv.data?.data ?? []).filter((r) => Number(r.outstanding_amount) !== 0);
  if (rows.length === 0) {
    const err = new Error(`${customer.customer_name} không còn chứng từ nợ nào — không có gì để thu`);
    err.code = "PAYMENT_NO_OPEN_INVOICE";
    throw err;
  }

  // Default target: OLDEST open invoice (posting_date asc) — thu công nợ cũ
  // trước là nghiệp vụ bán cám phổ biến; client có thể chỉ định invoice khác.
  const sorted = [...rows].sort((a, b) => String(a.posting_date).localeCompare(String(b.posting_date)));
  let target = opts.invoice
    ? sorted.find((r) => r.name === opts.invoice)
    : sorted[0];
  if (!target) {
    const err = new Error(`không tìm thấy chứng từ ${opts.invoice} đang nợ của ${customer.customer_name}`);
    err.code = "PAYMENT_INVOICE_NOT_OPEN";
    throw err;
  }

  const outstanding = Math.round(Number(target.outstanding_amount) || 0);
  if (outstanding <= 0) {
    const err = new Error(`chứng từ ${target.name} không phải khoản phải thu dương (outstanding ${outstanding}) — không thu qua phiếu này`);
    err.code = "PAYMENT_INVOICE_NOT_RECEIVABLE";
    throw err;
  }

  const warnings = [];
  let amount = Math.round(Number(opts.amount_vnd ?? outstanding) || 0);
  if (amount <= 0) {
    const err = new Error("số tiền thu phải là số dương (VND)");
    err.code = "PAYMENT_AMOUNT_INVALID";
    throw err;
  }
  if (amount > outstanding) {
    warnings.push(`số tiền đề xuất ${amount} vượt nợ của ${target.name} (${outstanding}) — đã kẹp về đúng nợ`);
    amount = outstanding;
  }

  const proposal = buildProposal({
    action: "create_payment_entry",
    risk: "HIGH",
    entity: { kind: "customer", id: customer.name, name: customer.customer_name },
    params: {
      amount_vnd: amount,
      invoice: target.name,
      outstanding_vnd: outstanding,
      mode: opts.mode ?? "Tiền mặt",
    },
    summary: `Thu ${amount}đ từ ${customer.customer_name} cho chứng từ ${target.name}`,
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

  return { proposal, invoice: target.name, outstanding_vnd: outstanding, warnings, action_id: proposal.action_id };
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
 * @returns {object} { erpnext_doc, paid_vnd, invoice, customer }
 */
export async function executePaymentProposal(mcp, proposal, commandId, store) {
  const { id: customerId } = proposal.entity;
  const requestedInvoice = proposal.params?.invoice;

  // 1. RE-READ live outstanding from ERPNext (never trust the proposal).
  assertReadOnly("erpnext_sales_invoice_list");
  const inv = await mcp.callTool("erpnext_sales_invoice_list", { customer: customerId, limit: 100 });
  const openRows = rowsOf(inv).filter((r) => Number(r.outstanding_amount) !== 0);
  const target = requestedInvoice
    ? openRows.find((r) => r.name === requestedInvoice)
    : [...openRows].sort((a, b) => String(a.posting_date).localeCompare(String(b.posting_date)))[0];

  if (!target) {
    throw Object.assign(
      new Error(`chứng từ ${requestedInvoice ?? "(mới nhất)"} không còn nợ tại thời điểm xác nhận — đã có người thu trước đó`),
      { code: "PAYMENT_INVOICE_ALREADY_SETTLED" },
    );
  }
  // `<= 0` alone lets NaN through (NaN <= 0 is false), which would build a
  // payload with paid_amount NaN. Require a finite positive number instead
  // (review finding, 2026-09-16).
  const rawOutstanding = Number(target.outstanding_amount);
  if (Number(target.is_return) === 1 || !Number.isFinite(rawOutstanding) || rawOutstanding <= 0) {
    throw Object.assign(new Error(`chứng từ ${target.name} không phải khoản phải thu dương`), {
      code: "PAYMENT_INVOICE_NOT_RECEIVABLE",
    });
  }

  const liveOutstanding = Math.round(rawOutstanding);

  // The amount is the client's INTENT; live outstanding is the CEILING. The two
  // must not be conflated (review finding, 2026-09-16): `Number(x) || live`
  // treats 0/NaN/"" as "collect everything", so a client that sends amount 0
  // (which buildPaymentProposal() itself rejects as PAYMENT_AMOUNT_INVALID)
  // would silently write a payment for the FULL debt. Fail closed instead —
  // never promote an invalid amount into a bigger one. This runs BEFORE
  // setReference(), so nothing is registered and nothing is written.
  const requested = Number(proposal.params?.amount_vnd);
  if (!Number.isFinite(requested) || requested <= 0) {
    throw Object.assign(
      new Error(`số tiền thu không hợp lệ (amount_vnd=${JSON.stringify(proposal.params?.amount_vnd)}) — từ chối ghi`),
      { code: "PAYMENT_AMOUNT_INVALID" },
    );
  }

  // Phase 9 (review of phase-07 behaviour): the proposal's snapshot must still
  // match ERPNext. Phase 7 CLAMPED the amount to the live debt and wrote anyway
  // — safe for the money but silent for the user. Now a mismatch is refused so
  // the user re-confirms on fresh numbers. This runs BEFORE setReference(), so
  // nothing is registered and nothing is written.
  const drift = detectDrift(proposal, {
    customerId,
    invoice: target.name,
    outstanding_vnd: liveOutstanding,
    customer: target.customer ?? null,
  });
  if (drift.length > 0) {
    throw Object.assign(
      new Error(`đề xuất đã lệch so với dữ liệu thật: ${drift.join("; ")} — KHÔNG ghi, hãy xác nhận lại`),
      { code: "PROPOSAL_STALE", problems: drift },
    );
  }

  const paid = Math.round(requested);
  const modeRequested = proposal.params?.mode ?? "Tiền mặt";

  // 2. Accounts AND the mode-of-payment document name are READ from ERPNext at
  //    execute time: account names embed a company abbreviation, and the
  //    Vietnamese label is usually not the stored document name (both facts
  //    learned from a real LinkValidationError, 2026-09-16).
  const accounts = await resolvePaymentAccounts(mcp, { invoice: target.name, mode: modeRequested });
  const mode = accounts.mode;

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
  const postingDate = new Date().toISOString().slice(0, 10);
  const actionId = proposal.action_id ?? null;
  const data = buildPaymentEntryData({
    customerId,
    paid,
    commandId,
    actionId,
    mode,
    invoice: target.name,
    invoiceTotal: Math.round(Number(target.grand_total) || liveOutstanding),
    invoiceOutstanding: liveOutstanding,
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
  const verified = await verifyWrittenPayment(mcp, docName, { commandId, paid, customerId, actionId });

  const result = {
    erpnext_doc: docName,
    paid_vnd: paid,
    invoice: target.name,
    customer: customerId,
    reference_no: commandId,
    action_id: actionId,
    docstatus: verified.docstatus ?? 0,
    mode_of_payment: mode,
    note: "phiếu tạo ở trạng thái NHÁP (docstatus 0) — submit là bước riêng, cần người quyết định",
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
  store.complete(commandId, result);
  return result;
}
