/**
 * Safety Gateway (P0, plan2_final §7 + §24.3 + §26).
 *
 * THE firewall of the ERP. Invariant:
 *
 *   > Không một AI runtime nào được gọi ERPNext WRITE nếu không đi qua
 *   > Safety Gateway.
 *
 * Concretely: the executor functions (`executePaymentProposal()`,
 * `executeSalesOrderProposal()` in B2 — the only functions in the project that
 * reach `callWriteTool`) are named in exactly ONE place — the WRITE_EXECUTORS
 * table below, in this file. The invariant is not a comment:
 * `test/safety-gateway.test.mjs` scans the source and fails if any other module
 * references a write path, or if a second module imports an executor.
 *
 * Order of gates (fail-closed, cheapest first, and NOTHING burns a
 * `command_id` before the last gate):
 *
 *   capability contract → request shape → amount policy → kill switch
 *   → freshness (TTL) → idempotency begin → replay / resume-reconcile
 *   → execute → verify (inside the skill)
 *
 * It lives in-process with :8788 on purpose (plan2_final §26: interface first,
 * thin implementation) — a module is enough, as long as there is no bypass.
 *
 * The HTTP layer only translates {command_id, proposal} into this call and the
 * returned {status, body} back to HTTP. No policy lives in http-ask.mjs.
 */

import { createMcpClient } from "./client.mjs";
import { pickServerScript } from "./copilot-server.mjs";
import { fingerprintProposal, isValidCommandId } from "./idempotency.mjs";
import { assertFresh, assertProposalSnapshot } from "./proposal-freshness.mjs";
import { BusinessDedupLedger, businessFingerprint, requiresDedupAck } from "./business-dedup.mjs";
import { executePaymentProposal, reconcilePaymentEntry } from "./skills/payment-write.mjs";
import {
  executeCustomerCreateProposal, // M1: master data — the ONE write that CREATES its entity
  reconcileCustomer,
} from "./skills/customer-create.mjs";
import {
  executeSalesOrderProposal,
  reconcileSalesOrder,
} from "./skills/sales-order-write.mjs";
import {
  executeQuotationProposal,
  reconcileQuotation,
} from "./skills/quotation-write.mjs";
import {
  executePurchaseOrderProposal,
  reconcilePurchaseOrder,
} from "./skills/purchase-order-write.mjs";
import {
  executeDeliveryProposal,
  reconcileDeliveryNote,
} from "./skills/delivery-write.mjs";
import {
  executePurchaseReceiptProposal,
  reconcilePurchaseReceipt,
} from "./skills/purchase-receipt-write.mjs";
import {
  executeSalesInvoiceProposal,
  reconcileSalesInvoice,
} from "./skills/sales-invoice-write.mjs";
import {
  executeStockAdjustmentProposal,
  reconcileStockEntry,
} from "./skills/stock-adjustment-write.mjs";
import {
  executeSalesReturnProposal,
  reconcileSalesReturn,
} from "./skills/sales-return-write.mjs";
import {
  assertCapabilityExecutable,
  capabilityForAction,
  executableWriteActions,
  getCapability,
} from "./capability-contract.mjs";
import { checkKillSwitch, logToggle } from "./kill-switch.mjs";
import { authorize, resolvePrincipal } from "./authorization.mjs";

/** Shape of a refusal the HTTP layer can send as-is. */
function refuse(status, body) {
  return { status, body: { ok: false, ...body } };
}

/**
 * B2 — skill-thrown codes that are REFUSALS, not failures: the check ran
 * BEFORE any create, so nothing was written and the status says what kind of
 * "no" it was (409 = the request conflicts with state already on the site —
 * the same family as the gateway's own IDEMPOTENCY_INTENT_IN_FLIGHT /
 * PROPOSAL_STALE refusals). Kept here in the firewall, the layer that owns
 * HTTP status; the skill only knows domain codes. Anything NOT listed stays
 * 500 (a builder refusal during execute is a clean failure — pinned by the
 * payment tests, and SO_CORRELATION_FIELD_MISSING's 500 deliberately means
 * "the SITE is misconfigured", a server error rather than a conflict).
 */
const SKILL_REFUSAL_STATUSES = Object.freeze({
  // M1: a duplicate create must NAME the existing customer so the card can say
  // "đã có khách …" instead of a dead-end 500 (the same family as the five
  // entries below — one row per write path, added together with the executor).
  CC_DUPLICATE_NAME: 409,
  CC_DUPLICATE_MOBILE: 409,
  CC_DUPLICATE_TAX_ID: 409,
  CC_FUZZY_MATCH: 409,
  CC_DUPLICATE_ACTION: 409,
  SO_DUPLICATE_ACTION: 409,
  // B3: the same refusal family for the quotation path (see the B2 finding in
  // B2-result.md — without an entry here a duplicate reports 500 and the card
  // loses the document name it needs to say "already quoted as QTN-...").
  QT_DUPLICATE_ACTION: 409,
  // B4: added together with the executor, on purpose. The B2 finding was that a
  // duplicate written BEFORE this table existed surfaced as a 500 and the card
  // could not name the existing document; a new write path starts with its
  // refusal statuses already in place instead of rediscovering that.
  PO_DUPLICATE_ACTION: 409,
  // next3/B: the SAME SUPPLIER INVOICE arriving as a SECOND, DIFFERENT command.
  // `PO_DUPLICATE_ACTION` above cannot see that (two commands ⇒ two action ids),
  // so this is the only code that fires here, and it must be a 409 carrying
  // `existing_doc` — the card has to be able to say "đã nhập vào PO-…" instead of
  // offering a retry that could only ever create the duplicate. NB
  // `PO_DOC_KEY_FIELD_MISSING` is deliberately NOT in this table: a site without
  // the column is MISCONFIGURED, which is the same 500 the correlation-field
  // refusal has always been (SO_CORRELATION_FIELD_MISSING, pinned by tests).
  PO_DUPLICATE_DOC: 409,
  // P9-D: same family for the invoice path. The reason is the one above — a
  // duplicate must NAME the existing document so the card can say "already
  // invoiced as SINV-…", which a 500 cannot do.
  SI_DUPLICATE_ACTION: 409,
  // P9-E: the write-off path. Same rule as the four above — a duplicate has to
  // NAME the existing Stock Entry so the card can say "đã xuất hủy ở phiếu …",
  // which a 500 cannot do.
  SE_DUPLICATE_ACTION: 409,
});

