/**
 * Phase 9 — proposal FRESHNESS (expiry) and SNAPSHOT DRIFT detection.
 *
 * Why this exists (phase-09 spec): a proposal is built from a snapshot of
 * ERPNext at one moment and executed at another. Between the two, someone else
 * may have collected the debt, the invoice may have been cancelled, or the user
 * may simply have walked away for an hour. Phase 7 handled that by CLAMPING the
 * amount to the live debt and writing anyway — safe for the money, silent for
 * the user. Phase 9 refuses instead: a proposal whose snapshot no longer
 * matches reality must be re-confirmed on fresh data, not executed on stale
 * intent.
 *
 * Fail CLOSED everywhere: a proposal we cannot prove is fresh is refused. The
 * caller (http-ask /execute) turns each refusal into a 409 BEFORE the
 * idempotency gate, so a refused proposal never burns its command_id.
 */

/** Spec: 10–15 phút. 10 is the conservative end; override with PROPOSAL_TTL_MS. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * How much clock skew is tolerated before a "created_at in the future" is
 * treated as forged rather than a wrong device clock.
 */
export const MAX_CLOCK_SKEW_MS = 60 * 1000;

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} effective TTL in ms (invalid/absent env ⇒ DEFAULT_TTL_MS)
 */
export function proposalTtlMs(env = process.env) {
  const raw = Number(env?.PROPOSAL_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * @param {object} proposal
 * @returns {number|null} epoch ms, or null when absent/unparseable
 */
export function proposalCreatedAtMs(proposal) {
  const raw = proposal?.created_at ?? proposal?.createdAt;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Freshness verdict. Never throws — the caller decides the HTTP shape.
 *
 * @param {object} proposal
 * @param {{now?: number, ttlMs?: number}} [opts]
 * @returns {{ok:true, ageMs:number} |
 *           {ok:false, code:string, error:string, ageMs?:number}}
 */
export function assertFresh(proposal, { now = Date.now(), ttlMs = proposalTtlMs() } = {}) {
  const created = proposalCreatedAtMs(proposal);
  if (created === null) {
    return {
      ok: false,
      code: "PROPOSAL_NO_CREATED_AT",
      error:
        "đề xuất thiếu created_at — không xác minh được độ mới nên TỪ CHỐI ghi; hãy hỏi lại để tạo đề xuất mới",
    };
  }
  const ageMs = now - created;
  if (ageMs < -MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      code: "PROPOSAL_CREATED_IN_FUTURE",
      error: `created_at nằm ở TƯƠNG LAI (${Math.round(-ageMs / 1000)}s) — đồng hồ sai hoặc dữ liệu không đáng tin, TỪ CHỐI ghi`,
      ageMs,
    };
  }
  if (ageMs > ttlMs) {
    return {
      ok: false,
      code: "PROPOSAL_EXPIRED",
      error: `đề xuất đã hết hạn (${Math.round(ageMs / 1000)}s > ${Math.round(ttlMs / 1000)}s) — hãy hỏi lại để xác nhận trên số liệu mới`,
      ageMs,
    };
  }
  return { ok: true, ageMs };
}

/**
 * Compare the proposal's recorded snapshot with LIVE ERPNext values.
 *
 * Returns a list of human-readable problems (empty = still valid). The caller
 * refuses the write when the list is non-empty — this replaces Phase 7's silent
 * "clamp to the live value" behaviour on the execute path.
 *
 * Deliberately strict:
 *  - a proposal without `params.outstanding_vnd` cannot be drift-checked at all
 *    ⇒ that counts as a problem (fail closed), because the only producer of
 *    executable proposals (buildPaymentProposal) always sets it;
 *  - the invoice must be the SAME document and must still belong to the same
 *    customer.
 *
 * @param {object} proposal
 * @param {{customerId?:string|null, invoice?:string|null, outstanding_vnd?:number|null, customer?:string|null}} live
 * @returns {string[]}
 */
export function detectDrift(proposal, live = {}) {
  const problems = [];
  const params = proposal?.params ?? {};

  const snapOutstanding = Number(params.outstanding_vnd);
  if (!Number.isFinite(snapOutstanding)) {
    problems.push("đề xuất không kèm snapshot nợ (params.outstanding_vnd) — không đối chiếu được");
  } else if (Number.isFinite(Number(live.outstanding_vnd))) {
    if (Math.round(snapOutstanding) !== Math.round(Number(live.outstanding_vnd))) {
      problems.push(
        `nợ lúc tạo đề xuất ${Math.round(snapOutstanding)} ≠ nợ hiện tại ${Math.round(Number(live.outstanding_vnd))}`,
      );
    }
  }

  if (!params.invoice) {
    problems.push("đề xuất không ghi rõ chứng từ đích (params.invoice)");
  } else if (live.invoice && String(params.invoice) !== String(live.invoice)) {
    problems.push(`chứng từ đích đổi từ ${params.invoice} sang ${live.invoice}`);
  }

  if (proposal?.entity?.id && live.customerId && String(proposal.entity.id) !== String(live.customerId)) {
    // The invoice moved to another customer (reassigned / re-issued).
    problems.push(`chứng từ không còn thuộc khách ${proposal.entity.id} (nay là ${live.customerId})`);
  }

  // Amount must still fit the live debt. Phase 7 clamped; Phase 9 refuses.
  const amount = Number(params.amount_vnd);
  if (Number.isFinite(amount) && Number.isFinite(Number(live.outstanding_vnd))) {
    if (Math.round(amount) > Math.round(Number(live.outstanding_vnd))) {
      problems.push(
        `số tiền ${Math.round(amount)} vượt nợ hiện tại ${Math.round(Number(live.outstanding_vnd))} — cần xác nhận lại`,
      );
    }
  }

  return problems;
}
