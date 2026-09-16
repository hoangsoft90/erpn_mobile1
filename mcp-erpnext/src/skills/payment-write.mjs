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

import { assertReadOnly } from "../readonly-guard.mjs";
import { buildProposal } from "../action-proposal.mjs";

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
      schema_note: "params.amount_vnd là ĐỀ XUẤT — execute sẽ đọc lại nợ thật từ ERPNext và kẹp trần",
    },
  });

  return { proposal, invoice: target.name, outstanding_vnd: outstanding, warnings };
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
  const payload = inv.data ?? inv;
  const openRows = (payload.data ?? []).filter((r) => Number(r.outstanding_amount) !== 0);
  const target = requestedInvoice
    ? openRows.find((r) => r.name === requestedInvoice)
    : [...openRows].sort((a, b) => String(a.posting_date).localeCompare(String(b.posting_date)))[0];

  if (!target) {
    throw Object.assign(
      new Error(`chứng từ ${requestedInvoice ?? "(mới nhất)"} không còn nợ tại thời điểm xác nhận — đã có người thu trước đó`),
      { code: "PAYMENT_INVOICE_ALREADY_SETTLED" },
    );
  }
  if (Number(target.is_return) === 1 || Number(target.outstanding_amount) <= 0) {
    throw Object.assign(new Error(`chứng từ ${target.name} không phải khoản phải thu dương`), {
      code: "PAYMENT_INVOICE_NOT_RECEIVABLE",
    });
  }

  const liveOutstanding = Math.round(Number(target.outstanding_amount));
  const paid = Math.min(Math.round(Number(proposal.params?.amount_vnd) || liveOutstanding), liveOutstanding);

  // 2. Register the ERPNext-side reference BEFORE the write (crash safety):
  //    if we die mid-call, reconcile looks for reference_no = command_id.
  store.setReference(commandId, commandId);

  // 3. THE WRITE — the only create_* call in the entire project.
  //    NOTE (review-in-place): assertReadOnly("create_payment_entry") here
  //    would ALWAYS throw — the guard is the Phase 2 read-only surface and
  //    must keep refusing writes. Transport differs by client instead:
  //    · MOCK client accepts the call (Stage A/B tests, Flutter mock flow).
  //    · REAL @casys/mcp-erpnext server exposes erpnext_create_payment_entry —
  //      Stage B (real ERPNext) must go through a dedicated, reviewed client
  //      wrapper that calls THAT tool name; it is intentionally NOT wired in
  //      this commit (user gates the real run).
  // callWriteTool = the client's SINGLE sanctioned write method (mock only in
  // Stage A); callTool keeps refusing every write verb — read paths unchanged.
  if (typeof mcp.callWriteTool !== "function") {
    throw Object.assign(new Error("EXECUTE_CLIENT_UNSUPPORTED: this MCP client has no write method (Stage B needs the reviewed real-server wrapper)"), { code: "EXECUTE_CLIENT_UNSUPPORTED" });
  }
  const res = await mcp.callWriteTool("create_payment_entry", {
    customer: customerId,
    paid_amount: paid,
    reference_no: commandId,
    mode_of_payment: proposal.params?.mode ?? "Tiền mặt",
  });

  const out = res.data ?? res;
  const docName = out?.name ?? out?.data?.name ?? null;
  const result = {
    erpnext_doc: docName,
    paid_vnd: paid,
    invoice: target.name,
    customer: customerId,
    reference_no: commandId,
  };
  if (!docName) {
    throw Object.assign(new Error("ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile"), {
      code: "PAYMENT_WRITE_UNVERIFIED",
    });
  }
  store.complete(commandId, result);
  return result;
}