/**
 * capability id -> the ONE executor allowed to write for it (B2).
 *
 * The mapping is deliberately a literal table in the firewall rather than a
 * lookup: every new WRITE has to be added HERE, so a new capability can never
 * arrive with an executor attached somewhere else in the codebase. A capability
 * the contract calls executable but that has no entry is REFUSED
 * (`EXECUTOR_NOT_REGISTERED`) — the fail-closed direction, since the alternative
 * ("no executor ⇒ no write") is exactly what the table already gives, and the
 * alternative failure (writing something nobody implemented) does not exist.
 *
 * Each entry answers the four questions the gateway must not hardcode per
 * capability:
 *   execute             how to perform the write
 *   reconcile           how to find out whether an interrupted attempt landed
 *   intentKey           what "the same intent" means (idempotency's intent lock)
 *   unverifiedCodes     error codes that mean "may have written, response lost"
 *                       (must stay PENDING so a retry reconciles instead of
 *                       writing a second document)
 *   resultFromReconcile the result shape this capability's clients expect
 *   clientUnavailableCode  the refusal code when the MCP client cannot open
 */
const WRITE_EXECUTORS = Object.freeze({
  // M1: the customer-CREATE path. Master data, not a transaction: the intent
  // key is the NORMALIZED NAME + contact slots — two proposals for the same
  // new customer cannot be in flight at once (a re-ask after a lost response
  // must reconcile, not clone the customer). The business-key duplicate check
  // lives in the skill (list re-read); the correlation field is the only
  // server-side dedup, exactly like every other write path.
  "customer.create": {
    execute: (client, proposal, commandId, store, ctx) =>
      executeCustomerCreateProposal(client, proposal, commandId, store, { company: ctx?.company ?? null }),
    reconcile: (client, reference, opts) => reconcileCustomer(client, reference, opts),
    intentKey: (proposal) =>
      `${String(proposal.params?.customer_name ?? "").toLowerCase().replace(/\s+/g, " ")}|${proposal.params?.mobile_no ?? ""}|${proposal.params?.tax_id ?? ""}`,
    unverifiedCodes: ["CC_WRITE_UNVERIFIED"],
    clientUnavailableCode: "CC_CLIENT_UNAVAILABLE",
    resultFromReconcile: (rec, proposal, reference) => ({
      erpnext_doc: rec.doc?.name ?? null,
      customer: rec.doc?.name ?? null,
      customer_name: proposal.params?.customer_name ?? rec.doc?.customer_name ?? null,
      mobile_no: proposal.params?.mobile_no ?? null,
      tax_id: proposal.params?.tax_id ?? null,
      reference_no: reference,
      docstatus: rec.doc?.docstatus ?? 0,
      reconciled: true,
      ...(rec.correlation_field_unavailable ? { correlation_field_unavailable: true } : {}),
    }),
  },
  "payment.create": {
    execute: (client, proposal, commandId, store) => executePaymentProposal(client, proposal, commandId, store),
    reconcile: (client, reference, opts) => reconcilePaymentEntry(client, reference, opts),
    intentKey: (proposal) => `${proposal.entity.id}|${proposal.params?.invoice ?? ""}`,
    unverifiedCodes: ["PAYMENT_WRITE_UNVERIFIED"],
    clientUnavailableCode: "PAYMENT_CLIENT_UNAVAILABLE",
    resultFromReconcile: (rec, proposal, reference) => {
      const direction = proposal.entity?.kind === "supplier" ? "pay" : "receive";
      const result = {
        erpnext_doc: rec.doc?.name ?? null,
        paid_vnd: Math.round(Number(rec.doc?.paid_amount) || 0),
        invoice: proposal.params?.invoice ?? null,
        // `customer` keeps its old key for every existing client/test; on the pay
        // side the id in it is the supplier (see `party_kind`).
        customer: proposal.entity.id,
        // P9-C: a reconciled result must say which way the money went, otherwise
        // a lost-response retry on a payment OUT would look identical to one IN.
        direction,
        party_kind: direction === "pay" ? "supplier" : "customer",
        reference_no: reference,
        docstatus: rec.doc?.docstatus ?? null,
        reconciled: true,
      };
      // PROMPT-4: when this command ASKED for a submit, a reconciled reply must
      // say truthfully whether the submit is now done — decided by the docstatus
      // the fresh READ just returned, never by an assumption. A draft-only
      // action (submit_now falsy) leaves submit_ok absent, exactly as before.
      if (proposal.params?.submit_now === true) {
        result.submit_ok = Number(rec.doc?.docstatus) === 1;
      }
      if (rec.correlation_field_unavailable) result.correlation_field_unavailable = true;
      return result;
    },
  },
  // P9-A2: the delivery path. Draft-only, like every line document here — a
  // SUBMITTED delivery note moves stock, which is not a chat side effect.
  "delivery.create": {
    execute: (client, proposal, commandId, store, ctx) =>
      executeDeliveryProposal(client, proposal, commandId, store, { company: ctx?.company ?? null }),
    reconcile: (client, reference, opts) => reconcileDeliveryNote(client, reference, opts),
    // A delivery note is identified by the ORDER plus the exact line set: two
    // proposals for the same order/lines cannot be in flight at once, so a
    // re-ask after a lost response must reconcile instead of shipping twice.
    intentKey: (proposal) =>
      `${proposal.entity.id}|${proposal.params?.against_sales_order ?? ""}|${(proposal.params?.lines ?? [])
        .map((l) => `${l.item_code}x${l.qty}${l.uom ?? ""}`)
        .join("+")}`,
    unverifiedCodes: ["DN_WRITE_UNVERIFIED"],
    clientUnavailableCode: "DN_CLIENT_UNAVAILABLE",
    resultFromReconcile: (rec, proposal, reference) => ({
      erpnext_doc: rec.doc?.name ?? null,
      customer: proposal.entity.id,
      against_sales_order: proposal.params?.against_sales_order ?? null,
      lines: proposal.params?.lines ?? [],
      line_count: proposal.params?.line_count ?? (proposal.params?.lines?.length ?? 0),
      reference_no: reference,
      docstatus: rec.doc?.docstatus ?? null,
      reconciled: true,
      ...(rec.correlation_field_unavailable ? { correlation_field_unavailable: true } : {}),
    }),
  },
  // P9-D: the invoice path. Draft-only, and the DRAFT is the whole safety story:
  // a SUBMITTED Sales Invoice posts revenue and receivable. `update_stock: 0`
  // is sent explicitly by the skill so the document can never move stock, and
  // the read-back verifies it.
  "sales_invoice.create": {
    execute: (client, proposal, commandId, store, ctx) =>
      executeSalesInvoiceProposal(client, proposal, commandId, store, { company: ctx?.company ?? null }),
    reconcile: (client, reference, opts) => reconcileSalesInvoice(client, reference, opts),
    // An invoice is identified by the ORDER plus the exact line set (quantity AND
    // rate): two proposals for the same order/lines/prices cannot be in flight at
    // once, so a re-ask after a lost response must reconcile instead of billing
    // twice. The rate is IN the key on purpose — the same quantities at a price
    // someone edited on the site are a different intent, and the executor's drift
    // check is what turns that into a refusal rather than a write.
    intentKey: (proposal) =>
      `${proposal.entity.id}|${proposal.params?.sales_order ?? ""}|${(proposal.params?.lines ?? [])
        .map((l) => `${l.item_code}x${l.qty}@${l.rate}`)
        .join("+")}`,
    unverifiedCodes: ["SI_WRITE_UNVERIFIED"],
    clientUnavailableCode: "SI_CLIENT_UNAVAILABLE",
    resultFromReconcile: (rec, proposal, reference) => ({
      erpnext_doc: rec.doc?.name ?? null,
      customer: proposal.entity.id,
      sales_order: proposal.params?.sales_order ?? null,
      lines: proposal.params?.lines ?? [],
      line_count: proposal.params?.line_count ?? (proposal.params?.lines?.length ?? 0),
      reference_no: reference,
      docstatus: rec.doc?.docstatus ?? null,
      reconciled: true,
      ...(rec.correlation_field_unavailable ? { correlation_field_unavailable: true } : {}),
    }),
  },
  // P9-B: the receiving path. Draft-only like every line document here — a
  // SUBMITTED Purchase Receipt moves stock, which is not a chat side effect.
  "purchase_receipt.create": {
    execute: (client, proposal, commandId, store, ctx) =>
      executePurchaseReceiptProposal(client, proposal, commandId, store, { company: ctx?.company ?? null }),
    reconcile: (client, reference, opts) => reconcilePurchaseReceipt(client, reference, opts),
    // A receipt is identified by the PO plus the exact line set: two proposals
    // for the same order/lines cannot be in flight at once, so a re-ask after a
    // lost response must reconcile instead of receiving twice.
    intentKey: (proposal) =>
      `${proposal.entity.id}|${proposal.params?.purchase_order ?? ""}|${(proposal.params?.lines ?? [])
        .map((l) => `${l.item_code}x${l.qty}${l.uom ?? ""}`)
        .join("+")}`,
    unverifiedCodes: ["PR_WRITE_UNVERIFIED"],
    clientUnavailableCode: "PR_CLIENT_UNAVAILABLE",
    resultFromReconcile: (rec, proposal, reference) => ({
      erpnext_doc: rec.doc?.name ?? null,
      supplier: proposal.entity.id,
      purchase_order: proposal.params?.purchase_order ?? null,
      lines: proposal.params?.lines ?? [],
      line_count: proposal.params?.line_count ?? (proposal.params?.lines?.length ?? 0),
      reference_no: reference,
      docstatus: rec.doc?.docstatus ?? null,
      reconciled: true,
      ...(rec.correlation_field_unavailable ? { correlation_field_unavailable: true } : {}),
    }),
  },
  // P9-E: the STOCK WRITE-OFF path. Draft-only, and the draft is the whole
  // safety story here in a way it is not for the line documents: a Stock Entry
  // only reaches `Bin`/Stock Ledger on SUBMIT. A DRAFT therefore moves NOTHING —
  // the goods are still on the shelf — which is exactly why the builder has to
  // subtract OTHER open drafts when it computes what is still issueable.
  // P9-F: the RETURN path. Same doctype as the invoice (Sales Invoice) but the
  // OPPOSITE money and stock direction, so its intent key names the ORIGINAL
  // invoice — two returns of the same invoice/lines cannot be in flight at once
  // (a re-ask after a lost response must reconcile, not receive the goods
  // twice). Executability is still single-doored here: the WRITE_EXECUTORS table
  // is the only place an executor is named.
  "sales_return.create": {
    execute: (client, proposal, commandId, store, ctx) =>
      executeSalesReturnProposal(client, proposal, commandId, store, { company: ctx?.company ?? null }),
    reconcile: (client, reference, opts) => reconcileSalesReturn(client, reference, opts),
    intentKey: (proposal) =>
      `${proposal.entity.id}|${proposal.params?.return_against ?? ""}|${(proposal.params?.lines ?? [])
        .map((l) => `${l.item_code}x${l.qty}@${l.rate}`)
        .join("+")}`,
    unverifiedCodes: ["SR_WRITE_UNVERIFIED"],
    clientUnavailableCode: "SR_CLIENT_UNAVAILABLE",
    resultFromReconcile: (rec, proposal, reference) => ({
      erpnext_doc: rec.doc?.name ?? null,
      customer: proposal.entity.id,
      return_against: proposal.params?.return_against ?? null,
      lines: proposal.params?.lines ?? [],
      line_count: proposal.params?.line_count ?? (proposal.params?.lines?.length ?? 0),
      reference_no: reference,
      docstatus: rec.doc?.docstatus ?? null,
      reconciled: true,
      ...(rec.correlation_field_unavailable ? { correlation_field_unavailable: true } : {}),
    }),
  },
  "stock.adjustment": {
    execute: (client, proposal, commandId, store, ctx) =>
      executeStockAdjustmentProposal(client, proposal, commandId, store, { company: ctx?.company ?? null }),
    reconcile: (client, reference, opts) => reconcileStockEntry(client, reference, opts),
    // A write-off has no document number and no party: the INTENT is the item,
    // the room and the quantity. Two identical write-offs cannot be in flight at
    // once, so a re-ask after a lost response must reconcile instead of issuing
    // the same goods twice.
    intentKey: (proposal) =>
      `${proposal.entity.id}|${proposal.params?.warehouse ?? ""}|${proposal.params?.qty ?? ""}${proposal.params?.uom ?? ""}`,
    unverifiedCodes: ["SE_WRITE_UNVERIFIED"],
    clientUnavailableCode: "SE_CLIENT_UNAVAILABLE",
    resultFromReconcile: (rec, proposal, reference) => ({
      erpnext_doc: rec.doc?.name ?? null,
      // No `customer`/`supplier` key: a write-off is about goods. Emitting an
      // empty party key would let a client render "khách: undefined".
      item_code: proposal.entity.id,
      warehouse: proposal.params?.warehouse ?? null,
      qty: proposal.params?.qty ?? null,
      uom: proposal.params?.uom ?? null,
      purpose: proposal.params?.purpose ?? null,
      reference_no: reference,
      docstatus: rec.doc?.docstatus ?? null,
      reconciled: true,
      ...(rec.correlation_field_unavailable ? { correlation_field_unavailable: true } : {}),
    }),
  },
  "quotation.create": {
    execute: (client, proposal, commandId, store, ctx) =>
      executeQuotationProposal(client, proposal, commandId, store, { company: ctx?.company ?? null }),
    reconcile: (client, reference, opts) => reconcileQuotation(client, reference, opts),
    // A quotation is an OFFER, not a booking — but the intent lock works the
    // same way: the customer plus the exact approved line set. Two proposals for
    // the same customer/lines cannot be in flight at once (a re-ask after a lost
    // response must reconcile, not issue a second offer with a second number).
    intentKey: (proposal) =>
      `${proposal.entity.id}|${(proposal.params?.lines ?? [])
        .map((l) => `${l.item_code}x${l.qty}${l.uom}@${l.rate}`)
        .join("+")}`,
    unverifiedCodes: ["QT_WRITE_UNVERIFIED"],
    clientUnavailableCode: "QT_CLIENT_UNAVAILABLE",
    resultFromReconcile: (rec, proposal, reference) => ({
      erpnext_doc: rec.doc?.name ?? null,
      customer: proposal.entity.id,
      lines: proposal.params?.lines ?? [],
      line_count: proposal.params?.line_count ?? (proposal.params?.lines?.length ?? 0),
      estimated_total_vnd: proposal.params?.estimated_total_vnd ?? null,
      erpnext_total_vnd: Number.isFinite(Number(rec.doc?.grand_total))
        ? Math.round(Number(rec.doc.grand_total))
        : null,
      reference_no: reference,
      docstatus: rec.doc?.docstatus ?? null,
      reconciled: true,
      ...(rec.correlation_field_unavailable ? { correlation_field_unavailable: true } : {}),
    }),
  },
  "purchase_order.create": {
    execute: (client, proposal, commandId, store, ctx) =>
      executePurchaseOrderProposal(client, proposal, commandId, store, { company: ctx?.company ?? null }),
    reconcile: (client, reference, opts) => reconcilePurchaseOrder(client, reference, opts),
    // A Purchase Order has no invoice either: the INTENT is the supplier plus the
    // exact line set. Two proposals for the same supplier/lines cannot be in
    // flight at once.
    //
    // next3/B: when the request carries a DOCUMENT identity, that identity IS the
    // intent — the same invoice is one intent no matter who typed which lines,
    // and two proposals for it must not run at once. It also keeps the lock
    // usable in the other direction: a DIFFERENT invoice for the same supplier
    // and the same lines is a legitimately different document, and the line-set
    // key would have collided with an interrupted attempt.
    intentKey: (proposal) =>
      proposal.params?.business_doc_key
        ? `bdk:${proposal.params.business_doc_key}`
        : `${proposal.entity.id}|${(proposal.params?.lines ?? [])
            .map((l) => `${l.item_code}x${l.qty}${l.uom}@${l.rate}`)
            .join("+")}`,
    unverifiedCodes: ["PO_WRITE_UNVERIFIED"],
    clientUnavailableCode: "PO_CLIENT_UNAVAILABLE",
    resultFromReconcile: (rec, proposal, reference) => ({
      erpnext_doc: rec.doc?.name ?? null,
      supplier: proposal.entity.id,
      lines: proposal.params?.lines ?? [],
      line_count: proposal.params?.line_count ?? (proposal.params?.lines?.length ?? 0),
      estimated_total_vnd: proposal.params?.estimated_total_vnd ?? null,
      price_side: proposal.params?.price_side ?? null,
      erpnext_total_vnd: Number.isFinite(Number(rec.doc?.grand_total))
        ? Math.round(Number(rec.doc.grand_total))
        : null,
      reference_no: reference,
      docstatus: rec.doc?.docstatus ?? null,
      reconciled: true,
      ...(rec.correlation_field_unavailable ? { correlation_field_unavailable: true } : {}),
    }),
  },
  "sales_order.create": {
    execute: (client, proposal, commandId, store, ctx) =>
      executeSalesOrderProposal(client, proposal, commandId, store, { company: ctx?.company ?? null }),
    reconcile: (client, reference, opts) => reconcileSalesOrder(client, reference, opts),
    // A Sales Order has no invoice: the INTENT is the customer plus the exact
    // line set, so two proposals for the same customer/order cannot run at once.
    intentKey: (proposal) =>
      `${proposal.entity.id}|${(proposal.params?.lines ?? [])
        .map((l) => `${l.item_code}x${l.qty}${l.uom}@${l.rate}`)
        .join("+")}`,
    unverifiedCodes: ["SO_WRITE_UNVERIFIED"],
    clientUnavailableCode: "SO_CLIENT_UNAVAILABLE",
    resultFromReconcile: (rec, proposal, reference) => ({
      erpnext_doc: rec.doc?.name ?? null,
      customer: proposal.entity.id,
      lines: proposal.params?.lines ?? [],
      line_count: proposal.params?.line_count ?? (proposal.params?.lines?.length ?? 0),
      estimated_total_vnd: proposal.params?.estimated_total_vnd ?? null,
      erpnext_total_vnd: Number.isFinite(Number(rec.doc?.grand_total))
        ? Math.round(Number(rec.doc.grand_total))
        : null,
      reference_no: reference,
      docstatus: rec.doc?.docstatus ?? null,
      reconciled: true,
      ...(rec.correlation_field_unavailable ? { correlation_field_unavailable: true } : {}),
    }),
  },
});

