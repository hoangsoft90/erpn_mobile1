/**
 * Safety Gateway (P0, plan2_final §7 + §24.3 + §26).
 *
 * THE firewall of the ERP. Invariant:
 *
 *   > Không một AI runtime nào được gọi ERPNext WRITE nếu không đi qua
 *   > Safety Gateway.
 *
 * Concretely: `executePaymentProposal()` (the only function in the project
 * that reaches `callWriteTool`) is invoked from exactly ONE place — this file.
 * The invariant is not a comment: `test/no-bypass.test.mjs` scans the source
 * and fails if any other module references the write path.
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
  assertCapabilityExecutable,
  capabilityForAction,
  executableWriteActions,
  getCapability,
} from "./capability-contract.mjs";
import { checkKillSwitch, logToggle } from "./kill-switch.mjs";

/** Shape of a refusal the HTTP layer can send as-is. */
function refuse(status, body) {
  return { status, body: { ok: false, ...body } };
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
 * @returns {Promise<{status:number, body:object}>}
 */
export async function runExecute({ command_id, proposal, store, createClient, dedup_ack = false, ledger = null } = {}) {
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
  let cap;
  try {
    cap = assertCapabilityExecutable(capabilityId);
  } catch (err) {
    return refuse(err?.code === "FORBIDDEN_IN_AI_PATH" ? 403 : 400, {
      code: err?.code ?? "CAPABILITY_INVALID",
      error: err?.message ?? String(err),
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
  const amount = checkAmountPolicy(cap, proposal?.params?.amount_vnd);
  if (!amount.ok) return refuse(400, { code: "INVALID_AMOUNT", error: amount.error });

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
      // Phase 9 — the (customer, invoice) pair is the INTENT. While one command
      // is PENDING on it, a second command_id must not execute it: two proposals
      // for the same debt are legitimate, paying it twice is not.
      intentKey: `${proposal.entity.id}|${proposal.params?.invoice ?? ""}`,
    });
  } catch (err) {
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
    const opened = await openClientOrRefuse(createClient);
    if (!opened.ok) return opened.refusal;
    const { client, release } = opened;
    try {
      const rec = await reconcilePaymentEntry(client, existing.reference_no, {
        actionId: proposal.action_id ?? null,
      });
      if (rec.found) {
        // Already written: complete the command with the FOUND document and
        // answer as a replay — never write a second payment.
        const result = {
          erpnext_doc: rec.doc?.name ?? null,
          paid_vnd: Math.round(Number(rec.doc?.paid_amount) || 0),
          invoice: proposal.params?.invoice ?? null,
          customer: proposal.entity.id,
          reference_no: existing.reference_no,
          docstatus: rec.doc?.docstatus ?? null,
          reconciled: true,
        };
        if (rec.correlation_field_unavailable) result.correlation_field_unavailable = true;
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
  const opened = await openClientOrRefuse(createClient);
  if (!opened.ok) return opened.refusal;
  const { client, release } = opened;
  try {
    const result = await executePaymentProposal(client, proposal, command_id, store);
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
      err?.code === "PAYMENT_WRITE_UNVERIFIED" || Boolean(store.status(command_id)?.reference_no);
    if (afterWrite) {
      return refuse(503, {
        retry_same_command_id: true,
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
    return refuse(500, { error: `execute failed: ${err?.message ?? err}` });
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
async function openClientOrRefuse(createClient) {
  try {
    return { ok: true, ...(await openClient(createClient)) };
  } catch (err) {
    return {
      ok: false,
      refusal: refuse(503, {
        code: "PAYMENT_CLIENT_UNAVAILABLE",
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