/**
 * The executor for a capability, or a refusal.
 * @param {string} capabilityId
 * @returns {{ok:true, executor:object} | {ok:false, refusal:object}}
 */
function executorFor(capabilityId) {
  const executor = Object.prototype.hasOwnProperty.call(WRITE_EXECUTORS, capabilityId)
    ? WRITE_EXECUTORS[capabilityId]
    : null;
  if (!executor) {
    return {
      ok: false,
      refusal: refuse(400, {
        code: "EXECUTOR_NOT_REGISTERED",
        error: `capability "${capabilityId}" khai là WRITE nhưng chưa có executor nào đăng ký — không có đường ghi nào cho nó (fail closed)`,
      }),
    };
  }
  return { ok: true, executor };
}

/**
 * Contract-driven amount policy check. The contract (not this file) decides
 * whether zero/negative/full-balance amounts are legal for a capability.
 * @param {object} cap capability contract entry
 * @param {unknown} rawAmount
 * @returns {{ok:true} | {ok:false, error:string}}
 */
export function checkAmountPolicy(cap, rawAmount) {
  const policy = cap.amount_policy ?? {};
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount)) {
    return { ok: false, error: "params.amount_vnd phải là số VND > 0" };
  }
  if (amount === 0 && policy.allow_zero !== true) {
    return { ok: false, error: "params.amount_vnd phải là số VND > 0" };
  }
  if (amount < 0 && policy.allow_negative !== true) {
    return { ok: false, error: "params.amount_vnd phải là số VND > 0" };
  }
  return { ok: true };
}

/**
 * Run one confirmed WRITE through every gate.
 *
 * @param {object} req
 * @param {string} req.command_id client-generated UUID (idempotency key)
 * @param {object} req.proposal   erpn.proposal/v1 built by the skill layer
 * @param {object} req.store      IdempotencyStore (already constructed by the caller)
 * @param {() => object} [req.createClient] test seam; defaults to the real client
 * @param {object} [req.principal]  P8: resolved principal (permissions + company)
 * @param {string} [req.company]    P8: company supplied by the request, if any
 * @param {object} [req.env]        P8: env used to resolve a principal when none is passed
 * @returns {Promise<{status:number, body:object}>}
 */
export async function runExecute({
  command_id,
  proposal,
  store,
  createClient,
  dedup_ack = false,
  ledger = null,
  principal,
  company,
  // P8: the job runner replays with an ACTOR ID rather than a resolved
  // principal object, so permissions are re-read from current config at the
  // moment of the write instead of being frozen when the job was queued.
  user_id,
  env = process.env,
} = {}) {
  if (!isValidCommandId(command_id)) {
    return refuse(400, { error: "command_id must be a client-generated UUID" });
  }

  // 1. CAPABILITY CONTRACT — the action must be a declared, executable WRITE.
  const capabilityId = capabilityForAction(proposal?.action);
  if (!capabilityId) {
    return refuse(400, {
      error: `only ${executableWriteActions().join("/")} proposals are executable (got action=${proposal?.action})`,
    });
  }
  if (getCapability(capabilityId)?.execution?.forbidden_in_ai_path === true) {
    return refuse(403, {
      code: "FORBIDDEN_IN_AI_PATH",
      error: `capability "${capabilityId}" bị CẤM trên đường AI — không có use case hợp lệ khi dùng AI UI (plan2_final §8)`,
    });
  }
  // 1a. EXECUTOR — must exist BEFORE any other gate, so a capability that is
  //     declared executable but has no implementation is refused as exactly
  //     that, instead of passing every safety gate and then failing as an
  //     unexplained 500 (B2: a stub WRITE capability cannot become a write path
  //     just by being declared).
  const bound = executorFor(capabilityId);
  if (!bound.ok) return bound.refusal;
  const executor = bound.executor;

  let cap;
  try {
    cap = assertCapabilityExecutable(capabilityId);
  } catch (err) {
    return refuse(err?.code === "FORBIDDEN_IN_AI_PATH" ? 403 : 400, {
      code: err?.code ?? "CAPABILITY_INVALID",
      error: err?.message ?? String(err),
    });
  }

  // 1b. AUTHORIZATION (P8, plan2_final §5 + §24.2) — server-side, contract
  //     driven, and BEFORE every other policy so an account that may not run
  //     this capability never even reaches the amount/business gates. Placed
  //     ahead of the idempotency gate on purpose: a refusal here must not burn
  //     a command_id. The principal is resolved once at the HTTP edge, but a
  //     direct caller (tests, job runner) that passes none still gets a real
  //     check against the process env instead of a bypass.
  const actor = principal ?? resolvePrincipal({ user: user_id ?? undefined, env });
  // NEXT6 (G5): a proposal is owned by the principal it was built for. Even
  // with a fresh command_id, another user must not confirm it. Proposals with
  // no stamp (built before this change, or by the dsh tool) are not blocked —
  // the check is purely additive. Placed before the idempotency gate so a
  // refusal does not burn a command_id.
  const proposalOwner = proposal?.principal_user_id ?? null;
  if (proposalOwner && actor?.user_id && proposalOwner !== actor.user_id) {
    return refuse(403, {
      code: "PROPOSAL_PRINCIPAL_MISMATCH",
      error: "Đề xuất này thuộc về người dùng khác — không thể xác nhận bằng tài khoản hiện tại.",
      user_id: actor.user_id,
    });
  }
  const authz = authorize(capabilityId, { principal: actor, company, env });
  if (!authz.ok) {
    return refuse(authz.code === "AUTHORIZATION_DENIED" ? 403 : 409, {
      code: authz.code,
      error: authz.error,
      authz_mode: actor.mode,
      user_id: actor.user_id,
    });
  }

  // 2. REQUEST SHAPE — a proposal without a resolved entity id is a client bug.
  if (!proposal?.entity?.id) {
    return refuse(400, {
      error: "proposal entity has no resolved ERPNext id — resolve the customer first",
    });
  }

  // 3. AMOUNT POLICY — money-shape gate at the boundary so a malformed request
  //    never reserves a command_id (review finding 2026-09-16: an invalid
  //    amount must never be "rounded up" into a larger payment).
  //    Deliberately STRICTER than the contract's `allow_full_balance`: the
  //    proposal builder is what fills the amount (currently = full outstanding),
  //    so a request that omits it is malformed, not "collect everything". The
  //    boundary must never accept a missing amount and let a downstream clamp
  //    decide the money. Pinned by test "omitted amount is refused".
  //
  //    B2: the gate runs for the capabilities that DECLARE an amount policy.
  //    A capability with `amount_policy: null` (a Sales Order — no single
  //    amount exists; its risk lives in `line_policy`, enforced by the skill)
  //    would otherwise be refused for a field it never has. The gate itself is
  //    unchanged, so payment behaviour is byte-for-byte what it was.
  if (cap.amount_policy) {
    const amount = checkAmountPolicy(cap, proposal?.params?.amount_vnd);
    if (!amount.ok) return refuse(400, { code: "INVALID_AMOUNT", error: amount.error });
  }

  // 4. KILL SWITCH — before the gate, so maintenance never burns an intent.
  const kill = checkKillSwitch(capabilityId);
  if (!kill.allowed) {
    // Audit trail (plan2_final §24.3 `audit: log every toggle`): a refusal is
    // when the switch actually bites, so that is what gets recorded.
    logToggle({ code: kill.code, capabilityId, source: "safety-gateway" });
    return refuse(503, { code: kill.code, level: kill.level, error: kill.error });
  }

  // 5. FRESHNESS (Phase 9) — age gate, also before the gate.
  const freshness = assertFresh(proposal);
  if (!freshness.ok) {
    return refuse(409, { code: freshness.code, error: freshness.error });
  }

  // 5b. SNAPSHOT INTEGRITY (P1 §9) — the proposal must be an immutable snapshot
  //     this code knows how to execute. A missing/older `version` means the
  //     fields validated here are not the fields the executor reads.
  const snapshot = assertProposalSnapshot(proposal);
  if (!snapshot.ok) {
    return refuse(409, { code: snapshot.code, error: snapshot.error });
  }

  // 5c. BUSINESS DEDUP (§10.5) — a SECOND proposal for the same real intent
  //     (same customer + amount + capability inside the window) needs an extra
  //     acknowledgement. Checked before the idempotency gate on purpose: a
  //     missing ack is a client mistake and must not burn a command_id.
  //     This layer is ADDITIVE — command_id idempotency below is unchanged.
  if (requiresDedupAck(proposal) && dedup_ack !== true) {
    return refuse(409, {
      code: "BUSINESS_DEDUP_CONFIRM_REQUIRED",
      error:
        proposal.business_dedup?.message ??
        "đề xuất này trùng ý định với một đề xuất gần đây — cần xác nhận thêm trước khi ghi",
      business_dedup: proposal.business_dedup ?? null,
      retry_same_command_id: true,
    });
  }

  // 6. IDEMPOTENCY GATE — from here on the command_id is owned.
  const fp = fingerprintProposal(proposal);
  let gate;
  try {
    gate = store.begin(command_id, {
      action: proposal.action,
      fingerprint: fp,
      // P8 §19 deliverable 4: the command record names the ACTOR. The
      // correlation log has it too, but the write record is what survives in
      // the store, so an audit after the fact does not depend on log retention.
      user_id: actor.user_id,
      company: authz.company ?? null,
      // Phase 9 — the intent key. While one command is PENDING on it, a second
      // command_id must not execute it: two proposals for the same debt (or the
      // same order) are legitimate, executing it twice is not. B2: what "the
      // same intent" MEANS is per capability (payment: customer+invoice; order:
      // customer+lines), so it comes from the executor table.
      intentKey: executor.intentKey(proposal),
    });
  } catch (err) {
    // NEXT6 (G4): a command_id owned by ANOTHER principal is a refusal with a
    // NAMED code (the client must not read it as generic "invalid command"), and
    // it burns nothing — the command belongs to the other user.
    if (err?.code === "COMMAND_ID_FOREIGN") {
      return refuse(409, {
        code: "COMMAND_ID_FOREIGN",
        error: err.message,
      });
    }
    return refuse(409, {
      error: err.message,
      ...(err?.code === "IDEMPOTENCY_INTENT_IN_FLIGHT"
        ? { code: err.code, clash_command_id: err.clashCommandId ?? null }
        : {}),
    });
  }
  if (gate.replay) {
    // once-only guarantee: the FIRST execution's result is returned again
    return { status: 200, body: { ok: true, replay: true, result: gate.result } };
  }

  const existing = store.status(command_id);
  if (gate.resumed) {
    if (!existing?.reference_no) {
      return refuse(409, {
        error:
          "command đang PENDING nhưng thiếu server reference — không thể đối soát, KHÔNG ghi để tránh trùng; cần người kiểm tra ERPNext",
        command_id,
      });
    }
    const opened = await openClientOrRefuse(createClient, executor.clientUnavailableCode);
    if (!opened.ok) return opened.refusal;
    const { client, release } = opened;
    try {
      const rec = await executor.reconcile(client, existing.reference_no, {
        actionId: proposal.action_id ?? null,
        proposal,
      });
      if (rec.found) {
        // Already written: complete the command with the FOUND document and
        // answer as a replay — never write a second document.
        const result = executor.resultFromReconcile(rec, proposal, existing.reference_no);
        store.complete(command_id, result);
        return {
          status: 200,
          body: {
            ok: true,
            replay: true,
            reconciled: true,
            duplicate_documents: rec.duplicates ? rec.count : 0,
            result,
          },
        };
      }
      // Not found ⇒ the earlier attempt never landed. Safe to write now.
    } catch (err) {
      return refuse(503, {
        error: `không đối soát được với ERPNext — KHÔNG ghi để tránh trùng: ${err?.message ?? err}`,
        command_id,
        reference_no: existing.reference_no,
      });
    } finally {
      await release();
    }
  }

  // 7. EXECUTE — the only write path in the project.
  const opened = await openClientOrRefuse(createClient, executor.clientUnavailableCode);
  if (!opened.ok) return opened.refusal;
  const { client, release } = opened;
  try {
    const result = await executor.execute(client, proposal, command_id, store, {
      company: authz.company ?? null,
    });
    recordExecutedIntent(store, proposal, command_id, ledger);
    return { status: 200, body: { ok: true, replay: false, result } };
  } catch (err) {
    // Classify before writing the terminal state (review finding 2026-09-16).
    // A failure AFTER the ERPNext reference was registered (i.e. during the
    // write or its read-back check) may mean the document DID land and only the
    // response was lost. Marking that FAILED would (a) make reconcile
    // impossible — begin() refuses a FAILED command — and (b) push the user
    // toward a NEW command_id, which is exactly how a second payment gets
    // written. Keep it PENDING: the next attempt reconciles against ERPNext
    // and either completes it or writes once.
    const afterWrite =
      executor.unverifiedCodes.includes(err?.code) || Boolean(store.status(command_id)?.reference_no);
    if (afterWrite) {
      return refuse(503, {
          retry_same_command_id: true,
          // P8: the effective company travels with the refusal so a queued retry
          // records the scope this write was authorized under.
          company: authz.company ?? null,
          error: `chưa xác minh được kết quả ghi: ${err?.message ?? err} — gửi lại ĐÚNG command_id này để hệ thống đối soát với ERPNext (KHÔNG tạo command_id mới)`,
        });
    }
    if (err?.code === "PROPOSAL_STALE") {
      // The intent no longer matches ERPNext (debt changed / invoice moved).
      // The check runs BEFORE setReference, so nothing was written; the command
      // is terminal so the client re-asks instead of retrying a stale intent.
      // P1 (§12): the refusal carries the SPECIFIC taxonomy code —
      // PROPOSAL_VERSION_STALE (data moved) vs PROPOSAL_ENTITY_CHANGED (the
      // customer itself is gone) — because the UX differs, with the old generic
      // code kept as `legacy_code` for clients that only know that one.
      store.fail(command_id, err.message);
      return refuse(409, {
        code: err.drift_code ?? "PROPOSAL_STALE",
        legacy_code: "PROPOSAL_STALE",
        error: err.message,
        problems: err.problems ?? [],
      });
    }
    store.fail(command_id, err?.message ?? String(err));
    const refusalStatus = SKILL_REFUSAL_STATUSES[err?.code];
    if (refusalStatus) {
      // Pre-write refusal, and the evidence travels with it (which document
      // already exists) so the card can offer "view the existing order"
      // instead of a dead end.
      return refuse(refusalStatus, {
        code: err.code,
        existing_doc: err?.existing_doc,
        error: err?.message ?? String(err),
      });
    }
    // B2: carry the refusal's OWN code when the skill raised one. The status
    // stays 500 (a builder refusal during execute is a clean failure — pinned by
    // the payment tests), but dropping the code made "ERPNext chưa có field
    // custom_ai_action_id" arrive as an anonymous server error, which the card
    // cannot explain and an operator cannot act on.
    return refuse(500, { ...(err?.code ? { code: err.code } : {}), error: `execute failed: ${err?.message ?? err}` });
  } finally {
    await release();
  }
}

/**
 * Open the MCP client, turning a *configuration* failure into a refusal.
 *
 * Regression fixed 2026-09-17 (self-review): client creation used to sit
 * OUTSIDE the try/catch, so `pickServerScript()` throwing
 * PARTIAL_ERPNEXT_CONFIG escaped runExecute() → escaped the async HTTP handler
 * → unhandled rejection killed the gateway process, while the command stayed
 * PENDING with no reference_no and the (customer,invoice) intent lock blocked
 * every later attempt — a typo in .env wedged that debt permanently.
 *
 * Nothing is registered with ERPNext before the client opens, so FAILING the
 * command would be wrong (it would force a new command_id for no reason). The
 * correct answer is non-terminal: fix the config, retry the SAME command_id.
 */
async function openClientOrRefuse(createClient, code = "PAYMENT_CLIENT_UNAVAILABLE") {
  try {
    return { ok: true, ...(await openClient(createClient)) };
  } catch (err) {
    return {
      ok: false,
      refusal: refuse(503, {
        code,
        retry_same_command_id: true,
        error: `không mở được kết nối ERPNext: ${err?.message ?? err} — CHƯA có gì được ghi; sửa ERPNEXT_URL/ERPNEXT_API_KEY/ERPNEXT_API_SECRET rồi gửi lại ĐÚNG command_id này`,
      }),
    };
  }
}

/** Open an MCP client and return its release function. */
async function openClient(createClient) {
  const client = createClient
    ? createClient()
    : createMcpClient({ serverScript: pickServerScript() });
  try {
    await client.initialize();
  } catch (err) {
    // Do not leak the spawned server (it would also keep the event loop alive).
    await client.close().catch(() => {});
    throw err;
  }
  return { client, release: () => client.close().catch(() => {}) };
}

/** Test seam — pins the leak guard (close the spawned server when initialize fails). */
export const __openClientForTest = openClient;

/**
 * Remember that this real-world intent was executed (§10.5), so the NEXT
 * proposal for the same customer+amount+capability inside the window can warn.
 * Never allowed to fail a write that already succeeded: the money moved, so a
 * bookkeeping problem is logged, not surfaced as a payment error.
 */
function recordExecutedIntent(store, proposal, commandId, injectedLedger) {
  try {
    const ledger = injectedLedger ?? new BusinessDedupLedger(store.dir);
    ledger.record({
      fingerprint: proposal?.business_dedup?.fingerprint ?? businessFingerprint(proposal),
      phase: "executed",
      proposal_id: proposal?.proposal_id ?? null,
      command_id: commandId,
    });
  } catch (err) {
    process.stderr.write(`[dedup] không ghi được ledger (bỏ qua): ${err?.message ?? err}\n`);
  }
}
